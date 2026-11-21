/**
 * B1 旧会话桶 → 新键的懒迁移。
 *
 * 这是本次唯一可能弄丢用户数据的地方，所以每条约束都单独钉一个用例：
 * `ctime` 排序、跨桶去重（桶内保留）、幂等、锁被占时的退路、坏数据跳过、备份与 TTL、空历史不建键。
 * 另外用一条源码级用例锁住「读路径必须走 loadConversation」——改回直接 `redis.get` 就会红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

const {
  LEGACY_TTL_SECONDS, MIGRATION_LOCK_PREFIX, MIGRATION_REPORT_KEY, SCHEMA_VERSION,
  ensureMigratedScope, loadConversation, mergeLegacyBuckets, parseLegacyKey, stripMemoryBlock
} = await import('../utils/conversationMigration.js')
const { CONVERSATION_KEY_PREFIX, conversationKeyOf } = await import('../utils/conversationKey.js')

/** 最小的 Redis 替身：只实现迁移真正用到的那几个命令 */
class FakeRedis {
  constructor(entries = []) {
    this.store = new Map(entries)
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

const legacyValue = ({ ctime, messages, replyTimestamps = [], sender = { user_id: '123', nickname: '老用户' } }) =>
  JSON.stringify({ sender, ctime, utime: ctime, num: messages.filter(m => m.role === 'assistant').length, messages, replyTimestamps })

const qa = (question, answer) => [{ role: 'user', content: question }, { role: 'assistant', content: answer }]

test('三个旧桶按 ctime 升序拼接（不是按 utime、也不是按插入顺序）', async () => {
  const scope = '3952769985'
  const redis = new FakeRedis([
    // 故意打乱插入顺序，并让 utime 与 ctime 反向：按 utime 排会得到相反结果
    [legacyKey(scope, 'pB', 'vb'), legacyValue({ ctime: '2026-10-02T00:00:00.000Z', messages: qa('中间的问题', '中间的回复'), replyTimestamps: [400] })],
    [legacyKey(scope, 'pA', 'va'), legacyValue({ ctime: '2026-10-01T00:00:00.000Z', messages: qa('最早的问题', '最早的回复'), replyTimestamps: [900] })],
    [legacyKey(scope, 'pC', 'vc'), legacyValue({ ctime: '2026-10-03T00:00:00.000Z', messages: qa('最新的问题', '最新的回复'), replyTimestamps: [100] })]
  ])
  const { status, value } = await ensureMigratedScope({ scope, client: redis, config: {} })
  assert.equal(status, 'migrated')
  assert.deepEqual(value.messages.map(m => m.content),
    ['最早的问题', '最早的回复', '中间的问题', '中间的回复', '最新的问题', '最新的回复'])
  assert.equal(value.schema, SCHEMA_VERSION)
  assert.equal(value.scope, scope)
  // utime 取 replyTimestamps 的最大值（真实最后活跃），不是 ctime
  assert.equal(value.utime, new Date(900).toISOString())
  assert.deepEqual(value.replyTimestamps, [100, 400, 900])
})

test('跨桶重复的问答对只保留一份，同一桶内的重复提问必须保留', async () => {
  const scope = '200'
  const repeated = qa('同一句话', '同一个回答')
  const redis = new FakeRedis([
    // 桶 A：用户真的问了两次一样的话；末尾还有一次被打断的连问（连续两条相同的 user）
    [legacyKey(scope, 'pA', 'va'), legacyValue({
      ctime: '2026-10-01T00:00:00.000Z',
      messages: [...repeated, ...repeated, { role: 'user', content: '连问两句' }, { role: 'user', content: '连问两句' }, { role: 'assistant', content: '一个回答' }]
    })],
    // 桶 B：分叉后同一轮被写进另一个桶，属假重复
    [legacyKey(scope, 'pB', 'vb'), legacyValue({ ctime: '2026-10-02T00:00:00.000Z', messages: [...repeated] })]
  ])
  const { value } = await ensureMigratedScope({ scope, client: redis, config: {} })
  assert.deepEqual(value.messages.map(m => m.content), [
    '同一句话', '同一个回答',   // 桶内第一遍
    '同一句话', '同一个回答',   // 桶内第二遍：用户真的重复问了，必须留
    '连问两句', '连问两句',     // 桶内相邻重复：同样不许去重
    '一个回答'
  ], '桶内一律保留，只丢跨桶那条')
  assert.equal(value.num, 3)
})

test('问答对级去重不会只丢一半（避免 user,user,assistant 这种残形）', async () => {
  const scope = '201'
  const duplicated = qa('一样的问题', '一样的回答')
  const redis = new FakeRedis([
    [legacyKey(scope, 'pA', 'va'), legacyValue({ ctime: '2026-10-01T00:00:00.000Z', messages: duplicated })],
    [legacyKey(scope, 'pB', 'vb'), legacyValue({ ctime: '2026-10-02T00:00:00.000Z', messages: [...duplicated, ...qa('新问题', '新回答')] })]
  ])
  const { value } = await ensureMigratedScope({ scope, client: redis, config: {} })
  assert.deepEqual(value.messages.map(m => m.content), ['一样的问题', '一样的回答', '新问题', '新回答'])
  // 角色必须成对交替，不能出现两个 user 相连或 assistant 起头
  assert.deepEqual(value.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant'])
})

test('连跑两次不翻倍：schema:3 哨兵让第二次直接命中已迁移的新键', async () => {
  const scope = '300'
  const redis = new FakeRedis([
    [legacyKey(scope, 'pA', 'va'), legacyValue({ ctime: '2026-10-01T00:00:00.000Z', messages: qa('问题一', '回答一') })],
    [legacyKey(scope, 'pB', 'vb'), legacyValue({ ctime: '2026-10-02T00:00:00.000Z', messages: qa('问题二', '回答二') })]
  ])
  const first = await ensureMigratedScope({ scope, client: redis, config: {} })
  assert.equal(first.status, 'migrated')
  const lengthAfterFirst = first.value.messages.length
  assert.equal(lengthAfterFirst, 4)

  const second = await ensureMigratedScope({ scope, client: redis, config: {} })
  assert.equal(second.status, 'already', '第二次必须认出已迁移，不能再合并一遍')
  assert.equal(JSON.parse(await redis.get(conversationKeyOf(scope))).messages.length, lengthAfterFirst, '历史条数不许翻倍')
})

test('抢不到迁移锁时直接读旧桶：不阻塞、不报错、不写新键', async () => {
  const scope = '400'
  const redis = new FakeRedis([
    [legacyKey(scope, 'pA', 'va'), legacyValue({ ctime: '2026-10-01T00:00:00.000Z', messages: qa('冷门问题', '冷门回答'), replyTimestamps: [999] })],
    [legacyKey(scope, 'pB', 'vb'), legacyValue({ ctime: '2026-10-02T00:00:00.000Z', messages: qa('更新的问题', '更新的回答'), replyTimestamps: [1] })]
  ])
  // 另一个进程正持有锁
  await redis.set(`${MIGRATION_LOCK_PREFIX}:${scope}`, '1', { EX: 30, NX: true })

  const result = await ensureMigratedScope({ scope, client: redis, config: {} })
  assert.equal(result.status, 'locked')
  // 退路是「最后活跃最大」的那个桶（replyTimestamps 999 > 1），不是 ctime 最新那个
  assert.deepEqual(result.value.messages.map(m => m.content), ['冷门问题', '冷门回答'])
  assert.equal(redis.store.has(conversationKeyOf(scope)), false, '抢不到锁时不许写新键')
  assert.equal([...redis.store.keys()].some(key => key.startsWith('CHATGPT:CONVERSATIONS_V2_BAK')), false, '也不许写备份')
})

test('旧桶数据损坏（非 JSON）时跳过该桶，其余桶照常合并', async () => {
  const scope = '500'
  const redis = new FakeRedis([
    [legacyKey(scope, 'pGood', 'v1'), legacyValue({ ctime: '2026-10-01T00:00:00.000Z', messages: qa('好的问题', '好的回答') })],
    [legacyKey(scope, 'pBad', 'v2'), '{ 这不是 JSON'],
    [legacyKey(scope, 'pGood2', 'v3'), legacyValue({ ctime: '2026-10-02T00:00:00.000Z', messages: qa('另一个问题', '另一个回答') })]
  ])
  const { status, value } = await ensureMigratedScope({ scope, client: redis, config: {} })
  assert.equal(status, 'migrated', '坏桶不许让整个 scope 迁移失败')
  assert.deepEqual(value.messages.map(m => m.content), ['好的问题', '好的回答', '另一个问题', '另一个回答'])
  assert.equal(value.migration.buckets, 2, '坏桶不计入合并桶数')
})

test('旧键不删：备份键存在且 TTL 为 7 天，旧键本身也只是置 TTL', async () => {
  const scope = '600'
  const oldKey = legacyKey(scope, 'pA', 'va')
  const redis = new FakeRedis([
    [oldKey, legacyValue({ ctime: '2026-10-01T00:00:00.000Z', messages: qa('问题', '回答') })]
  ])
  const parsed = parseLegacyKey(oldKey)
  await ensureMigratedScope({ scope, client: redis, config: {} })

  const backupKey = `CHATGPT:CONVERSATIONS_V2_BAK:${scope}:${parsed.connectionVersion}`
  assert.equal(redis.store.has(backupKey), true, '备份键必须存在，否则迁移算法有 bug 时原件不可考')
  assert.equal(redis.ttl.get(backupKey), LEGACY_TTL_SECONDS)
  assert.equal(redis.store.has(oldKey), true, '旧键不许 DEL（回滚后旧代码要能读到）')
  assert.equal(redis.ttl.get(oldKey), LEGACY_TTL_SECONDS)
  assert.equal(LEGACY_TTL_SECONDS, 604800)
})

test('空历史 / 首次对话：不建新键、不写空数组、不写备份、不算已迁移', async () => {
  const scope = '700'
  const redis = new FakeRedis()
  const result = await ensureMigratedScope({ scope, client: redis, config: {} })
  assert.equal(result.status, 'empty')
  assert.equal(result.value, null)
  assert.deepEqual([...redis.store.keys()], [], '一条键都不该写出来')

  const loaded = await loadConversation({ scope, client: redis, config: {} })
  assert.equal(loaded.isNewConversation, true, '既无新键也无旧桶才是首轮')
  assert.equal(loaded.value, null)
})

test('归并成功即视为续接：isNewConversation 必须是 false', async () => {
  const scope = '800'
  const redis = new FakeRedis([
    [legacyKey(scope, 'pA', 'va'), legacyValue({ ctime: '2026-10-01T00:00:00.000Z', messages: qa('老问题', '老回答') })]
  ])
  const loaded = await loadConversation({ scope, client: redis, config: {} })
  assert.equal(loaded.status, 'migrated')
  assert.equal(loaded.isNewConversation, false, '老用户迁完必须算续接，否则 when:"session" 会误触发')
  assert.equal(loaded.value.messages.length, 2)
})

test('B1 正面覆盖：两个 V2 旧桶 + 空的新键，走读路径续接历史且按 ctime 拼接', async () => {
  const scope = '1500'
  const older = legacyKey(scope, 'chanOld', 'v1')
  const newer = legacyKey(scope, 'chanNew', 'v2')
  const redis = new FakeRedis([
    // 故意把新桶先塞进去：读路径不许依赖插入顺序，只认 ctime
    [newer, legacyValue({ ctime: '2026-11-05T00:00:00.000Z', messages: qa('换了模型之后的问题', '换了模型之后的回答'), replyTimestamps: [2000] })],
    [older, legacyValue({ ctime: '2026-10-20T00:00:00.000Z', messages: qa('换模型之前的问题', '换模型之前的回答'), replyTimestamps: [1000] })]
  ])
  // 新键一开始不存在：这正是「用户改了模型，下一句」的真实场景
  assert.equal(redis.store.has(conversationKeyOf(scope)), false)

  const loaded = await loadConversation({ scope, client: redis, config: {} })
  assert.equal(loaded.status, 'migrated')
  assert.equal(loaded.isNewConversation, false, '有旧桶就必须算续接，绝不能当首轮把历史扔掉')
  assert.deepEqual(loaded.value.messages.map(m => m.content), [
    '换模型之前的问题', '换模型之前的回答',
    '换了模型之后的问题', '换了模型之后的回答'
  ], '跨通道的两个桶要按 ctime 拼成一条连续历史')
  assert.equal(loaded.value.migration.buckets, 2)
  assert.equal(redis.store.has(conversationKeyOf(scope)), true, '迁移结果要落到新键，下一轮直接命中')

  // 再读一次：走 already 分支，条数不变
  const again = await loadConversation({ scope, client: redis, config: {} })
  assert.equal(again.status, 'already')
  assert.equal(again.value.messages.length, 4)
})

test('历史里烘进去的记忆块被剥掉，剥不动就原样保留', () => {
  const stripped = stripMemoryBlock('【历史记忆参考（不可信数据）】\n记忆内容\n（记忆结束）\n\n用户真正的问题')
  assert.deepEqual(stripped, { content: '用户真正的问题', stripped: true })
  // 行中出现的字样不处理（必须行首锚定）
  const inline = '我问他【历史记忆参考（不可信数据）】是什么（记忆结束）'
  assert.deepEqual(stripMemoryBlock(inline), { content: inline, stripped: false })
  // 找不到结束标记：整条不剥，宁可留脏数据也不误删用户原话
  const broken = '【历史记忆参考（不可信数据）】没有结束标记的用户原话'
  assert.deepEqual(stripMemoryBlock(broken), { content: broken, stripped: false })
})

test('合并时剥记忆块并把条数记进报告', () => {
  const buckets = [{
    key: legacyKey('900'), parsed: { scope: '900', providerId: 'p', connectionVersion: 'v' },
    value: { ctime: '2026-10-01T00:00:00.000Z', messages: [{ role: 'user', content: '【历史记忆参考（不可信数据）】\n旧记忆\n（记忆结束）\n\n真问题' }, { role: 'assistant', content: '回答' }] }
  }]
  const { value } = mergeLegacyBuckets(buckets, { config: {} })
  assert.deepEqual(value.messages.map(m => m.content), ['真问题', '回答'])
  assert.equal(value.migration.strippedMemoryBlocks, 1)
})

test('读路径必须走 loadConversation，不许再直接 redis.get 会话键', () => {
  const source = fs.readFileSync(path.join(ROOT, 'apps/chat.js'), 'utf8')
  assert.match(source, /loadConversation\(/, '读会话必须经过懒迁移入口')
  assert.doesNotMatch(source, /const savedConversation = key \? await redis\.get\(key\) : null/,
    '直接 get 会话键会绕过迁移，老用户下一句就丢上下文')
})

test('迁移模块不依赖 Config / 不碰 config.json：参数全由调用方传，可独立 import', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'utils/conversationMigration.js'), 'utf8')
  assert.doesNotMatch(source, /from '\.\/config\.js'/, '不许 import Config——B8 的门 2 要在没有 Yunzai 环境时独立加载本模块')
  assert.doesNotMatch(source, /from '\.\.\/apps\//, '也不许反向依赖插件实例')
  assert.doesNotMatch(source, /\bfs\./, '不许读写文件系统')
  assert.doesNotMatch(source, /config\.json/, '不许读写 config.json')
  // 真正在**子进程**里独立 import 一次：不设任何 Yunzai 全局（logger/redis/Bot 全无），
  // 加载失败就是 B8 门 2 的硬阻塞，所以这里必须实跑而不是只做源码扫描。
  const target = path.join(ROOT, 'utils', 'conversationMigration.js')
  const script = `import(${JSON.stringify('file:///' + target.replace(/\\/g, '/'))}).then(m => {`
    + `console.log('OK:' + typeof m.ensureMigratedScope + ':' + typeof m.migrateAllScopes) })`
  const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim()
  assert.equal(output, 'OK:function:function', '模块必须能在无 Yunzai 环境下独立加载')
})

test('全量迁移回执字段完整：scope / 合并条数 / 坏桶 / 备份都要能报出来', async () => {
  const { migrateAllScopes } = await import('../utils/conversationMigration.js')
  const redis = new FakeRedis([
    [legacyKey('2101', 'pA', 'va'), legacyValue({ ctime: '2026-10-01T00:00:00.000Z', messages: qa('a1', 'b1') })],
    [legacyKey('2101', 'pB', 'vb'), legacyValue({ ctime: '2026-10-02T00:00:00.000Z', messages: qa('a2', 'b2') })],
    [legacyKey('2102', 'pA', 'va'), legacyValue({ ctime: '2026-10-01T00:00:00.000Z', messages: qa('c1', 'd1') })],
    [legacyKey('2102', 'pBad', 'vx'), '坏掉的值']
  ])
  const summary = await migrateAllScopes({ client: redis, config: {} })
  assert.equal(summary.scopes, 2)
  assert.equal(summary.migrated, 2)
  assert.equal(summary.mergedMessages, 6, '两个 scope 各 4/2 条，合计 6 条')
  assert.equal(summary.badBuckets, 1, '坏桶数量必须如实回到回执里')
  assert.equal(summary.backups, 3, '三个有效旧桶各写一个备份键')
  assert.equal(summary.failed, 0)
})

test('全量迁移统计：同 scope 多桶算一个 scope，第二次跑全部跳过', async () => {
  const { migrateAllScopes } = await import('../utils/conversationMigration.js')
  const redis = new FakeRedis([
    [legacyKey('1001', 'pA', 'va'), legacyValue({ ctime: '2026-10-01T00:00:00.000Z', messages: qa('a1', 'b1') })],
    [legacyKey('1001', 'pB', 'vb'), legacyValue({ ctime: '2026-10-02T00:00:00.000Z', messages: qa('a2', 'b2') })],
    [legacyKey('1002', 'pA', 'va'), legacyValue({ ctime: '2026-10-01T00:00:00.000Z', messages: qa('c1', 'd1') })]
  ])
  const first = await migrateAllScopes({ client: redis, config: {} })
  assert.equal(first.scannedKeys, 3)
  assert.equal(first.scopes, 2)
  assert.equal(first.migrated, 2)
  assert.equal(redis.store.has(MIGRATION_REPORT_KEY), true, '迁移报告要能事后回答「合成了什么样」')

  const second = await migrateAllScopes({ client: redis, config: {} })
  assert.equal(second.migrated, 0)
  assert.equal(second.skipped, 2)
  assert.equal(redis.store.has(`${CONVERSATION_KEY_PREFIX}:1001`), true)
})
