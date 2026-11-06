import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runProviderFallback, createAttemptHistory, trimConversation } from '../utils/providerFallback.js'

const main = { id: 'main' }, backup = { id: 'backup' }
test('主失败重试一次再备用，下一轮重新优先主；独立任务只调用一次', async () => {
  const calls = []
  const execute = async (row, state) => {
    calls.push(row.id)
    state.requested = true
    if (row === main) throw new Error('额度不足')
    return { text: '备用回复' }
  }
  assert.equal((await runProviderFallback(main, backup, execute)).text, '备用回复')
  assert.deepEqual(calls, ['main', 'main', 'backup'])
  calls.length = 0
  await assert.rejects(runProviderFallback(main, backup, execute, { enabled: false }), /额度不足/)
  assert.deepEqual(calls, ['main'])
})

test('工具或生成输出开始后不重试；拒绝和本地校验失败不切换', async () => {
  for (const kind of ['tool', 'output', 'local', 'refusal', 'cancel']) {
    let count = 0
    await assert.rejects(runProviderFallback(main, backup, async (row, state) => {
      count++
      state.requested = kind !== 'local'
      state.irreversible = ['tool', 'output'].includes(kind)
      throw Object.assign(new Error(kind), { noRetry: ['refusal', 'cancel'].includes(kind) })
    }))
    assert.equal(count, 1, kind)
  }
  let count = 0
  assert.equal((await runProviderFallback(main, backup, async () => { count++; return { text: '拒绝', refused: true } })).refused, true)
  assert.equal(count, 1)
})

test('空回复可回退，全失败只尝试三次；历史缓冲与输入隔离', async () => {
  let count = 0
  await assert.rejects(runProviderFallback(main, backup, async (row, state) => { count++; state.requested = true; return { text: '' } }), /有效回复/)
  assert.equal(count, 3)
  const messages = [{ role: 'user', content: '问题' }, { role: 'assistant', content: '答案' }]
  const first = createAttemptHistory('gemini', messages)
  const second = createAttemptHistory('gemini', messages)
  await first.upsertMessage({ id: first.parentMessageId, text: '失败尝试' })
  assert.deepEqual((await second.getMessageById(second.parentMessageId)).parts, [{ text: '答案' }])
  assert.equal(messages[1].content, '答案')
})

const trimCfg = { chatgptBlockCount: 500, maxModelTokens: 600000, apiMaxToken: 65536 }
const pairs = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }))

test('历史裁剪：未超上界不裁，超过才一次裁到 70% 且保持偶数', () => {
  assert.equal(trimConversation(pairs(400), trimCfg).length, 400)
  assert.equal(trimConversation(pairs(500), trimCfg).length, 500)
  const cut = trimConversation(pairs(501), trimCfg)
  assert.equal(cut.length, 350, '500 × 0.7 = 350')
  assert.equal(cut.length % 2, 0)
})

test('历史裁剪后能稳定累积很多轮才再次触发', () => {
  let history = []
  let cuts = 0
  for (let turn = 0; turn < 600; turn++) {
    const before = history.length
    history = trimConversation(history.concat(pairs(2)), trimCfg)
    if (history.length < before) cuts++
    assert.ok(history.length <= 500, '任何时候都不得超过上界')
  }
  // 逐轮裁剪会是 600 次；批量裁剪应该只有个位数
  assert.ok(cuts <= 12, `裁剪次数应远小于轮数，实际 ${cuts}`)
})

test('条数上限为奇数或极小值时仍安全，且结果为偶数', () => {
  for (const count of [1, 2, 3, 5, 7, 199]) {
    const out = trimConversation(pairs(40), { ...trimCfg, chatgptBlockCount: count })
    assert.ok(out.length <= Math.max(2, count), `count=${count} 超出上界`)
    assert.equal(out.length % 2, 0, `count=${count} 裁出了奇数条`)
  }
})

test('0 表示不按条数裁，交给 token 预算', () => {
  const out = trimConversation(pairs(600), { ...trimCfg, chatgptBlockCount: 0 })
  assert.equal(out.length, 600)
})

test('token 预算分支：超预算也一次裁到 70%，不会连轮丢一条', () => {
  const longPairs = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(4000) }))
  const cfg = { chatgptBlockCount: 0, maxModelTokens: 128000, apiMaxToken: 65536 }
  const out = trimConversation(longPairs(40), cfg)
  const chars = out.reduce((n, m) => n + m.content.length, 0)
  // budget = 128000 - 65536 = 62464，字符上限 = budget * 2 = 124928，裁到 70% ≈ 87449
  assert.ok(chars <= 87449, `应收敛到 70% 预算以内，实际 ${chars}`)
  assert.ok(out.length < 40)
  assert.equal(out.length % 2, 0)
})
