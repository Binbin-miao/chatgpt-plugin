/**
 * 原文文件后端（T-05）：RawStore 本体 + MemoryStore 的 file 分流
 *
 * 运行：node --experimental-test-module-mocks --test test/memoryRawFileStore.test.js
 *
 * 全部用例用 `fs.mkdtemp(os.tmpdir())` 做临时根目录，跑完删除，绝不落仓库 data/。
 * 需要 redis 的地方用一个只记录写调用的假客户端：文件模式下 `raw:*` 一条都不该被写。
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {}, trace() {}, log() {} }

const { RawStore } = await import('../utils/memory/rawStore.js')
const { MemoryStore } = await import('../utils/memory/store.js')
const { Config } = await import('../utils/config.js')

/** 北京时间 2026-03-01 10:00 / 03-02 10:00（用 UTC 毫秒构造，避免宿主时区影响断言） */
const T1 = Date.UTC(2026, 2, 1, 2, 0, 0) / 1000
const T2 = Date.UTC(2026, 2, 2, 2, 0, 0) / 1000
const MAX_SEC = Number.MAX_SAFE_INTEGER

let baseDir
let rawStore

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-raw-file-'))
  rawStore = new RawStore({ baseDir })
})

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true })
  Config.getConfig().memoryStorage = 'redis'
})

/** 只记录写 key 的假 redis：文件模式下这些 key 一个都不该出现 raw:* */
function fakeRedis({ task = null } = {}) {
  const writes = []
  const hsetCalls = []
  return {
    writes,
    hsetCalls,
    set: async (k) => { writes.push(k); return 'OK' },
    zAdd: async (k) => { writes.push(k); return 1 },
    del: async () => 1,
    zRange: async () => [],
    zRangeByScore: async () => [],
    sMembers: async () => [],
    sRem: async () => 1,
    sCard: async () => 0,
    hGetAll: async (key) => (task && String(key).includes(':task:') ? { ...task } : {}),
    hSet: async (key, fields) => { hsetCalls.push({ key: String(key), fields }); return 1 },
    hDel: async () => 1,
    expire: async () => 1,
  }
}

const dayFile = (gid, day) => path.join(baseDir, gid, `${day}.ndjson`)
const lines = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)

test('append：按北京时间日期分文件、只追加，行数与文件数正确', async () => {
  assert.equal(new RawStore().baseDir, path.join(process.cwd(), 'data', 'chatgpt', 'memory', 'raw'), '默认路径必须是 data/chatgpt/memory/raw')

  await rawStore.append('100', { groupId: '100', messageId: 'a', text: '第一天的消息', time: T1 })
  await rawStore.append('100', { groupId: '100', messageId: 'b', text: '第二天的消息', time: T2 })

  assert.deepEqual(fs.readdirSync(path.join(baseDir, '100')).sort(), ['2026-03-01.ndjson', '2026-03-02.ndjson'])
  assert.equal(lines(dayFile('100', '2026-03-01')).length, 1)
  assert.equal(lines(dayFile('100', '2026-03-02')).length, 1)
  assert.equal(await rawStore.count('100'), 2)
})

test('readRange：按时间过滤，跨天文件按日期升序拼接', async () => {
  await rawStore.append('100', { groupId: '100', messageId: 'a', time: T1 })
  await rawStore.append('100', { groupId: '100', messageId: 'b', time: T2 })

  assert.deepEqual((await rawStore.readRange('100', T1, T1)).map(r => r.messageId), ['a'])
  assert.deepEqual((await rawStore.readRange('100', T2, T2)).map(r => r.messageId), ['b'])
  assert.deepEqual((await rawStore.readRange('100', T1, T2)).map(r => r.messageId), ['a', 'b'])
  assert.deepEqual(await rawStore.readRange('999', 0, MAX_SEC), [], '没有文件的群返回空数组')
})

test('坏行被跳过：不抛异常，其余行照常返回', async () => {
  await rawStore.append('100', { groupId: '100', messageId: 'a', time: T1 })
  fs.appendFileSync(dayFile('100', '2026-03-01'), '{oops\n')
  await rawStore.append('100', { groupId: '100', messageId: 'c', time: T1 + 60 })

  const rows = await rawStore.readRange('100', 0, MAX_SEC)
  assert.deepEqual(rows.map(r => r.messageId), ['a', 'c'], '坏行必须只丢自己，不能拖垮整次读取')
})

test('cleanup：只删早于保留期的日期文件，0 时一条不删', async () => {
  await rawStore.append('100', { groupId: '100', messageId: 'a', time: T1 })
  await rawStore.append('100', { groupId: '100', messageId: 'b', time: T2 })

  const removedKeep = await rawStore.cleanup('100', 0, Date.UTC(2026, 2, 20) )
  assert.equal(removedKeep, 0, '0 = 永久保留，不能删任何文件')
  assert.equal(fs.existsSync(dayFile('100', '2026-03-01')), true)

  // now = 2026-03-03 08:00 北京时间 → 保留期 1 天 → 只删 03-01（03-02 仍在新窗口内）
  const removed = await rawStore.cleanup('100', 1, Date.UTC(2026, 2, 3))
  assert.equal(removed, 1, '返回删除的原文条数')
  assert.equal(fs.existsSync(dayFile('100', '2026-03-01')), false)
  assert.equal(fs.existsSync(dayFile('100', '2026-03-02')), true, '未过期的那天不能删')
})

test('并发 append 10 条：行数 = 10 且每行都能 parse（串行化生效）', async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    rawStore.append('200', { groupId: '200', messageId: `m${i}`, text: `消息${i}`, time: T1 + i })))

  const file = dayFile('200', '2026-03-01')
  assert.equal(lines(file).length, 10, '并发写入不能丢行或写半行')
  for (const line of lines(file)) assert.doesNotThrow(() => JSON.parse(line), `半行/坏行：${line}`)
})

test('readRecent：按时间倒序、提前停止并给出 limited', async () => {
  for (let i = 0; i < 5; i++) await rawStore.append('300', { groupId: '300', messageId: `r${i}`, time: T1 + i * 60 })

  const recent = await rawStore.readRecent('300', T1 + 3600, 2)
  assert.deepEqual(recent.rows.map(r => r.messageId), ['r4', 'r3'], '最近的在前')
  assert.equal(recent.limited, true)
  assert.equal(recent.limit, 2)
})

test('file 模式：saveRawMessage 落盘、redis 里 raw:* 一条不写', async () => {
  Config.getConfig().memoryStorage = 'file'
  const redis = fakeRedis()
  const store = new MemoryStore(redis, { rawStore })

  await store.saveRawMessage({ groupId: '100', messageId: 'a', senderId: '10001', text: '我叫玉玉', time: T1, isCommand: false, contentHash: 'h1' }, 30)
  await store.saveRawMessage({ groupId: '100', messageId: 'b', senderId: '10001', text: '今天下雨', time: T2, isCommand: false, contentHash: 'h2' }, 30)

  assert.equal(lines(dayFile('100', '2026-03-01')).length, 1)
  assert.equal(lines(dayFile('100', '2026-03-02')).length, 1)
  assert.deepEqual(redis.writes.filter(k => k.includes(':raw')), [], 'file 模式不得再写 redis 原文/索引')
  assert.deepEqual((await store.getRawMessages('100', 0, MAX_SEC)).map(r => r.messageId), ['a', 'b'])
})

test('file 模式：getRawTimeRange 给出 min/max，空群返回 null', async () => {
  Config.getConfig().memoryStorage = 'file'
  const store = new MemoryStore(fakeRedis(), { rawStore })
  assert.equal(await store.getRawTimeRange('100'), null, '没有原文时必须返回 null')

  await store.saveRawMessage({ groupId: '100', messageId: 'a', senderId: '1', text: 'x', time: T1, contentHash: 'h1' }, 30)
  await store.saveRawMessage({ groupId: '100', messageId: 'b', senderId: '1', text: 'y', time: T2, contentHash: 'h2' }, 30)
  assert.deepEqual(await store.getRawTimeRange('100'), { minTime: T1, maxTime: T2 })
})

test('file 模式：getRecentRawMessages 返回结构与 redis 口径一致', async () => {
  Config.getConfig().memoryStorage = 'file'
  const store = new MemoryStore(fakeRedis(), { rawStore })
  await store.saveRawMessage({ groupId: '100', messageId: 'a', senderId: '1', text: 'x', time: T1 }, 30)
  await store.saveRawMessage({ groupId: '100', messageId: 'b', senderId: '1', text: 'y', time: T2 }, 30)

  const recent = await store.getRecentRawMessages('100', T2)
  assert.deepEqual(recent.rows.map(r => r.messageId), ['b', 'a'])
  assert.equal(recent.limited, false)
  assert.equal(recent.limit, 20000)
})

test('file 模式：cleanupExpiredRaw 删过期文件并返回条数', async () => {
  Config.getConfig().memoryStorage = 'file'
  const store = new MemoryStore(fakeRedis(), { rawStore })
  await store.saveRawMessage({ groupId: '100', messageId: 'a', senderId: '1', text: 'x', time: T1 }, 30)
  await store.saveRawMessage({ groupId: '100', messageId: 'b', senderId: '1', text: 'y', time: T2 }, 30)

  assert.equal(await store.cleanupExpiredRaw('100', 0), 0, '0 = 永久，直接返回 0')

  // 把系统时间拨到 2026-03-03 之后：保留 1 天 → 只有 03-01 过期
  const realNow = Date.now
  try {
    Date.now = () => Date.UTC(2026, 2, 3, 6, 0, 0)
    assert.equal(await store.cleanupExpiredRaw('100', 1), 1)
  } finally {
    Date.now = realNow
  }
  assert.equal(fs.existsSync(dayFile('100', '2026-03-01')), false)
  assert.equal(fs.existsSync(dayFile('100', '2026-03-02')), true)
})

test('file 模式：clearGroup 删掉该群目录', async () => {
  Config.getConfig().memoryStorage = 'file'
  const store = new MemoryStore(fakeRedis(), { rawStore })
  await store.saveRawMessage({ groupId: '100', messageId: 'a', senderId: '1', text: 'x', time: T1 }, 30)
  assert.equal(fs.existsSync(path.join(baseDir, '100')), true)

  await store.clearGroup('100')
  assert.equal(fs.existsSync(path.join(baseDir, '100')), false, 'file 模式必须能清掉群目录，否则 T-03 会漏')
})

test('写入队列：一次失败不会毒化后续写入', async () => {
  const store = new RawStore({ baseDir })
  // 把群目录的位置占成普通文件，让该次 mkdir 必然失败（模拟磁盘瞬时异常）
  fs.writeFileSync(path.join(baseDir, '500'), 'block')
  await assert.rejects(store.append('500', { groupId: '500', messageId: 'x', time: T1 }), '本次失败必须抛给调用方')

  fs.unlinkSync(path.join(baseDir, '500'))
  await store.append('500', { groupId: '500', messageId: 'y', time: T1 })
  assert.equal(await store.count('500'), 1, '磁盘恢复后写入必须能继续，队列不能停在 rejected')
})

test('重复 append（补录/重复开启）按 messageId 去重：readRange 与 readRecent 都只返回一次', async () => {
  for (let i = 0; i < 2; i++) {
    await rawStore.append('400', { groupId: '400', messageId: 'dup', text: '同一句', time: T1 })
  }
  await rawStore.append('400', { groupId: '400', messageId: 'other', text: '另一句', time: T1 + 60 })

  assert.deepEqual((await rawStore.readRange('400', 0, MAX_SEC)).map(r => r.messageId), ['dup', 'other'], '同一条消息只算一次')
  assert.deepEqual((await rawStore.readRecent('400', T2, 10)).rows.map(r => r.messageId), ['other', 'dup'])
  assert.equal(await rawStore.count('400'), 3, 'count 是物理行数，去重只发生在读取侧')
})

test('file 模式：任务标脏仍然写 redis（needsReextract 不能因分流丢失）', async () => {
  Config.getConfig().memoryStorage = 'file'
  const redis = fakeRedis({ task: { status: 'completed' } })
  const store = new MemoryStore(redis, { rawStore })

  await store.saveRawMessage({ groupId: '100', messageId: 'a', senderId: '10001', text: '我叫玉玉', time: T1, isCommand: false, contentHash: 'h1' }, 30)

  const taskWrite = redis.hsetCalls.find(c => c.key.includes(':task:100:2026-03-01'))
  assert.ok(taskWrite, `file 模式必须仍标脏已完成窗口：${JSON.stringify(redis.hsetCalls)}`)
  assert.equal(taskWrite.fields.needsReextract, '1')
})

test('redis 模式（默认）：行为不变，仍写 redis 且不落盘', async () => {
  const redis = fakeRedis()
  const store = new MemoryStore(redis, { rawStore })
  await store.saveRawMessage({ groupId: '100', messageId: 'a', senderId: '1', text: 'x', time: T1 }, 30)

  assert.ok(redis.writes.some(k => k.includes(':raw:100:a')), '默认模式必须继续写 redis 原文')
  assert.equal(fs.existsSync(path.join(baseDir, '100')), false, '默认模式不得创建文件')
})

test('file 模式：分页读取（群成员技能）走文件且按时间倒序、offset 生效', async () => {
  // 5 条，时间递增；分页必须和 redis 版一样「新的在前」
  for (let i = 0; i < 5; i++) {
    await rawStore.append('500', { groupId: '500', messageId: `m${i}`, text: `第${i}条`, time: T1 + i * 60 })
  }
  Config.getConfig().memoryStorage = 'file'
  const store = new MemoryStore(fakeRedis(), { rawStore })

  const first = await store.getRecentRawMessagesPage('500', T2, 0, 2)
  assert.deepEqual(first.rows.map(r => r.messageId), ['m4', 'm3'], '第一页应是最新两条')
  assert.equal(first.count, 2)

  const second = await store.getRecentRawMessagesPage('500', T2, 2, 2)
  assert.deepEqual(second.rows.map(r => r.messageId), ['m2', 'm1'], '第二页顺延')

  const tail = await store.getRecentRawMessagesPage('500', T2, 4, 2)
  assert.deepEqual(tail.rows.map(r => r.messageId), ['m0'], '最后一页只剩 1 条')
  assert.equal(tail.count, 1)
})
