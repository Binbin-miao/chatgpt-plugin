/**
 * 群记录快照的重建判定——纯函数，不 import 任何 Yunzai 运行时，单测可直接加载。
 *
 * 快照内容一旦冻结就逐字节不变，system 段才吃得下 prompt 缓存。重建只看「攒够多少条
 * 新消息」，不看时间：往 system 末尾追加内容会把缓存断点前移到末尾，命中率从 98%
 * 掉到 62%（2026-11-08 定论）。时间只用来做拉取频率保护。
 */

/** 拉取频率保护：同一群 30 秒内不再拉历史，直接复用快照（不触发重建） */
export const GROUP_SNAPSHOT_MIN_INTERVAL = 30 * 1000

/** 重建下限：冷清群也至少攒够 3 条新消息再换 system，避免每轮都重建 */
const REBUILD_MIN_NEW = 3

/**
 * 重建窗口：新消息吃掉窗口 2/3 才重建（拉满 60 条 → 40）。
 *
 * 2026-11-09 实测：阈值 20（吃 1/3）时活跃群约 10 分钟就翻新一次 system，
 * 而 system 已有约 20k，翻新一次就把长会话里本该命中的历史前缀整段打断——
 * 50k+ 请求每次多付 54% 未命中 token（25,798 → 39,778）。放宽到 2/3 让
 * 翻新频率减半，代价是群记录最多滞后 40 条新消息。
 */
const REBUILD_WINDOW_DIVISOR = 1.5

/**
 * 按实际拉到的条数折算重建阈值。
 *
 * @param {number} [count] 本轮实际拉到的群记录条数
 * @returns {number}
 */
export function rebuildThreshold(count) {
  return Math.max(REBUILD_MIN_NEW, Math.ceil((count || 0) / REBUILD_WINDOW_DIVISOR))
}

/**
 * 数出比 lastId 更新的条数。
 *
 * lastId 找不到时视为全部为新增：旧 id 已滑出窗口，无从判断谁更新，只能整段重建。
 *
 * @param {Array<{message_id?: string|number}>} [chats] 按时间升序的群记录
 * @param {string} [lastId] 上次快照最末一条的 message_id
 * @returns {number}
 */
export function countNewerMessages(chats, lastId) {
  if (!Array.isArray(chats) || chats.length === 0) return 0
  if (!lastId) return chats.length
  const index = chats.findIndex(chat => String(chat?.message_id ?? '') === String(lastId))
  return index < 0 ? chats.length : chats.length - index - 1
}

/**
 * 是否该重建快照。
 *
 * 没有缓存时必建；否则只有「比 newestMessageId 更新的条数」攒够阈值才重建。拉取失败
 * （chats 为 null）或返回空一律复用旧快照——缓存既不清空也不缩短，system 才不会被截短。
 *
 * @param {{text: string, newestMessageId: string, fetchedAt: number}} [cached] 现有快照
 * @param {Array<{message_id?: string|number}>|null} [chats] 本轮拉到的记录，null 表示拉取失败
 * @param {number} [pulledCount] 本轮实际拉到的条数，用于折算阈值
 * @returns {boolean}
 */
export function shouldRebuildSnapshot(cached, chats, pulledCount) {
  if (!cached) return true
  // 下限 3（rebuildThreshold 里的 max）是「chats=null 双语义」的护栏：
  // 0 永远达不到阈值，所以「没到时间没拉」和「拉了但失败」都能安全落到复用。
  // 把它改成 0，会立刻把「没到时间」变成「每轮重建」。
  return countNewerMessages(chats, cached.newestMessageId) >= rebuildThreshold(pulledCount)
}
