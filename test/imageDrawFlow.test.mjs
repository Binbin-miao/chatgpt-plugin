import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeRedis } from './fixtures/fakeRedis.mjs'
import { ImageDrawError } from '../utils/imageDraw/client.js'
import { formatDrawDuration, launchDraw, precheckDraw, runDraw } from '../utils/imageDraw/index.js'
import { buildAckText } from '../utils/imageDraw/ack.js'
import { CIRCUIT_KEY, cooldownKey, dailyKey, dayKeyOf, getCircuit, reserveQuota, tripCircuit } from '../utils/imageDraw/quota.js'

const today = () => dayKeyOf(Math.floor(Date.now() / 1000))
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const PROVIDER = { name: '测试站', baseUrl: 'https://api.example.com', apiKey: 'sk-test', model: 'gpt-image-2' }

/** 框架带引用发送时塞进载荷的引用段标记 */
const REPLY_MARK = { type: 'reply' }

/**
 * 事件替身。
 *
 * `reply` 复刻框架语义：带引用时会把引用段 **unshift 进调用方传进来的那个数组本身**
 * （不是拷贝）。不模拟这一点，降级重发复用了被改过的数组这类 bug 就测不出来。
 */
function makeEvent ({ userId = '20001', isMaster = false, replyImpl } = {}) {
  const replies = []
  const replyCalls = []
  const e = {
    isMaster,
    group_id: '90001',
    message_id: 'msg-1',
    sender: { user_id: userId },
    img: [],
    async reply (content, quote) {
      let payload = content
      if (quote && e.message_id) {
        payload = Array.isArray(content) ? content : [content]
        payload.unshift(REPLY_MARK)
      }
      replyCalls.push({ content: payload, quote })
      replies.push(payload)
      return replyImpl ? replyImpl(payload, quote) : true
    },
    replies,
    replyCalls
  }
  return e
}

/** 去掉框架塞进来的引用段，只看插件真正想发的东西 */
const payloadOf = content => (Array.isArray(content) ? content.filter(item => item !== REPLY_MARK) : content)

/** 等后台任务把消息发完：launchDraw 只承诺「已开始」，发图是之后再发生的事 */
async function waitFor (predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('后台任务没有在预期时间内完成')
}

const baseConfig = {
  imageDrawEnable: true,
  imageDrawDailyLimit: 1,
  imageDrawCooldownMinutes: 1,
  imageDrawSize: '1024x1024',
  imageDrawQuality: 'medium',
  imageDrawTimeoutSeconds: 180,
  imageDrawFailStreakLimit: 5,
  imageDrawGlobalCooldownHours: 5
}

const unlimitedConfig = { ...baseConfig, imageDrawDailyLimit: 0 }

/** 图片消息可能是「图 + 次数说明」的数组：剥掉引用段后取里面的图 */
const imageOf = content => {
  const payload = payloadOf(content)
  return Array.isArray(payload) ? payload[0] : payload
}

/** 次数说明那半句；没有就是 undefined */
const noteOf = content => {
  const payload = payloadOf(content)
  return Array.isArray(payload) ? payload[1] : undefined
}

function run (overrides = {}) {
  return runDraw({
    e: makeEvent(),
    prompt: '一只猫',
    provider: PROVIDER,
    config: baseConfig,
    store: createFakeRedis(),
    generate: async () => ({ buffer: PNG, mimeType: 'image/png' }),
    deliver: async () => {},
    ...overrides
  })
}

test('正常出图：发图、记一张、写入冷却', async () => {
  const store = createFakeRedis()
  const delivered = []
  const e = makeEvent({ userId: '20002' })
  const result = await run({ e, store, deliver: async image => { delivered.push(image) } })

  assert.equal(result.ok, true)
  assert.equal(delivered.length, 1)
  assert.deepEqual(delivered[0].buffer, PNG)
  assert.equal(store.peek(dailyKey(today(), '20002')), '1')
  assert.ok(store.peek(cooldownKey('20002')))
})

test('额度用完时直接拒绝，不调用出图', async () => {
  const store = createFakeRedis()
  const e = makeEvent({ userId: '20003' })
  await reserveQuota({ userId: '20003', limit: 1 }, store)
  let called = false
  const result = await run({
    e,
    store,
    generate: async () => { called = true; return { buffer: PNG, mimeType: 'image/png' } }
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'quota')
  assert.equal(called, false)
  assert.match(result.message, /今天的 1 张已经画完了/)
})

test('冷却期内直接拒绝', async () => {
  const store = createFakeRedis()
  const e = makeEvent({ userId: '20004' })
  await store.set(cooldownKey('20004'), '1', { EX: 60 })
  const result = await run({ e, store })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'cooldown')
  assert.match(result.message, /刚画过一张/)
})

test('熔断期间所有人都画不了，主人也不例外', async () => {
  const store = createFakeRedis()
  await tripCircuit({ hours: 5 }, store)
  const user = await run({ e: makeEvent({ userId: '20005' }), store })
  const master = await run({ e: makeEvent({ userId: '20006', isMaster: true }), store })

  assert.equal(user.code, 'circuit')
  assert.equal(master.code, 'circuit')
  assert.match(user.message, /#绘图解禁/)
})

test('生成失败要退回额度，并记一次失败', async () => {
  const store = createFakeRedis()
  const result = await run({
    e: makeEvent({ userId: '20007' }),
    store,
    generate: async () => { throw new ImageDrawError('boom', 'upstream', 500) }
  })

  assert.equal(result.ok, false)
  assert.equal(store.peek(dailyKey(today(), '20007')), '0', '失败必须把预扣的那张退回去')
  assert.equal(await store.get('CHATGPT:DRAW:FAILSTREAK'), '1')
})

test('连续失败达到阈值后全员熔断', async () => {
  const store = createFakeRedis()
  const config = { ...baseConfig, imageDrawDailyLimit: 0, imageDrawFailStreakLimit: 3 }
  for (let index = 0; index < 3; index += 1) {
    await run({
      e: makeEvent({ userId: `2001${index}` }),
      store,
      config,
      generate: async () => { throw new ImageDrawError('boom', 'network') }
    })
  }

  assert.equal((await getCircuit(store)).open, true)
  const blocked = await run({ e: makeEvent({ userId: '20019' }), store, config })
  assert.equal(blocked.code, 'circuit')
})

test('审核拒绝不计入熔断：连着被拦也不能停掉全群', async () => {
  const store = createFakeRedis()
  const config = { ...baseConfig, imageDrawDailyLimit: 0, imageDrawFailStreakLimit: 3 }
  for (let index = 0; index < 6; index += 1) {
    const blocked = await run({
      e: makeEvent({ userId: `2010${index}` }),
      store,
      config,
      generate: async () => { throw new ImageDrawError('内容被拒绝', 'moderation', 400) }
    })
    assert.equal(blocked.code, 'moderation')
  }

  assert.equal((await getCircuit(store)).open, false, '提示词被拦属于用户问题，不该让全群冷却五小时')
  const next = await run({ e: makeEvent({ userId: '20199' }), store, config })
  assert.equal(next.ok, true)
})

test('同一人连点两次只放一次请求进去', async () => {
  const store = createFakeRedis()
  let calls = 0
  const slow = async () => {
    calls += 1
    await new Promise(resolve => setTimeout(resolve, 30))
    return { buffer: PNG, mimeType: 'image/png' }
  }
  const e = makeEvent({ userId: '20201' })
  const [first, second] = await Promise.all([
    run({ e, store, config: { ...baseConfig, imageDrawDailyLimit: 0 }, generate: slow }),
    run({ e, store, config: { ...baseConfig, imageDrawDailyLimit: 0 }, generate: slow })
  ])

  assert.equal(calls, 1, '第二次点击应该在在途锁上被挡掉')
  assert.equal(second.code, 'busy')
  assert.equal(first.ok, true)
})

test('主人不受张数与冷却限制，也不产生计数', async () => {
  const store = createFakeRedis()
  const e = makeEvent({ userId: '20020', isMaster: true })
  for (let index = 0; index < 3; index += 1) {
    const result = await run({ e, store })
    assert.equal(result.ok, true, `第 ${index + 1} 次应当放行：${result.message || ''}`)
  }
  assert.equal(store.peek(dailyKey(today(), '20020')), null, '主人不该被计数')
  assert.equal(store.peek(cooldownKey('20020')), null, '主人不该进冷却')
})

test('配置不全时不调接口，且把预扣的额度退回', async () => {
  const store = createFakeRedis()
  const result = await runDraw({
    e: makeEvent({ userId: '20021' }),
    prompt: '一只猫',
    config: { ...baseConfig, imageDrawProviderId: '' },
    store,
    generate: async () => { throw new Error('不该被调用') }
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'config')
  assert.equal(store.peek(dailyKey(today(), '20021')), '0')
})

test('预检只读，不写任何计数', async () => {
  const store = createFakeRedis()
  const e = makeEvent({ userId: '20022' })
  const check = await precheckDraw({ e, config: baseConfig, store })
  assert.equal(check.ok, true)
  assert.equal(store.peek(dailyKey(today(), '20022')), null)

  await tripCircuit({ hours: 5 }, store)
  const open = await precheckDraw({ e, config: baseConfig, store })
  assert.equal(open.ok, false)
  assert.equal(open.code, 'circuit')
  assert.ok(store.peek(CIRCUIT_KEY), '预检不该动熔断键')
})

test('文案里的时长可读', () => {
  assert.equal(formatDrawDuration(45), '45 秒')
  assert.equal(formatDrawDuration(90), '1 分钟')
  assert.equal(formatDrawDuration(3600), '1 小时')
  assert.equal(formatDrawDuration(3900), '1 小时 5 分钟')
})

test('没给 ack 时，出图前一句话都不说', async () => {
  const store = createFakeRedis()
  const e = makeEvent({ userId: '20301' })
  let release
  const gate = new Promise(resolve => { release = resolve })
  const result = await launchDraw({
    e,
    prompt: '一只猫',
    provider: PROVIDER,
    config: unlimitedConfig,
    store,
    generate: async () => { await gate; return { buffer: PNG, mimeType: 'image/png' } }
  })

  assert.equal(result.ok, true)
  assert.equal(e.replies.length, 0, '工具链路的说话权交给模型，插件不能先插一句「在画了」')

  release()
  await waitFor(() => e.replies.length === 1)
  assert.deepEqual(imageOf(e.replies[0]), PNG, '出图后只补发图片本身')
  assert.equal(noteOf(e.replies[0]), undefined, '不限额度时不该附带次数说明')
})

test('返图引用触发它的那条消息', async () => {
  const store = createFakeRedis()
  const e = makeEvent({ userId: '20302' })
  const result = await launchDraw({
    e,
    prompt: '一只猫',
    provider: PROVIDER,
    config: unlimitedConfig,
    store,
    generate: async () => ({ buffer: PNG, mimeType: 'image/png' })
  })

  assert.equal(result.ok, true)
  await waitFor(() => e.replyCalls.length === 1)
  const [call] = e.replyCalls
  assert.equal(call.quote, true, '图和指令对不上号时，群里没人知道这是画给谁的')
  assert.equal(call.content[0], REPLY_MARK, '引用段被框架塞在载荷最前面')
  assert.deepEqual(imageOf(call.content), PNG)
})

test('带引用发送失败时降级为普通发送，不退款也不记失败', async () => {
  const store = createFakeRedis()
  const e = makeEvent({
    userId: '20303',
    // 框架发送失败不抛异常，而是 resolve 成 { error }，所以只能看返回值
    replyImpl: (content, quote) => (quote ? { error: [new Error('引用已失效')] } : true)
  })
  const result = await launchDraw({
    e,
    prompt: '一只猫',
    provider: PROVIDER,
    config: baseConfig,
    store,
    generate: async () => ({ buffer: PNG, mimeType: 'image/png' })
  })

  assert.equal(result.ok, true)
  await waitFor(() => e.replyCalls.length === 2)
  const [first, second] = e.replyCalls
  assert.equal(first.quote, true)
  assert.deepEqual(imageOf(first.content), PNG)
  assert.equal(second.quote, undefined, '重发要用普通消息，别再撞同一次失败')
  assert.deepEqual(imageOf(second.content), PNG, '重发的还是同一张图，不能白画')
  assert.equal(noteOf(second.content), noteOf(first.content), '降级重发也得带上那句次数说明')
  assert.match(noteOf(first.content), /今天的额度用完啦/)
  assert.equal(store.peek(dailyKey(today(), '20303')), '1', '图发出去了，额度不该退')
  assert.ok(store.peek(cooldownKey('20303')), '图发出去了就该进冷却')
  assert.equal(await store.get('CHATGPT:DRAW:FAILSTREAK'), null, '引用失效是本地发送问题，不算上游失败')
})

test('降级重发的载荷里不能留着上一轮塞进去的引用段', async () => {
  const store = createFakeRedis()
  const e = makeEvent({
    userId: '20311',
    replyImpl: (content, quote) => (quote ? { error: [new Error('引用已失效')] } : true)
  })
  await launchDraw({
    e,
    prompt: '一只猫',
    provider: PROVIDER,
    config: { ...baseConfig, imageDrawDailyLimit: 3 },
    store,
    generate: async () => ({ buffer: PNG, mimeType: 'image/png' })
  })

  await waitFor(() => e.replyCalls.length === 2)
  const retried = e.replyCalls[1].content
  assert.equal(retried.includes(REPLY_MARK), false, '引用段还在载荷里的话，重发只是换个参数再失败一次')
  assert.deepEqual(payloadOf(retried), [PNG, '\n今天还剩 2 张'])
})

test('两次发送都失败才报错并退额度', async () => {
  const store = createFakeRedis()
  const e = makeEvent({
    userId: '20304',
    replyImpl: () => ({ error: [new Error('全挂了')] })
  })
  await launchDraw({
    e,
    prompt: '一只猫',
    provider: PROVIDER,
    config: baseConfig,
    store,
    generate: async () => ({ buffer: PNG, mimeType: 'image/png' })
  })

  await waitFor(() => e.replies.length === 3)
  assert.deepEqual(e.replies[2], '图没发出去，稍后再试', '图已经画好了，别让它被读成「生成失败」')
  assert.equal(store.peek(dailyKey(today(), '20304')), '0', '图没送到就该把额度退回去')
})

test('出图时把扣完这一张之后的剩余次数交给 deliver', async () => {
  const store = createFakeRedis()
  const metas = []
  const result = await run({
    e: makeEvent({ userId: '20305' }),
    store,
    config: { ...baseConfig, imageDrawDailyLimit: 3 },
    deliver: async (image, meta) => { metas.push(meta) }
  })

  assert.equal(result.ok, true)
  assert.deepEqual(metas, [{ remaining: 2 }], '3 张的额度画完第一张，还剩 2 张')
})

test('不限额度与主人时 remaining 为 null，返图也不提次数', async () => {
  const store = createFakeRedis()
  const metas = []
  const collect = async (image, meta) => { metas.push(meta) }
  await run({ e: makeEvent({ userId: '20306' }), store, config: unlimitedConfig, deliver: collect })
  await run({ e: makeEvent({ userId: '20307', isMaster: true }), store, deliver: collect })
  assert.deepEqual(metas.map(meta => meta.remaining), [null, null])

  const e = makeEvent({ userId: '20310', isMaster: true })
  await launchDraw({
    e,
    prompt: '一只猫',
    provider: PROVIDER,
    store,
    generate: async () => ({ buffer: PNG, mimeType: 'image/png' })
  })
  await waitFor(() => e.replies.length === 1)
  assert.equal(noteOf(e.replies[0]), undefined, '主人不该收到次数说明，图片就是一条纯图片消息')
})

test('返图与剩余次数合成一条消息', async () => {
  const store = createFakeRedis()
  const e = makeEvent({ userId: '20308' })
  await launchDraw({
    e,
    prompt: '一只猫',
    provider: PROVIDER,
    config: { ...baseConfig, imageDrawDailyLimit: 3 },
    store,
    generate: async () => ({ buffer: PNG, mimeType: 'image/png' })
  })

  await waitFor(() => e.replyCalls.length === 1)
  const payload = payloadOf(e.replyCalls[0].content)
  assert.equal(Array.isArray(payload), true, '图和说明要一起发，不能拆成两条')
  assert.equal(payload.length, 2)
  assert.deepEqual(imageOf(payload), PNG)
  assert.match(noteOf(payload), /今天还剩 2 张/)
})

test('给了回执就原样发出去，且只发一次', async () => {
  const store = createFakeRedis()
  const e = makeEvent({ userId: '20309' })
  let release
  const gate = new Promise(resolve => { release = resolve })
  const ack = '小画收到啦，30秒~3分钟之内交图，今天还能画 3 张～'
  await launchDraw({
    e,
    prompt: '一只猫',
    provider: PROVIDER,
    config: unlimitedConfig,
    store,
    ack,
    generate: async () => { await gate; return { buffer: PNG, mimeType: 'image/png' } }
  })

  assert.deepEqual(e.replyCalls[0], { content: ack, quote: false }, '回执不引用，出图前只发这一条')

  release()
  await waitFor(() => e.replies.length === 2)
})

test('预检冷却：要报出还要等多少秒，以及今天画了几张', async () => {
  const store = createFakeRedis()
  const e = makeEvent({ userId: '20401' })
  await store.set(cooldownKey('20401'), '1', { EX: 60 })
  await reserveQuota({ userId: '20401', limit: 3 }, store)

  const check = await precheckDraw({ e, config: { ...baseConfig, imageDrawDailyLimit: 3 }, store })
  assert.equal(check.ok, false)
  assert.equal(check.code, 'cooldown')
  assert.ok(check.retryAfter > 0, '不报秒数的话，转达的人只能说「等一会儿」')
  assert.equal(check.limit, 3, '被冷却也要带上真实上限')
  assert.equal(check.used, 1, '今天画了几张是实数')
})

test('预检额度用完：要报出每日上限与今日已用', async () => {
  const store = createFakeRedis()
  const e = makeEvent({ userId: '20402' })
  await reserveQuota({ userId: '20402', limit: 1 }, store)

  const check = await precheckDraw({ e, config: { ...baseConfig, imageDrawDailyLimit: 1 }, store })
  assert.equal(check.ok, false)
  assert.equal(check.code, 'quota')
  assert.equal(check.limit, 1)
  assert.equal(check.used, 1)
})

test('预检熔断：要报出恢复还要多久，以及今天画了几张', async () => {
  const store = createFakeRedis()
  const e = makeEvent({ userId: '20403' })
  await tripCircuit({ hours: 5 }, store)
  await reserveQuota({ userId: '20403', limit: 3 }, store)

  const check = await precheckDraw({ e, config: { ...baseConfig, imageDrawDailyLimit: 3 }, store })
  assert.equal(check.ok, false)
  assert.equal(check.code, 'circuit')
  assert.ok(check.retryAfter > 0)
  assert.equal(check.limit, 3, '熔断也要带上真实上限')
  assert.equal(check.used, 1)
})

test('被拦截时 launchDraw 把结构化理由一起带出去', async () => {
  const store = createFakeRedis()
  const e = makeEvent({ userId: '20404' })
  await store.set(cooldownKey('20404'), '1', { EX: 60 })

  const result = await launchDraw({ e, prompt: '一只猫', config: baseConfig, store })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'cooldown')
  assert.ok(result.retryAfter > 0, '拦截理由只在 launchDraw 丢掉的话，调用方永远拿不到秒数')
  assert.match(result.message, /刚画过一张/)
})

test('回执带上每日张数与冷却间隔', () => {
  const text = buildAckText({
    name: '小画',
    timeoutSeconds: 25,
    remaining: null,
    dailyLimit: 3,
    cooldownMinutes: 5,
    pick: () => 0
  })
  assert.match(text, /3 张/)
  assert.match(text, /5 分钟/)
})

test('不冷却时回执只报每日张数', () => {
  const text = buildAckText({
    name: '小画',
    timeoutSeconds: 25,
    remaining: null,
    dailyLimit: 3,
    cooldownMinutes: 0,
    pick: () => 0
  })
  assert.match(text, /3 张/)
  assert.doesNotMatch(text, /分钟/, '没配冷却就别报分钟数')
})

test('不限额时回执不报规则', () => {
  const text = buildAckText({
    name: '小画',
    timeoutSeconds: 25,
    remaining: null,
    dailyLimit: null,
    pick: () => 0
  })
  assert.doesNotMatch(text, /每天|间隔/)
})
