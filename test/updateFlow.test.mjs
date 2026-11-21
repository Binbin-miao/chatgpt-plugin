/**
 * B8 编排层：`apps/update.js` 只按决策执行，这里把 I/O 全部挡在 seam 上（mock updateProbe），
 * 决策本身用真实的 updateGuard。跑的是真实的 update() / runUpdate() 流程。
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

mock.module('../../../lib/plugins/plugin.js', { defaultExport: class {} })

const state = {
  heads: [],
  gates: { filesPresent: true, filesImportable: true, missing: [], degraded: false, failures: [] },
  installers: { hasPnpm: false, hasLock: false },
  results: {},
  commands: [],
  workTree: { ok: true, isWorkTree: true, missingCommand: false, detail: '' },
  configBefore: '{"a":1,"b":2}',
  configAfter: '{"a":1,"b":2}'
}

mock.module('../utils/updateProbe.js', {
  namedExports: {
    probeWorkTree: async () => state.workTree,
    shortHead: async () => state.heads.shift() ?? 'bbbb2222',
    probeModuleGates: async () => state.gates,
    probeInstallers: async () => state.installers,
    readConfigText: async () => state.configAfter,
    backupConfig: async () => '/tmp/config.json.bak-更新前-20260101-000000',
    restoreConfig: async () => true,
    configPathOf: () => '/tmp/config.json',
    backupStamp: () => '20260101-000000',
    runCommand: async (cwd, command, args = []) => {
      const line = [command, ...args].join(' ')
      state.commands.push(line)
      return state.results[`${command} ${args[0] ?? ''}`.trim()] || { ok: true, code: 0, stdout: '', stderr: '', missingCommand: false }
    }
  }
})

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
globalThis.Bot = { uin: [] }
globalThis.redis = { set: async () => 'OK', del: async () => 1 }

// 真实的插件目录（带 package.json）：版本号只读不改，用它验证回显里的 2.8.6@hash
const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-update-flow-'))
fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'chatgpt-plugin', version: '2.8.6', type: 'module' }))
process.on('exit', () => { try { fs.rmSync(pluginDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ } })

const { Update } = await import('../apps/update.js')

function makeUpdate(overrides = {}) {
  const replies = []
  const update = Object.create(Update.prototype)
  update.e = { isMaster: true, msg: '#chatgpt强制更新', isGroup: false, logFnc: '', reply: async () => {} }
  update.reply = async value => { replies.push(String(value)) }
  update.pluginDir = pluginDir
  const restored = []
  for (const [key, value] of Object.entries(overrides)) update[key] = value
  return { update, replies, restored }
}

function resetState() {
  state.heads = []
  state.gates = { filesPresent: true, filesImportable: true, missing: [], degraded: false, failures: [] }
  state.installers = { hasPnpm: false, hasLock: false }
  state.results = {}
  state.commands = []
  state.workTree = { ok: true, isWorkTree: true, missingCommand: false, detail: '' }
  state.configBefore = '{"a":1,"b":2}'
  state.configAfter = '{"a":1,"b":2}'
}

test('装依赖失败：不置 isUp、不重启、回滚到旧 commit', async () => {
  resetState()
  state.heads = ['aaaa1111', 'bbbb2222']
  state.results['npm install'] = { ok: false, code: 1, stdout: '', stderr: 'EACCES: permission denied', missingCommand: false }
  const { update, replies } = makeUpdate()
  const restarts = []
  update.restart = () => restarts.push(1)

  const result = await update.update()

  assert.equal(result, false)
  assert.equal(update.isUp, false, '装依赖失败绝不能置 isUp——否则会带着坏依赖重启')
  assert.deepEqual(restarts, [], '不许重启')
  assert.ok(state.commands.includes('git reset --hard aaaa1111'), `必须回滚，实际命令：${state.commands.join(' ; ')}`)
  const rollbackAt = state.commands.indexOf('git reset --hard aaaa1111')
  assert.ok(!state.commands.slice(rollbackAt).some(line => line.startsWith('git clean')), '回滚里不许再 clean（会二次破坏）')
  assert.ok(replies.some(text => text.includes('依赖安装失败')), `要告诉用户卡在哪：${replies.join(' | ')}`)
  assert.ok(replies.some(text => text.includes('已回滚到 aaaa1111')))
})

test('装依赖成功 + 自检通过：才置 isUp，先提示再重启（2 秒）', async t => {
  resetState()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  state.heads = ['aaaa1111', 'bbbb2222']
  const { update, replies } = makeUpdate()
  const restarts = []
  update.restart = () => restarts.push(1)

  const result = await update.update()

  assert.equal(result, true)
  assert.equal(update.isUp, true)
  assert.ok(state.commands.some(line => line.startsWith('npm install --omit=dev')), '线上没有 pnpm，必须回落到 npm')
  assert.equal(state.commands.filter(line => line === 'git reset --hard aaaa1111').length, 0, '成功路径不许回滚')
  assert.ok(replies.some(text => text.includes('2.8.6@aaaa1111 →')), '回显要带 hash（版本号不变时它是唯一区分）')
  assert.deepEqual(restarts, [], '还没到重启时间')
  const notice = replies.findIndex(text => text.includes('即将重启'))
  assert.ok(notice >= 0, '重启前必须先说一句，别让用户以为掉线')
  t.mock.timers.tick(2000)
  assert.deepEqual(restarts, [1], '2 秒后才重启，且只重启一次')
  assert.ok(notice < replies.length, '提示要在重启之前发出')
})

test('B 象限：已在修复版上 → 不装依赖、不重启、不回滚', async () => {
  resetState()
  state.heads = ['bbbb2222', 'bbbb2222']
  const { update, replies } = makeUpdate()
  const restarts = []
  update.restart = () => restarts.push(1)

  const result = await update.update()

  assert.equal(result, true)
  assert.equal(update.isUp, false)
  assert.equal(state.commands.filter(line => line.includes('npm')).length, 0, 'B 场景不装依赖')
  assert.deepEqual(restarts, [])
  assert.ok(replies.some(text => text.includes('当前已是修复版')))
})

test('D 象限：门不过且 hash 没变 → 不回滚，明确说修复没合进 origin/v2', async () => {
  resetState()
  state.heads = ['aaaa1111', 'aaaa1111']
  state.gates = { filesPresent: false, filesImportable: false, missing: ['utils/conversationKey.js'], degraded: false, failures: [] }
  const { update, replies } = makeUpdate()

  const result = await update.update()

  assert.equal(result, false)
  assert.equal(update.isUp, false)
  assert.equal(state.commands.filter(line => line === 'git reset --hard aaaa1111').length, 0,
    'D 场景 reset 到同一 commit 是空动作，不许假装回滚')
  assert.ok(replies.some(text => text.includes('修复还没合进 origin/v2')), replies.join(' | '))
})

test('C 象限：门不过但 hash 变了 → 回滚并列出缺失文件', async () => {
  resetState()
  state.heads = ['aaaa1111', 'cccc3333']
  state.gates = { filesPresent: false, filesImportable: false, missing: ['utils/conversationMigration.js'], degraded: false, failures: [] }
  const { update, replies } = makeUpdate()

  const result = await update.update()

  assert.equal(result, false)
  assert.equal(update.isUp, false)
  assert.ok(state.commands.includes('git reset --hard aaaa1111'))
  assert.ok(replies.some(text => text.includes('utils/conversationMigration.js')))
})

test('非 git 目录：直接拒绝，零次 git 写操作', async () => {
  resetState()
  state.workTree = { ok: false, isWorkTree: false, missingCommand: false, detail: 'not a git repository' }
  const { update, replies } = makeUpdate()

  const result = await update.update()

  assert.equal(result, false)
  assert.equal(state.commands.length, 0, '不是仓库时一次命令都不许跑（reset/clean 会毁掉手工目录）')
  assert.ok(replies.some(text => text.includes('不是 git 仓库')), replies.join(' | '))
})

test('抢不到更新锁：拒绝并提示，不跑任何命令', async () => {
  resetState()
  const { update, replies } = makeUpdate()
  const original = globalThis.redis.set
  globalThis.redis.set = async () => null
  try {
    const result = await update.update()
    assert.equal(result, false)
    assert.equal(state.commands.length, 0)
    assert.ok(replies.some(text => text.includes('正在更新中')), replies.join(' | '))
  } finally {
    globalThis.redis.set = original
  }
})
