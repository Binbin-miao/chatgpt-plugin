/**
 * 面板切换触发的自动迁移：只测编排与失败回滚，迁移本身由 memoryMigration.test.js 覆盖。
 *
 * 运行：node --experimental-test-module-mocks --test --test-force-exit test/memoryAutoMigrate.test.js
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {}, trace() {}, log() {} }

let calls = 0
let shouldFail = false
/** 第二遍（尾窗补迁）抛错，与第一遍分开控制 */
let shouldFailOnTail = false
/** 模拟「部分群失败」：runMigration 是逐群 try/catch，失败只进 failed 数组、从不抛错 */
let failedGroups = []
/** 尾窗那一遍的失败群 */
let tailFailedGroups = []
/** 记录 runMigration 实际收到的参数：注入的 rawStore 被吞掉就等于迁到不存在的后端 */
let lastArgs = null

mock.module('../utils/memory/migrateRawToFile.js', {
  namedExports: {
    planMigration: async () => ({ totals: { groups: 0, redisCount: 0, fileCount: 0, toAppend: 0 } }),
    runMigration: async (args) => {
      calls++
      lastArgs = args
      const isTail = calls > 1
      if (isTail ? shouldFailOnTail : shouldFail) throw new Error('磁盘写满')
      return {
        groups: [{ groupId: '100' }, { groupId: '200' }],
        appended: 3,
        skipped: 1,
        failed: isTail ? tailFailedGroups : failedGroups
      }
    },
    verifyMigration: async () => ({ ok: true, groups: [] })
  }
})

const { migrateRawOnSwitch, resumePendingRawTail } = await import('../utils/memory/autoMigrate.js')
const { Config } = await import('../utils/config.js')
const { acquireHeavyTask, releaseHeavyTask, heavyTaskOwner } = await import('../utils/memory/heavyTask.js')

const notes = []

beforeEach(() => {
  calls = 0
  shouldFail = false
  shouldFailOnTail = false
  failedGroups = []
  tailFailedGroups = []
  lastArgs = null
  notes.length = 0
  Config.memoryStorage = 'redis'
  Config.memoryStorageTailPendingAt = 0
})

afterEach(() => {
  Config.memoryStorage = 'redis'
  Config.memoryStorageTailPendingAt = 0
  releaseHeavyTask()
})

const run = (overrides = {}) => migrateRawOnSwitch({
  store: {},
  rawStore: {},
  saveConfig: () => {},
  notify: (text) => notes.push(text),
  ...overrides
})

test('成功：迁移跑两遍（第二遍补尾窗的新消息），然后切到 file', async () => {
  const result = await run()

  assert.equal(result.ok, true)
  assert.equal(calls, 2, '必须跑两遍：全量 + 尾窗')
  assert.equal(Config.memoryStorage, 'file')
  assert.match(notes.at(-1), /已切到文件后端/)
})

test('失败：保持 redis 并通知，绝不切到 file', async () => {
  shouldFail = true
  const result = await run()

  assert.equal(result.ok, false)
  assert.equal(Config.memoryStorage, 'redis', '迁移失败必须留在 Redis，否则历史读不到')
  assert.match(notes.at(-1), /迁移失败/)
})

test('部分群失败：同样不切 file——file 模式只读文件，切过去那些群的历史会当场消失', async () => {
  failedGroups = [{ groupId: '300', reason: '磁盘已满' }]
  const result = await run()

  assert.equal(result.ok, false)
  assert.equal(Config.memoryStorage, 'redis', '有群没迁完就不能切，否则读路径拿不到那些群')
  assert.equal(result.failed.length, 1, '要把失败的群原样回传给调用方，不能只在文案里提一句')
  assert.equal(result.failed[0].groupId, '300')
  assert.match(notes.at(-1), /1 个群未迁完/)
})

test('通知抛异常：迁移结果不受影响，配置照样切到 file', async () => {
  const result = await run({ notify: () => { throw new Error('QQ 发送失败') } })

  assert.equal(result.ok, true)
  assert.equal(Config.memoryStorage, 'file')
})

test('已经是 file：直接返回，不重复跑也不改写配置', async () => {
  Config.memoryStorage = 'file'
  const result = await run()

  assert.equal(result.ok, true)
  assert.equal(result.reason, 'already')
  assert.equal(calls, 0, '不该白跑两遍几十万条，失败还会把配置降级回 redis')
})

test('任何退出路径都释放锁：成功、抛错、部分失败都不留残留', async () => {
  await run()
  assert.equal(heavyTaskOwner(), '', '成功路径必须释放，否则后续所有迁移都会被判定 busy')

  Config.memoryStorage = 'redis'
  shouldFail = true
  await run()
  assert.equal(heavyTaskOwner(), '', '迁移抛错路径必须释放')
  shouldFail = false

  Config.memoryStorage = 'redis'
  failedGroups = [{ groupId: '300' }]
  await run()
  assert.equal(heavyTaskOwner(), '', '部分失败路径必须释放')
})

test('成功时把 file 真的落盘：saveConfig 被调用一次，且此刻值已是 file', async () => {
  const saved = []
  await run({ saveConfig: () => saved.push(Config.memoryStorage) })

  assert.deepEqual(saved, ['file'], '不落盘的话重启后配置回退 redis，而文件里已经有数据')
})

test('尾窗补迁有群失败：已经切了 file，不报失败但通知必须点名怎么补', async () => {
  tailFailedGroups = [{ groupId: '400', reason: '磁盘已满' }]
  const result = await run()

  assert.equal(result.ok, true, '第一遍已成功，整体不该显示为失败')
  assert.equal(Config.memoryStorage, 'file', '回滚会把缺口挪到另一段，反而更差')
  assert.equal(result.failed.length, 1, '失败的群要回传给调用方')
  assert.match(notes.at(-1), /没补上/)
  assert.match(notes.at(-1), /#记忆迁移到文件/)
})

test('尾窗补迁抛错：配置留在 file，并告诉主人用哪条指令补', async () => {
  shouldFailOnTail = true
  const result = await run()

  assert.equal(result.ok, true)
  assert.equal(Config.memoryStorage, 'file')
  assert.match(notes.at(-1), /补最后几分钟的新原文时出错/)
})

test('部分失败时落盘的是 redis，不是 file', async () => {
  failedGroups = [{ groupId: '300' }]
  const saved = []
  await run({ saveConfig: () => saved.push(Config.memoryStorage) })

  assert.deepEqual(saved, ['redis'])
})

test('runMigration 拿到的是注入的 store 与 rawStore，不会迁到别的后端', async () => {
  const store = { name: 'store' }
  const rawStore = { name: 'rawStore' }
  await run({ store, rawStore })

  assert.equal(lastArgs.store, store)
  assert.equal(lastArgs.rawStore, rawStore)
})

test('没传 rawStore 时回落到 store 自带的那个', async () => {
  const storeRaw = { name: 'storeRaw' }
  await run({ store: { rawStore: storeRaw }, rawStore: undefined })

  assert.equal(lastArgs.rawStore, storeRaw, '兜底分支断了就等于往一个不存在的后端写')
})

test('全部成功后清掉尾窗标记', async () => {
  await run()
  assert.equal(Config.memoryStorageTailPendingAt, 0, '不清的话每次启动都会白补一遍')
})

test('尾窗失败时标记保留，下次启动或保存会重试', async () => {
  tailFailedGroups = [{ groupId: '400' }]
  await run()

  assert.ok(Config.memoryStorageTailPendingAt > 0, '没补完就清标记，那批消息会随 Redis TTL 无声消失')
})

test('顺序契约：标记必须早于 file 落盘', async () => {
  const writes = []
  await run({
    saveConfig: () => writes.push({
      storage: Config.memoryStorage,
      pending: Config.memoryStorageTailPendingAt
    })
  })

  const fileWrite = writes.find(w => w.storage === 'file')
  assert.ok(fileWrite, '必须真的把 file 落盘')
  assert.ok(fileWrite.pending > 0, '切 file 那一刻标记必须已经写了，否则进程被杀就永远没人知道尾窗没补')
})

test('已是 file 但尾窗标记还在：面板再保存必须接着补，不用等重启', async () => {
  Config.memoryStorage = 'file'
  Config.memoryStorageTailPendingAt = Date.now()
  const result = await run()

  assert.equal(calls, 1, '标记还在就要补一遍；只回「无需迁移」的话，用户不重启就永远补不上')
  assert.equal(result.ok, true)
  assert.equal(Config.memoryStorageTailPendingAt, 0, '补成功要清标记')
})

test('恢复：当前是 redis 后端时直接拒绝，不在错误的后端上白跑', async () => {
  Config.memoryStorage = 'redis'
  Config.memoryStorageTailPendingAt = Date.now()
  const result = await resumePendingRawTail({ store: {}, rawStore: {}, notify: t => notes.push(t) })

  assert.equal(result.reason, 'not-file')
  assert.equal(calls, 0, 'redis 后端下不该往文件里写一遍')
})

test('恢复：有标记时补一遍，成功才清标记', async () => {
  Config.memoryStorage = 'file'
  Config.memoryStorageTailPendingAt = Date.now()
  const result = await resumePendingRawTail({ store: {}, rawStore: {}, notify: t => notes.push(t) })

  assert.equal(result.ok, true)
  assert.equal(calls, 1)
  assert.equal(Config.memoryStorageTailPendingAt, 0)
})

test('恢复：没有标记时什么都不做', async () => {
  Config.memoryStorage = 'file'
  const result = await resumePendingRawTail({ store: {}, rawStore: {} })

  assert.equal(result.reason, 'no-pending')
  assert.equal(calls, 0)
})

test('恢复：没补成功就不能清标记', async () => {
  Config.memoryStorage = 'file'
  Config.memoryStorageTailPendingAt = Date.now()
  failedGroups = [{ groupId: '500' }]
  const result = await resumePendingRawTail({ store: {}, rawStore: {}, notify: t => notes.push(t) })

  assert.equal(result.ok, false)
  assert.ok(Config.memoryStorageTailPendingAt > 0)
})

test('恢复：锁被占用时跳过，避免和手动迁移各算一份快照重复写', async () => {
  Config.memoryStorage = 'file'
  Config.memoryStorageTailPendingAt = Date.now()
  acquireHeavyTask('记忆迁移')
  const result = await resumePendingRawTail({ store: {}, rawStore: {} })

  assert.equal(result.reason, 'busy')
  assert.equal(calls, 0)
})

test('锁被占用：跳过时不能把别人的锁放掉', async () => {
  acquireHeavyTask('记忆迁移')
  await run()

  assert.equal(heavyTaskOwner(), '记忆迁移', 'acquire 失败后如果也执行 release，会把正在跑的任务锁拆掉')
})

test('锁被占用：直接跳过，不重复跑迁移', async () => {
  acquireHeavyTask('记忆迁移')
  const result = await run()

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'busy')
  assert.equal(calls, 0)
  assert.match(notes.at(-1), /已有「记忆迁移」在跑/)
})
