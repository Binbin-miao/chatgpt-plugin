import { FRAMEWORK_CONFIG_SPEC } from './paths.js'
import { listInstalledPlugins } from './registry.js'
import { planMapSync, readMapIndex } from './mapPlan.js'
import { downloadMaps } from './mapSync.js'
import { readLocalMeta } from './mapStore.js'
import { patchSyncState, readSyncState } from './syncState.js'

/**
 * 一次完整同步：枚举本机插件 → 读索引 → 按版本比对 → 下载待更新项 → 汇总。
 *
 * 每日任务与手动指令共用这一条路径，区别只在「要不要回报」。没有变化时
 * 只发一次索引请求，不下载任何地图。
 */

const LOG_PREFIX = '[Chatgpt][map]'

/**
 * @param {{
 *   indexUrl: string,
 *   fetchImpl?: Function,
 *   plugins?: Array<{ key: string, version?: string }>,
 *   onProgress?: (done: number, total: number) => void
 * }} options
 * @returns {Promise<{
 *   revision: number, scanned: number, updated: number, upToDate: number,
 *   missing: string[], failed: number, errors: string[]
 * }>}
 */
export async function syncPluginMaps ({ indexUrl, fetchImpl, plugins, onProgress } = {}) {
  const list = Array.isArray(plugins) ? plugins : await listInstalledPlugins()
  const { base, index, revision } = await readMapIndex({ indexUrl, fetchImpl })

  const localVersions = new Map()
  for (const plugin of list) {
    const meta = readLocalMeta(plugin.key)
    if (meta?.version) localVersions.set(plugin.key, String(meta.version))
  }

  const plan = planMapSync({ index, plugins: list, localVersions })
  const downloaded = plan.pending.length
    ? await downloadMaps({ base, pending: plan.pending, fetchImpl, onProgress })
    : { updated: 0, failed: 0, errors: [] }

  if (plan.pending.length) {
    globalThis.logger?.mark?.(
      `${LOG_PREFIX} ${plan.pending.length} 份待更新：成 ${downloaded.updated} / 败 ${downloaded.failed}`
    )
  } else {
    globalThis.logger?.mark?.(`${LOG_PREFIX} 已是新版（${revision}），无需下载`)
  }

  // 未覆盖清单要落盘：拼提示词是同步路径，注入时从这里读，不再算一遍
  patchSyncState({ missing: plan.missing })

  return {
    revision,
    scanned: list.length,
    updated: downloaded.updated,
    upToDate: plan.upToDate.length,
    missing: plan.missing,
    failed: downloaded.failed,
    errors: downloaded.errors
  }
}

/**
 * 每日检查：拉一次，只在「有更新」或「连续失败满三的倍数」时私聊主人。
 *
 * 失败计数落盘，避免每天一条报错——真正的故障看得见，偶发抖动不打扰。
 *
 * @param {{ indexUrl: string, fetchImpl?: Function, plugins?: object[], notify?: Function }} [options]
 */
export async function dailyPluginMapSync ({ indexUrl, fetchImpl, plugins, notify = notifyOwner } = {}) {
  const previous = readSyncState()

  try {
    const result = await syncPluginMaps({ indexUrl, fetchImpl, plugins })
    const streak = result.failed > 0 ? previous.failStreak + 1 : 0
    patchSyncState({ failStreak: streak })

    if (result.updated > 0) {
      await safeNotify(notify, buildUpdatedText(result))
    }
    if (result.failed > 0 && shouldAlert(streak)) {
      await safeNotify(notify, buildFailureText(result, streak))
    }
    return { ok: true, failStreak: streak, ...result }
  } catch (err) {
    const streak = previous.failStreak + 1
    patchSyncState({ failStreak: streak })
    if (shouldAlert(streak)) {
      await safeNotify(notify, [`【插件地图】同步失败（连续第 ${streak} 次）：${err?.message || err}`])
    }
    return { ok: false, failStreak: streak, error: err?.message || String(err) }
  }
}

function shouldAlert (streak) {
  return streak >= 3 && streak % 3 === 0
}

/**
 * 手动拉取的回执。与每日通知的区别：这里是用户主动要结果，所以无论有没有
 * 更新都给一条完整回执，缺失插件也一定列出来。
 *
 * @param {object} result syncPluginMaps 的返回值
 * @param {number} seconds 耗时
 * @returns {string}
 */
export function formatManualReport (result, seconds) {
  const lines = [
    `插件地图已更新（版本 ${result.revision}，耗时 ${seconds}s）`,
    `本机插件 ${result.scanned} 个 ｜ 更新 ${result.updated} 份 ｜ 已最新 ${result.upToDate} 份 ｜ 失败 ${result.failed} 份`
  ]
  if (result.failed) lines.push(`失败原因：${result.errors.slice(0, 3).join('；')}`)
  if (result.missing.length) {
    lines.push(
      `云端没有地图的插件（${result.missing.length} 个，AI 无法代执行）：${result.missing.slice(0, 10).join('、')}${result.missing.length > 10 ? ' 等' : ''}`
    )
  }
  return lines.join('\n')
}

function buildUpdatedText (result) {
  const lines = [`【插件地图】已更新 ${result.updated} 份（版本 ${result.revision}）`]
  if (result.failed) lines.push(`失败 ${result.failed} 份：${result.errors.slice(0, 3).join('；')}（下次自动重试）`)
  if (result.missing.length) lines.push(`云端没有地图的插件：${result.missing.slice(0, 10).join('、')}`)
  return lines
}

function buildFailureText (result, streak) {
  return [
    `【插件地图】连续 ${streak} 次有下载失败：${result.failed} 份`,
    result.errors.slice(0, 3).join('；')
  ]
}

async function safeNotify (notify, lines) {
  try {
    await notify?.(Array.isArray(lines) ? lines.join('\n') : String(lines))
  } catch (err) {
    globalThis.logger?.warn?.(`${LOG_PREFIX} 通知发送失败：${err?.message || err}`)
  }
}


/** 私聊主人。拿不到主人号或发送失败时只写日志——通知是尽力而为，
 * 不能因为通知失败把同步结果吞掉。
 */
async function notifyOwner (text) {
  try {
    const mod = await import(FRAMEWORK_CONFIG_SPEC)
    const masterQQ = mod?.default?.masterQQ || mod?.masterQQ || []
    const masters = (Array.isArray(masterQQ) ? masterQQ : [masterQQ]).map(Number).filter(Boolean)
    const bot = globalThis.Bot
    if (!masters.length || !bot?.pickFriend) {
      globalThis.logger?.warn?.(`${LOG_PREFIX} 无法私聊主人，通知降级为日志：${text}`)
      return
    }
    for (const qq of masters.slice(0, 3)) {
      const friend = await bot.pickFriend(qq)
      await friend?.sendMsg?.(text)
    }
  } catch (err) {
    globalThis.logger?.warn?.(`${LOG_PREFIX} 通知发送失败：${err?.message || err}`)
  }
}
