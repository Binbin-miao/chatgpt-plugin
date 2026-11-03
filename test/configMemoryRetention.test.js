/**
 * 锅巴「关闭后保留天数」字段与文案（T-04）
 *
 * 运行：node --test test/configMemoryRetention.test.js
 *
 * 用临时 cwd 起子进程加载 guoba.support.js：Config 的落盘路径在模块加载时按
 * `process.cwd()` 固定，同进程内 import 会写到真实仓库的 config.json。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const moduleUrl = relative => new URL(relative, import.meta.url).href

test('锅巴记忆保留期：关闭后保留天数可填 0、原文保留允许 0、非法值回退 90', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-guoba-retention-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const configDir = path.join(cwd, 'plugins/chatgpt-plugin/config')
  fs.mkdirSync(configDir, { recursive: true })
  const file = path.join(configDir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({}))

  const run = action => JSON.parse(execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import { mock } from 'node:test'
    import assert from 'node:assert/strict'
    globalThis.logger = { error: console.error, warn() {}, info() {} }
    globalThis.redis = { get: async () => null }
    mock.module(${JSON.stringify(moduleUrl('../utils/tts.js'))}, { namedExports: { speakers: [], vits_emotion_map: [] } })
    mock.module(${JSON.stringify(moduleUrl('../utils/tts/microsoft-azure.js'))}, { namedExports: { supportConfigurations: [] } })
    const { supportGuoba } = await import(${JSON.stringify(moduleUrl('../guoba.support.js'))})
    const guoba = supportGuoba().configInfo
    ${action}
    process.stdout.write(JSON.stringify(await guoba.getConfigData()))
    process.exit(0)
  `], { cwd, encoding: 'utf8', timeout: 15000 }))

  // 1. 字段存在、默认 90、可填 0
  run(`
    const closed = guoba.schemas.find(s => s.field === 'memoryGroupCapture.closedGroupRetentionDays')
    assert.ok(closed, '面板必须有「关闭后保留天数」')
    assert.equal(closed.component, 'InputNumber')
    assert.equal(closed.componentProps.min, 0)
    assert.equal(closed.componentProps.step, 1)
    assert.match(closed.bottomHelpMessage, /0/)
    assert.match(closed.bottomHelpMessage, /永不自动清理|不自动清理/)
    assert.equal((await guoba.getConfigData()).memoryGroupCapture.closedGroupRetentionDays, 90)
  `)

  // 2. 原文保留天数允许填 0，且保存后就是 0（不被夹回 1）
  run(`
    const raw = guoba.schemas.find(s => s.field === 'memoryGroupCapture.rawRetentionDays')
    assert.equal(raw.componentProps.min, 0, '原文保留天数必须允许 0')
    assert.match(raw.bottomHelpMessage, /0 = 永久保留/)
    await guoba.setConfigData({ 'memoryGroupCapture.rawRetentionDays': 0 }, { Result: { ok() {}, error(m) { throw new Error(m) } } })
  `)
  const afterRaw = JSON.parse(fs.readFileSync(file))
  assert.equal(afterRaw.memoryGroupCapture.rawRetentionDays, 0, '保存 0 后 config.json 里必须是 0')

  // 3. 群选择器文案不再引导「来源级清理」
  run(`
    const groups = guoba.schemas.find(s => s.field === 'memoryGroupCapture.groups')
    assert.doesNotMatch(groups.bottomHelpMessage, /来源级清理/)
    assert.match(groups.bottomHelpMessage, /只停止采集/)
    assert.match(groups.bottomHelpMessage, /#清理无效记忆/)

    // 原文存储后端：面板可选 redis / file，默认 redis（T-05）
    const storage = guoba.schemas.find(s => s.field === 'memoryStorage')
    assert.ok(storage, '面板必须有「群消息原文存储后端」')
    assert.equal(storage.component, 'Select')
    assert.deepEqual(storage.componentProps.options.map(o => o.value), ['redis', 'file'])
    assert.match(storage.bottomHelpMessage, /#记忆存储/)
    assert.equal((await guoba.getConfigData()).memoryStorage, 'redis')
  `)

  // 4. 非法值（负数 / 非数字）回退 90，不写坏配置
  //    回退值等于默认值，差量保存不会落这个键，所以要断言「重载后的有效值」而不是文件内容
  run(`
    await guoba.setConfigData({ 'memoryGroupCapture.closedGroupRetentionDays': -5 }, { Result: { ok() {}, error(m) { throw new Error(m) } } })
  `)
  assert.equal(run('').memoryGroupCapture.closedGroupRetentionDays, 90, '负数必须回退 90')
  run(`
    await guoba.setConfigData({ 'memoryGroupCapture.closedGroupRetentionDays': 'abc' }, { Result: { ok() {}, error(m) { throw new Error(m) } } })
  `)
  assert.equal(run('').memoryGroupCapture.closedGroupRetentionDays, 90, '非数字必须回退 90')

  // 5. 合法值原样落盘（含 0 = 永不自动清理）
  run(`
    await guoba.setConfigData({ 'memoryGroupCapture.closedGroupRetentionDays': 0 }, { Result: { ok() {}, error(m) { throw new Error(m) } } })
  `)
  assert.equal(JSON.parse(fs.readFileSync(file)).memoryGroupCapture.closedGroupRetentionDays, 0)
  const reloaded = run('')
  assert.equal(reloaded.memoryGroupCapture.closedGroupRetentionDays, 0, '重载后仍是 0')
})

test('锅巴重新勾选群时清掉历史 closedAt（sweep 自愈的窄窗口）', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-guoba-reopen-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const configDir = path.join(cwd, 'plugins/chatgpt-plugin/config')
  fs.mkdirSync(configDir, { recursive: true })
  const file = path.join(configDir, 'config.json')
  // 100 已在采集；200 曾被关闭（policy 里还留着 3 月的时间戳），面板上未选中
  fs.writeFileSync(file, JSON.stringify({
    memoryGroupCapture: { groups: [{ groupId: '100', switchOn: true }, { groupId: '200', switchOn: false }] }
  }))

  const hdel = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import { mock } from 'node:test'
    import assert from 'node:assert/strict'
    globalThis.logger = { error: console.error, warn() {}, info() {} }
    const calls = []
    globalThis.redis = {
      get: async () => null,
      hDel: async (key, ...fields) => { calls.push([key, ...fields]); return 1 }
    }
    mock.module(${JSON.stringify(moduleUrl('../utils/tts.js'))}, { namedExports: { speakers: [], vits_emotion_map: [] } })
    mock.module(${JSON.stringify(moduleUrl('../utils/tts/microsoft-azure.js'))}, { namedExports: { supportConfigurations: [] } })
    const { supportGuoba } = await import(${JSON.stringify(moduleUrl('../guoba.support.js'))})
    const guoba = supportGuoba().configInfo
    // 面板把 200 重新勾上（100 本来就是启用状态，不该被无谓地写一次）
    await guoba.setConfigData({ 'memoryGroupCapture.groups': [100, 200] }, { Result: { ok() {}, error(m) { throw new Error(m) } } })
    assert.deepEqual(calls, [['CHATGPT:MEMORY:V2:policy:200', 'closedAt', 'closedBy']])
    process.stdout.write('OK')
    process.exit(0)
  `], { cwd, encoding: 'utf8', timeout: 15000 })
  assert.match(hdel, /OK/)

  const stored = JSON.parse(fs.readFileSync(file))
  assert.deepEqual(stored.memoryGroupCapture.groups, [
    { groupId: '100', switchOn: true },
    { groupId: '200', switchOn: true }
  ], '选中状态照常落盘')
})
