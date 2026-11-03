/**
 * Redis → 文件 迁移（T-06）：预览 / 执行 / 校验
 *
 * 运行：node --experimental-test-module-mocks --test test/memoryMigration.test.js
 *
 * 全部用假 Redis（内存）与临时 rawStore 目录，不碰真实 Redis，也不写仓库 data/。
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {}, trace() {}, log() {} }

const { MemoryStore } = await import('../utils/memory/store.js')
const { RawStore } = await import('../utils/memory/rawStore.js')
const { planMigration, runMigration, verifyMigration } = await import('../utils/memory/migrateRawToFile.js')

const PREFIX = 'CHATGPT:MEMORY:V2'
const RAW = (gid, id) => `${PREFIX}:raw:${gid}:${id}`
const RAWIDX = gid => `${PREFIX}:rawIdx:${gid}`

/** 假 Redis：只实现迁移路径用到的命令 */
function fakeRedis() {
  const strings = new Map()
  const zsets = new Map()
  return {
    strings,
    zsets,
    async get(k) { return strings.has(k) ? strings.get(k) : null },
    async set(k, v) { strings.set(k, String(v)); return 'OK' },
    async del(...keys) { let n = 0; for (const k of keys) if (strings.delete(k) || zsets.delete(k)) n++; return n },
    async zAdd(k, item) {
      if (!zsets.has(k)) zsets.set(k, new Map())
      zsets.get(k).set(String(item.value), Number(item.score))
      return 1
    },
    async zRange(k) {
      const z = zsets.get(k)
      if (!z) return []
      return [...z.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0])
    },
    async zRangeByScore(k, min, max) {
      const z = zsets.get(k)
      if (!z) return []
      return [...z.entries()].filter(([, s]) => s >= min && s <= max).sort((a, b) => a[1] - b[1]).map(e => e[0])
    },
    async dbsize() { return strings.size + zsets.size },
    *scanIterator({ MATCH = '*' } = {}) {
      const re = new RegExp(`^${MATCH.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
      for (const k of [...strings.keys(), ...zsets.keys()]) if (re.test(k)) yield k
    },
  }
}

/** 往 Redis 写一条原文 + 索引（当作历史数据） */
function seed(redis, gid, { messageId, time, text }) {
  const payload = { messageId, senderId: '10001', senderName: 'A', role: '', text, time, isCommand: false, contentHash: `h-${messageId}`, groupId: gid }
  redis.strings.set(RAW(gid, messageId), JSON.stringify(payload))
  if (!redis.zsets.has(RAWIDX(gid))) redis.zsets.set(RAWIDX(gid), new Map())
  redis.zsets.get(RAWIDX(gid)).set(String(messageId), Number(time))
}

const T1 = Date.UTC(2026, 2, 1, 2, 0, 0) / 1000
const T2 = Date.UTC(2026, 2, 2, 2, 0, 0) / 1000

let baseDir
let rawStore
let redis
let store

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-migrate-'))
  rawStore = new RawStore({ baseDir })
  redis = fakeRedis()
  store = new MemoryStore(redis, { rawStore })

  seed(redis, '100', { messageId: 'a1', time: T1, text: '第一天的消息' })
  seed(redis, '100', { messageId: 'a2', time: T2, text: '第二天的消息' })
  seed(redis, '200', { messageId: 'b1', time: T1, text: '另一个群的消息' })
})

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true })
})

const fileLines = gid => {
  const dir = path.join(baseDir, gid)
  if (!fs.existsSync(dir)) return 0
  return fs.readdirSync(dir)
    .flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean))
    .length
}

test('预览：只统计不写文件，零写入', async () => {
  const plan = await planMigration({ store, rawStore })

  assert.equal(plan.totals.groups, 2)
  assert.equal(plan.totals.redisCount, 3)
  assert.equal(plan.totals.fileCount, 0)
  assert.deepEqual(plan.groups.map(g => [g.groupId, g.redisCount, g.fileCount]).sort(), [['100', 2, 0], ['200', 1, 0]])
  assert.equal(fs.existsSync(path.join(baseDir, '100')), false, '预览不得创建任何文件')
})

test('首次迁移：文件去重条数 == Redis 有效条数，skipped=0', async () => {
  const result = await runMigration({ store, rawStore })

  assert.equal(result.appended, 3)
  assert.equal(result.skipped, 0)
  assert.deepEqual(result.failed, [])
  assert.equal(fileLines('100'), 2)
  assert.equal(fileLines('200'), 1)
  const rows = await rawStore.readRange('100', 0, Number.MAX_SAFE_INTEGER)
  assert.deepEqual(rows.map(r => r.messageId), ['a1', 'a2'])
  assert.equal(rows[0].text, '第一天的消息', 'payload 必须原样带过去')
  assert.equal(result.dbsize.dropped, false, '只加不删：dbsize 不得减少')
})

test('幂等：第二次执行 appended=0、skipped=首次条数，文件行数不变', async () => {
  const first = await runMigration({ store, rawStore })
  const linesAfterFirst = fileLines('100') + fileLines('200')

  const second = await runMigration({ store, rawStore })
  assert.equal(second.appended, 0)
  assert.equal(second.skipped, first.appended)
  assert.equal(second.failed.length, 0)
  assert.equal(fileLines('100') + fileLines('200'), linesAfterFirst, '重复执行不能把文件写翻倍')
})

test('Redis 里已过期的 key（get 返回 null）不计入对账，也不写入文件', async () => {
  // 索引里留着 id，但正文已被 TTL 清掉
  redis.zsets.get(RAWIDX('100')).set('gone', T1)
  assert.equal(redis.strings.has(RAW('100', 'gone')), false)

  const plan = await planMigration({ store, rawStore })
  assert.equal(plan.groups.find(g => g.groupId === '100').redisCount, 2, '过期 key 不算条数')

  await runMigration({ store, rawStore })
  const rows = await rawStore.readRange('100', 0, Number.MAX_SAFE_INTEGER)
  assert.deepEqual(rows.map(r => r.messageId), ['a1', 'a2'])
})

test('文件里多出的 messageId 不算冲突：迁移照常补齐 Redis 旧行', async () => {
  await rawStore.append('300', { groupId: '300', messageId: 'orphan', time: T1, text: '文件里已有的行' })
  redis.zsets.set(RAWIDX('300'), new Map([['missing1', T1], ['missing2', T2]]))

  const result = await runMigration({ store, rawStore })

  assert.deepEqual(result.failed, [], '多出的行是切文件模式后新采集的数据，不能判失败')
  assert.equal(fileLines('300'), 1, '没有可补的 Redis 行时文件保持原样')
  assert.equal(result.appended, 3, '其他群照常迁移')
})

test('不一致：同一 messageId 两侧内容不同 → 该群 failed，不追加第二份', async () => {
  await rawStore.append('200', { groupId: '200', messageId: 'b1', time: T1, text: '被改过的文本' })

  const result = await runMigration({ store, rawStore })

  assert.deepEqual(result.failed.map(f => f.groupId), ['200'])
  assert.match(result.failed[0].reason, /内容不一致/)
  assert.equal(fileLines('200'), 1)
})

test('校验：迁移后一致；文件被篡改时能报出差异', async () => {
  await runMigration({ store, rawStore })
  const clean = await verifyMigration({ store, rawStore })
  assert.equal(clean.ok, true, `干净迁移不应有差异：${JSON.stringify(clean.diffs)}`)
  assert.equal(clean.checked, 3)

  // 篡改文件里第一条的正文
  const file = path.join(baseDir, '100', '2026-03-01.ndjson')
  const tampered = fs.readFileSync(file, 'utf8').replace('第一天的消息', '被篡改的消息')
  fs.writeFileSync(file, tampered)

  const dirty = await verifyMigration({ store, rawStore })
  assert.equal(dirty.ok, false)
  const diff = dirty.diffs.find(d => d.field === 'text')
  assert.ok(diff, `应报出 text 差异：${JSON.stringify(dirty.diffs)}`)
  assert.equal(diff.messageId, 'a1')
  assert.equal(diff.kind, 'changed')
  assert.equal(diff.redis, '第一天的消息')
  assert.equal(diff.file, '被篡改的消息')
})

test('校验：文件缺行时报告 missing-in-file', async () => {
  await runMigration({ store, rawStore })
  fs.rmSync(path.join(baseDir, '200'), { recursive: true, force: true })

  const result = await verifyMigration({ store, rawStore })
  assert.equal(result.ok, false)
  assert.deepEqual(result.diffs.map(d => [d.groupId, d.kind]), [['200', 'missing-in-file']])
})

test('onProgress 每个群回调一次，失败群也回调', async () => {
  redis.zsets.set(RAWIDX('300'), new Map([['missing1', T1]]))
  await rawStore.append('300', { groupId: '300', messageId: 'orphan', time: T1, text: 'x' })

  const seen = []
  await runMigration({ store, rawStore, onProgress: p => seen.push([p.groupId, p.status]) })

  assert.deepEqual(seen, [['100', 'ok'], ['200', 'ok'], ['300', 'ok']])
})

test('一次处理全部群：不再分批，60 个新群一轮全部落盘', async () => {
  for (let i = 0; i < 60; i++) seed(redis, `9${String(i).padStart(3, '0')}`, { messageId: `m${i}`, time: T1, text: `第${i}群` })

  const plan = await planMigration({ store, rawStore })
  assert.equal(plan.totals.groups, 62, '100/200 + 60 个新群全部在计划里')

  const result = await runMigration({ store, rawStore })
  assert.equal(result.groups.length, 62)
  assert.equal(fs.readdirSync(baseDir).length, 62, '每个群都应生成目录')
  assert.equal(result.failed.length, 0)
})

test('索引缺失的孤儿原文也要迁进文件（只信 rawIdx 会永久漏掉）', async () => {
  // 原文键存在，但 rawIdx 里没有这个成员（索引重建/写入中断都会造成）
  redis.strings.set(RAW('100', 'orphan1'), JSON.stringify({
    messageId: 'orphan1', senderId: '1', senderName: 'A', role: '', text: '索引外的孤儿原文',
    time: T2, isCommand: false, contentHash: 'h-orphan1', groupId: '100'
  }))

  const result = await runMigration({ store, rawStore })

  assert.equal(result.failed.length, 0)
  const rows = await rawStore.readRange('100', 0, Number.MAX_SAFE_INTEGER)
  assert.ok(rows.some(r => r.messageId === 'orphan1'), '孤儿原文必须出现在文件里')
  assert.equal(result.appended, 4, '原有 3 条 + 孤儿 1 条')
})
