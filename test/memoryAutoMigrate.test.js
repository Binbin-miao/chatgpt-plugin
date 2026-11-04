/**
 * 面板切换触发的自动迁移：只测编排与失败回滚，迁移本身由 memoryMigration.test.js 覆盖。
 *
 * 运行：node --experimental-test-module-mocks --test test/memoryAutoMigrate.test.js
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {}, trace() {}, log() {} }

let calls = 0
let shouldFail = false
/** 模拟「部分群失败」：runMigration 是逐群 try/catch，失败只进 failed 数组、从不抛错 */
let failedGroups = []

mock.module('../utils/memory/migrateRawToFile.js', {
  namedExports: {
    planMigration: async () => ({ totals: { groups: 0, redisCount: 0, fileCount: 0, toAppend: 0 } }),
    runMigration: async () => {
      calls++
      if (shouldFail) throw new Error('磁盘写满')
      return { groups: [{ groupId: '100' }, { groupId: '200' }], appended: 3, skipped: 1, failed: failedGroups }
    },
    verifyMigration: async () => ({ ok: true, groups: [] })
  }
})

const { migrateRawOnSwitch } = await import('../utils/memory/autoMigrate.js')
const { Config } = await import('../utils/config.js')
const { acquireHeavyTask, releaseHeavyTask } = await import('../utils/memory/heavyTask.js')

const notes = []

beforeEach(() => {
  calls = 0
  shouldFail = false
  failedGroups = []
  notes.length = 0
  Config.memoryStorage = 'redis'
})

afterEach(() => {
  Config.memoryStorage = 'redis'
  releaseHeavyTask()
})

const run = (overrides = {}) => migrateRawOnSwitch({
  store: {},
  rawStore: {},
  saveConfig: () => {},
  notify: (text) => notes.push(text),
  ...overrides
})

test('成功：迁移跑两遍（第二遍补迁移期间的新消息），然后切到 file', async () => {
  const result = await run()

  assert.equal(result.ok, true)
  assert.equal(calls, 2, '必须跑两遍：全量 + 增量')
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

test('锁被占用：直接跳过，不重复跑迁移', async () => {
  acquireHeavyTask('记忆迁移')
  const result = await run()

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'busy')
  assert.equal(calls, 0)
  assert.match(notes.at(-1), /已有「记忆迁移」在跑/)
})
