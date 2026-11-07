import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeRedis } from './fixtures/fakeRedis.mjs'
import {
  CIRCUIT_KEY,
  FAIL_STREAK_KEY,
  clearCircuit,
  cooldownKey,
  dailyKey,
  getCircuit,
  getCooldown,
  getQuotaUsage,
  markCooldown,
  recordFailure,
  recordSuccess,
  refundQuota,
  reserveQuota,
  secondsUntilNextDay,
  tripCircuit
} from '../utils/imageDraw/quota.js'
import { dayKeyOf } from '../utils/imageDraw/quota.js'

const today = () => dayKeyOf(Math.floor(Date.now() / 1000))

test('每日额度：普通用户逐张累加，超过上限立刻回退那一张', async () => {
  const store = createFakeRedis()
  const userId = '10001'

  const first = await reserveQuota({ userId, limit: 2 }, store)
  assert.equal(first.ok, true)
  assert.equal(first.used, 1)

  const second = await reserveQuota({ userId, limit: 2 }, store)
  assert.equal(second.ok, true)

  const third = await reserveQuota({ userId, limit: 2 }, store)
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'quota')
  // 超额那次必须回退掉，否则每被拒一次计数就往上涨
  assert.equal(store.peek(dailyKey(today(), userId)), '2')
})

test('每日额度：0 表示不限，不写计数键', async () => {
  const store = createFakeRedis()
  const result = await reserveQuota({ userId: '10002', limit: 0 }, store)
  assert.equal(result.ok, true)
  assert.equal(store.peek(dailyKey(today(), '10002')), null)
})

test('每日额度：主人既不计数也不受限', async () => {
  const store = createFakeRedis()
  for (let index = 0; index < 5; index += 1) {
    const result = await reserveQuota({ userId: '10003', limit: 1, isMaster: true }, store)
    assert.equal(result.ok, true)
  }
  assert.equal(store.peek(dailyKey(today(), '10003')), null)
  assert.deepEqual(await getQuotaUsage({ userId: '10003', limit: 1, isMaster: true }, store), { used: 0, unlimited: true })
})

test('每日额度：失败退回后可以再画一张', async () => {
  const store = createFakeRedis()
  const userId = '10004'
  assert.equal((await reserveQuota({ userId, limit: 1 }, store)).ok, true)
  assert.equal((await reserveQuota({ userId, limit: 1 }, store)).ok, false)
  await refundQuota({ userId }, store)
  assert.equal((await reserveQuota({ userId, limit: 1 }, store)).ok, true)
})

test('每日额度：计数键在次日 0 点后失效，不会跨天累积', async () => {
  const store = createFakeRedis()
  const userId = '10005'
  await reserveQuota({ userId, limit: 1 }, store)
  const ttl = await store.ttl(dailyKey(today(), userId))
  const untilMidnight = secondsUntilNextDay()
  assert.ok(ttl > untilMidnight, 'TTL 必须覆盖到次日 0 点之后')
  assert.ok(ttl < untilMidnight + 3 * 86400, '但也不该无限期留着')
})

test('个人冷却：写进去之后能读出来，主人不写也不读', async () => {
  const store = createFakeRedis()
  await markCooldown({ userId: '10006', minutes: 2 }, store)
  const left = await getCooldown({ userId: '10006' }, store)
  assert.ok(left > 100 && left <= 120, `冷却剩余秒数不对：${left}`)
  assert.ok(store.peek(cooldownKey('10006')))

  await markCooldown({ userId: '10007', minutes: 2, isMaster: true }, store)
  assert.equal(store.peek(cooldownKey('10007')), null)
  assert.equal(await getCooldown({ userId: '10007', isMaster: true }, store), 0)
})

test('个人冷却：0 分钟等于不冷却', async () => {
  const store = createFakeRedis()
  await markCooldown({ userId: '10008', minutes: 0 }, store)
  assert.equal(await getCooldown({ userId: '10008' }, store), 0)
})

test('熔断：连续失败达到阈值才触发，成功一次即清零', async () => {
  const store = createFakeRedis()
  for (let index = 1; index < 5; index += 1) {
    const result = await recordFailure({ threshold: 5, hours: 5 }, store)
    assert.equal(result.tripped, false, `第 ${index} 次不该熔断`)
  }
  const tripped = await recordFailure({ threshold: 5, hours: 5 }, store)
  assert.equal(tripped.tripped, true)
  assert.equal(await store.get(FAIL_STREAK_KEY), null, '熔断后连击要清零，避免解禁后立刻再触发')

  const circuit = await getCircuit(store)
  assert.equal(circuit.open, true)
  assert.ok(circuit.retryAfter > 4 * 3600)
})

test('熔断：中途成功会打断连击', async () => {
  const store = createFakeRedis()
  await recordFailure({ threshold: 3, hours: 5 }, store)
  await recordFailure({ threshold: 3, hours: 5 }, store)
  await recordSuccess(store)
  const result = await recordFailure({ threshold: 3, hours: 5 }, store)
  assert.equal(result.tripped, false)
  assert.equal((await getCircuit(store)).open, false)
})

test('熔断：阈值为 0 时不熔断', async () => {
  const store = createFakeRedis()
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await recordFailure({ threshold: 0, hours: 5 }, store)).tripped, false)
  }
  assert.equal((await getCircuit(store)).open, false)
})

test('熔断：主人解禁后立刻恢复', async () => {
  const store = createFakeRedis()
  await tripCircuit({ hours: 5 }, store)
  assert.equal((await getCircuit(store)).open, true)
  await clearCircuit(store)
  assert.deepEqual(await getCircuit(store), { open: false, retryAfter: 0 })
  assert.equal(store.peek(CIRCUIT_KEY), null)
})

test('Redis 缺失时全部放行，不把功能锁死', async () => {
  const result = await reserveQuota({ userId: '10009', limit: 1 }, null)
  assert.equal(result.ok, true)
  assert.equal(await getCooldown({ userId: '10009' }, null), 0)
  assert.deepEqual(await getCircuit(null), { open: false, retryAfter: 0 })
})
