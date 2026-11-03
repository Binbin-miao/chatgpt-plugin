/**
 * 群记忆软关闭 / 到期清理 / 无效记忆清理（T-01 ~ T-03）
 *
 * 运行：node --experimental-test-module-mocks --test test/memoryGroupClose.test.js
 *
 * 为什么要单独一个文件：`capture.disableGroup` 与 `enableGroup` 会调 `Config.save()`，
 * 而 Config 落盘路径在模块加载时由 `process.cwd()` 固定，真实 Config 会在仓库里写出
 * `plugins/chatgpt-plugin/config/config.json`。这里把 Config 换成内存 stub，
 * 存储层（真实 MemoryStore + 假 Redis）、采集层、每日任务、指令层全部跑真实生产代码。
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

/* ================= Mock Redis（内存实现，只实现被覆盖路径用到的方法） ================= */

class MockRedis {
  constructor() {
    this.data = new Map()
  }

  async get(k) { const v = this.data.get(k); return typeof v === 'string' ? v : null }
  async set(k, v, options = {}) {
    if (options?.NX && this.data.has(k)) return null
    this.data.set(k, String(v))
    return 'OK'
  }
  async del(...keys) { let n = 0; for (const k of keys) if (this.data.delete(k)) n++; return n }
  async expire(k, seconds) { this.data.set(`__ttl:${k}`, Date.now() + seconds * 1000); return 1 }
  async exists(k) { return this.data.has(k) ? 1 : 0 }

  async hGetAll(k) { const v = this.data.get(k); return v instanceof Map ? Object.fromEntries([...v.entries()]) : {} }
  async hSet(k, fields) {
    if (!(this.data.get(k) instanceof Map)) this.data.set(k, new Map())
    const m = this.data.get(k)
    for (const [f, val] of Object.entries(fields || {})) m.set(String(f), String(val))
    return 1
  }
  async hDel(k, ...fields) {
    const m = this.data.get(k)
    if (!(m instanceof Map)) return 0
    let n = 0
    for (const f of fields) if (m.delete(String(f))) n++
    return n
  }

  async sAdd(k, ...members) {
    if (!(this.data.get(k) instanceof Set)) this.data.set(k, new Set())
    const s = this.data.get(k)
    let n = 0
    for (const m of members) if (!s.has(String(m))) { s.add(String(m)); n++ }
    return n
  }
  async sRem(k, ...members) {
    const s = this.data.get(k)
    if (!(s instanceof Set)) return 0
    let n = 0
    for (const m of members) if (s.delete(String(m))) n++
    return n
  }
  async sMembers(k) { const s = this.data.get(k); return s instanceof Set ? [...s] : [] }
  async sCard(k) { const s = this.data.get(k); return s instanceof Set ? s.size : 0 }

  async zAdd(k, memberOrObj) {
    if (!(this.data.get(k) instanceof Map)) this.data.set(k, new Map())
    const z = this.data.get(k)
    z.set(String(memberOrObj.value), Number(memberOrObj.score))
    return 1
  }
  async zRange(k, start, stop) {
    const z = this.data.get(k)
    if (!(z instanceof Map)) return []
    const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0])
    return sorted.slice(start, stop === -1 ? undefined : stop + 1)
  }
  async zRangeByScore(k, min, max) {
    const z = this.data.get(k)
    if (!(z instanceof Map)) return []
    return [...z.entries()].filter(([, s]) => s >= min && s <= max).sort((a, b) => a[1] - b[1]).map(e => e[0])
  }
  async zRem(k, ...members) {
    const z = this.data.get(k)
    if (!(z instanceof Map)) return 0
    let n = 0
    for (const m of members) if (z.delete(String(m))) n++
    return n
  }

  *scanIterator({ MATCH = '*' } = {}) {
    const escaped = MATCH.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    const re = new RegExp(`^${escaped}$`)
    for (const key of [...this.data.keys()]) {
      if (re.test(key)) yield key
    }
  }
}

/* ================= 测试环境准备 ================= */

const mockRedis = new MockRedis()
global.redis = mockRedis
globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {}, trace() {}, log() {} }

/** 内存版配置：capture / dailyTask / memoryManage 都只读这几项 */
let config = {}
function resetConfig(patch = {}) {
  config = {
    enableMemory: true,
    maxMemoriesPerUser: 100,
    maxMemoriesPerGroup: 50,
    memoryContextLimit: 8,
    memoryRecallProvider: '',
    allowMemberDeleteOwnMemory: true,
    memoryGroupCapture: {
      groups: [{ groupId: '100', switchOn: true }],
      cronTime: '0 0 4 * * ? *',
      provider: 'current',
      rawRetentionDays: 30,
      closedGroupRetentionDays: 90,
      eventRetentionDays: 90,
    },
    ...patch,
  }
}
resetConfig()

const ConfigStub = new Proxy({}, {
  get: (_, prop) => {
    if (prop === 'getConfig') return () => config
    if (prop === 'save') return () => true
    return config[prop]
  },
  set: (_, prop, value) => { config[prop] = value; return true },
})
mock.module('../utils/config.js', { namedExports: { Config: ConfigStub } })

/** TRSS 插件基类 stub：只保留被测代码实际调用的 reply / awaitContext */
class PluginStub {
  constructor(options = {}) { Object.assign(this, options) }
  async reply() {}
  async awaitContext() { return { msg: '是' } }
}
mock.module('../../../lib/plugins/plugin.js', { defaultExport: PluginStub })
mock.module('../utils/common.js', { namedExports: { makeForwardMsg: async () => ({}) } })

const { MemoryStore, normalizeRetentionDays } = await import('../utils/memory/store.js')
const { groupCapture } = await import('../utils/memory/capture.js')
const { DailyConsolidation } = await import('../utils/memory/dailyTask.js')
const { memoryManage } = await import('../apps/memoryManage.js')

const clearStore = async () => { for (const k of [...mockRedis.data.keys()]) mockRedis.data.delete(k) }

const DAY_MS = 86400000

/** 写入一条本群个人记忆（走真实 applyFact 校验） */
async function writeGroupMemory(store, gid, messageId, text = '用户叫玉玉') {
  const row = { messageId, senderId: '10001', senderName: 'A', role: '', time: 1780000000, text }
  const res = await store.applyFact({
    scope: 'user_group', subjectId: '10001', speakerId: '10001', kind: 'identity',
    factKey: 'identity.name', factValue: 'yuyu', text, confidence: 0.9, importance: 0.6,
    evidenceMessageIds: [messageId],
  }, { groupId: gid, source: `group-window:${gid}:2026-08-30`, evidenceMap: { [messageId]: row } })
  assert.equal(res.ok, true, `写入测试记忆失败: ${res.reason}`)
}

async function writeRaw(store, gid, messageId, time = 1780000000) {
  await store.saveRawMessage({
    groupId: gid, messageId, senderId: '10001', senderName: 'A', role: '',
    text: '我叫玉玉', time, isCommand: false, contentHash: `h-${messageId}`,
  }, 30)
}

async function groupSnapshot(store, gid) {
  const memories = (await store.listByScope({ scope: 'user_group', ownerId: '10001', groupId: gid }))
    .filter(m => m.status === 'active')
  const raws = await store.getRawMessages(gid, 0, 1999999999)
  return { memories: memories.length, raws: raws.length }
}

/* ================= T-01：软关闭（打标，不删数据） ================= */

test('关闭标记：首次写入 closedAt，重复关闭保留最早时间，开启时被清除', async () => {
  await clearStore()
  resetConfig()
  const store = new MemoryStore(mockRedis)

  assert.equal(await store.markGroupClosed('100', 1000), true, '首次关闭应写入')
  assert.equal((await store.getPolicy('100')).closedAt, '1000', 'closedAt 以毫秒字符串存储')
  assert.equal(await store.markGroupClosed('100', 5000), false, '重复关闭不应覆盖')
  assert.equal((await store.getPolicy('100')).closedAt, '1000', '保留最早关闭时间，反悔窗口不被推迟')

  // 与既有 policy 字段共存，不能被整体覆盖
  await store.setPolicy('100', { lastDailyEnd: '2026-09-01' })
  assert.equal((await store.getPolicy('100')).lastDailyEnd, '2026-09-01')
  assert.equal((await store.getPolicy('100')).closedAt, '1000')

  assert.equal(await store.clearGroupClosedAt('100'), 1)
  const policy = await store.getPolicy('100')
  assert.equal(policy.closedAt, undefined, '开启后关闭标记必须消失')
  assert.equal(policy.lastDailyEnd, '2026-09-01', '清除关闭标记不得影响提炼游标')
})

test('#群记忆关闭：只停采集并打标，原文与记忆一条不少', async () => {
  await clearStore()
  resetConfig()
  const store = new MemoryStore(mockRedis)
  groupCapture.store = store

  await writeGroupMemory(store, '100', 'm1')
  await writeRaw(store, '100', 'm1')
  const before = await groupSnapshot(store, '100')
  assert.deepEqual(before, { memories: 1, raws: 1 }, '前提：已有 1 条原文与 1 条记忆')

  const res = await groupCapture.disableGroup({ isGroup: true, group_id: '100' })
  assert.equal(res.ok, true)
  assert.doesNotMatch(res.message, /来源级清理/, '关闭不再做清理，文案不得再提来源级清理')
  assert.match(res.message, /保留 90 天/, '文案要给出关闭后的保留天数')
  assert.match(res.message, /#清理无效记忆/, '文案要给立即清理的出口')
  assert.deepEqual(await groupSnapshot(store, '100'), before, '关闭后原文与记忆条数必须不变')

  assert.equal((await store.getPolicy('100')).closedAt !== undefined, true, '关闭必须打标')
  assert.equal(ConfigStub.memoryGroupCapture.groups.find(g => g.groupId === '100').switchOn, false, '关闭必须取消授权')
})

test('#群记忆关闭：保留天数为 0 时文案写明不自动清理', async () => {
  await clearStore()
  resetConfig()
  config.memoryGroupCapture.closedGroupRetentionDays = 0
  const store = new MemoryStore(mockRedis)
  groupCapture.store = store

  const res = await groupCapture.disableGroup({ isGroup: true, group_id: '100' })
  assert.equal(res.ok, true)
  assert.match(res.message, /不自动清理/)
  assert.doesNotMatch(res.message, /保留 0 天/)
})

test('#群记忆开启：清除关闭标记', async () => {
  await clearStore()
  resetConfig()
  const store = new MemoryStore(mockRedis)
  groupCapture.store = store
  await store.markGroupClosed('100', 5000)

  const res = await groupCapture.enableGroup({ isGroup: true, group_id: '100' })
  assert.equal(res.ok, true)
  assert.equal((await store.getPolicy('100')).closedAt, undefined, '重新开启必须清掉 closedAt')
})

/* ================= T-02：到期自动清理 ================= */

test('到期清理：非授权群首次只打标、满期只清该群、授权群与未到期群一条不动', async () => {
  await clearStore()
  resetConfig({
    memoryGroupCapture: {
      groups: [{ groupId: '100', switchOn: true }],
      cronTime: '0 0 4 * * ? *',
      rawRetentionDays: 30,
      closedGroupRetentionDays: 90,
      eventRetentionDays: 90,
    },
  })
  const store = new MemoryStore(mockRedis)
  const now = Date.now()

  for (const gid of ['100', '200', '300', '400']) {
    await writeGroupMemory(store, gid, `m-${gid}`)
    // 用「现在」写原文：本用例验证的是「清理记忆不动原文」，原文本身不能是过期的
    await writeRaw(store, gid, `m-${gid}`, Math.floor(now / 1000))
  }
  // 100 = 授权群但历史上被打过关闭标记（不能被清，且标记要被自愈清掉）
  await store.markGroupClosed('100', now - 200 * DAY_MS)
  // 300 = 非授权且已满 90 天，历史提炼游标必须活下来（否则重新授权会整段重提炼）
  await store.markGroupClosed('300', now - 91 * DAY_MS)
  await store.setPolicy('300', { lastDailyEnd: '2026-03-01' })
  // 400 = 非授权但未满期
  await store.markGroupClosed('400', now - 10 * DAY_MS)
  // 200 = 非授权且从未打标（首次发现，只打标）

  const dc = new DailyConsolidation({ store })
  const report = await dc.sweepClosedGroups(dc.cfg())

  assert.equal(report.marked, 1, '只有从未打标的群被打标')
  assert.deepEqual(report.purgedGroups.map(p => p.groupId), ['300'], '只有满期的非授权群被清理')
  assert.equal(report.purged, 1)
  assert.equal(report.healed, 1, '授权群上的陈旧 closedAt 必须被自愈并计数')

  assert.equal((await groupSnapshot(store, '300')).memories, 0, '满期群记忆应被清空')
  assert.equal((await groupSnapshot(store, '300')).raws, 1, '到期清理只清记忆，原文归 rawRetentionDays')
  assert.equal((await store.getPolicy('300')).lastDailyEnd, '2026-03-01', '提炼游标不能被清（否则重授权会造回记忆）')
  assert.equal((await groupSnapshot(store, '200')).memories, 1, '首次发现只打标，本轮不得删')
  assert.notEqual((await store.getPolicy('200')).closedAt, undefined, '首次发现必须打标')
  assert.equal((await groupSnapshot(store, '400')).memories, 1, '未满期不得删')
  assert.equal((await groupSnapshot(store, '100')).memories, 1, '授权中的群即使有 closedAt 也不得清')
  assert.equal((await store.getPolicy('100')).closedAt, undefined, '授权群的陈旧 closedAt 必须被自愈清掉')

  const meta = await store.getMeta()
  assert.equal(Number(meta.lastSweepAt) > 0, true, 'meta 必须记录上次清理时间')
  assert.equal(meta.lastSweepPurged, '1', 'meta 必须记录上次清理的群数')
})

test('到期扫描顺带清理非授权群的过期原文：文件模式没有 TTL 兜底', async () => {
  await clearStore()
  resetConfig({
    memoryGroupCapture: {
      groups: [{ groupId: '100', switchOn: true }],
      cronTime: '0 0 4 * * ? *',
      rawRetentionDays: 30,
      closedGroupRetentionDays: 90,
      eventRetentionDays: 90,
    },
  })
  const store = new MemoryStore(mockRedis)
  const now = Date.now()
  await writeGroupMemory(store, '200', 'm-200')
  await writeRaw(store, '200', 'm-200')
  await store.markGroupClosed('200', now - 91 * DAY_MS)

  const calls = []
  store.cleanupExpiredRaw = async (gid, days) => { calls.push([gid, days]); return 0 }

  const dc = new DailyConsolidation({ store })
  await dc.sweepClosedGroups(dc.cfg())

  assert.deepEqual(calls, [['200', 30]], '非授权群必须按 rawRetentionDays 主动清原文，不能只依赖 redis 的 TTL')
})

test('到期清理自愈：重新授权的群带着 120 天前的 closedAt，sweep 后标记消失且记忆不变', async () => {
  await clearStore()
  resetConfig()
  const store = new MemoryStore(mockRedis)
  // 复现：3 月关闭 → 4 月锅巴面板重新勾选（不经 enableGroup，closedAt 留在 policy）→ 次日 sweep
  await writeGroupMemory(store, '100', 'm-100')
  await writeRaw(store, '100', 'm-100')
  await store.markGroupClosed('100', Date.now() - 120 * DAY_MS)
  assert.notEqual((await store.getPolicy('100')).closedAt, undefined, '前提：旧 closedAt 还在')

  const dc = new DailyConsolidation({ store })
  const report = await dc.sweepClosedGroups(dc.cfg())

  assert.equal((await store.getPolicy('100')).closedAt, undefined, '重新授权后陈旧 closedAt 必须被清掉')
  assert.equal(report.healed, 1, '自愈要计数，便于确认真的跑了')
  assert.equal(report.purged, 0, '授权群不得被清理')
  assert.deepEqual(await groupSnapshot(store, '100'), { memories: 1, raws: 1 }, '记忆与原文都不该少')
})

test('到期清理：保留天数为 0 时永不自动删', async () => {
  await clearStore()
  resetConfig({
    memoryGroupCapture: {
      groups: [{ groupId: '100', switchOn: true }],
      cronTime: '0 0 4 * * ? *',
      rawRetentionDays: 30,
      closedGroupRetentionDays: 0,
      eventRetentionDays: 90,
    },
  })
  const store = new MemoryStore(mockRedis)
  await writeGroupMemory(store, '300', 'm-300')
  await store.markGroupClosed('300', Date.now() - 365 * DAY_MS)

  const dc = new DailyConsolidation({ store })
  const report = await dc.sweepClosedGroups(dc.cfg())

  assert.equal(report.purged, 0, '保留期 0 = 永不自动清理')
  assert.equal((await groupSnapshot(store, '300')).memories, 1)
})

test('到期清理：单轮最多清理 50 个群，打标不设限', async () => {
  await clearStore()
  resetConfig()
  const store = new MemoryStore(mockRedis)
  const now = Date.now()
  const gids = []
  for (let i = 0; i < 60; i++) {
    const gid = `9${String(i).padStart(3, '0')}`
    gids.push(gid)
    await writeGroupMemory(store, gid, `m-${gid}`)
    await store.markGroupClosed(gid, now - 100 * DAY_MS)
  }

  const dc = new DailyConsolidation({ store })
  const report = await dc.sweepClosedGroups(dc.cfg())

  assert.equal(report.purged, 50, `单轮最多清 50 个群，实际 ${report.purged}`)
  const kept = []
  for (const gid of gids) if ((await groupSnapshot(store, gid)).memories > 0) kept.push(gid)
  assert.equal(kept.length, 10, '超出的 10 个群留到下一轮，不能一次全清')
})

test('配置归一：原文保留填 0 不被夹回 30，关闭保留期 0 不被夹回 90，非法值各自回退', async () => {
  await clearStore()
  resetConfig()
  config.memoryGroupCapture.rawRetentionDays = 0
  config.memoryGroupCapture.closedGroupRetentionDays = 0
  const dc = new DailyConsolidation({ store: new MemoryStore(mockRedis) })

  const zero = dc.cfg()
  assert.equal(zero.rawRetentionDays, 0, '0 = 永久保留，不能被 `|| 30` 吞掉')
  assert.equal(zero.closedGroupRetentionDays, 0, '0 = 永不自动清理')

  config.memoryGroupCapture.rawRetentionDays = 'abc'
  config.memoryGroupCapture.closedGroupRetentionDays = -5
  const bad = dc.cfg()
  assert.equal(bad.rawRetentionDays, 30, '非数字回退 30')
  assert.equal(bad.closedGroupRetentionDays, 90, '负数回退 90')
})

/* ================= T-03：#清理无效记忆 ================= */

test('无效记忆清单：只含非授权群，带记忆条数，超过上限提示还有更多', async () => {
  await clearStore()
  resetConfig()
  const store = new MemoryStore(mockRedis)
  await writeGroupMemory(store, '100', 'm-100')
  await writeGroupMemory(store, '200', 'm-200')
  await writeGroupMemory(store, '300', 'm-300')

  const all = await store.listUnauthorizedGroups(['100'], 50)
  assert.deepEqual(all.groups.map(g => g.groupId), ['200', '300'], '授权群不得出现在待清理清单里')
  assert.deepEqual(all.groups.map(g => g.memoryCount), [1, 1])
  assert.equal(all.hasMore, false)

  const limited = await store.listUnauthorizedGroups(['100'], 1)
  assert.deepEqual(limited.groups.map(g => g.groupId), ['200'])
  assert.equal(limited.hasMore, true, '还有未列出的群时必须给出提示')
})

test('#清理无效记忆 预览：列出群号与条数，不写任何数据', async () => {
  await clearStore()
  resetConfig()
  const store = new MemoryStore(mockRedis)
  await writeGroupMemory(store, '100', 'm-100')
  await writeGroupMemory(store, '200', 'm-200')
  await writeRaw(store, '200', 'm-200')

  const replies = []
  const plugin = new memoryManage({})
  plugin.reply = async m => { replies.push(String(m)) }
  await plugin.purgeInvalidMemories({ msg: '#清理无效记忆 预览', user_id: '9999', isMaster: true })

  const text = replies.at(-1)
  assert.match(text, /预览/)
  assert.match(text, /群 200：记忆 1 条/)
  assert.doesNotMatch(text, /群 100/, '授权群不得出现在清单里')
  assert.deepEqual(await groupSnapshot(store, '100'), { memories: 1, raws: 0 })
  assert.deepEqual(await groupSnapshot(store, '200'), { memories: 1, raws: 1 }, '预览不得删除任何数据')
  assert.equal((await store.getPolicy('200')).closedAt, undefined, '预览不得写关闭标记')
})

test('#清理无效记忆：确认后只清非授权群的记忆，原文与授权群一条不动', async () => {
  await clearStore()
  resetConfig()
  const store = new MemoryStore(mockRedis)
  await writeGroupMemory(store, '100', 'm-100')
  await writeGroupMemory(store, '200', 'm-200')
  await writeRaw(store, '200', 'm-200')
  await store.setPolicy('200', { lastDailyEnd: '2026-03-01' })
  await writeGroupMemory(store, '300', 'm-300')

  const replies = []
  const plugin = new memoryManage({})
  plugin.reply = async m => { replies.push(String(m)) }
  await plugin.purgeInvalidMemories({ msg: '#清理无效记忆', user_id: '9999', isMaster: true })

  assert.ok(replies.some(r => /确认/.test(r)), `必须先二次确认，实际提示：${JSON.stringify(replies)}`)
  assert.match(replies.at(-1), /已清理 2 个群/)
  assert.deepEqual(await groupSnapshot(store, '200'), { memories: 0, raws: 1 }, '只清记忆，原文必须保留')
  assert.equal((await store.getPolicy('200')).lastDailyEnd, '2026-03-01', '清理不得丢掉提炼游标')
  assert.deepEqual(await groupSnapshot(store, '300'), { memories: 0, raws: 0 })
  assert.deepEqual(await groupSnapshot(store, '100'), { memories: 1, raws: 0 }, '授权群一条不动')
})

test('#清理无效记忆：确认期间群被重新授权，执行时必须跳过（TOCTOU）', async () => {
  await clearStore()
  resetConfig()
  const store = new MemoryStore(mockRedis)
  await writeGroupMemory(store, '200', 'm-200')
  await writeGroupMemory(store, '400', 'm-400')

  const replies = []
  const plugin = new memoryManage({})
  plugin.reply = async m => { replies.push(String(m)) }
  // 用户看到清单后去锅巴把群 200 重新勾上，然后才回复「是」
  plugin.awaitContext = async () => {
    config.memoryGroupCapture.groups = [...config.memoryGroupCapture.groups, { groupId: '200', switchOn: true }]
    return { msg: '是' }
  }
  await plugin.purgeInvalidMemories({ msg: '#清理无效记忆', user_id: '9999', isMaster: true })

  assert.equal((await groupSnapshot(store, '200')).memories, 1, '确认期间重新授权的群不得被清')
  assert.equal((await groupSnapshot(store, '400')).memories, 0, '仍然无效的群照常清理')
  assert.match(replies.at(-1), /跳过 1 个已重新授权的群/, `必须告知跳过了哪些群：${replies.at(-1)}`)
})

test('#清理无效记忆：回复非确认内容视为取消，不得删除数据', async () => {
  await clearStore()
  resetConfig()
  const store = new MemoryStore(mockRedis)
  await writeGroupMemory(store, '200', 'm-200')

  const replies = []
  const plugin = new memoryManage({})
  plugin.reply = async m => { replies.push(String(m)) }
  plugin.awaitContext = async () => ({ msg: '否' })
  await plugin.purgeInvalidMemories({ msg: '#清理无效记忆', user_id: '9999' })

  assert.match(replies.at(-1), /已取消/)
  assert.equal((await groupSnapshot(store, '200')).memories, 1, '取消后不得删除')
})

test('#清理无效记忆：没有无效群时直接告知，不进入确认流程', async () => {
  await clearStore()
  resetConfig()
  const store = new MemoryStore(mockRedis)
  await writeGroupMemory(store, '100', 'm-100')

  const replies = []
  let asked = false
  const plugin = new memoryManage({})
  plugin.reply = async m => { replies.push(String(m)) }
  plugin.awaitContext = async () => { asked = true; return { msg: '是' } }
  await plugin.purgeInvalidMemories({ msg: '#清理无效记忆', user_id: '9999' })

  assert.equal(asked, false, '没有待清理群时不得要求二次确认')
  assert.match(replies.at(-1), /没有需要清理的群/)
})

test('指令注册：#清理无效记忆 支持预览后缀且限主人', async () => {
  const plugin = new memoryManage({})
  const rule = plugin.rule.find(r => r.fnc === 'purgeInvalidMemories')
  assert.ok(rule, '必须注册 #清理无效记忆')
  assert.equal(rule.permission, 'master')
  const re = new RegExp(rule.reg)
  assert.equal(re.test('#清理无效记忆'), true)
  assert.equal(re.test('#清理无效记忆 预览'), true)
  assert.equal(re.test('#记忆统计'), false)
})

test('保留天数归一：唯一实现，0 原样保留、非法值回退、不吃 NaN', async () => {
  assert.equal(normalizeRetentionDays(0, 90), 0, '0 是合法值（永久保留 / 永不清理）')
  assert.equal(normalizeRetentionDays('0', 90), 0, '配置里是字符串 0 也算 0')
  assert.equal(normalizeRetentionDays(undefined, 90), 90, '缺失回退默认值')
  assert.equal(normalizeRetentionDays('abc', 90), 90, '非数字回退默认值，不能返回 NaN')
  assert.equal(normalizeRetentionDays(-5, 30), 30, '负数回退默认值')
  assert.equal(normalizeRetentionDays(7.9, 30), 7, '取整')
  assert.equal(Number.isNaN(normalizeRetentionDays('abc', 90)), false, 'NaN 会让到期判断恒为假：一到期就立刻清')
})

test('#群记忆关闭：配置里是非法值（abc）时按 90 天告知，不能显示 NaN 或谎称 0', async () => {
  await clearStore()
  resetConfig()
  config.memoryGroupCapture.closedGroupRetentionDays = 'abc'
  groupCapture.store = new MemoryStore(mockRedis)

  const res = await groupCapture.disableGroup({ isGroup: true, group_id: '100' })
  assert.match(res.message, /保留 90 天/, `非法值必须回退 90：${res.message}`)
  assert.doesNotMatch(res.message, /NaN/)

  const replies = []
  const plugin = new memoryManage({})
  plugin.reply = async m => { replies.push(String(m)) }
  plugin.awaitContext = async () => ({ msg: '否' })
  await plugin.disableGroupMemory({ isGroup: true, group_id: '100', msg: '#群记忆关闭' })
  assert.match(replies[0], /90 天后由每日任务自动清理/, `确认文案同样要按 90 天：${replies[0]}`)
  assert.doesNotMatch(replies[0], /NaN|为 0/)
})

test('#群记忆状态：原文保留天数填 0 时显示「永久保留」而不是「0 天」', async () => {
  await clearStore()
  resetConfig()
  config.memoryGroupCapture.rawRetentionDays = 0
  const store = new MemoryStore(mockRedis)
  await writeGroupMemory(store, '100', 'm-100')

  const replies = []
  const plugin = new memoryManage({})
  plugin.reply = async m => { replies.push(String(m)) }
  await plugin.groupMemoryStatus({ group_id: '100' })

  assert.match(replies.at(-1), /原文保留：永久保留/, `0 天实际是永久保留：${replies.at(-1)}`)
  assert.doesNotMatch(replies.at(-1), /原文保留：0 天/)
})

/* ================= 状态展示 ================= */

test('#群记忆状态：展示关闭中群数与上次清理时间/清理数', async () => {
  await clearStore()
  resetConfig()
  const store = new MemoryStore(mockRedis)
  await writeGroupMemory(store, '200', 'm-200')
  await writeGroupMemory(store, '400', 'm-400')
  await store.markGroupClosed('200', Date.now() - 10 * DAY_MS)
  await store.markGroupClosed('400', Date.now() - 10 * DAY_MS)

  const replies = []
  const plugin = new memoryManage({})
  plugin.reply = async m => { replies.push(String(m)) }

  // 尚未跑过清理：清理信息显示「暂无」
  await plugin.groupMemoryStatus({ group_id: '100' })
  assert.match(replies.at(-1), /关闭中：2 个群/, `应展示关闭中的群数：${replies.at(-1)}`)
  assert.match(replies.at(-1), /上次清理：暂无/)

  // 跑一次清理后展示真实结果
  const dc = new DailyConsolidation({ store })
  await store.setMeta({ lastSweepAt: Date.now(), lastSweepPurged: 0 })
  const report = await dc.sweepClosedGroups(dc.cfg())
  assert.equal(report.purged, 0, '前提：90 天保留期未满，本轮不清理')
  await plugin.groupMemoryStatus({ group_id: '100' })
  assert.match(replies.at(-1), /上次清理：\d{4}-\d{2}-\d{2} \d{2}:\d{2} \/ 清理 0 个群/)
})
