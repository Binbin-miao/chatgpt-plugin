import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACK_TEMPLATE_COUNT, buildAckText, formatDrawSpan, formatWaitWindow } from '../utils/imageDraw/ack.js'

/** 逐个模板取一条文案：落点放在每格正中，避开浮动误差 */
const rollsFor = index => () => (index + 0.5) / ACK_TEMPLATE_COUNT

test('formatDrawSpan：秒数说成人话', () => {
  assert.equal(formatDrawSpan(180), '3分钟')
  assert.equal(formatDrawSpan(200), '3分20秒')
  assert.equal(formatDrawSpan(90), '1分30秒')
  assert.equal(formatDrawSpan(45), '45秒')
  assert.equal(formatDrawSpan(0), '一会儿')
  assert.equal(formatDrawSpan(Number.NaN), '一会儿')
})

test('formatWaitWindow：报出等待区间', () => {
  assert.equal(formatWaitWindow(180), '30秒~3分钟')
  assert.equal(formatWaitWindow(200), '30秒~3分20秒')
  assert.equal(formatWaitWindow(25), '25秒内')
  assert.equal(formatWaitWindow(0), '一会儿')
})

test('模板至少有八条，且互不雷同', () => {
  assert.ok(ACK_TEMPLATE_COUNT >= 8, `模板只剩 ${ACK_TEMPLATE_COUNT} 条，随机就退化成念稿了`)
  const texts = new Set()
  for (let index = 0; index < ACK_TEMPLATE_COUNT; index += 1) {
    texts.add(buildAckText({ name: '小画', timeoutSeconds: 180, pick: rollsFor(index) }))
  }
  assert.equal(texts.size, ACK_TEMPLATE_COUNT, '每条模板都该是独立文案')
})

test('每条模板都带称呼与等待窗口', () => {
  for (let index = 0; index < ACK_TEMPLATE_COUNT; index += 1) {
    const text = buildAckText({ name: '小画', timeoutSeconds: 200, pick: rollsFor(index) })
    assert.ok(text.includes('小画'), `第 ${index + 1} 条漏了称呼：${text}`)
    assert.ok(text.includes('30秒~3分20秒'), `第 ${index + 1} 条漏了等待窗口：${text}`)
  }
})

test('没取到昵称时用「我」顶替，且不留拼接痕迹', () => {
  for (let index = 0; index < ACK_TEMPLATE_COUNT; index += 1) {
    const text = buildAckText({ name: '  ', timeoutSeconds: 180, pick: rollsFor(index) })
    assert.ok(text.startsWith('我'), `第 ${index + 1} 条没以「我」开头：${text}`)
    assert.doesNotMatch(text, /\s{2,}/, `第 ${index + 1} 条有连续空白：${text}`)
    assert.doesNotMatch(text, /^我\s/, `第 ${index + 1} 条称呼后面挂了空格：${text}`)
  }
})

test('同一个随机值稳定返回同一条文案', () => {
  const pick = () => 0.42
  assert.equal(buildAckText({ name: '小画', pick }), buildAckText({ name: '小画', pick }))
})

test('随机源越界也不抛错', () => {
  assert.ok(buildAckText({ pick: () => 1 }).length > 0, 'pick 返回 1 时不能取到空模板')
  assert.ok(buildAckText({ pick: () => Number.NaN }).length > 0)
})

test('remaining 为剩余张数时，每条模板都说「今天还能画 N 张」（含正在画的这张）', () => {
  for (let index = 0; index < ACK_TEMPLATE_COUNT; index += 1) {
    const text = buildAckText({ name: '小画', remaining: 3, pick: rollsFor(index) })
    assert.match(text, /还能画 3 (张|次)/, `第 ${index + 1} 条没报剩余张数：${text}`)
    assert.doesNotMatch(text, /还剩/, `第 ${index + 1} 条用了「还剩」，与返图那两个数会被读成矛盾：${text}`)
  }
})

test('remaining 为 0 时说「今天是最后一张」', () => {
  for (let index = 0; index < ACK_TEMPLATE_COUNT; index += 1) {
    const text = buildAckText({ name: '小画', remaining: 0, pick: rollsFor(index) })
    assert.match(text, /今天是最后一张/, `第 ${index + 1} 条没说这是最后一张：${text}`)
  }
})

test('remaining 为 null（不限额度/主人）时不提次数', () => {
  for (let index = 0; index < ACK_TEMPLATE_COUNT; index += 1) {
    const text = buildAckText({ name: '小画', remaining: null, pick: rollsFor(index) })
    assert.doesNotMatch(text, /还剩|还能画|最后/, `第 ${index + 1} 条不该报次数：${text}`)
  }
})
