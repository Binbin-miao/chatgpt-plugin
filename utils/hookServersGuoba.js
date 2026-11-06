/**
 * 上下文注入条目列表（hookServers）的解析与锅巴 GSubForm 序列化
 *
 * 存储形态与 mcpServers 同款：JSON 字符串，兼容裸数组与
 * { "hookServers": [...] } 包装形态。条目六个字段：enabled /
 * url（或 server 引用）/ headers / timeout / maxChars / when。
 *
 * 两类入口（见 docs/adr/0016-context-injection-hooks.md）：
 * - parseHookServersConfig：运行期每轮解析。失败整段放弃，error 一行后
 *   降级为空列表，不影响对话。
 * - stringifyHookServersFromGuoba：面板保存路径。校验失败抛错，由
 *   setConfigData 的 Result.error 拦截，不落半截配置。
 */

const HOOK_WHEN_VALUES = new Set(['turn', 'session'])

/**
 * 解析 hookServers 配置为条目数组
 *
 * @param {string|object} value JSON 字符串或已解析的值（兼容裸数组与包装形态）
 * @param {boolean} [throwOnError] 校验失败时抛错（供面板保存路径拦截）；默认 error 降级为空
 * @returns {Array} 条目数组；无配置或解析失败时为 []
 */
export function parseHookServersConfig(value, throwOnError = false) {
  if (!value) {
    return []
  }

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (Array.isArray(parsed)) {
      return parsed
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.hookServers)) {
      return parsed.hookServers
    }
  } catch (err) {
    if (throwOnError) {
      throw new Error(`hookServers JSON parse failed: ${err.message}`)
    }
    globalThis.logger?.error?.(`[ContextInjection] 解析 hookServers 配置 JSON 失败: ${err.message}，本轮放弃全部注入条目`)
    return []
  }

  if (throwOnError) {
    throw new Error('hookServers JSON must be an array or an object with a hookServers array')
  }
  globalThis.logger?.error?.('[ContextInjection] hookServers 配置必须是数组或 {hookServers: [...]}，本轮放弃全部注入条目')
  return []
}

/** 把存储的 headers 键值对展开成面板多行文本（每行 KEY=value，value 可含 =） */
function formatHeadersForGuoba(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return ''
  }
  return Object.entries(headers)
    .map(([key, value]) => `${key}=${value ?? ''}`)
    .join('\n')
}

/**
 * 把 hookServers 配置转换为锅巴 GSubForm 行数组（getConfigData 用）
 *
 * @param {string|object} value 存储的 hookServers 配置
 * @returns {Array} 面板行数组
 */
export function formatHookServersForGuoba(value) {
  return parseHookServersConfig(value).map(entry => {
    const config = entry && typeof entry === 'object' ? entry : {}
    return {
      enabled: config.enabled !== false,
      url: config.url || '',
      server: config.server || '',
      headers: formatHeadersForGuoba(config.headers),
      timeout: config.timeout ?? '',
      maxChars: config.maxChars ?? '',
      when: HOOK_WHEN_VALUES.has(config.when) ? config.when : 'turn'
    }
  })
}

function splitLines(value) {
  if (Array.isArray(value)) {
    return value.map(item => `${item}`.trim()).filter(Boolean)
  }
  if (value == null) {
    return []
  }
  return `${value}`.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
}

/** 面板多行文本解析为 headers 键值对；与 mcpServers 的 env 同款 KEY=value 规则 */
function parseHeadersFromGuoba(value, rowNumber) {
  if (!value) {
    return {}
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => `${key}`.trim()))
  }

  const headers = {}
  for (const line of splitLines(value)) {
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) {
      throw new Error(`注入条目第 ${rowNumber} 行：headers 必须是 KEY=value 格式（每行一个，value 可包含 =）`)
    }
    const key = line.slice(0, separatorIndex).trim()
    if (!key) {
      throw new Error(`注入条目第 ${rowNumber} 行：headers 的键不能为空`)
    }
    headers[key] = line.slice(separatorIndex + 1)
  }

  return headers
}

/** 正数校验：空值返回 undefined（不写键，走运行期默认）；0 与负数无业务语义，报错 */
function normalizePositiveNumber(value, field, rowNumber) {
  if (value == null || `${value}`.trim() === '') {
    return undefined
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`注入条目第 ${rowNumber} 行：${field} 必须是正数`)
  }
  return n
}

function isEmptyHookRow(row) {
  if (!row || typeof row !== 'object') {
    return true
  }
  // 只看目标字段：全新默认行（未填任何内容）静默丢弃，与 mcpServers 面板行为一致
  return ['url', 'server', 'headers'].every(key => !`${row[key] ?? ''}`.trim())
}

/**
 * 把锅巴 GSubForm 行数组序列化回存储 JSON（setConfigData 用）
 *
 * @param {Array|string} rows 面板行数组；字符串视为用户直接粘贴的 JSON，校验后按包装形态保存
 * @returns {string} { "hookServers": [...] } 形态的 JSON 字符串
 */
export function stringifyHookServersFromGuoba(rows) {
  if (typeof rows === 'string') {
    return JSON.stringify({ hookServers: parseHookServersConfig(rows, true) }, null, 2)
  }
  if (rows == null) {
    rows = []
  }
  if (!Array.isArray(rows)) {
    throw new Error('hookServers must be a table array')
  }

  const entries = []
  rows.forEach((row, index) => {
    const rowNumber = index + 1
    if (isEmptyHookRow(row)) {
      return
    }

    const url = `${row.url || ''}`.trim()
    const server = `${row.server || ''}`.trim()
    if (!url && !server) {
      throw new Error(`注入条目第 ${rowNumber} 行：url 与 server 至少填一项`)
    }

    const entry = { enabled: row.enabled !== false && row.enabled !== 'false' }
    if (url) {
      entry.url = url
    }
    if (server) {
      entry.server = server
    }

    const headers = parseHeadersFromGuoba(row.headers, rowNumber)
    if (Object.keys(headers).length) {
      entry.headers = headers
    }

    const timeout = normalizePositiveNumber(row.timeout, 'timeout', rowNumber)
    if (timeout !== undefined) {
      entry.timeout = timeout
    }
    const maxChars = normalizePositiveNumber(row.maxChars, 'maxChars', rowNumber)
    if (maxChars !== undefined) {
      entry.maxChars = maxChars
    }

    const when = `${row.when || ''}`.trim() || 'turn'
    if (!HOOK_WHEN_VALUES.has(when)) {
      throw new Error(`注入条目第 ${rowNumber} 行：when 只能是 turn 或 session`)
    }
    entry.when = when

    entries.push(entry)
  })

  return JSON.stringify({ hookServers: entries }, null, 2)
}
