import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'
import { parseSourceImg } from '../utils/common.js'
import { parseDrawCommand } from '../utils/imageDraw/args.js'
import { buildAckText } from '../utils/imageDraw/ack.js'
import { launchDraw, formatDrawDuration } from '../utils/imageDraw/index.js'
import { getCooldown, getQuotaUsage, getCircuit, clearCircuit } from '../utils/imageDraw/quota.js'
import { logMark } from '../utils/imageDraw/log.js'

/**
 * 绘图指令。
 *
 * 与 AI 工具共用同一条执行路径（utils/imageDraw），额度、冷却、熔断口径完全一致，
 * 不会出现「AI 画得了、指令画不了」这种两套规则的裂缝。
 *
 * 只认 `#绘图`，不碰 `#绘画`：后者是 nai-plugin 等第三方绘图插件的主指令，
 * 抢过来会让装了那些插件的用户莫名其妙地改走 gpt-image。
 */
export class imageDraw extends plugin {
  constructor () {
    super({
      name: 'ChatGPT-Plugin 绘图',
      dsc: '#绘图 文生图/图生图；#绘图头像 用自己头像；#绘图状态 看额度；#绘图解禁 解除熔断（主人）',
      event: 'message',
      priority: 500,
      rule: [
        // 提示词前必须有空格：#绘图解禁 / #绘图状态 不能被当成「画一个叫解禁的东西」
        { reg: '^#绘图(?:头像)?(?:\\s+[\\s\\S]*)?$', fnc: 'draw' },
        { reg: '^#绘图解禁$', fnc: 'unlock', permission: 'master' },
        { reg: '^#绘图状态$', fnc: 'status' }
      ]
    })
  }

  async draw (e) {
    // 没开就放行，交给别的绘图插件；开着才接管 #绘图
    if (!Config.imageDrawEnable) return false

    // 与 #识图 同一套口径：开了「仅主人可用」就只认主人，连额度都不查
    if (Config.imageDrawOnlyMaster && !e.isMaster) {
      await e.reply('绘图目前只对主人开放。', true)
      return true
    }

    // 指令链路上没人替我们解析引用消息，e.img 默认是空的：不补这一步，
    // 「引用一张图 + #绘图 改成水彩」会被当成文生图，画出一张全新的图。
    // 第二个参数关掉 @头像：否则「画个图 @小王」会被当成拿小王头像做参考图。
    await parseSourceImg(e, false).catch(err => logMark(`解析引用图失败：${err?.message || err}`))

    const useAvatar = /^#绘图头像/.test(String(e.msg || '').trim())
    const parsed = parseDrawCommand(e.msg || '', {
      defaultSize: Config.imageDrawSize,
      defaultQuality: Config.imageDrawQuality
    })
    if (parsed.error) {
      await e.reply(parsed.error, true)
      return true
    }

    // 回执在扣额度之前发出，所以这里的剩余张数是快照，可能与最终差一张
    const limit = Number(Config.imageDrawDailyLimit) || 0
    let remaining = null
    if (limit > 0 && !e.isMaster) {
      const { used } = await getQuotaUsage({ userId: e.user_id, isMaster: e.isMaster })
      remaining = Math.max(0, limit - used)
    }

    const result = await launchDraw({
      e,
      prompt: parsed.prompt,
      size: parsed.size,
      quality: parsed.quality,
      useAvatar: useAvatar || parsed.useAvatar,
      // 指令链路由插件自己回执：报个等待区间和当日剩余张数，比干等 40-100 秒有底
      ack: buildAckText({
        name: e.bot?.nickname || '',
        timeoutSeconds: Number(Config.imageDrawTimeoutSeconds) || 180,
        remaining,
        // 规则也要说清：主人与不限额的人不受张数与冷却限制，就别提
        dailyLimit: e.isMaster ? null : (Number(Config.imageDrawDailyLimit) || 0) || null,
        cooldownMinutes: e.isMaster ? null : (Number(Config.imageDrawCooldownMinutes) || 0)
      })
    })
    if (!result.ok) await e.reply(result.message, true)
    return true
  }

  /** 主人提前解除熔断，不用等满时长 */
  async unlock (e) {
    await clearCircuit()
    logMark(`主人 ${e.user_id} 手动解除熔断`)
    await e.reply('已解除绘图熔断，现在可以继续画了。', true)
    return true
  }

  async status (e) {
    if (!Config.imageDrawEnable) {
      await e.reply('绘图还没启用，请主人到锅巴「绘图」里打开。', true)
      return true
    }
    const limit = Number(Config.imageDrawDailyLimit) || 0
    const circuit = await getCircuit()
    const cooldown = await getCooldown({ userId: e.user_id, isMaster: e.isMaster })
    const { used } = await getQuotaUsage({ userId: e.user_id, isMaster: e.isMaster })

    const lines = []
    lines.push(`绘图模型：${Config.imageDrawModel || '未填'}`)
    lines.push(`每日额度：${e.isMaster ? '主人不限' : limit > 0 ? `已用 ${used}/${limit} 张` : '不限'}`)
    if (cooldown > 0) lines.push(`冷却中：${formatDrawDuration(cooldown)}后可再画`)
    if (circuit.open) lines.push(`接口熔断中：${formatDrawDuration(circuit.retryAfter)}后自动恢复（主人可用 #绘图解禁）`)
    await e.reply(lines.join('\n'), true)
    return true
  }
}
