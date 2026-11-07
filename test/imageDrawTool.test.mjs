/**
 * 绘图工具（DrawImageTool）的返回契约。
 *
 * 工具链路的说话权只有模型一个：插件不许自己发消息，被拒与受理都得写成
 * 「原因 + 数字」交给模型去转达，模型才不会被读成「已经画好了」。
 *
 * 只 mock 依赖边界（配置与出图编排），被测的分支与文案拼装跑的是生产代码。
 */
import { test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

/** 假配置：工具只读这几个键，给定值才能断言文本里的数字 */
const DEFAULT_CONFIG = {
  proxy: '',
  imageDrawOnlyMaster: false,
  imageDrawDailyLimit: 3,
  imageDrawCooldownMinutes: 5
}
const fakeConfig = { ...DEFAULT_CONFIG }

/** 出图编排的结果由用例决定：这里只关心工具怎么把结果写成文本 */
let launchResult = { ok: true }
const launchCalls = []

mock.module('../utils/config.js', {
  namedExports: {
    Config: fakeConfig,
    providerDefaults: {}
  }
})
mock.module('../utils/imageDraw/index.js', {
  namedExports: {
    launchDraw: async options => {
      launchCalls.push(options)
      return launchResult
    }
  }
})

const { DrawImageTool } = await import('../utils/tools/DrawImageTool.js')

beforeEach(() => {
  Object.assign(fakeConfig, DEFAULT_CONFIG)
  launchResult = { ok: true }
})

function makeEvent ({ isMaster = false } = {}) {
  const replies = []
  return {
    isMaster,
    sender: { user_id: '20001' },
    replies,
    async reply (content) {
      replies.push(content)
      return true
    }
  }
}

test('被冷却拦截：工具给出原因与相关数字', async () => {
  launchResult = {
    ok: false,
    code: 'cooldown',
    message: '刚画过一张，1分钟后可以再画。',
    retryAfter: 60,
    limit: 3,
    used: 1
  }
  const e = makeEvent()
  const text = await new DrawImageTool().func({ prompt: '一只猫' }, e)
  const lines = text.split('\n')

  assert.equal(lines[0], 'Error: 绘图请求未受理')
  assert.equal(lines[1], 'reason: cooldown')
  assert.equal(lines[2], 'retry_after_seconds: 60')
  assert.equal(lines[3], 'daily_limit: 3', '被冷却也要报真实上限，不能报 0')
  assert.equal(lines[4], 'used_today: 1', '今天画了几张是实数，不能报 0')
  assert.equal(lines[5], 'cooldown_minutes: 5')
  assert.equal(lines[6], 'detail: 刚画过一张，1分钟后可以再画。')
  assert.match(lines[7], /转达给用户/)
  assert.equal(e.replies.length, 0, '工具链路不许插件自己发消息')
})

test('额度用完：工具给出每日上限与今日已用', async () => {
  launchResult = {
    ok: false,
    code: 'quota',
    message: '今天的 3 张已经画完了，明天再来吧。',
    limit: 3,
    used: 3
  }
  const text = await new DrawImageTool().func({ prompt: '一只猫' }, makeEvent())
  const lines = text.split('\n')

  assert.equal(lines[1], 'reason: quota')
  assert.equal(lines[2], 'retry_after_seconds: 0')
  assert.equal(lines[3], 'daily_limit: 3')
  assert.equal(lines[4], 'used_today: 3')
})

test('不限额时工具报 unlimited，不能报 0', async () => {
  fakeConfig.imageDrawDailyLimit = 0
  const text = await new DrawImageTool().func({ prompt: '一只猫' }, makeEvent())
  const lines = text.split('\n')

  assert.equal(lines[1], 'daily_limit: unlimited', '0 会被模型读成「今天 0 张」')
})

test('主人不受每日张数限制', async () => {
  launchResult = { ok: true }
  const text = await new DrawImageTool().func({ prompt: '一只猫' }, makeEvent({ isMaster: true }))
  const lines = text.split('\n')

  assert.equal(lines[1], 'daily_limit: unlimited')
})

test('被拒时也不把不限报成 0', async () => {
  // 主人在配置里有每日上限，但主人本人不受限：预检给出的上限是 0，工具要照实报 unlimited
  launchResult = {
    ok: false,
    code: 'cooldown',
    message: '刚画过一张，1分钟后可以再画。',
    retryAfter: 60,
    limit: 0,
    used: 0
  }
  const text = await new DrawImageTool().func({ prompt: '一只猫' }, makeEvent({ isMaster: true }))
  const lines = text.split('\n')

  assert.equal(lines[3], 'daily_limit: unlimited', '预检报 0 是不限额，不能变成「今天 0 张」')
})

test('受理成功：工具告诉模型每日张数与冷却时长', async () => {
  launchResult = { ok: true }
  const e = makeEvent()
  const text = await new DrawImageTool().func({ prompt: '一只猫' }, e)
  const lines = text.split('\n')

  assert.equal(lines[0], '已受理，正在生成。图片会由插件直接发出。')
  assert.equal(lines[1], 'daily_limit: 3')
  assert.equal(lines[2], 'cooldown_minutes: 5')
  assert.match(lines[3], /告诉用户/)
  assert.equal(e.replies.length, 0, '工具链路不许插件自己发消息')
  assert.equal(launchCalls.at(-1).ack, undefined, '回执交给模型，插件不先插一句')
})

test('工具说明写清被拒与成功时该怎么转达', () => {
  const description = new DrawImageTool().description
  assert.match(description, /绘图请求未受理/)
  assert.match(description, /daily_limit/)
  assert.match(description, /unlimited/)
})
