import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  CUT_RATIO,
  MAX_HISTORY_MESSAGES,
  clearHistoryWindows,
  getHistoryAnchor,
  planHistoryWindow,
  resetHistoryWindow,
  setHistoryAnchor
} from '../utils/historyWindow.js'

/** 造一段 id 可预测的历史，模拟真实消息链 */
function makeHistory(count, prefix = 'm') {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}` }))
}

test('未超上限：不切割，起点为 0', () => {
  clearHistoryWindows()
  const plan = planHistoryWindow(makeHistory(10), 'conv-a')
  assert.deepEqual(plan, { start: 0, cut: false, anchorId: null })
  assert.equal(getHistoryAnchor('conv-a'), undefined)
})

test('首次超限：一次切到 CUT_RATIO，并记住锚点', () => {
  clearHistoryWindows()
  const history = makeHistory(MAX_HISTORY_MESSAGES + 100)
  const plan = planHistoryWindow(history, 'conv-b')
  const expectedStart = history.length - Math.floor(MAX_HISTORY_MESSAGES * CUT_RATIO)
  assert.equal(plan.cut, true)
  assert.equal(plan.start, expectedStart)
  assert.equal(plan.anchorId, history[expectedStart].id)
  assert.equal(getHistoryAnchor('conv-b'), history[expectedStart].id)
})

test('锚点命中后头不动：追加新消息只是让窗口变长', () => {
  clearHistoryWindows()
  const base = makeHistory(MAX_HISTORY_MESSAGES + 100)
  const first = planHistoryWindow(base, 'conv-c')
  // 下一轮多两条消息（用户提问 + 模型回答）
  const next = base.concat([{ id: 'm-new-1' }, { id: 'm-new-2' }])
  const second = planHistoryWindow(next, 'conv-c')
  assert.equal(second.cut, false, '锚点还在窗口内就不该再切')
  assert.equal(second.start, first.start, '起点必须一字不动，否则前缀整体错位')
})

test('锚点滑出窗口：重新切割，且仍然是「一次切一大段」', () => {
  clearHistoryWindows()
  const history = makeHistory(MAX_HISTORY_MESSAGES + 100)
  const first = planHistoryWindow(history, 'conv-d')
  // 一次追加到超过上限，中间不调用 plan（真实场景是很多轮之后才再次触发）
  const grown = history.concat(makeHistory(Math.floor(MAX_HISTORY_MESSAGES * CUT_RATIO) + 5, 'g'))
  const cut = planHistoryWindow(grown, 'conv-d')
  assert.equal(cut.cut, true)
  assert.ok(cut.start > first.start, '锚点必须向前推进')
  assert.equal(cut.start, grown.length - Math.floor(MAX_HISTORY_MESSAGES * CUT_RATIO))
})

test('会话重建（锚点不在链上）不会报错，按首次超限处理', () => {
  clearHistoryWindows()
  setHistoryAnchor('conv-e', 'not-in-chain')
  const history = makeHistory(MAX_HISTORY_MESSAGES + 10)
  const plan = planHistoryWindow(history, 'conv-e')
  assert.equal(plan.cut, true)
  assert.equal(plan.anchorId, history[plan.start].id)
})

test('不同会话的锚点互不影响', () => {
  clearHistoryWindows()
  const a = makeHistory(MAX_HISTORY_MESSAGES + 100, 'a')
  const b = makeHistory(MAX_HISTORY_MESSAGES + 100, 'b')
  const planA = planHistoryWindow(a, 'conv-a')
  const planB = planHistoryWindow(b, 'conv-b')
  assert.equal(getHistoryAnchor('conv-a'), a[planA.start].id)
  assert.equal(getHistoryAnchor('conv-b'), b[planB.start].id)
  assert.notEqual(planA.anchorId, planB.anchorId)
  resetHistoryWindow('conv-a')
  assert.equal(getHistoryAnchor('conv-a'), undefined)
})

test('空历史与自定义参数', () => {
  clearHistoryWindows()
  assert.deepEqual(planHistoryWindow([], 'conv-f'), { start: 0, cut: false, anchorId: null })
  assert.deepEqual(planHistoryWindow(undefined, 'conv-f'), { start: 0, cut: false, anchorId: null })

  const history = makeHistory(100)
  const plan = planHistoryWindow(history, 'conv-g', { maxKeep: 50, ratio: 0.5 })
  assert.equal(plan.cut, true)
  assert.equal(plan.start, 100 - 25)
})

test('长期增长中切割次数很少（这才是相对滑动窗口的收益）', () => {
  clearHistoryWindows()
  let history = []
  let cuts = 0
  let stableTurns = 0
  const totalTurns = 1500
  for (let turn = 0; turn < totalTurns; turn++) {
    history = history.concat([{ id: `u${turn}` }, { id: `a${turn}` }])
    const plan = planHistoryWindow(history, 'conv-long')
    if (plan.cut) cuts++
    else stableTurns++
  }
  // 滑动窗口会是 1500 次全切；锚点应该只有个位数到二十几次
  assert.ok(cuts < 30, `切割次数应远小于轮数，实际 ${cuts}`)
  assert.ok(stableTurns > totalTurns * 0.95, `绝大多数轮次前缀应保持不动，实际 ${stableTurns}`)
})

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

test('四个通道都接了同一套窗口逻辑，不会漏掉某一条', () => {
  assert.match(read('utils/openai/chatgpt-api.js'), /setHistoryAnchor/, 'OpenAI Chat 未接入')
  assert.match(read('client/ClaudeAPIClient.js'), /planHistoryWindow/, 'Claude 未接入')
  assert.match(read('client/CustomGoogleGeminiClient.js'), /planHistoryWindow/, 'Gemini 未接入')
  assert.match(read('model/core.js'), /planHistoryWindow/, 'Responses 无状态路径未接入')
})

test('显式设置的条数上限不被批量切块改写', () => {
  const source = read('utils/openai/chatgpt-api.js')
  assert.match(source, /if \(stopReason === 'budget' &&/, '只有预算路径才允许批量切块')
  assert.doesNotMatch(source, /=== 'block_count_reached'/, '条数上限必须精确遵守，不能参与批量切块')
})
