/**
 * 第一人称呼叫（喊名字）的呼叫判定
 *
 * 回归背景：这条规则的 `reg` 曾经直接取 `Config.tts_First_person`，而框架只在插件加载时把
 * 字符串编译成 RegExp 一次。于是运行期通过 `#gpt语音换源` 改掉名字后规则仍是旧名字的
 * 快照，喊新名字完全没反应；名字里带 `(`、`[` 这类元字符时还会在加载期抛错。
 * 现在规则退化成「全量匹配 + 排在最后」，由本用例钉住的运行期判定决定是否接管消息。
 *
 * 只 mock 边界（宿主插件基类、重依赖、模型调用），被测的判定与入口流程执行真实代码。
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

class PluginStub {
  constructor(options = {}) {
    Object.assign(this, options)
  }

  async reply() {}
}
mock.module('../../../lib/plugins/plugin.js', { defaultExport: PluginStub })
mock.module('../../../lib/common/common.js', { defaultExport: {} })
mock.module('../utils/tts/microsoft-azure.js', { defaultExport: {} })
mock.module('../utils/common.js', { namedExports: {
  completeJSON() {}, formatDate() {}, formatDate2() {}, generateAudio() {}, getDefaultReplySetting() {},
  getImageOcrText() {}, parseSourceImg: async () => false, getUin: e => e.self_id,
  getUserData: async () => ({}), getUserReplySetting: async () => ({}),
  isImage() {}, makeForwardMsg() {}, normalizeChatMode: mode => mode, randomString() {}, render() {}, renderUrl() {}
} })
mock.module('../utils/conversation.js', { namedExports: { deleteConversation() {}, getConversations() {}, getLatestMessageIdByConversationId() {} } })
mock.module('../utils/tts.js', { namedExports: { convertSpeaker() {}, speakers: [] } })
mock.module('../utils/face.js', { namedExports: { convertFacesAndCQCode: text => [text] } })
mock.module('../model/conversation.js', { namedExports: { ConversationManager: class {}, originalValues: [] } })
mock.module('../utils/proxy.js', { namedExports: { getProxy() {} } })
mock.module('../utils/chat.js', { namedExports: { generateSuggestedResponse() {} } })
mock.module('../utils/postprocessors/BasicProcessor.js', { namedExports: { collectProcessors: () => [] } })
mock.module('../utils/paimonFuction.js', { namedExports: {
  hidePrivacyInfo: text => text, removeCQCode: text => text, recognitionResultsByGemini() {},
  convertSentenceToArray() {}, extractCharacterName() {}, splitString_Enter() {}
} })
mock.module('../utils/chatCooldown.js', { defaultExport: { check: async () => ({ canChat: true }), end() {} } })
const requests = []
mock.module('../model/core.js', { defaultExport: {
  async sendMessage(...args) {
    requests.push(args)
    return { noMsg: true }
  }
} })
/** 名字里刻意带正则元字符：旧实现把它直接当正则编译，既是错的也会抛错 */
const Config = {
  tts_First_person: '小猫(改)',
  chat_for_First_person: true,
  toggleMode: 'at',
  defaultProviderId: 'api-main',
  modelProviders: { api: [{ id: 'api-main', name: '默认' }], responses: [], claude: [], gemini: [] },
  whitelist: [], blacklist: [], blockWords: [], promptBlockWords: [],
  rateLimiting: 0, enablePrivateChat: true, enableGroupContext: false
}
Config.getConfig = () => Object.fromEntries(Object.entries(Config).filter(([, value]) => typeof value !== 'function'))
mock.module('../utils/config.js', { namedExports: { Config, providerDefaults: {} } })
globalThis.Bot = { uin: [] }
globalThis.redis = { get: async () => null }

const { chatgpt, isFirstPersonCall } = await import('../apps/chat.js')

/** 直接调入口，只关心「是否走到模型请求」这一条可观察结果 */
async function callEntry(fields, options) {
  const e = {
    isGroup: false, user_id: '123', self_id: '999', sender: { user_id: '123' },
    message: [], reply: async () => {}, message_id: 'm1',
    ...fields
  }
  const chat = Object.create(chatgpt.prototype)
  chat.e = e
  requests.length = 0
  const result = await chat.chatgpt_for_firstperson_call(e, options)
  return { result, requested: requests.length }
}

test('规则不再内嵌名字快照：全量匹配且排在最后，名字含元字符也不会编译失败', () => {
  const instance = new chatgpt({})
  const rules = instance.rule || []
  const holders = rules.filter(rule => rule.fnc === 'chatgpt_for_firstperson_call')
  assert.equal(holders.length, 1, '第一人称呼叫只能有一条规则')
  assert.equal(rules.at(-1).fnc, 'chatgpt_for_firstperson_call', '它必须排在最后，让命令与 @ 先匹配')
  const reg = new RegExp(holders[0].reg)
  // 旧实现这里等价于 /小猫(改)/，不带名字的消息就匹配不上，规则根本不会执行
  assert.ok(reg.test('今天天气不错'), '不带名字的消息也要能进入运行期判定')
  assert.ok(reg.test(''), '只 @ 不打字时 e.msg 为空，规则也必须有机会接管')
  assert.ok(reg.test('第一行\n第二行'), '多行消息不能被漏掉')
})

test('喊到名字才算呼叫，没喊到就放行给后续规则', () => {
  assert.equal(isFirstPersonCall({ msg: '小猫(改)在吗' }, '小猫(改)'), true)
  assert.equal(isFirstPersonCall({ msg: '今天天气不错' }, '小猫(改)'), false)
  assert.equal(isFirstPersonCall({ msg: '喵喵喵' }, '  小猫(改)  '), false, '配置里的首尾空格不参与匹配')
})

test('只 @ 不打字也算呼叫（框架不把 at 段写进 e.msg）', () => {
  assert.equal(isFirstPersonCall({ msg: '', atme: true }, '小猫(改)'), true)
  assert.equal(isFirstPersonCall({ msg: '', at: '999', self_id: '999' }, '小猫(改)'), true)
  assert.equal(isFirstPersonCall({ msg: '', at: '888', self_id: '999', atme: false, atBot: false }, '小猫(改)'), false)
})

test('名字为空时不做文字匹配，否则 includes(空串) 会把所有消息都吃掉', () => {
  for (const name of ['', '   ', undefined, null]) {
    assert.equal(isFirstPersonCall({ msg: '随便说点什么' }, name), false)
  }
  assert.equal(isFirstPersonCall({ msg: '随便说点什么', atme: true }, ''), true, '@ 仍然是呼叫')
})

test('入口：不喊名字提前退出，不触碰模型', async () => {
  const { result, requested } = await callEntry({ msg: '今天天气不错', raw_message: '今天天气不错' })
  assert.equal(result, false)
  assert.equal(requested, 0)
})

test('入口：喊到名字就继续，自主回复不受名字判定影响', async () => {
  const named = await callEntry({ msg: '小猫(改)在吗', raw_message: '小猫(改)在吗' })
  assert.equal(named.result, undefined)
  assert.equal(named.requested, 1)

  const automatic = await callEntry({ msg: '今天天气不错', raw_message: '今天天气不错' }, { automatic: true })
  assert.equal(automatic.result, undefined)
  assert.equal(automatic.requested, 1)
})
