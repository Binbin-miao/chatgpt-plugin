/**
 * 历史窗口锚点（批量截断）
 *
 * 以尾部为基准的「保留最近 N 条」是最常见的写法，但它每来一轮就整体前滑一格：
 * 请求前缀从第 2 条消息起就错位，提示词缓存整段失效（实测命中率会从 85%~90%
 * 掉到个位数，且每次都按全价重算历史）。
 *
 * 这里改成「头固定、尾部增长」：锚点不动时只在尾部追加新消息，前缀逐轮变长；
 * 涨过上限后一次性把锚点前移一大段（默认只保留 70%），之后又能稳定很多轮。
 * 代价是每次切割产生一次缓存未命中，而不是每轮一次。
 *
 * 锚点只存在进程内：重启后第一次请求会重新切一次（多一次未命中），换来的是
 * 不动存储结构。会话结束/重建时锚点会自然失配（链上找不到该 id），按切割处理。
 */

/** 单个会话保留的历史条数上限；超过就一次切到 CUT_RATIO */
export const MAX_HISTORY_MESSAGES = 600

/** 切割后保留的比例：切得越狠，下次切割间隔越久 */
export const CUT_RATIO = 0.7

/**
 * 把「本次要保留的条数」对齐成偶数。
 *
 * Gemini 的 contents 必须 user/model 交替，奇数条会从错误的角色开始；两条消息
 * 一组也正好是「一问一答」。只在切割时对齐——未切割的轮次必须保持字节不动，
 * 否则等于每轮又改一次前缀。
 *
 * @param {number} value
 * @returns {number}
 */
export function evenFloor(value) {
  const n = Math.floor(Number(value) || 0)
  return n - (n % 2)
}

/**
 * 切割后应该保留多少条（偶数、至少 2 条）。
 *
 * @param {number} maxKeep 窗口上限
 * @param {number} [ratio]
 * @returns {number}
 */
export function cutKeepCount(maxKeep, ratio = CUT_RATIO) {
  return Math.max(2, evenFloor(Math.floor(Number(maxKeep) * ratio)))
}

/** 内存里最多记多少个会话的锚点，超出按插入顺序淘汰最旧的 */
const MAX_TRACKED_CONVERSATIONS = 500

/** @type {Map<string, string>} conversationKey -> 锚点消息 id */
const anchors = new Map()

/**
 * @param {string} [key]
 * @returns {string|undefined}
 */
export function getHistoryAnchor(key) {
  return key ? anchors.get(key) : undefined
}

/**
 * @param {string} [key]
 * @param {string} [messageId]
 */
export function setHistoryAnchor(key, messageId) {
  if (!key || !messageId) return
  if (!anchors.has(key) && anchors.size >= MAX_TRACKED_CONVERSATIONS) {
    const oldest = anchors.keys().next().value
    if (oldest !== undefined) anchors.delete(oldest)
  }
  anchors.set(key, messageId)
}

/**
 * 会话结束时清掉锚点；不清也不会错，只是下次要多算一次切割。
 * @param {string} [key]
 */
export function resetHistoryWindow(key) {
  if (key) anchors.delete(key)
}

/** 仅供测试：清空全部锚点 */
export function clearHistoryWindows() {
  anchors.clear()
}

/**
 * 计算本次请求要保留的历史起点。
 *
 * @param {Array<{id?: string}>} messages 完整历史，时间正序（不含本轮提问）
 * @param {string} [key] 会话键（通常是 conversationId）
 * @param {{maxKeep?: number, ratio?: number}} [opt]
 * @returns {{start: number, cut: boolean, anchorId: string|null}}
 *   start 为保留起点下标；cut 为 true 表示本次发生了批量截断
 */
export function planHistoryWindow(messages, key, opt = {}) {
  const list = Array.isArray(messages) ? messages : []
  const total = list.length
  const maxKeep = opt.maxKeep ?? MAX_HISTORY_MESSAGES
  const ratio = opt.ratio ?? CUT_RATIO
  if (total === 0) return { start: 0, cut: false, anchorId: null }

  const anchorId = getHistoryAnchor(key)
  let start = 0
  if (anchorId) {
    const idx = list.findIndex(message => message && message.id === anchorId)
    if (idx >= 0) start = idx
    else resetHistoryWindow(key) // 锚点已不在链上（会话重建/结束对话）
  }

  // 锚点内的窗口还在上限之内：头不动，尾部照常增长
  if (total - start <= maxKeep) return { start, cut: false, anchorId: anchorId ?? null }

  // 切割：一次切到 70%，并保证保留条数是偶数
  let next = total - cutKeepCount(maxKeep, ratio)
  if (next <= start) next = start + 1
  if (next >= total) next = total - 1
  const newAnchor = list[next]?.id ?? null
  setHistoryAnchor(key, newAnchor)
  return { start: next, cut: true, anchorId: newAnchor }
}
