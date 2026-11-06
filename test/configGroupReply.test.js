import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const moduleUrl = relative => new URL(relative, import.meta.url).href

test('锅巴群聊判断表格、内置提示词、数值边界与保存后重载一致，旧伪人入口失效', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-group-reply-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const configDir = path.join(cwd, 'plugins/chatgpt-plugin/config')
  fs.mkdirSync(configDir, { recursive: true })
  const file = path.join(configDir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ enableBYM: true, bymRate: 100, assistantLabel: '旧名字', tts_First_person: '测试称呼', groupReply: { systemPrompt: '旧版只在被点名时回复', decisionPrompt: '旧自定义提示词' } }))
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
  const saved = run(`
    const initial = await guoba.getConfigData()
    assert.equal(initial.groupReply.enabled, false)
    assert.equal(initial.groupReply.historyCount, 50)
    assert.equal(initial.groupReply.debounceSeconds, undefined)
    assert.equal(initial.groupReply.decisionPrompt, undefined)
    assert.equal(initial.groupReply.systemPrompt, undefined)
    assert.ok(!guoba.schemas.some(s => s.field === 'groupReply.decisionPrompt'))
    assert.ok(!guoba.schemas.some(s => s.field === 'groupReply.systemPrompt'))
    assert.equal(initial.groupReply.extraSystemPrompt, '')
    const extraPromptSchema = guoba.schemas.find(s => s.field === 'groupReply.extraSystemPrompt')
    assert.equal(extraPromptSchema.component, 'InputTextArea')
    assert.equal(extraPromptSchema.label, '补充系统提示词')
    assert.equal(initial.enableBYM, undefined)
    assert.equal(initial.assistantLabel, undefined)
    assert.equal(initial.tts_First_person, '测试称呼')
    assert.ok(!guoba.schemas.some(s => s.field === 'assistantLabel'))
    assert.equal(guoba.schemas.filter(s => s.field === 'tts_First_person').length, 1)
    const table = guoba.schemas.find(s => s.field === 'groupReply.groups')
    assert.equal(table.component, 'GSelectGroup')
    assert.equal(table.componentProps.placeholder, '点击选择要自主回复的群')
    const tuning = guoba.schemas.find(s => s.field === 'groupReply.groupTuning')
    assert.equal(tuning.component, 'GSubForm')
    assert.equal(tuning.componentProps.multiple, true)
    assert.deepEqual(tuning.componentProps.schemas.map(s => s.field), ['groupId', 'debounceSeconds', 'enthusiasm'])
    const enthusiasm = tuning.componentProps.schemas.find(s => s.field === 'enthusiasm')
    assert.equal(enthusiasm.label, '热情度（%）')
    assert.equal(enthusiasm.componentProps.placeholder, '默认 40%')
    assert.equal(enthusiasm.componentProps.min, 1)
    assert.equal(enthusiasm.componentProps.max, 100)
    const wait = tuning.componentProps.schemas.find(s => s.field === 'debounceSeconds')
    assert.equal(wait.componentProps.max, undefined)
    assert.match(wait.label, /每隔多久判断是否回复/)
    assert.ok(!guoba.schemas.some(s => s.field === 'groupReply.debounceSeconds'))
    const tabs = guoba.schemas.filter(s => s.component === 'SOFT_GROUP_BEGIN').map(s => s.label)
    // 上下文注入字段（enableHooks/hookServers）并入智能模式组、紧跟 MCP 配置，无独立分组
    assert.deepEqual(tabs.slice(tabs.indexOf('智能模式'), tabs.indexOf('小功能') + 1), ['智能模式', '主动触发', '小功能'])
    let tab
    for (const schema of guoba.schemas) {
      if (schema.component === 'SOFT_GROUP_BEGIN') tab = schema.label
      if (schema.field?.startsWith('groupReply.') || ['initiativeChatGroups', 'helloPrompt', 'helloInterval', 'helloProbability'].includes(schema.field)) assert.equal(tab, '主动触发')
    }
    assert.ok(!guoba.schemas.some(s => s.field === 'enableBYM'))
    await guoba.setConfigData({
      'groupReply.enabled': true,
      'groupReply.groups': ['100', '200', ' 100 '],
      'groupReply.groupTuning': [
        { groupId: '100', debounceSeconds: 0, enthusiasm: 0 },
        { groupId: '200', debounceSeconds: 3600, enthusiasm: 150 },
        { groupId: '300', debounceSeconds: 30, enthusiasm: 80 }
      ],
      'groupReply.historyCount': 5,
      'groupReply.provider': initial.modelProviders.responses[0].id,
      'groupReply.model': ' small-model ',
      'groupReply.decisionPrompt': '仅被点名时才回复',
      'groupReply.extraSystemPrompt': '  仅补充：优先接梗，少总结。  '
    }, { Result: { ok() {}, error(message) { throw new Error(message) } } })
  `)
  const reloaded = run('')
  assert.deepEqual(reloaded.groupReply, saved.groupReply)
  assert.equal(reloaded.tts_First_person, '测试称呼')
  assert.equal(JSON.parse(fs.readFileSync(file)).assistantLabel, undefined)
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).groupReply.groups, [{ groupId: '100', switchOn: true, debounceSeconds: 0, enthusiasm: 1 }, { groupId: '200', switchOn: true, debounceSeconds: 3600, enthusiasm: 100 }])
  assert.equal(JSON.parse(fs.readFileSync(file)).groupReply.groupTuning, undefined, '每群参数表是面板派生视图，不落盘')
  assert.equal(saved.groupReply.historyCount, 20)
  assert.equal(saved.groupReply.extraSystemPrompt, '仅补充：优先接梗，少总结。')
  assert.equal(JSON.parse(fs.readFileSync(file)).groupReply.extraSystemPrompt, '仅补充：优先接梗，少总结。')
  assert.equal(saved.groupReply.debounceSeconds, undefined)
  assert.equal(saved.groupReply.decisionPrompt, undefined)
  assert.equal(JSON.parse(fs.readFileSync(file)).groupReply.decisionPrompt, undefined)
  assert.equal(JSON.parse(fs.readFileSync(file)).groupReply.systemPrompt, undefined)
  assert.equal(saved.groupReply.model, undefined)
  assert.equal(JSON.parse(fs.readFileSync(file)).enableBYM, undefined)
  const toggled = run(`
    mock.module(${JSON.stringify(moduleUrl('../../../lib/plugins/plugin.js'))}, { defaultExport: class {} })
    mock.module(${JSON.stringify(moduleUrl('../utils/groupReply.js'))}, { namedExports: { groupReply: { prune() {} } } })
    const { groupReplyObserver } = await import(${JSON.stringify(moduleUrl('../apps/groupReply.js'))})
    Config.getConfig().groupReply.enabled = false
    await new groupReplyObserver().toggle({ isMaster: true, isGroup: true, group_id: '300', msg: '#群聊自主回复开启', reply: async () => {} })
  `)
  assert.equal(toggled.groupReply.enabled, true)
  assert.equal(toggled.groupReply.groups.at(-1), 300)
  assert.deepEqual(run('').groupReply, toggled.groupReply)
  // 只改选群、不传每群参数时，已选中的群保留原参数；取消选中的群连同参数一起移除
  const partial = run(`
    await guoba.setConfigData({ 'groupReply.groups': ['200'] }, { Result: { ok() {} } })
  `)
  assert.deepEqual(partial.groupReply.groups, [200])
  assert.deepEqual(partial.groupReply.groupTuning, [{ groupId: '200', debounceSeconds: 3600, enthusiasm: 100 }])
  const defaults = run(`
    await guoba.setConfigData({
      'groupReply.debounceSeconds': 5,
      'groupReply.groups': ['100', '200', '300', '400'],
      'groupReply.groupTuning': [
        { groupId: '100' },
        { groupId: '200', debounceSeconds: null },
        { groupId: '300', debounceSeconds: '', enthusiasm: '' },
        { groupId: '400', debounceSeconds: '坏值', enthusiasm: '坏值' }
      ]
    }, { Result: { ok() {} } })
  `)
  assert.deepEqual(defaults.groupReply.groupTuning.map(g => g.debounceSeconds), [60, 60, 60, 60])
  assert.deepEqual(defaults.groupReply.groupTuning.map(g => g.enthusiasm), [40, 40, 40, 40])
  assert.equal(defaults.groupReply.debounceSeconds, undefined)
  assert.deepEqual(run('').groupReply, defaults.groupReply)
  // 字段缺值（null）按「本次没改」处理，不能清空已选群或参数
  const nullNoop = run(`
    await guoba.setConfigData({ 'groupReply.groups': null, 'groupReply.groupTuning': null }, { Result: { ok() {} } })
  `)
  assert.deepEqual(nullNoop.groupReply.groups, [100, 200, 300, 400])
  assert.deepEqual(nullNoop.groupReply.groupTuning.map(g => g.debounceSeconds), [60, 60, 60, 60])
  const cleared = run(`
    await guoba.setConfigData({ 'groupReply.groups': [], 'groupReply.decisionPrompt': '', 'groupReply.historyCount': '坏值' }, { Result: { ok() {} } })
  `)
  assert.deepEqual(cleared.groupReply.groups, [])
  assert.equal(cleared.groupReply.decisionPrompt, undefined)
  assert.equal(cleared.groupReply.historyCount, 50)
  // 浏览器还缓存着旧面板时会按对象数组提交，参数要跟着带过去，不能被重置成默认值
  const legacyShape = run(`
    await guoba.setConfigData({ 'groupReply.groups': [
      { groupId: '700', switchOn: true, debounceSeconds: 15, enthusiasm: 85 },
      { groupId: '701', switchOn: false, debounceSeconds: 60, enthusiasm: 40 }
    ] }, { Result: { ok() {} } })
  `)
  assert.deepEqual(legacyShape.groupReply.groups, [700])
  assert.deepEqual(legacyShape.groupReply.groupTuning, [{ groupId: '700', debounceSeconds: 15, enthusiasm: 85 }])
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).groupReply.groups.map(g => [g.groupId, g.switchOn]), [['700', true], ['701', false]])
  assert.equal(cleared.groupReply.debounceSeconds, undefined)
})
