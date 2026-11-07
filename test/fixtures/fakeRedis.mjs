/**
 * 测试用的极简 Redis 替身：只实现绘图模块用到的那几个命令，
 * 语义对齐 node-redis v4（ttl 返回 -2 缺键 / -1 无过期，multi 链式返回结果数组）。
 */
export function createFakeRedis ({ now = () => Date.now() } = {}) {
  const store = new Map()

  const alive = (key) => {
    const entry = store.get(key)
    if (!entry) return null
    if (entry.expireAt !== null && entry.expireAt <= now()) {
      store.delete(key)
      return null
    }
    return entry
  }

  const api = {
    async get (key) {
      const entry = alive(key)
      return entry ? entry.value : null
    },
    async set (key, value, options = {}) {
      // 对齐 node-redis：NX 抢不到返回 null
      if (options.NX && alive(key)) return null
      const expireAt = options.EX ? now() + Number(options.EX) * 1000 : null
      store.set(key, { value: String(value), expireAt })
      return 'OK'
    },
    async del (key) {
      return store.delete(key) ? 1 : 0
    },
    async incr (key) {
      const entry = alive(key)
      const next = (entry ? Number(entry.value) : 0) + 1
      store.set(key, { value: String(next), expireAt: entry ? entry.expireAt : null })
      return next
    },
    async decr (key) {
      const entry = alive(key)
      const next = (entry ? Number(entry.value) : 0) - 1
      store.set(key, { value: String(next), expireAt: entry ? entry.expireAt : null })
      return next
    },
    async ttl (key) {
      const entry = alive(key)
      if (!entry) return -2
      if (entry.expireAt === null) return -1
      return Math.max(0, Math.ceil((entry.expireAt - now()) / 1000))
    },
    async expire (key, seconds) {
      const entry = alive(key)
      if (!entry) return 0
      entry.expireAt = now() + Number(seconds) * 1000
      return 1
    },
    async expireAt (key, seconds) {
      const entry = alive(key)
      if (!entry) return 0
      entry.expireAt = Number(seconds) * 1000
      return 1
    },
    multi () {
      const queue = []
      const chain = {
        incr: (key) => { queue.push(() => api.incr(key)); return chain },
        decr: (key) => { queue.push(() => api.decr(key)); return chain },
        expire: (key, seconds) => { queue.push(() => api.expire(key, seconds)); return chain },
        expireAt: (key, seconds) => { queue.push(() => api.expireAt(key, seconds)); return chain },
        async exec () {
          const results = []
          for (const run of queue) results.push(await run())
          return results
        }
      }
      return chain
    },
    /** 测试辅助：直接读原始计数 */
    peek (key) {
      const entry = alive(key)
      return entry ? entry.value : null
    },
    /** 测试辅助：直接改计数，模拟「历史已用 N 张」 */
    seed (key, value, { exSeconds } = {}) {
      store.set(key, { value: String(value), expireAt: exSeconds ? now() + exSeconds * 1000 : null })
    }
  }
  return api
}
