import { fetchVerified } from '../commandMap/fetchMap.js'

import { CAPABILITY_MAP_SCHEMA } from './paths.js'
import { saveLocalMap } from './mapStore.js'

/**
 * 按「待下载」清单逐份拉取地图，哈希对得上才落盘。
 *
 * 每份独立 try：一份脏数据或一次网络抖动只记一条错误，不能连累其余插件。
 * `file` 字段来自远端索引，必须限制在索引所在主机内——否则一份被改过的索引
 * 就能让所有使用者去任意地址取内容。
 *
 * @param {{
 *   base: string,
 *   pending?: Array<{ key: string, entry: { file?: string, sha256?: string, revision?: number } }>,
 *   fetchImpl?: Function,
 *   onProgress?: (done: number, total: number) => void
 * }} options
 * @returns {Promise<{ updated: number, failed: number, errors: string[] }>}
 */
export async function downloadMaps ({ base, pending = [], fetchImpl, onProgress } = {}) {
  const root = String(base || '').trim()
  if (!root) throw new Error('缺少索引 base 地址，无法拼出地图下载地址')

  const rootOrigin = new URL(root).origin
  const list = Array.isArray(pending) ? pending : []
  const result = { updated: 0, failed: 0, errors: [] }
  let done = 0

  for (const item of list) {
    const key = String(item?.key || '')
    try {
      await downloadOne({ key, item, root, rootOrigin, fetchImpl })
      result.updated += 1
    } catch (err) {
      result.failed += 1
      result.errors.push(`${key || '未知插件'}: ${err?.message || err}`)
    }
    done += 1
    onProgress?.(done, list.length)
  }

  return result
}

async function downloadOne ({ key, item, root, rootOrigin, fetchImpl }) {
  const file = typeof item?.entry?.file === 'string' ? item.entry.file.trim() : ''
  if (!key) throw new Error('索引条目缺少 key')
  if (!file) throw new Error('索引条目缺少 file')

  const url = new URL(file, root)
  if (url.origin !== rootOrigin) throw new Error(`file 指向了索引以外的主机：${url.origin}`)

  const expected = typeof item.entry.sha256 === 'string' ? item.entry.sha256 : ''
  if (!expected) throw new Error('索引没有声明 sha256，拒绝安装来路不明的地图')

  const { text, source } = await fetchVerified(url.toString(), { sha256: expected, fetchImpl })

  let map
  try {
    map = JSON.parse(text)
  } catch {
    throw new Error(`${source} 返回的不是 JSON`)
  }
  if (Number(map?.schema) !== CAPABILITY_MAP_SCHEMA) {
    throw new Error(`地图版本是 ${map?.schema}，只认 ${CAPABILITY_MAP_SCHEMA}`)
  }
  if (!map.plugin || typeof map.plugin !== 'object' || !Array.isArray(map.instructions)) {
    throw new Error('地图结构不合法：缺少 plugin 或 instructions')
  }

  saveLocalMap(key, map, {
    version: typeof item.entry.version === 'string' ? item.entry.version : '',
    revision: item.entry.revision,
    sha256: expected,
    fetchedAt: new Date().toISOString()
  })
}
