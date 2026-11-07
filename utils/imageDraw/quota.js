import { logError, logWarn } from './log.js'

/**
 * 绘图配额、个人冷却与全员熔断。
 *
 * - 每日张数：按北京时间自然日计数，主人直接跳过（不计数、不冷却）
 * - 个人冷却：出图成功后 n 分钟内不能再画
 * - 全员熔断：接口连续失败达到阈值时，所有人停画 n 小时，主人可用指令解除
 *
 * 计数一律用 Redis 原子自增：预扣成功才去生成，生成失败再退回。
 * 「先查再写」在并发下会超发，这里不采用。
 */

/** 北京时间偏移（中国无夏令时）。不引 utils/memory/dailyTask.js：那边会把 MemoryStore 拉进启动路径 */
const BJT_OFFSET = 8 * 3600 * 1000

/** 时间戳（秒）→ 北京时间 YYYY-MM-DD */
export function dayKeyOf (tsSeconds) {
  const d = new Date(Number(tsSeconds) * 1000 + BJT_OFFSET)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 北京时间某天 00:00 的时间戳（秒） */
export function dayStartTs (day) {
  const [y, m, d] = day.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / 1000) - BJT_OFFSET / 1000
}

const PREFIX = 'CHATGPT:DRAW'
const FAIL_STREAK_TTL = 6 * 3600

export const dailyKey = (day, userId) => `${PREFIX}:DAILY:${day}:${userId}`
export const cooldownKey = (userId) => `${PREFIX}:CD:${userId}`
export const CIRCUIT_KEY = `${PREFIX}:CIRCUIT`
export const FAIL_STREAK_KEY = `${PREFIX}:FAILSTREAK`
export const INFLIGHT_KEY = (userId) => `${PREFIX}:INFLIGHT:${userId}`

function client (override) {
  return override || globalThis.redis
}

/** 距下一个北京时间 0 点还有多少秒（至少 1 秒，避免 EXPIREAT 落到过去） */
export function secondsUntilNextDay (now = Date.now()) {
  const currentDay = dayKeyOf(Math.floor(now / 1000))
  const nextMidnight = dayStartTs(currentDay) + 86400
  return Math.max(1, nextMidnight - Math.floor(now / 1000))
}

/** 计数键的过期时间：次日 0 点再宽限两天，防时钟漂移留下永久键 */
function dailyExpireAt (now = Date.now()) {
  return dayStartTs(dayKeyOf(Math.floor(now / 1000))) + 86400 + 2 * 86400
}

/** 查询今日已用张数（主人恒为 0） */
export async function getQuotaUsage ({ userId, isMaster = false, now = Date.now() } = {}, store) {
  if (isMaster) return { used: 0, unlimited: true }
  const redis = client(store)
  if (!redis) return { used: 0, unlimited: true }
  const raw = await redis.get(dailyKey(dayKeyOf(Math.floor(now / 1000)), userId))
  return { used: Number(raw || 0) || 0, unlimited: false }
}

/**
 * 预扣一张。
 *
 * @returns {Promise<{ok: boolean, used: number, reason?: string}>}
 */
export async function reserveQuota ({ userId, limit = 0, isMaster = false, now = Date.now() } = {}, store) {
  if (isMaster) return { ok: true, used: 0, unlimited: true }
  if (!limit || limit <= 0) return { ok: true, used: 0, unlimited: true }
  const redis = client(store)
  if (!redis) return { ok: true, used: 0, unlimited: true }

  const key = dailyKey(dayKeyOf(Math.floor(now / 1000)), userId)
  try {
    const [used] = await redis.multi().incr(key).expireAt(key, dailyExpireAt(now)).exec()
    const count = Number(used) || 0
    if (count > limit) {
      await redis.decr(key).catch(() => {})
      return { ok: false, used: count - 1, reason: 'quota' }
    }
    return { ok: true, used: count }
  } catch (err) {
    logError(`额度计数失败，本次放行：${err?.message || err}`)
    return { ok: true, used: 0 }
  }
}

/** 生成失败时退回预扣的那一张 */
export async function refundQuota ({ userId, isMaster = false, now = Date.now() } = {}, store) {
  if (isMaster) return
  const redis = client(store)
  if (!redis) return
  const key = dailyKey(dayKeyOf(Math.floor(now / 1000)), userId)
  try {
    const left = await redis.decr(key)
    if (Number(left) < 0) await redis.set(key, '0', { EX: Math.max(60, secondsUntilNextDay(now)) })
  } catch (err) {
    logWarn(`退回额度失败：${err?.message || err}`)
  }
}

/**
 * 同一个人在途锁：出图要 40-100 秒，这段时间里连发指令或模型反复调工具，
 * 每次都是真实计费请求。冷却要成功后才写，拦不住并发，所以这里用 NX 抢占。
 *
 * 抢不到返回 false；Redis 异常时放行（宁可多画一张，也不要因为缓存挂了把功能锁死）。
 */
export async function acquireInflight ({ userId, seconds = 300 } = {}, store) {
  const redis = client(store)
  if (!redis) return true
  try {
    const result = await redis.set(INFLIGHT_KEY(userId), '1', { NX: true, EX: Math.max(60, seconds) })
    return result === 'OK'
  } catch (err) {
    logWarn(`写在途锁失败，本次放行：${err?.message || err}`)
    return true
  }
}

export async function releaseInflight ({ userId } = {}, store) {
  const redis = client(store)
  if (!redis) return
  await redis.del(INFLIGHT_KEY(userId)).catch(() => {})
}

/** 个人冷却剩余秒数；0 表示可以画 */export async function getCooldown ({ userId, isMaster = false } = {}, store) {
  if (isMaster) return 0
  const redis = client(store)
  if (!redis) return 0
  try {
    const ttl = await redis.ttl(cooldownKey(userId))
    return Number(ttl) > 0 ? Number(ttl) : 0
  } catch {
    return 0
  }
}

export async function markCooldown ({ userId, minutes = 0, isMaster = false } = {}, store) {
  if (isMaster || !minutes || minutes <= 0) return
  const redis = client(store)
  if (!redis) return
  try {
    await redis.set(cooldownKey(userId), '1', { EX: Math.round(minutes * 60) })
  } catch (err) {
    logWarn(`写入冷却失败：${err?.message || err}`)
  }
}

/** 全员熔断是否生效；open 为真时 retryAfter 是剩余秒数 */
export async function getCircuit (store) {
  const redis = client(store)
  if (!redis) return { open: false, retryAfter: 0 }
  try {
    const ttl = await redis.ttl(CIRCUIT_KEY)
    return Number(ttl) > 0 ? { open: true, retryAfter: Number(ttl) } : { open: false, retryAfter: 0 }
  } catch {
    return { open: false, retryAfter: 0 }
  }
}

export async function tripCircuit ({ hours = 5 } = {}, store) {
  const redis = client(store)
  const seconds = Math.max(60, Math.round(hours * 3600))
  if (!redis) return seconds
  try {
    await redis.set(CIRCUIT_KEY, String(Date.now()), { EX: seconds })
    logWarn(`接口连续失败，全员停止绘图 ${hours} 小时`)
  } catch (err) {
    logError(`写入熔断失败：${err?.message || err}`)
  }
  return seconds
}

/** 记一次接口失败；达到阈值立刻熔断并清零连击，返回是否触发了熔断 */
export async function recordFailure ({ threshold = 5, hours = 5 } = {}, store) {
  const redis = client(store)
  if (!redis) return { streak: 0, tripped: false }
  try {
    const [raw] = await redis.multi().incr(FAIL_STREAK_KEY).expire(FAIL_STREAK_KEY, FAIL_STREAK_TTL).exec()
    const streak = Number(raw) || 0
    if (threshold > 0 && streak >= threshold) {
      await redis.del(FAIL_STREAK_KEY).catch(() => {})
      await tripCircuit({ hours }, redis)
      return { streak, tripped: true }
    }
    return { streak, tripped: false }
  } catch (err) {
    logWarn(`记录失败次数出错：${err?.message || err}`)
    return { streak: 0, tripped: false }
  }
}

/** 成功一次即清零连击，避免偶发失败累积成熔断 */
export async function recordSuccess (store) {
  const redis = client(store)
  if (!redis) return
  await redis.del(FAIL_STREAK_KEY).catch(() => {})
}

/** 主人解禁：清掉熔断与连击 */
export async function clearCircuit (store) {
  const redis = client(store)
  if (!redis) return
  await redis.del(CIRCUIT_KEY).catch(() => {})
  await redis.del(FAIL_STREAK_KEY).catch(() => {})
}
