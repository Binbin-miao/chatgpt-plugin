/**
 * B8 更新流程：纯决策 + 真实目录探测。
 *
 * 分两层跑：
 * - 决策层（updateGuard）逐条锁四象限 / 安装器 / 配置校验，不碰文件系统
 * - 探测层（updateProbe）在 `fs.mkdtemp` 的临时 git 仓库里跑真实 git 与 node，
 *   断言「有修复模块的 commit → A」「没有的 commit → C」。不碰真实仓库、不联网。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

const {
  REQUIRED_MODULES,
  decideUpdateOutcome,
  evaluateUpdate,
  pickInstaller,
  validateConfig,
  isGateUnsupported
} = await import('../utils/updateGuard.js')
const {
  probeModuleGates,
  probeWorkTree,
  shortHead,
  backupConfig,
  restoreConfig,
  readConfigText,
  runCommand,
  configPathOf
} = await import('../utils/updateProbe.js')

// ---------------------------------------------------------------- 决策层

test('四象限 A：门都过 + hash 变了 → 装依赖并重启', () => {
  const outcome = decideUpdateOutcome({
    filesPresent: true, filesImportable: true, hashChanged: true,
    version: '2.8.6', oldHash: 'c9884974', newHash: 'a1b2c3d4'
  })
  assert.equal(outcome.quadrant, 'A')
  assert.equal(outcome.action, 'update')
  assert.equal(outcome.message, 'chatgpt-plugin 2.8.6@c9884974 → 2.8.6@a1b2c3d4',
    '版本号不变，回显里 hash 是唯一能区分修复前后'
  )
})

test('四象限 B：门都过 + hash 没变 → 已是修复版，不装依赖不重启', () => {
  const outcome = decideUpdateOutcome({
    filesPresent: true, filesImportable: true, hashChanged: false,
    version: '2.8.6', oldHash: 'a1b2c3d4', newHash: 'a1b2c3d4'
  })
  assert.equal(outcome.quadrant, 'B')
  assert.equal(outcome.action, 'noop')
  assert.match(outcome.message, /当前已是修复版 2\.8\.6@a1b2c3d4，无需更新/)
})

test('四象限 C：门不过 + hash 变了 → 回滚，并列出缺哪个文件', () => {
  const outcome = decideUpdateOutcome({
    filesPresent: false, filesImportable: false, hashChanged: true,
    missing: ['utils/conversationKey.js', 'utils/conversationMigration.js'],
    version: '2.8.6', oldHash: 'c9884974', newHash: 'deadbeef'
  })
  assert.equal(outcome.quadrant, 'C')
  assert.equal(outcome.action, 'rollback')
  assert.match(outcome.message, /已拉到 2\.8\.6@deadbeef/)
  assert.match(outcome.message, /utils\/conversationKey\.js/)
  assert.match(outcome.message, /已回滚到 2\.8\.6@c9884974/)
})

test('四象限 D：门不过 + hash 没变 → 不回滚（reset 到同一 commit 是空动作），只报告', () => {
  const outcome = decideUpdateOutcome({
    filesPresent: false, filesImportable: false, hashChanged: false,
    missing: ['utils/conversationKey.js'],
    version: '2.8.6', oldHash: 'c9884974', newHash: 'c9884974'
  })
  assert.equal(outcome.quadrant, 'D')
  assert.equal(outcome.action, 'report')
  assert.doesNotMatch(outcome.message, /已回滚/, 'D 场景说「已回滚」就是撒谎')
  assert.match(outcome.message, /当前已是 origin\/v2 最新/)
  assert.match(outcome.message, /修复还没合进 origin\/v2/)
})

test('门2 环境不支持时降级并明示，不许静默通过', () => {
  for (const stderr of ['node: bad option: --input-type', 'unknown option -e', 'not supported in this runtime']) {
    assert.equal(isGateUnsupported(stderr), true, stderr)
  }
  assert.equal(isGateUnsupported('SyntaxError: Unexpected token'), false)
  assert.equal(isGateUnsupported('ERR_MODULE_NOT_FOUND'), false)

  const outcome = decideUpdateOutcome({
    filesPresent: true, filesImportable: true, hashChanged: true, degraded: true,
    version: '2.8.6', oldHash: 'a', newHash: 'b'
  })
  assert.match(outcome.message, /已降级为语法检查/, '降级必须在回复里写出来')
})

test('安装器选择：pnpm → npm ci → npm install --omit=dev', () => {
  assert.deepEqual(pickInstaller({ hasPnpm: true, hasLock: false }).args, ['i'])
  assert.equal(pickInstaller({ hasPnpm: true, hasLock: false }).manager, 'pnpm')

  const ci = pickInstaller({ hasPnpm: false, hasLock: true })
  assert.equal(ci.manager, 'npm')
  assert.deepEqual(ci.args, ['ci'])

  // 线上就是这个组合：没有 pnpm，锁文件是 pnpm-lock.yaml（没有 package-lock.json）
  const fallback = pickInstaller({ hasPnpm: false, hasLock: false })
  assert.equal(fallback.manager, 'npm')
  assert.deepEqual(fallback.args, ['install', '--omit=dev'])
})

test('配置校验：更新后文件不见了', () => {
  const result = validateConfig('{"a":1,"b":2}', null)
  assert.equal(result.ok, false)
  assert.equal(result.exists, false)
  assert.equal(result.problems[0].kind, 'missing')
})

test('配置校验：更新后能读到但解析失败', () => {
  const result = validateConfig('{"a":1}', '{坏掉的 JSON')
  assert.equal(result.ok, false)
  assert.equal(result.exists, true)
  assert.equal(result.problems[0].kind, 'unparsable')
})

test('配置校验：顶层 key 数变了（78 → 12），要点出两个数字', () => {
  const before = JSON.stringify(Object.fromEntries(Array.from({ length: 78 }, (_, i) => [`k${i}`, i])))
  const after = JSON.stringify(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i])))
  const result = validateConfig(before, after)
  assert.equal(result.ok, false)
  assert.equal(result.beforeKeyCount, 78)
  assert.equal(result.afterKeyCount, 12)
  assert.equal(result.problems[0].kind, 'key-count-changed')
  assert.match(result.problems[0].message, /从 78 变成 12/)

  // 键相同就不该报问题
  assert.equal(validateConfig(before, before).ok, true)
  // 首次安装没有基线，不做 key 数比较
  assert.equal(validateConfig(null, after).ok, true)
})

// ---------------------------------------------------------------- 探测层

function git(dir, args) {
  return new Promise(resolve => {
    import('node:child_process').then(({ execFile }) => {
      execFile('git', args, { cwd: dir, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') })
      })
    })
  })
}

const PURE_MODULE = 'export const marker = 1\n'

function writeFile(dir, relative, content) {
  const target = path.join(dir, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}

test('集成：真实 git 仓库里两个 commit，判定落在 A 与 C', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-update-'))
  try {
    writeFile(dir, 'package.json', JSON.stringify({ name: 'chatgpt-plugin', version: '2.8.6', type: 'module' }))
    writeFile(dir, 'index.js', 'export default {}\n')
    await git(dir, ['init'])
    await git(dir, ['config', 'user.email', 'fixture@example.invalid'])
    await git(dir, ['config', 'user.name', 'fixture'])
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-m', 'base：没有修复模块'])
    const oldHash = await shortHead(dir)
    assert.ok(oldHash, '要先拿到旧 commit')

    // 第二个 commit：把两个修复模块加进来（纯模块，必须能独立 import）
    writeFile(dir, REQUIRED_MODULES[0], PURE_MODULE)
    writeFile(dir, REQUIRED_MODULES[1], PURE_MODULE)
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-m', 'fix：加上会话键与迁移模块'])
    const newHash = await shortHead(dir)
    assert.notEqual(newHash, oldHash)

    // —— 正常更新：旧 commit → 新 commit，门都过 → A
    await git(dir, ['reset', '--hard', newHash])
    let gates = await probeModuleGates(dir, REQUIRED_MODULES)
    assert.equal(gates.filesPresent, true, '两个文件都要在')
    assert.equal(gates.filesImportable, true, `加载门要过：${JSON.stringify(gates.failures)}`)
    let outcome = evaluateUpdate({ ...gates, oldHash, newHash, version: '2.8.6' })
    assert.equal(outcome.quadrant, 'A')
    assert.match(outcome.message, new RegExp(`2\\.8\\.6@${oldHash} → 2\\.8\\.6@${newHash}`))

    // —— 拉到了不含修复的 commit：新 commit → 旧 commit，门不过且 hash 变了 → C（要回滚）
    await git(dir, ['reset', '--hard', oldHash])
    gates = await probeModuleGates(dir, REQUIRED_MODULES)
    assert.equal(gates.filesPresent, false)
    assert.deepEqual(gates.missing, REQUIRED_MODULES)
    outcome = evaluateUpdate({ ...gates, oldHash: newHash, newHash: oldHash, version: '2.8.6' })
    assert.equal(outcome.quadrant, 'C')
    assert.equal(outcome.action, 'rollback')

    // —— 停在旧 commit 且 hash 没变：D（不回滚，只说明修复没合进 origin/v2）
    outcome = evaluateUpdate({ ...gates, oldHash, newHash: oldHash, version: '2.8.6' })
    assert.equal(outcome.quadrant, 'D')
    assert.equal(outcome.action, 'report')

    // —— 文件在但加载不了（半截文件）：门2 必须拦住
    await git(dir, ['reset', '--hard', newHash])
    writeFile(dir, REQUIRED_MODULES[0], 'export const broken = (\n')
    gates = await probeModuleGates(dir, REQUIRED_MODULES)
    assert.equal(gates.filesPresent, true)
    assert.equal(gates.filesImportable, false, '文件存在不等于能加载')
    assert.equal(gates.failures[0].file, REQUIRED_MODULES[0])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('非 git 目录：探测直接判否，不留任何写操作', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-notgit-'))
  try {
    const probe = await probeWorkTree(dir)
    assert.equal(probe.isWorkTree, false)
    assert.equal(probe.missingCommand, false, 'git 存在但这里不是仓库')
    assert.deepEqual(fs.readdirSync(dir), [], '探测不许在目录里留下任何东西')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('配置备份：只保留最近 3 份，回滚能复制回去', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-config-'))
  try {
    writeFile(dir, 'config/config.json', JSON.stringify({ a: 1, b: 2 }))
    const stamps = [
      new Date(2026, 2, 1, 10, 0, 0),
      new Date(2026, 2, 2, 10, 0, 0),
      new Date(2026, 2, 3, 10, 0, 0),
      new Date(2026, 2, 4, 10, 0, 0)
    ]
    let latest = null
    for (const now of stamps) latest = await backupConfig(dir, { now })
    const backups = fs.readdirSync(path.join(dir, 'config'))
      .filter(name => name.startsWith('config.json.bak-更新前-'))
      .sort()
    assert.equal(backups.length, 3, '只留最近 3 份')
    assert.ok(backups.at(-1).endsWith('20260304-100000'), '最新的那份必须在')

    // 回滚：把备份复制回 config.json
    fs.writeFileSync(configPathOf(dir), '{"broken":true}')
    assert.equal(await restoreConfig(dir, latest), true)
    assert.deepEqual(JSON.parse(await readConfigText(dir)), { a: 1, b: 2 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('vnpm 探测：命令不存在时不抛错，按可回落处理', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-installer-'))
  try {
    const ret = await runCommand(dir, 'definitely-not-a-real-command-xyz', ['--version'])
    assert.equal(ret.ok, false)
    assert.equal(ret.missingCommand, true, 'ENOENT 必须能识别成「命令不存在」而不是安装失败')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
