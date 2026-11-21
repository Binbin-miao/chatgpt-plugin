/**
 * 迁移「退路」必须返回**完整会话值 + schema 哨兵**。
 *
 * 调用方（apps/chat.js）拿到退路返回值会当历史用、追加本轮问答后原样写回
 * `CHATGPT:CONVERSATION_V3:<scope>`。退路缺 schema 时，下一轮的复查
 * `Number(recheck.schema) >= SCHEMA_VERSION` 判否 → 又当「没迁过」重扫旧桶合并，
 * 本轮刚说的那句话被覆盖——用户会看到自己刚发的内容凭空消失。
 *
 * 这里钉住两条退路：抢不到迁移锁（locked）、合并过程中抛错（fallback）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
const { ensureMigratedScope, loadConversation, MIGRATION_LOCK_PREFIX, SCHEMA_VERSION } =
  await import('../utils/conversationMigration.js')
const { conversationKeyOf } = await import('../utils/conversationKey.js')

/** 最小 redis 桩：只实现迁移用到的命令 */
class FakeRedis {
  constructor() {
    this.store = new Map()
    this.ttl = new Map()
    this.locks = new Set()
  }

  async get(key) { return this.store.has(key) ? this.store.get(key) : null }

  async set(key, value, options = {}) {
    if (options?.NX) {
      if (this.locks.has(key) || this.store.has(key)) return null
      this.locks.add(key)
      this.store.set(key, value)
      if (options.EX) this.ttl.set(key, options.EX)
      return 'OK'
    }
    this.store.set(key, value)
    if (options?.EX) this.ttl.set(key, options.EX)
    return 'OK'
  }

  async del(key) {
    this.locks.delete(key)
    this.ttl.delete(key)
    return this.store.delete(key) ? 1 : 0
  }

  async expire(key, seconds) {
    if (!this.store.has(key)) return 0
    this.ttl.set(key, seconds)
    return 1
  }

  async hSet(key, field, value) {
    const hash = this.store.get(key) && typeof this.store.get(key) === 'object' ? this.store.get(key) : {}
    hash[field] = value
    this.store.set(key, hash)
    return 1
  }

  async * scanIterator({ MATCH } = {}) {
    const pattern = '^' + String(MATCH || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    const re = new RegExp(pattern)
    for (const key of [...this.store.keys()]) if (re.test(key)) yield key
  }
}

const legacyKey = (scope, providerId = 'p1', version = 'v1') =>
  `CHATGPT:CONVERSATIONS_V2:${providerId}:${version}:${scope}`

const legacyValue = ({ ctime, messages }) =>
  JSON.stringify({
    sender: { user_id: '123', nickname: '老用户' },
    ctime,
    utime: ctime,
    num: 1,
    messages,
    replyTimestamps: []
  })

/** 两个 ctime 不同的旧桶：内容必须不同，否则跨桶去重会把它们合成一对 */
function seedTwoBuckets(redis, scope) {
  redis.store.set(legacyKey(scope, 'p1', 'v1'), legacyValue({
    ctime: '2026-01-01T00:00:00.000Z',
    messages: [{ role: 'user', content: '早先问' }, { role: 'assistant', content: '早先答' }]
  }))
  redis.store.set(legacyKey(scope, 'p2', 'v2'), legacyValue({
    ctime: '2026-02-01T00:00:00.000Z',
    messages: [{ role: 'user', content: '后来问' }, { role: 'assistant', content: '后来答' }]
  }))
}

const ALL_CONTENTS = ['早先问', '早先答', '后来问', '后来答']

/** 断言 messages 是「两个桶合并后的全部 4 条」，顺序按 ctime 升序 */
function assertMerged(value) {
  assert.deepEqual(value.messages.map(m => m.content), ALL_CONTENTS)
}

/** 模拟调用方：把退路值当历史，追加本轮发言后写回新键 */
async function appendAndWriteBack(redis, scope, value, content) {
  const messages = [...value.messages, { role: 'user', content }]
  await redis.set(conversationKeyOf(scope), JSON.stringify({ ...value, messages }))
}

test('抢不到迁移锁：退路仍返回带 schema 的完整合并值，写回后下一轮不会覆盖本轮发言', async () => {
  const redis = new FakeRedis()
  const scope = 'u_locked'
  seedTwoBuckets(redis, scope)
  const lockKey = `${MIGRATION_LOCK_PREFIX}:${scope}`
  redis.locks.add(lockKey)

  const first = await loadConversation({ scope, client: redis, config: {} })
  assert.equal(first.status, 'locked')
  assert.equal(first.value.schema, SCHEMA_VERSION)
  assertMerged(first.value)
  assert.equal(first.value.messages.length, 4)

  await appendAndWriteBack(redis, scope, first.value, '本轮刚说的话')
  redis.locks.delete(lockKey)

  const second = await loadConversation({ scope, client: redis, config: {} })
  assert.equal(second.status, 'already')
  assert.ok(
    second.value.messages.some(m => m.content === '本轮刚说的话'),
    '本轮发言被重合并覆盖了：退路返回值缺 schema'
  )
})

test('合并抛错：退路仍返回带 schema 的完整合并值，写回后下一轮不会覆盖本轮发言', async () => {
  class ThrowingRedis extends FakeRedis {
    async expire() { throw new Error('expire 炸了') }
  }
  const redis = new ThrowingRedis()
  const scope = 'u_fallback'
  seedTwoBuckets(redis, scope)

  const first = await loadConversation({ scope, client: redis, config: {} })
  assert.equal(first.status, 'fallback')
  assert.equal(first.value.schema, SCHEMA_VERSION)
  assert.ok(first.value.messages.length > 0)
  assertMerged(first.value)

  await appendAndWriteBack(redis, scope, first.value, '本轮刚说的话')

  const second = await loadConversation({ scope, client: redis, config: {} })
  assert.equal(second.status, 'already')
  assert.ok(
    second.value.messages.some(m => m.content === '本轮刚说的话'),
    '本轮发言被重合并覆盖了：退路返回值缺 schema'
  )
})
