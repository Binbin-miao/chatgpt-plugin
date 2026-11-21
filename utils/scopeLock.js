/**
 * 会话 scope 级「在途」互斥锁。
 *
 * 为什么需要：一轮对话是「读历史 → 请求模型 → 写历史」，三步跨了好几秒到几十秒。
 * 同 scope 的两个请求（用户的正常回复 + 它触发的自主回复，或者两条几乎同时到的消息）
 * 会各自读到同一份旧历史、各自写回，**后写把前写的那一轮整段覆盖掉**，用户看到的就是
 * 「我刚说过的话它忘了」。
 *
 * 粒度必须是 **scope**（会话键里的那一段），不是全局：不同用户/不同群之间没有任何共享状态，
 * 全局锁会把整台机器串成一条队。
 *
 * 只做互斥，不做排队：调用方自己决定等多久（见 apps/chat.js 里的两条策略）。
 */

/** 锁键前缀：与会话键、冷却键分属不同命名空间，互不影响 */
export const SCOPE_LOCK_PREFIX = 'CHATGPT:SCOPE_LOCK'

/**
 * 锁的 TTL：必须长于一次请求的最长耗时（客户端超时 600 秒），否则长请求跑到一半锁就过期了，
 * 并把互斥让给下一个请求。进程崩溃时最坏情况是这段时间内该 scope 无人应答，由调用方的
 * 「跳过本轮」策略兜住——绝不能为了快速恢复而把 TTL 压到请求耗时以内。
 */
export const SCOPE_LOCK_TTL_SECONDS = 600

/**
 * scope → 锁键。空 scope 返回空串（没有会话就没有竞争，调用方据此跳过加锁）。
 *
 * @param {string} scope
 * @returns {string}
 */
export function scopeLockKey(scope) {
  const normalized = String(scope ?? '').trim()
  if (!normalized) return ''
  return `${SCOPE_LOCK_PREFIX}:${normalized}`
}

/**
 * 抢锁。用 `SET NX EX` 一条命令完成「不存在才写 + 过期释放」，天然不会出现
 * 「先 GET 再 SET」那种两个请求同时判空的竞态。
 *
 * @param {string} scope
 * @param {{waitMs?: number, pollMs?: number}} [options] waitMs 为 0 表示只试一次
 * @returns {Promise<boolean>} 是否拿到
 */
export async function acquireScopeLock(scope, { waitMs = 0, pollMs = 25 } = {}) {
  const key = scopeLockKey(scope)
  if (!key) return false
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0)
  for (;;) {
    const acquired = await redis.set(key, String(Date.now()), { NX: true, EX: SCOPE_LOCK_TTL_SECONDS })
    if (acquired) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}

/**
 * 释放锁。必须在 `finally` 里调：异常路径漏掉就会把该 scope 卡到 TTL 到期。
 *
 * @param {string} scope
 * @returns {Promise<void>}
 */
export async function releaseScopeLock(scope) {
  const key = scopeLockKey(scope)
  if (!key) return
  await redis.del(key)
}
