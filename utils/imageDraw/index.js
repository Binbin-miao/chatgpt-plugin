import { logError, logMark, logWarn } from './log.js'
import { Config } from '../config.js'
import { resolveProvider } from '../providers.js'
import { KEY_FIELDS, URL_FIELDS } from '../providerProfiles.js'
import { newFetch } from '../proxy.js'
import { loadQuotedImageMedias } from '../quotedImage.js'
import { generateImage, ImageDrawError, toUserMessage, normalizeSize, normalizeQuality } from './client.js'
import {
  acquireInflight,
  getCircuit,
  getCooldown,
  getQuotaUsage,
  releaseInflight,
  reserveQuota,
  refundQuota,
  markCooldown,
  recordFailure,
  recordSuccess
} from './quota.js'

/**
 * 绘图编排：把「谁在问 → 还能不能画 → 用哪套密钥 → 画 → 发出/记账」串起来。
 *
 * 指令与 AI 工具共用这一条路径，避免两边各写一份之后额度口径跑偏。
 */

/** 这些错误说明上游真的坏了，计入熔断连击；配置错、提示词空属于用法问题，不该拖累全群 */
const CIRCUIT_ERROR_CODES = new Set(['upstream', 'network', 'timeout', 'auth', 'quota', 'rate-limit', 'bad-response'])
// 刻意不含 empty / moderation / download：
// - moderation：一个人连发五条被审核的提示词，不该让全群停画五小时
// - download：上游画出来了，只是 CDN 取不回来，说明接口本身没坏
// - empty：多半是站点不认这条通道，交给路由降级去处理

/** 这几类错误的 message 本来就是给用户看的话，直接透出，别再套「生成失败」模板 */
const USER_FACING_ERROR_CODES = new Set(['config', 'delivery'])

export function formatDrawDuration (seconds) {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}

/** 从 provider 行取连接参数；模型名以绘图配置为准，不跟对话模型走 */
export function resolveDrawProvider (config = Config) {
  const id = String(config.imageDrawProviderId || '').trim()
  if (!id) throw new ImageDrawError('还没选绘图用的提供商，请主人到锅巴「绘图」里选一个', 'config')
  const row = resolveProvider(id)
  const baseUrl = String(row[URL_FIELDS[row.type]] || '').trim()
  const rawKey = String(row[KEY_FIELDS[row.type]] || '').trim()
  const apiKey = rawKey.split(/[,，;]/).map(key => key.trim()).filter(Boolean)[0] || ''
  const model = String(config.imageDrawModel || '').trim()
  if (!baseUrl) throw new ImageDrawError('选中的提供商没有填地址，请主人检查', 'config')
  if (!apiKey) throw new ImageDrawError('选中的提供商没有填密钥，请主人检查', 'config')
  if (!model) throw new ImageDrawError('还没填绘图模型名，请主人到锅巴「绘图」里填（例如 gpt-image-2）', 'config')
  return { name: row.name || row.id, baseUrl, apiKey, model }
}

/** 拉一张 QQ 头像当参考图；拿不到就返回 null，让调用方退回文生图而不是整单失败 */
export async function fetchAvatarBuffer (qq, { timeoutMs = 20_000, fetchImpl = newFetch } = {}) {
  const uin = String(qq || '').trim()
  if (!/^\d+$/.test(uin)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640`, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    if (!buffer.length) return null
    const contentType = res.headers?.get?.('content-type') || 'image/png'
    return { buffer, mimeType: contentType.split(';')[0].trim() || 'image/png' }
  } catch (err) {
    logWarn(`取头像失败：${err?.message || err}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 参考图优先级：指令/工具显式给的 > 引用消息里的图 > 头像 */
export async function collectRefs (e, { useAvatar = false, refs = [] } = {}) {
  if (Array.isArray(refs) && refs.length) return refs.slice(0, 1)
  const quoted = await loadQuotedImageMedias(e)
  if (quoted?.medias?.length) {
    const first = quoted.medias[0]
    return [{ buffer: Buffer.from(first.data, 'base64'), mimeType: first.mimeType }]
  }
  if (useAvatar) {
    const avatar = await fetchAvatarBuffer(e?.sender?.user_id)
    if (avatar) return [avatar]
  }
  return []
}

/**
 * 只读预检：把「现在到底能不能画」先问清楚，避免先回一句「在画了」再补一句「画不了」。
 *
 * 不做预扣，真正的判定仍在 runDraw 里用原子自增兜底；两人同时抢最后一张时，
 * 後到的那个会拿到 quota 结果，由调用方补发失败消息。
 *
 * 拒绝时除了人话，还要带上结构化字段（retryAfter / limit / used）：
 * 调用方要拿这些数字去告诉提问者，光有一句话是转达不出来的。
 */
export async function precheckDraw ({ e, config = Config, store } = {}) {
  const isMaster = Boolean(e?.isMaster)
  const userId = String(e?.sender?.user_id || e?.user_id || '')
  if (!userId) return { ok: false, code: 'config', message: '拿不到用户身份，画不了' }

  // 今日用量读一次，三个拒绝分支共用这份真值：被冷却或被熔断挡下的人，
  // 同样要知道今天画了几张、每天上限是多少
  const limit = Number(config.imageDrawDailyLimit) || 0
  let usage = { limit: 0, used: 0 }
  if (!isMaster && limit > 0) {
    const { used } = await getQuotaUsage({ userId, isMaster, now: Date.now() }, store)
    usage = { limit, used: Number(used) || 0 }
  }

  const circuit = await getCircuit(store)
  if (circuit.open) {
    return {
      ok: false,
      code: 'circuit',
      retryAfter: circuit.retryAfter,
      message: `绘图暂时停了：接口连续出错触发了保护，${formatDrawDuration(circuit.retryAfter)}后自动恢复。主人可用 #绘图解禁 提前解除。`,
      ...usage
    }
  }

  const cooldownLeft = await getCooldown({ userId, isMaster }, store)
  if (cooldownLeft > 0) {
    return { ok: false, code: 'cooldown', retryAfter: cooldownLeft, message: `刚画过一张，${formatDrawDuration(cooldownLeft)}后可以再画。`, ...usage }
  }

  // usage 只在真有额度概念时才非零，原判据还得带上：否则 limit=0 的人会被 0>=0 拦下
  if (!isMaster && limit > 0 && usage.used >= limit) {
    return { ok: false, code: 'quota', message: `今天的 ${limit} 张已经画完了，明天再来吧。`, ...usage }
  }

  return { ok: true }
}

/** 返图时附的那句话；与回执同口径，但不限额度与主人一个字都不加 */
function formatRemainingNote (remaining) {
  if (remaining === null || remaining === undefined) return ''
  if (remaining > 0) return `\n今天还剩 ${remaining} 张`
  return '\n今天的额度用完啦，明天再来'
}

/**
 * 画一张并直接发到当前会话：可选回执，后台生成，完成后补发图片。
 *
 * 同步等图会把整轮对话卡住 40-100 秒（工具调用还可能撞上框架超时），
 * 所以这里统一走「立即 ack + 后台推送」。ack 传空则一句话都不说，
 * 把开口的机会留给调用方（AI 工具链路要的就是这个）。
 *
 * @param {object} options
 * @param {string} [options.ack] 回执原文；空串表示不发（称呼、剩余次数由调用方拼好）
 * @returns {Promise<{ok: boolean, code?: string, message?: string, retryAfter?: number, limit?: number, used?: number}>}
 *          被拒时把预检结论整个带出去：code 是原因，retryAfter / limit / used 是数字
 */
export async function launchDraw ({ e, prompt, size, quality, useAvatar = false, ack = '', provider, generate, config = Config, store } = {}) {
  const check = await precheckDraw({ e, config, store })
  if (!check.ok) return { ...check }

  if (ack) {
    try {
      await e.reply?.(ack, false)
    } catch (err) {
      logWarn(`回执发送失败：${err?.message || err}`)
    }
  }
  const task = (async () => {
    const result = await runDraw({
      e,
      prompt,
      size,
      quality,
      useAvatar,
      provider,
      generate,
      config,
      store,
      deliver: async (image, { remaining } = {}) => {
        const segmentImage = globalThis.segment?.image
        const seg = segmentImage ? segmentImage(image.buffer) : image.buffer
        const note = formatRemainingNote(remaining)
        // 次数并进同一条消息：再补一句「今天还剩 N 张」只会让群里多一条噪音
        const buildMessage = () => (note ? [seg, note] : seg)
        // 先引用触发它的那条消息，群里才看得清这是画给谁的。
        // 框架发送失败不抛异常，而是 resolve 成 { error }：不查返回值就会
        // 「图丢了、账记了、冷却也进」——所以必须降级重发一次普通消息。
        // 每次重建载荷：带引用时框架会把引用段 unshift 进传进去的那个数组本身，
        // 复用同一个数组重发，引用段还躺在里面，只会再失败一次（白重试）。
        const sent = await e.reply(buildMessage(), true)
        if (sent?.error) {
          logWarn('带引用发图失败，改为普通发送')
          const retry = await e.reply(buildMessage())
          if (retry?.error) throw new ImageDrawError('图没发出去，稍后再试', 'delivery')
        }
      }
    })
    if (!result.ok) await e.reply(result.message)
  })()
  // 后台任务不能有未捕获异常，否则整个进程会告警；失败要能让用户看到
  task.catch(err => logError(`后台任务异常：${err?.message || err}`))
  return { ok: true }
}

/**
 * 执行一次绘图。
 *
 * @param {object} options
 * @param {object} options.e 云崽事件
 * @param {string} options.prompt 提示词
 * @param {string} [options.size]
 * @param {string} [options.quality]
 * @param {boolean} [options.useAvatar] 用发指令者头像做参考图
 * @param {Array<object>} [options.refs] 已备好的参考图
 * @param {(image: {buffer: Buffer, mimeType: string}, meta: {remaining: number|null}) => Promise<void>} options.deliver 发图回调；`remaining` 为扣完这一张后的当日剩余次数，null 表示不限额度/主人
 * @param {object} [options.config]
 * @param {object} [options.store] 测试注入的 redis
 * @returns {Promise<{ok: boolean, code?: string, message?: string, used?: number, limit?: number}>}
 */
export async function runDraw ({
  e,
  prompt,
  size,
  quality,
  useAvatar = false,
  refs,
  deliver,
  provider,
  config = Config,
  store,
  generate = generateImage
} = {}) {
  const isMaster = Boolean(e?.isMaster)
  const userId = String(e?.sender?.user_id || e?.user_id || '')
  if (!userId) return { ok: false, code: 'config', message: '拿不到用户身份，画不了' }

  const limit = Number(config.imageDrawDailyLimit) || 0
  const cooldownMinutes = Number(config.imageDrawCooldownMinutes) || 0
  const threshold = Number(config.imageDrawFailStreakLimit) || 0
  const cooldownHours = Number(config.imageDrawGlobalCooldownHours) || 5

  // 1. 全线熔断：接口坏了谁也别画，主人也一样——问题在上游，绕过去只会继续报错
  const circuit = await getCircuit(store)
  if (circuit.open) {
    return {
      ok: false,
      code: 'circuit',
      message: `绘图暂时停了：接口连续出错触发了保护，${formatDrawDuration(circuit.retryAfter)}后自动恢复。主人可用 #绘图解禁 提前解除。`
    }
  }

  // 2. 个人冷却（主人不受限）
  const cooldownLeft = await getCooldown({ userId, isMaster }, store)
  if (cooldownLeft > 0) {
    return { ok: false, code: 'cooldown', message: `刚画过一张，${formatDrawDuration(cooldownLeft)}后可以再画。` }
  }

  // 3. 同一个人同一时刻只允许一张在途。出图要 40-100 秒，这段时间里连发指令、
  //    或模型一轮里反复调工具，每次都是真实计费请求；冷却要成功后才写，拦不住。
  const timeoutMs = Math.max(30, Number(config.imageDrawTimeoutSeconds) || 180) * 1000
  const inflight = await acquireInflight({ userId, seconds: Math.round(timeoutMs / 1000) + 60 }, store)
  if (!inflight) {
    return { ok: false, code: 'busy', message: '上一张还在画，等它出来再画下一张吧。' }
  }

  try {
    // 4. 每日张数（主人不受限）
    const reserved = await reserveQuota({ userId, limit, isMaster }, store)
    if (!reserved.ok) {
      return {
        ok: false,
        code: 'quota',
        message: `今天的 ${limit} 张已经画完了，明天再来吧。`
      }
    }

    let connection
    try {
      connection = provider || resolveDrawProvider(config)
    } catch (err) {
      await refundQuota({ userId, isMaster }, store)
      return { ok: false, code: 'config', message: err?.message || '绘图配置不完整' }
    }

    try {
      const startedAt = Date.now()
      const finalRefs = await collectRefs(e, { useAvatar, refs })
      const image = await generate({
        provider: connection,
        prompt,
        size: normalizeSize(size || config.imageDrawSize),
        quality: normalizeQuality(quality || config.imageDrawQuality),
        refs: finalRefs,
        timeoutMs
      })

      // 这一张已经计入 reserved.used：剩余次数在这里才是权威值，交给 deliver 决定说不说
      const remaining = limit > 0 && !isMaster ? Math.max(0, limit - reserved.used) : null
      await deliver?.(image, { remaining })
      await recordSuccess(store)
      await markCooldown({ userId, minutes: cooldownMinutes, isMaster }, store)
      // 通道（images/chat）是排障第一现场：同一个站两条通道的表现可以完全不同
      logMark(`用户 ${userId} 出图成功（${finalRefs.length ? '图生图' : '文生图'}，${connection.name}/${connection.model}，通道 ${image.route || '未知'}，${Math.round(image.buffer.length / 1024)} KB，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）`)
      return { ok: true, used: reserved.used, limit, model: connection.model }
    } catch (err) {
      await refundQuota({ userId, isMaster }, store)
      const code = err instanceof ImageDrawError ? err.code : 'failed'
      if (CIRCUIT_ERROR_CODES.has(code)) {
        const failure = await recordFailure({ threshold, hours: cooldownHours }, store)
        if (failure.tripped) {
          logError(`接口连续失败 ${failure.streak} 次，已全员停画 ${cooldownHours} 小时`)
        }
      }
      logError(`用户 ${userId} 出图失败（${code}）：${err?.message || err}`)
      return { ok: false, code, message: USER_FACING_ERROR_CODES.has(code) ? err.message : toUserMessage(err) }
    }
  } finally {
    await releaseInflight({ userId }, store)
  }
}
