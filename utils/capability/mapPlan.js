import { fetchVerified } from '../commandMap/fetchMap.js'

/**
 * 拉取计划：读一次索引，算出本机需要哪几份地图。
 *
 * 只读索引、不下载任何地图——索引只有几十 KB，日常检查靠它就能判断要不要干活。
 * 索引结构不对时整体报错，不做部分采用：拿半份索引去规划会漏拉一批插件，
 * 而且要等到下一轮才发现。
 */

const INDEX_SCHEMA = 2

/**
 * 读云端索引。索引本身没有哈希可校，只做结构校验。
 *
 * @param {{ indexUrl?: string, fetchImpl?: Function }} [options]
 * @returns {Promise<{ index: object, base: string, source: string, revision: number }>}
 */
export async function readMapIndex ({ indexUrl, fetchImpl } = {}) {
  const url = String(indexUrl || '').trim()
  if (!url) throw new Error('没有配置地图索引地址')

  const base = url.replace(/[^/]+$/, '')
  const { text, source } = await fetchVerified(url, { requireHash: false, fetchImpl })

  let index
  try {
    index = JSON.parse(text)
  } catch {
    throw new Error(`${source} 返回的索引不是 JSON`)
  }
  if (!index || typeof index !== 'object') {
    throw new Error(`索引结构不合法（来自 ${source}）`)
  }
  if (Number(index.schema) !== INDEX_SCHEMA) {
    throw new Error(`索引结构不合法：schema ${index.schema}，只认 ${INDEX_SCHEMA}（来自 ${source}）`)
  }
  if (!index.plugins || typeof index.plugins !== 'object') {
    throw new Error(`索引结构不合法：缺少 plugins（来自 ${source}）`)
  }

  return { index, base, source, revision: Number(index.revision) || 0 }
}

/**
 * 按版本比对本机需要哪几份地图。纯函数，不碰网络与磁盘。
 *
 * @param {{
 *   index: object,
 *   plugins?: Array<{ key: string, version?: string }>,
 *   localVersions?: Map<string, string>
 * }} input localVersions 是「已留存地图的版本」，来自各插件的元信息
 * @returns {{
 *   revision: number,
 *   pending: Array<{ key: string, reason: string, cloudVersion: string, localVersion: string, entry: object }>,
 *   upToDate: string[],
 *   missing: string[]
 * }}
 */
export function planMapSync ({ index, plugins = [], localVersions = new Map(), localMetas = null } = {}) {
  const entries = index?.plugins && typeof index.plugins === 'object' ? index.plugins : {}
  const pending = []
  const upToDate = []
  const missing = []

  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    const key = typeof plugin?.key === 'string' ? plugin.key.trim() : ''
    if (!key) continue

    const entry = entries[key]
    if (!entry || typeof entry !== 'object') {
      missing.push(key)
      continue
    }

    const cloudVersion = typeof entry.version === 'string' ? entry.version.trim() : ''
    const cloudSha = typeof entry.sha256 === 'string' ? entry.sha256.trim() : ''

    // localMetas 优先（带 sha256）；老调用方只给 localVersions 时退回纯版本比对
    const meta = localMetas?.get(key)
    const localVersion = meta
      ? String(meta.version || '')
      : String(localVersions.get(key) || '')
    const localSha = meta ? String(meta.sha256 || '') : ''

    // 本地没有这份地图：版本相同也得拉，否则等于没有
    if (!localVersion && !localSha) {
      pending.push({ key, reason: 'no-local-map', cloudVersion, localVersion, entry })
      continue
    }

    // 云端没写 version 时 version 两边都可能是空串，比 sha256 才判得准；
    // 否则每轮都判成「版本变了」，等于全量重拉
    const same = cloudVersion
      ? localVersion === cloudVersion
      : Boolean(cloudSha) && localSha === cloudSha
    if (same) {
      upToDate.push(key)
      continue
    }
    pending.push({ key, reason: 'version-changed', cloudVersion, localVersion, entry })
  }

  return { revision: Number(index?.revision) || 0, pending, upToDate, missing }
}
