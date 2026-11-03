import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const moduleUrl = relative => new URL(relative, import.meta.url).href

test('锅巴群选择器：采集群与主动打招呼读旧格式、写群号数组，落盘形状不变', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-guoba-groups-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const configDir = path.join(cwd, 'plugins/chatgpt-plugin/config')
  fs.mkdirSync(configDir, { recursive: true })
  const file = path.join(configDir, 'config.json')
  // 旧格式：采集群是对象数组（含 switchOn:false），主动打招呼是逗号字符串
  fs.writeFileSync(file, JSON.stringify({
    memoryGroupCapture: { groups: [{ groupId: '300', switchOn: false }, { groupId: '400', switchOn: true }] },
    initiativeChatGroups: '111,222'
  }))
  const run = action => JSON.parse(execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import { mock } from 'node:test'
    import assert from 'node:assert/strict'
    globalThis.logger = { error: console.error, warn() {}, info() {} }
    globalThis.redis = { get: async () => null }
    mock.module(${JSON.stringify(moduleUrl('../utils/tts.js'))}, { namedExports: { speakers: [], vits_emotion_map: [] } })
    mock.module(${JSON.stringify(moduleUrl('../utils/tts/microsoft-azure.js'))}, { namedExports: { supportConfigurations: [] } })
    const { Config } = await import(${JSON.stringify(moduleUrl('../utils/config.js'))})
    const { supportGuoba } = await import(${JSON.stringify(moduleUrl('../guoba.support.js'))})
    const guoba = supportGuoba().configInfo
    ${action}
    process.stdout.write(JSON.stringify(await guoba.getConfigData()))
    process.exit(0)
  `], { cwd, encoding: 'utf8', timeout: 15000 }))

  const initial = run(`
    const collect = guoba.schemas.find(s => s.field === 'memoryGroupCapture.groups')
    assert.equal(collect.component, 'GSelectGroup')
    assert.equal(collect.componentProps.placeholder, '点击选择要采集的群')
    const greet = guoba.schemas.find(s => s.field === 'initiativeChatGroups')
    assert.equal(greet.component, 'GSelectGroup')
    assert.equal(greet.componentProps.placeholder, '点击选择要主动打招呼的群')
    const current = await guoba.getConfigData()
    // 面板只展示开启中的群；switchOn:false 的历史记录不显示
    assert.deepEqual(current.memoryGroupCapture.groups, [400])
    // 旧的逗号字符串在面板上是数组，组件才能渲染
    assert.deepEqual(current.initiativeChatGroups, [111, 222])
  `)
  assert.deepEqual(initial.memoryGroupCapture.groups, [400])
  assert.deepEqual(initial.initiativeChatGroups, [111, 222])

  run(`
    await guoba.setConfigData({
      'memoryGroupCapture.groups': ['100', 200, '100', '坏值'],
      'initiativeChatGroups': []
    }, { Result: { ok() {}, error(message) { throw new Error(message) } } })
  `)

  const stored = JSON.parse(fs.readFileSync(file))
  // 采集群落盘仍是对象数组，去重、数字转字符串、非法值丢弃
  assert.deepEqual(stored.memoryGroupCapture.groups, [
    { groupId: '100', switchOn: true },
    { groupId: '200', switchOn: true }
  ])
  // 清空后与默认值一致，差量保存不再写这个键（重载回默认空数组，而不是旧群号）
  assert.equal(stored.initiativeChatGroups, undefined)

  const reloaded = run('')
  assert.deepEqual(reloaded.memoryGroupCapture.groups, [100, 200])
  assert.deepEqual(reloaded.initiativeChatGroups, [])

  // 字段缺值（null）一律按「本次没改」处理，不能把已选群清空
  run(`
    await guoba.setConfigData({ 'initiativeChatGroups': ['111', '555'] }, { Result: { ok() {} } })
    await guoba.setConfigData({ 'memoryGroupCapture.groups': null, 'initiativeChatGroups': null }, { Result: { ok() {} } })
  `)
  const afterNull = run('')
  assert.deepEqual(afterNull.memoryGroupCapture.groups, [100, 200])
  assert.deepEqual(afterNull.initiativeChatGroups, [111, 555])

  // 旧缓存页面按对象数组提交时，它自己的开关状态必须保留：不能把已暂停的群悄悄打开
  run(`
    await guoba.setConfigData({
      'memoryGroupCapture.groups': [{ groupId: '500', switchOn: false }, { groupId: '600', switchOn: true }]
    }, { Result: { ok() {} } })
  `)
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).memoryGroupCapture.groups, [
    { groupId: '500', switchOn: false },
    { groupId: '600', switchOn: true }
  ])
  assert.deepEqual(run('').memoryGroupCapture.groups, [600])
})
