/**
 * 会话键的单一来源（B1 使能项）。
 *
 * 回归背景：键原本由 `providerConversationKey(row, scope)` 拼，把通道 id 与连接版本写进了键名，
 * 于是「改模型 / 改地址 / 换 key」都会换一个 Redis 桶，用户下一句就接不上上一句。
 * 更隐蔽的是 `#加入对话` 靠「空 scope 留下尾冒号」再 `+ qq` 当分隔符——键格式一改就静默拼出
 * 另一个键，不抛异常、不告警。本文件同时钉住「键与通道无关」与「不许手工拼键」两件事。
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
// `model/conversation.js` 只是拿到 getUin 这一个纯函数，宿主无关；其余依赖走真实实现。
mock.module('../utils/common.js', { namedExports: { getUin: e => e.self_id } })

const {
  CONVERSATION_KEY_PREFIX, conversationKeyFor, conversationKeyOf, conversationScopeOfKey, conversationScanPattern
} = await import('../utils/conversationKey.js')

const privateEvent = { isGroup: false, sender: { user_id: '123' }, self_id: '999' }
const groupEvent = { isGroup: true, group_id: '892283141', sender: { user_id: '123' }, self_id: '999' }

test('键格式是 prefix + scope', () => {
  assert.equal(CONVERSATION_KEY_PREFIX, 'CHATGPT:CONVERSATION_V3')
  assert.equal(conversationKeyOf('123'), 'CHATGPT:CONVERSATION_V3:123')
  assert.equal(conversationKeyFor(privateEvent, false), 'CHATGPT:CONVERSATION_V3:123')
  assert.equal(conversationScanPattern(), 'CHATGPT:CONVERSATION_V3:*')
})

test('同一 scope 下改 model / 地址 / key，会话键逐字不变', async () => {
  const { connectionVersion } = await import('../utils/providerProfiles.js')
  const before = { id: 'p-api', type: 'api', apiKey: 'k1', openAiBaseUrl: 'https://a.example/v1', model: 'gpt-4o' }
  const after = { ...before, apiKey: 'k2', openAiBaseUrl: 'https://b.example/v1', model: 'gpt-5' }
  // 先证明「通道确实换了」：否则这条用例会因为两边本来一样而永远绿
  assert.notEqual(connectionVersion(before), connectionVersion(after))

  const key = conversationKeyFor(privateEvent, false)
  assert.equal(key, 'CHATGPT:CONVERSATION_V3:123')
  for (const row of [before, after]) {
    assert.ok(!key.includes(row.id), '键里不得出现通道 id')
    assert.ok(!key.includes(connectionVersion(row)), '键里不得出现连接版本')
  }
})

test('groupMerge 开关按预期切换 scope，取值与现状一致（不加 u:/g: 前缀）', () => {
  assert.equal(conversationKeyFor(groupEvent, true), 'CHATGPT:CONVERSATION_V3:892283141')
  assert.equal(conversationKeyFor(groupEvent, false), 'CHATGPT:CONVERSATION_V3:123')
})

test('取不到身份时返回空串，绝不产出尾空 scope 的键', () => {
  assert.equal(conversationKeyOf(''), '')
  assert.equal(conversationKeyOf(undefined), '')
  assert.equal(conversationKeyOf('   '), '')
  assert.equal(conversationKeyFor({ isGroup: false, sender: {} }, false), '')
  assert.equal(conversationKeyFor({ isGroup: false }, false), '')
})

test('groupMerge 开启但缺 group_id：回落发言者，并 warn 留痕', () => {
  const warnings = []
  const original = globalThis.logger
  globalThis.logger = { ...original, warn: (...args) => warnings.push(args.map(String).join(' ')) }
  try {
    assert.equal(conversationKeyFor({ isGroup: true, sender: { user_id: '123' } }, true), 'CHATGPT:CONVERSATION_V3:123')
    assert.equal(warnings.length, 1, '缺群号必须留痕，不能静默退回')
    assert.match(warnings[0], /groupMerge/)
  } finally {
    globalThis.logger = original
  }
})

test('@某人 类指令按目标账号算 scope；群共用时目标账号不作数', () => {
  assert.equal(conversationKeyFor(groupEvent, false, '999'), 'CHATGPT:CONVERSATION_V3:999')
  assert.equal(conversationKeyFor(groupEvent, true, '999'), 'CHATGPT:CONVERSATION_V3:892283141')
})

test('conversationScopeOfKey 能取回 scope，非本前缀返回空串', () => {
  assert.equal(conversationScopeOfKey('CHATGPT:CONVERSATION_V3:123'), '123')
  assert.equal(conversationScopeOfKey('CHATGPT:CONVERSATIONS_V2:p:ver:123'), '')
})

test('#加入对话 不许再用字符串拼接拼键（旧写法靠尾冒号当分隔符）', () => {
  const source = fs.readFileSync(path.join(ROOT, 'apps/chat.js'), 'utf8')
  const start = source.indexOf('async joinConversation')
  const end = source.indexOf('async totalAvailable')
  assert.ok(start > 0 && end > start, '找不到 joinConversation，用例已失效需同步更新')
  const body = source.slice(start, end)
  // 只看代码行：注释里说明旧写法时可能原样引用 `+ qq`，那是文档不是实现
  const code = body.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
  assert.match(code, /conversationKeyOf\(qq\)/, '目标会话必须由键函数按 scope 生成')
  assert.match(code, /conversationKeyOf\(e\.sender\.user_id\)/, '自己的会话也得由键函数生成')
  assert.doesNotMatch(code, /\+\s*qq/, '不许再出现「键 + qq」这种拼串')
  assert.doesNotMatch(code, /providerConversationKey/, '旧的含通道信息的键构造函数必须彻底移除')
})

test('全仓守卫：会话键字面量只出现在 utils/conversationKey.js', () => {
  const offenders = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(?:js|mjs|cjs)$/.test(entry.name)) continue
      const relative = path.relative(ROOT, full).split(path.sep).join('/')
      // 迁移模块必须认得旧前缀才能搬桶，与 lint 规则 9 的白名单保持一致
      if (relative === 'utils/conversationKey.js' || relative === 'utils/conversationMigration.js') continue
      const text = fs.readFileSync(full, 'utf8')
      if (/CHATGPT:CONVERSATIONS?_V[23]\b/.test(text)) offenders.push(relative)
    }
  }
  for (const dir of ['apps', 'client', 'model', 'utils']) walk(path.join(ROOT, dir))
  assert.deepEqual(offenders, [], '这些文件自己拼了会话键，改用 conversationKeyFor / conversationKeyOf')
})

test('#结束全部对话 三种写法一律扫全库；只清单条 scope 由 #结束对话 承担', async () => {
  const { Config } = await import('../utils/config.js')
  const { ConversationManager } = await import('../model/conversation.js')
  const previousRedis = globalThis.redis
  const seed = () => new Map([
    ['CHATGPT:CONVERSATION_V3:123', '{"num":1}'],
    ['CHATGPT:CONVERSATION_V3:888', '{"num":2}']
  ])
  let store = seed()
  const deleted = []
  globalThis.redis = {
    del: async key => { deleted.push(key); return store.delete(key) ? 1 : 0 },
    async * scanIterator({ MATCH } = {}) {
      const prefix = String(MATCH || '').replace(/\*$/, '')
      for (const key of [...store.keys()]) if (key.startsWith(prefix)) yield key
    }
  }
  try {
    const manager = Object.create(ConversationManager.prototype)
    const replies = []
    manager.reply = async message => { replies.push(String(message)) }

    for (const msg of ['#结束全部对话', '#结束全部模式对话', '#结束全部模型对话']) {
      store = seed(); deleted.length = 0
      await manager.endAllConversations({ ...privateEvent, isMaster: true, msg })
      assert.deepEqual(deleted.sort(), ['CHATGPT:CONVERSATION_V3:123', 'CHATGPT:CONVERSATION_V3:888'],
        `${msg} 必须扫全库（历史上「只清当前」的分支从未执行过，本次也不拆）`)
      assert.match(replies.at(-1), /已结束 2 个会话/)
    }

    // 非主人：一把都不许删
    store = seed(); deleted.length = 0
    await manager.endAllConversations({ ...privateEvent, isMaster: false, msg: '#结束全部对话' })
    assert.deepEqual(deleted, [], 'isMaster 护栏必须保留')

    // 只清当前 scope 的那条指令另外存在，别把两件事混成一个
    store = seed(); deleted.length = 0
    await manager.endConversation({ ...privateEvent, isMaster: true, message: [], msg: '#结束对话' }, { type: 'api' })
    assert.deepEqual(deleted, ['CHATGPT:CONVERSATION_V3:123'], '#结束对话 只清当前 scope')
    assert.equal(Config.groupMerge, false, '本用例依赖 groupMerge 默认关闭')
  } finally {
    globalThis.redis = previousRedis
  }
})

test('同一 scope 换分流规则 / 换默认通道，会话键逐字不变', async t => {
  const { Config } = await import('../utils/config.js')
  const { resolveProvider } = await import('../utils/providers.js')
  const { sessionProfile } = await import('../utils/sessionProvider.js')
  const config = Config.getConfig()
  const snapshot = structuredClone(config)
  // 只靠 finally 自觉太薄：万一哪天有人把还原写漏/写错，这里会立刻红
  t.after(() => {
    assert.deepEqual(structuredClone(Config.getConfig()), snapshot, '用例必须把全局配置原地还原，不留残留')
  })
  const saved = {
    defaultProviderId: config.defaultProviderId,
    enableSessionProviderRule: config.enableSessionProviderRule,
    sessionProviderRules: structuredClone(config.sessionProviderRules),
    modelProviders: structuredClone(config.modelProviders)
  }
  try {
    const e = { isGroup: true, group_id: '1055241628', sender: { user_id: '123' } }
    // 先铺一条能解析出来的通道：本工作树没有 config.json，否则 resolveProvider 直接抛错
    Object.assign(config, {
      defaultProviderId: 'chan-a',
      enableSessionProviderRule: false,
      sessionProviderRules: [],
      modelProviders: { ...config.modelProviders, api: [{ id: 'chan-a', name: 'A', apiKey: 'k', openAiBaseUrl: 'https://a.example/v1', model: 'm' }] }
    })
    const before = conversationKeyFor(e, true)
    const providerBefore = sessionProfile(e, Config.getConfig(), resolveProvider).id
    assert.equal(providerBefore, 'chan-a')

    // 打开分流、切到另一条通道，并让规则命中同一个群：key 不该有任何变化
    Object.assign(config, {
      defaultProviderId: 'alt-channel',
      enableSessionProviderRule: true,
      sessionProviderRules: [{ id: 'r_1', providerId: 'alt-channel', model: '', groups: ['1055241628'], privateUsers: [] }],
      modelProviders: { ...config.modelProviders, api: [...config.modelProviders.api, { id: 'alt-channel', name: '另一条', apiKey: 'k', openAiBaseUrl: 'https://c.example/v1', model: 'm' }] }
    })
    const providerAfter = sessionProfile(e, Config.getConfig(), resolveProvider).id
    // 先证明「通道确实换了」——否则这条断言会因为两边本来一样而永远绿
    assert.equal(providerAfter, 'alt-channel', '分流必须真的生效，否则本用例无效')
    assert.notEqual(providerAfter, providerBefore)
    assert.equal(conversationKeyFor(e, true), before, '换分流规则 / 换默认通道后会话键必须逐字不变')
  } finally {
    Object.assign(config, saved)
  }
})

test('scope 本身变了键必须变（防止键函数退化成常量）；同 scope 必然同桶是契约，不是巧合', () => {
  const privateKey = conversationKeyFor(privateEvent, false)
  const mergedGroupKey = conversationKeyFor(groupEvent, true)
  const sameScopeInGroupKey = conversationKeyFor(groupEvent, false)
  const otherUserKey = conversationKeyFor(privateEvent, false, '456')
  assert.equal(new Set([privateKey, mergedGroupKey, otherUserKey]).size, 3, '三种不同 scope 必须得到三个不同键')
  // 契约：groupMerge=false 时群聊按「发言者账号」算 scope，于是与私聊同桶。
  // 这是设计（同一个人在哪里聊都是同一段上下文），不是漏判群号——别当 bug 改掉。
  assert.equal(sameScopeInGroupKey, privateKey, '契约：groupMerge=false 的群聊与私聊同桶（按账号算 scope）')
})
