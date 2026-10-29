import fs from 'node:fs'
import path from 'node:path'

import { CAPABILITY_MAP_SCHEMA, capabilityMapsDir } from './paths.js'

/**
 * 本地地图留存：一个插件一个目录，一份 `map.json` + 一份 `meta.json`。
 *
 * 只认 schema 2。读到版本不符或 JSON 坏掉时返回 null 并记一条 warn：
 * 一份坏地图不能连累其余插件，上层把它算作缺失即可。
 *
 * 目录名要净化：pluginKey 来自远端索引，`..` 或分隔符不能把写入带出留存目录。
 */

const LOG_PREFIX = '[ChatGPT][map]'

/** 路径段净化：`example/add` 这类带分隔符的 key 会被压成一个目录名 */
function safeSegment (value) {
  return String(value ?? '').replace(/[\\/]/g, '_').replace(/\.{2,}/g, '_').trim()
}

/**
 * @param {string} key 插件注册单位
 * @returns {string} 该插件的地图目录
 */
export function mapDir (key) {
  const segment = safeSegment(key)
  if (!segment) throw new Error('插件 key 为空，无法定位地图目录')
  return path.join(capabilityMapsDir(), segment)
}

/**
 * 写入一份地图与它的元信息。
 *
 * @param {string} key 插件注册单位
 * @param {{ plugin: object, instructions: object[] }} map
 * @param {{ version?: string, revision?: number, sha256?: string, fetchedAt?: string }} [meta]
 */
export function saveLocalMap (key, map, meta = {}) {
  const dir = mapDir(key)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'map.json'),
    JSON.stringify({ schema: CAPABILITY_MAP_SCHEMA, ...map }, null, 2),
    'utf8'
  )
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify(
      {
        schema: CAPABILITY_MAP_SCHEMA,
        key: String(key),
        // 版本以索引为准：地图文件里的同名字段只作兜底，两处并存必然打架
        version: typeof meta.version === 'string' && meta.version.trim()
          ? meta.version.trim()
          : (typeof map?.plugin?.version === 'string' ? map.plugin.version : ''),
        fingerprint: typeof map?.plugin?.fingerprint === 'string' ? map.plugin.fingerprint : '',
        revision: Number(meta.revision) || 0,
        sha256: typeof meta.sha256 === 'string' ? meta.sha256 : '',
        fetchedAt: meta.fetchedAt || new Date().toISOString()
      },
      null,
      2
    ),
    'utf8'
  )
}

/**
 * 读一份地图。结构不对、版本不符、文件缺失一律返回 null。
 *
 * @param {string} key
 * @returns {{ plugin: object, instructions: object[] } | null}
 */
export function readLocalMap (key) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(path.join(mapDir(key), 'map.json'), 'utf8'))
  } catch (err) {
    // 没装过这份地图是常态，不吭声；读得到却坏了才值得留一条
    if (err?.code !== 'ENOENT') globalThis.logger?.warn?.(`[ChatGPT][map] 地图读不出来（${key}）：${err?.message || err}`)
    return null
  }
  return validateMap(raw, key)
}

/** 读元信息；用于对账与排查来源版本 */
export function readLocalMeta (key) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(mapDir(key), 'meta.json'), 'utf8'))
    return meta && typeof meta === 'object' ? meta : null
  } catch (err) {
    if (err?.code !== 'ENOENT') globalThis.logger?.warn?.(`[ChatGPT][map] 元信息读不出来（${key}）：${err?.message || err}`)
    return null
  }
}

/**
 * 列出所有已留存的插件 key。key 取 meta 里的原值，meta 坏掉时退回目录名。
 *
 * @returns {string[]}
 */
export function listLocalMapKeys () {
  let entries = []
  try {
    entries = fs.readdirSync(capabilityMapsDir(), { withFileTypes: true })
  } catch (err) {
    if (err?.code !== 'ENOENT') globalThis.logger?.warn?.(`[ChatGPT][map] 地图目录读不出来：${err?.message || err}`)
    return []
  }

  const keys = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const meta = readLocalMetaByDir(entry.name)
    keys.push(typeof meta?.key === 'string' && meta.key ? meta.key : entry.name)
  }
  return keys
}

function readLocalMetaByDir (segment) {
  try {
    return JSON.parse(fs.readFileSync(path.join(capabilityMapsDir(), segment, 'meta.json'), 'utf8'))
  } catch (err) {
    if (err?.code !== 'ENOENT') globalThis.logger?.warn?.(`[ChatGPT][map] 索引目录里的元信息坏了（${segment}）：${err?.message || err}`)
    return null
  }
}

/** 结构校验：schema 必须是 2，instructions 必须是数组 */
function validateMap (raw, key) {
  if (!raw || typeof raw !== 'object') return null
  if (Number(raw.schema) !== CAPABILITY_MAP_SCHEMA) {
    globalThis.logger?.warn?.(`${LOG_PREFIX} ${key} 的地图版本是 ${raw.schema}，只认 ${CAPABILITY_MAP_SCHEMA}，按缺失处理`)
    return null
  }
  if (!raw.plugin || typeof raw.plugin !== 'object') return null
  if (!Array.isArray(raw.instructions)) return null
  return { plugin: raw.plugin, instructions: raw.instructions }
}
