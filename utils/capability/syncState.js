import fs from 'node:fs'
import path from 'node:path'

import { capabilityMapsDir } from './paths.js'

/**
 * 同步状态的落盘：失败连击数与「云端没有地图的插件」。
 *
 * 两者都必须在注入时同步读到——拼提示词是同步路径，改成异步要牵动所有 provider 分支。
 * 状态与地图同目录，跟着 `data/` 一起被版本控制忽略。
 */

const STATE_FILE = '.state.json'
const LOG_PREFIX = '[ChatGPT][map]'

/** @returns {{ failStreak: number, missing: string[] }} */
export function readSyncState () {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    return {
      failStreak: Number(state?.failStreak) || 0,
      missing: Array.isArray(state?.missing) ? state.missing.filter(item => typeof item === 'string') : []
    }
  } catch (err) {
    // 首次运行没有这个文件，属正常；坏掉了才记一条
    if (err?.code !== 'ENOENT') globalThis.logger?.warn?.(`[ChatGPT][map] 同步状态读不出来：${err?.message || err}`)
    return { failStreak: 0, missing: [] }
  }
}

/** @param {{ failStreak?: number, missing?: string[] }} state */
export function writeSyncState (state) {
  try {
    fs.mkdirSync(capabilityMapsDir(), { recursive: true })
    fs.writeFileSync(
      statePath(),
      JSON.stringify({
        failStreak: Number(state?.failStreak) || 0,
        missing: Array.isArray(state?.missing) ? state.missing : []
      }),
      'utf8'
    )
  } catch (err) {
    globalThis.logger?.warn?.(`${LOG_PREFIX} 状态写入失败：${err?.message || err}`)
  }
}

/** 只改其中几个字段，其余保持原样——两个写入方各管一块，不互相覆盖 */
export function patchSyncState (patch) {
  writeSyncState({ ...readSyncState(), ...patch })
}

function statePath () {
  return path.join(capabilityMapsDir(), STATE_FILE)
}
