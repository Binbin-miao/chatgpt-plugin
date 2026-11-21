/**
 * 群记录快照的重建判定——纯函数，不 import 任何 Yunzai 运行时，单测可直接加载。
 *
 * 快照内容一旦冻结就逐字节不变，system 段才吃得下 prompt 缓存。所以重建不能太勤；
 * 但太懒又会让「群里刚聊完的话题模型完全没看见」。B2 定的口径是**双阈值，任一满足即重建**：
 *
 * - 条数：攒够 `REBUILD_NEW_MESSAGES = 5` 条新消息就换（**不再按窗口折算**，窗口 20/50/60 一律 5）
 * - 时间：距上次重建超过 `REBUILD_MAX_AGE_MS = 180 秒` 也换（兜住「群很冷、攒不到 5 条」）
 *
 * 滞后上界因此是**双上界**：≤4 条新消息（判据是「≥」，差一错误在这里最容易犯）、
 * ≤180 秒 + 一次拉取耗时。180 秒这个代价是可接受的：**用户自己刚发的那条消息永远不受
 * 快照滞后影响**——它走本轮 prompt，不走群记录；滞后只影响「群里其他人刚说的话」。
 *
 * 历史教训（别再按窗口折算）：旧实现用 `max(3, ceil(窗口/1.5))`，20 条窗口 → 阈值 14（滞后 13），
 * 50 条窗口 → 阈值 34（**滞后 33**）。线上 `groupContextLength` 是 50，于是「别人刚说的话
 * 33 条之内都进不了快照」——这才是「它完全没看见我们刚才聊的」的真实来源。
 */

/** 拉取频率保护：同一群 30 秒内不再拉历史。到 180 秒重建线时会被绕过（见 model/core.js） */
export const GROUP_SNAPSHOT_MIN_INTERVAL = 30 * 1000

/** 条数阈值：固定 5 条新消息，与窗口大小无关 */
export const REBUILD_NEW_MESSAGES = 5

/** 时间阈值：距上次**重建**（不是上次拉取）超过 180 秒就换 */
export const REBUILD_MAX_AGE_MS = 180 * 1000

/**
 * 重建阈值。
 *
 * 保留函数形态是为了让调用点读起来仍是「阈值」这个概念；**不再接受窗口条数**——
 * 一旦按窗口折算，大窗口的滞后上界就会失控（50 条窗口 → 33 条），这正是 B2 要消灭的分叉。
 *
 * @returns {number}
 */
export function rebuildThreshold() {
  return REBUILD_NEW_MESSAGES
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
 * 没有缓存时必建；拉取失败（`chats` 为 null）或返回空一律复用旧快照——缓存既不清空也不缩短，
 * 否则 system 被截短会跌破上游门槛，比多带一轮旧记录亏得多。
 *
 * @param {{text: string, newestMessageId: string, fetchedAt: number, rebuiltAt?: number}} [cached] 现有快照
 * @param {Array<{message_id?: string|number}>|null} [chats] 本轮拉到的记录，null 表示本轮没拉或拉取失败
 * @param {number} [now] 当前时刻（测试注入用）
 * @returns {boolean}
 */
export function shouldRebuildSnapshot(cached, chats, now = Date.now()) {
  if (!cached) return true
  // 没拉（频率保护）或拉失败/拉空：本轮没有可换的新内容，一律沿用
  if (!Array.isArray(chats) || chats.length === 0) return false
  if (countNewerMessages(chats, cached.newestMessageId) >= REBUILD_NEW_MESSAGES) return true
  // 时间线必须锚在「上次重建」而不是「上次拉取」：拉取每 30 秒就会刷新 fetchedAt，
  // 用它算年龄会让 180 秒这条永远触发不了。
  return now - Number(cached.rebuiltAt || 0) >= REBUILD_MAX_AGE_MS
}
