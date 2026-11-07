/**
 * 会话分流（按群 / 私聊指定模型提供商）的逻辑层
 *
 * 覆盖 SPEC 第 8 节：#1~#11（运行时命中、总开关、降级、模型覆盖、回退类型冲突、first-wins、
 * 第 6 条规则）与 #12~#15（面板槽位合并、保存期强校验、自检文案）。
 * 期望值写死在本文件里，不从 `utils/sessionProvider.js` 的常量或函数推导。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  SESSION_RULE_SLOTS,
  normalizeSessionRules,
  buildSessionIndex,
  pickSessionRule,
  applyRuleModel,
  pickSessionProfile,
  sessionProfile,
  allowFallbackFor,
  mergePanelSlots,
  validateSessionRules,
  findInvalidPrivateUser
} = await import('../utils/sessionProvider.js')
const { normalizeProviders } = await import('../utils/providerProfiles.js')

const PROVIDER_ROWS = {
  api: [
    { id: 'api-main', name: '默认', model: 'gpt-4o' },
    { id: 'api-backup', name: '备用', model: 'gpt-4o-mini' }
  ],
  responses: [],
  claude: [{ id: 'claude-1', name: 'Claude', claudeApiModel: 'claude-sonnet-4' }],
  gemini: [{ id: 'gemini-1', name: 'Gemini', geminiModel: 'gemini-3.8-flash' }]
}

/** 与被测模块无关的解析器：只按 id 在快照里找条目，找不到就抛错（与真实 resolveProvider 同语义） */
function resolveProvider(id, source) {
  for (const [type, rows] of Object.entries(source.modelProviders || {})) {
    const row = rows.find(item => item.id === id)
    if (row) return structuredClone({ ...row, type })
  }
  throw new Error('模型提供商未配置或已删除，请在锅巴重新选择')
}

function makeSource(overrides = {}) {
  return {
    enableSessionProviderRule: true,
    defaultProviderId: 'api-main',
    fallbackProviderId: 'api-backup',
    modelProviders: structuredClone(PROVIDER_ROWS),
    sessionProviderRules: [],
    ...overrides
  }
}

const groupEvent = groupId => ({ isGroup: true, group_id: String(groupId), group: { group_id: String(groupId) }, user_id: '42', sender: { user_id: '42' } })
const privateEvent = userId => ({ isGroup: false, user_id: String(userId), sender: { user_id: String(userId) } })

test('归一：群号与私聊账号拆分隔符、去重、剥 ^ 前缀，未知字段一律丢弃', () => {
  const [rule] = normalizeSessionRules([{
    id: 'r_0000abcd',
    providerId: ' gemini-1 ',
    model: ' gemini-3.8-pro ',
    groups: '1055241628，1055241628, 892283141 1055241628',
    privateUsers: ['^3589629156', '3589629156', 'QQ:123', '', 'bot@example.com'],
    priority: 3,
    enabled: true
  }])
  assert.deepEqual(rule, {
    id: 'r_0000abcd',
    providerId: 'gemini-1',
    model: 'gemini-3.8-pro',
    groups: ['1055241628', '892283141'],
    privateUsers: ['3589629156', 'bot@example.com']
  })
})

test('#1 群命中规则：用规则里的提供商', () => {
  const source = makeSource({ sessionProviderRules: [{ id: 'r_1', providerId: 'gemini-1', groups: ['1055241628'] }] })
  const routed = pickSessionProfile(groupEvent('1055241628'), source, resolveProvider)
  assert.equal(routed.profile.id, 'gemini-1')
  assert.equal(routed.profile.type, 'gemini')
  assert.equal(routed.slot, 1)
})

test('#2 私聊命中规则：用规则里的提供商', () => {
  const source = makeSource({ sessionProviderRules: [{ id: 'r_1', providerId: 'claude-1', privateUsers: ['3589629156'] }] })
  const routed = pickSessionProfile(privateEvent('3589629156'), source, resolveProvider)
  assert.equal(routed.profile.id, 'claude-1')
})

test('#3 未命中：返回 null，由调用方回落全局默认', () => {
  const source = makeSource({ sessionProviderRules: [{ id: 'r_1', providerId: 'gemini-1', groups: ['1055241628'] }] })
  assert.equal(pickSessionProfile(groupEvent('999'), source, resolveProvider), null)
})

test('#4 总开关关闭：规则全部不生效', () => {
  const source = makeSource({
    enableSessionProviderRule: false,
    sessionProviderRules: [{ id: 'r_1', providerId: 'gemini-1', groups: ['1055241628'] }]
  })
  assert.equal(pickSessionProfile(groupEvent('1055241628'), source, resolveProvider), null)
})

test('#5 规则引用的提供商已删：解析层抛错，运行时据此降级', () => {
  const source = makeSource({ sessionProviderRules: [{ id: 'r_1', providerId: 'gone-1', groups: ['1055241628'] }] })
  assert.throws(() => pickSessionProfile(groupEvent('1055241628'), source, resolveProvider), /模型提供商未配置或已删除/)
})

test('#6 规则带 model：覆盖该协议的模型字段，不动别的字段', () => {
  const source = makeSource({ sessionProviderRules: [{ id: 'r_1', providerId: 'claude-1', model: 'claude-opus-4', groups: ['1'] }] })
  const { profile } = pickSessionProfile(groupEvent('1'), source, resolveProvider)
  assert.equal(profile.claudeApiModel, 'claude-opus-4')
  assert.equal(profile.name, 'Claude')
})

test('#6b applyRuleModel：模型名为空时保持提供商自带模型', () => {
  const row = applyRuleModel({ type: 'gemini', geminiModel: 'gemini-3.8-flash' }, { model: '' })
  assert.equal(row.geminiModel, 'gemini-3.8-flash')
})

test('#6c 规则的模型必须回写进配置快照：Core.sendMessage 会用同一个 source 重新解析提供商', () => {
  const source = makeSource({ sessionProviderRules: [{ id: 'r_1', providerId: 'claude-1', model: 'claude-opus-4', groups: ['1055241628'] }] })
  const { profile } = pickSessionProfile(groupEvent('1055241628'), source, resolveProvider)
  // abstractChat 把这份 source 一起传给 Core.sendMessage，后者 resolveProvider(profile.id, source)
  // 再 providerConfig(row, source) 取模型。只改局部副本的话这里拿到的还是提供商自带模型，
  // 而 connectionVersion 已按新模型算过——结果是历史清零但模型没换。
  const reread = resolveProvider(profile.id, source)
  assert.equal(reread.claudeApiModel, 'claude-opus-4')
  assert.equal(reread.id, 'claude-1')
  const row = source.modelProviders.claude.find(item => item.id === 'claude-1')
  assert.equal(row.claudeApiModel, 'claude-opus-4', '快照里那一行本身要被改到')
  assert.equal(source.modelProviders.claude[0].name, 'Claude', '同一行其他字段不动')
})

test('#6d 会话管理的 key 与对话请求同源：分流群用规则条目（含模型覆盖），未命中用全局默认', () => {
  const source = makeSource({ sessionProviderRules: [{ id: 'r_1', providerId: 'claude-1', model: 'claude-opus-4', groups: ['1055241628'] }] })
  const routed = pickSessionProfile(groupEvent('1055241628'), source, resolveProvider)
  const managed = sessionProfile(groupEvent('1055241628'), source, resolveProvider)
  assert.equal(managed.id, routed.profile.id)
  assert.equal(managed.claudeApiModel, 'claude-opus-4', 'key 的版本哈希与请求必须用同一份模型名')
  assert.notEqual(managed.id, source.defaultProviderId, '#结束对话 不能再去删全局默认的 key')
  assert.equal(sessionProfile(groupEvent('777'), source, resolveProvider).id, 'api-main')
  const off = makeSource({ enableSessionProviderRule: false, sessionProviderRules: [{ id: 'r_1', providerId: 'claude-1', groups: ['1055241628'] }] })
  assert.equal(sessionProfile(groupEvent('1055241628'), off, resolveProvider).id, 'api-main')
})

test('#7 规则提供商与全局备用协议不同：本次不启用回退，避免 model/core.js 硬校验抛错', () => {
  const source = makeSource({ sessionProviderRules: [{ id: 'r_1', providerId: 'claude-1', groups: ['1'] }] })
  const { profile } = pickSessionProfile(groupEvent('1'), source, resolveProvider)
  assert.equal(allowFallbackFor(profile, source, resolveProvider), false)
})

test('#8 规则提供商与全局备用协议相同：正常启用回退', () => {
  const source = makeSource({ sessionProviderRules: [{ id: 'r_1', providerId: 'api-main', groups: ['1'] }] })
  const { profile } = pickSessionProfile(groupEvent('1'), source, resolveProvider)
  assert.equal(allowFallbackFor(profile, source, resolveProvider), true)
})

test('#8b 备用本身就是本次的主条目 / 备用已删 / 没有备用：一律不启用回退', () => {
  const profile = { id: 'api-backup', type: 'api' }
  assert.equal(allowFallbackFor(profile, makeSource(), resolveProvider), false)
  assert.equal(allowFallbackFor({ id: 'gemini-1', type: 'gemini' }, makeSource({ fallbackProviderId: 'gone-1' }), resolveProvider), false)
  assert.equal(allowFallbackFor({ id: 'api-main', type: 'api' }, makeSource({ fallbackProviderId: '' }), resolveProvider), false)
})

test('#9 同一群出现在两条规则：first-wins 取第一条', () => {
  const rules = normalizeSessionRules([
    { id: 'r_1', providerId: 'gemini-1', groups: ['1055241628'] },
    { id: 'r_2', providerId: 'claude-1', groups: ['1055241628', '999'] }
  ])
  assert.equal(pickSessionRule(groupEvent('1055241628'), rules).id, 'r_1')
  assert.equal(pickSessionRule(groupEvent('999'), rules).id, 'r_2')
  // providerId 为空的槽位不参与匹配，不会挡住后面的规则
  const withEmptySlot = normalizeSessionRules([
    { id: 'r_1', providerId: '', groups: ['1055241628'] },
    { id: 'r_2', providerId: 'claude-1', groups: ['1055241628'] }
  ])
  assert.equal(pickSessionRule(groupEvent('1055241628'), withEmptySlot).id, 'r_2')
})

test('#9b buildSessionIndex：同一目标只保留第一条', () => {
  const rules = normalizeSessionRules([
    { id: 'r_1', providerId: 'gemini-1', groups: ['1'] },
    { id: 'r_2', providerId: 'claude-1', groups: ['1'], privateUsers: ['7'] }
  ])
  const index = buildSessionIndex(rules)
  assert.deepEqual([...index.keys()], ['group:1', 'private:7'])
  assert.equal(index.get('group:1').id, 'r_1')
})

test('#10 第 6 条规则（只存在于 JSON）运行时照样生效', () => {
  const rules = Array.from({ length: SESSION_RULE_SLOTS }, (_, index) => ({ id: `r_${index + 1}`, providerId: '', groups: [] }))
  rules.push({ id: 'r_6', providerId: 'gemini-1', groups: ['1055241628'] })
  const source = makeSource({ sessionProviderRules: rules })
  const routed = pickSessionProfile(groupEvent('1055241628'), source, resolveProvider)
  assert.equal(routed.profile.id, 'gemini-1')
  assert.equal(routed.slot, 6)
})

test('#11 面板保存：前 5 条按槽位重建，第 6 条不丢，槽位 id 与位置都不串', () => {
  const existing = [
    { id: 'r_aaaaaaa1', providerId: 'gemini-1', groups: ['1'] },
    { id: 'r_aaaaaaa2', providerId: 'claude-1', groups: ['2'] },
    { id: 'r_aaaaaaa3', providerId: '', groups: [] },
    { id: 'r_aaaaaaa4', providerId: '', groups: [] },
    { id: 'r_aaaaaaa5', providerId: '', groups: [] },
    { id: 'r_handwritten', providerId: 'claude-1', groups: ['9'] }
  ]
  const merged = mergePanelSlots(existing, {
    1: { providerId: 'gemini-1', groups: [1055241628], privateUsers: '' },
    2: { providerId: 'claude-1', groups: [2] }
  })
  assert.equal(merged.length, 6)
  assert.deepEqual(merged.map(rule => rule.id), ['r_aaaaaaa1', 'r_aaaaaaa2', 'r_aaaaaaa3', 'r_aaaaaaa4', 'r_aaaaaaa5', 'r_handwritten'])
  assert.deepEqual(merged[0].groups, ['1055241628'])
  assert.equal(merged[0].providerId, 'gemini-1')
  assert.equal(merged[2].providerId, '')
  assert.deepEqual(merged[5].groups, ['9'], '第 6 条必须原样保留')
  // 空槽位要有稳定 id，且是新生成的 r_<8位>
  const created = mergePanelSlots([], { 1: { providerId: 'gemini-1', groups: ['1'] } })
  assert.equal(created.length, 5)
  for (const rule of created) assert.match(rule.id, /^r_[0-9a-f]{8}$/)
})

test('#12 保存期：同一群出现在两条规则 → 报错', () => {
  const rules = normalizeSessionRules([
    { id: 'r_1', providerId: 'gemini-1', groups: ['1055241628'] },
    { id: 'r_2', providerId: 'claude-1', groups: ['1055241628'] }
  ])
  assert.throws(() => validateSessionRules(rules, () => true), /群 1055241628 已出现在规则 1，请只保留一条/)
})

test('#12b 保存期：同一私聊账号重复同样报错（群号与 QQ 号同值不算重复）', () => {
  const duplicated = normalizeSessionRules([
    { id: 'r_1', providerId: 'gemini-1', privateUsers: ['3589629156'] },
    { id: 'r_2', providerId: 'claude-1', privateUsers: ['3589629156'] }
  ])
  assert.throws(() => validateSessionRules(duplicated, () => true), /私聊 3589629156 已出现在规则 1/)

  const sameNumber = normalizeSessionRules([
    { id: 'r_1', providerId: 'gemini-1', groups: ['42'] },
    { id: 'r_2', providerId: 'claude-1', privateUsers: ['42'] }
  ])
  assert.doesNotThrow(() => validateSessionRules(sameNumber, () => true))
})

test('#13 保存期：选了群或私聊却没选提供商 → 报错', () => {
  const rules = normalizeSessionRules([{ id: 'r_1', providerId: '', groups: ['1055241628'] }])
  assert.throws(() => validateSessionRules(rules, () => true), /分流规则 1 已选群但未选提供商/)
})

test('#14 保存期：引用已删除的提供商 → 报错；空槽位不算错', () => {
  const rules = normalizeSessionRules([
    { id: 'r_1', providerId: '', groups: [] },
    { id: 'r_2', providerId: 'gone-1', groups: ['1055241628'] }
  ])
  assert.throws(() => validateSessionRules(rules, () => false), /分流规则 2 引用的模型提供商不存在，请先改选再删除/)
  assert.doesNotThrow(() => validateSessionRules(normalizeSessionRules([{ id: 'r_1', providerId: '', groups: [] }]), () => false))
})

test('#14b 保存期：供应商与目标都没填 → 报"必须至少选一个群"', () => {
  const rules = normalizeSessionRules([{ id: 'r_1', providerId: 'gemini-1', groups: [], privateUsers: [] }])
  assert.throws(() => validateSessionRules(rules, () => true), /分流规则 1 必须至少选一个群或填一个私聊账号/)
})

test('#11b 面板保存：手写第 6 条缺 privateUsers / groups 写成字符串时，归一后不丢、能通过校验', () => {
  const slots = Array.from({ length: SESSION_RULE_SLOTS }, (_, index) => ({ id: `r_slot${index + 1}`, providerId: '', groups: [] }))
  slots[0] = { id: 'r_slot1', providerId: 'gemini-1', groups: ['1055241628'] }
  // 缺 privateUsers 键、groups 用逗号字符串——手改配置最容易写成的两种形态
  const merged = mergePanelSlots([...slots, { id: 'r_handwritten', providerId: 'claude-1', groups: '9,10' }], {
    1: { providerId: 'gemini-1', groups: [1055241628] }
  })
  assert.deepEqual(merged[5], { id: 'r_handwritten', providerId: 'claude-1', model: '', groups: ['9', '10'], privateUsers: [] })
  // 未归一时 '9,10' 会被逐字符迭代，validateSessionRules 直接 TypeError / 误报重复
  assert.doesNotThrow(() => validateSessionRules(merged, () => true))
})

test('#11c 面板保存：第 6 条的 groups 字符串不会与自己误报重复', () => {
  const slots = Array.from({ length: SESSION_RULE_SLOTS }, (_, index) => ({ id: `r_slot${index + 1}`, providerId: '', groups: [] }))
  const merged = mergePanelSlots([...slots, { id: 'r_handwritten', providerId: 'claude-1', groups: '1,1,10' }], {})
  assert.deepEqual(merged[5].groups, ['1', '10'])
  assert.doesNotThrow(() => validateSessionRules(merged, () => true))
})

test('#14d 删除被规则引用的提供商：配置归一化直接拦住（空槽位不算）', () => {
  const config = {
    providerConfigVersion: 1,
    defaultProviderId: 'api-main',
    fallbackProviderId: '',
    modelProviders: structuredClone(PROVIDER_ROWS),
    sessionProviderRules: [
      { id: 'r_1', providerId: '', groups: ['1055241628'] },
      { id: 'r_2', providerId: 'gone-1', groups: ['892283141'] }
    ]
  }
  assert.throws(() => normalizeProviders(config, { api: {}, responses: {}, claude: {}, gemini: {} }), /分流规则 2 引用的模型提供商不存在/)
  config.sessionProviderRules = [{ id: 'r_1', providerId: '', groups: [] }]
  assert.doesNotThrow(() => normalizeProviders(config, { api: {}, responses: {}, claude: {}, gemini: {} }))
})

test('#14c 保存期：私聊账号字符集不合格时点名拦下，别静默丢弃', () => {
  // 归一会把不合格的条目过滤掉；保存路径必须先拦一次，否则用户看到「保存成功」而规则其实空着
  assert.equal(findInvalidPrivateUser('3589629156, bot@example.com'), '')
  assert.equal(findInvalidPrivateUser('^3589629156'), '')
  assert.equal(findInvalidPrivateUser('3589629156，QQ:123'), 'QQ:123')
  assert.equal(findInvalidPrivateUser(''), '')
  assert.equal(findInvalidPrivateUser('3589629156 #号'), '#号')
})

