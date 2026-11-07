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
    // 必须比「加了两条之后」少，才算真的裁过。只比 before 会漏掉
    // 「每轮从头部挤掉一条」这种退化——那正是本改动要消灭的行为
    if (history.length < before + 2) cuts++
    assert.ok(history.length <= 500, '任何时候都不得超过上界')
  }
  assert.ok(cuts <= 7, `裁剪次数应远小于轮数，实际 ${cuts}`)
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

  // 稳态才是关键：触发线与目标线若写成同一个，裁完刚好停在目标线，
  // 下一轮加一对又超，于是每轮都裁——与本次要修的滑窗完全一样。
  let steady = out
  let steadyCuts = 0
  for (let turn = 0; turn < 20; turn++) {
    const before = steady.length
    steady = trimConversation(steady.concat(longPairs(2)), cfg)
    if (steady.length < before + 2) steadyCuts++
  }
  assert.ok(steadyCuts <= 5, `稳态下不应每轮裁剪，实际 20 轮裁了 ${steadyCuts} 次`)
})

test('上下文窗口按通道类型取值：claude / gemini 不会被当成 12.8 万来裁', () => {
  const longPairs = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(4000) }))
  const history = longPairs(80)
  const cfg = { chatgptBlockCount: 0 }
  const api = trimConversation(history, cfg, { type: 'api' })
  const claude = trimConversation(history, cfg, { type: 'claude' })
  const gemini = trimConversation(history, cfg, { type: 'gemini' })
  assert.ok(claude.length > api.length, `200k 的 claude 应比 128k 的 api 留得多，实际 ${claude.length} vs ${api.length}`)
  assert.ok(gemini.length >= claude.length, '1M 的 gemini 应留得最多')
  assert.equal(gemini.length, 80, 'gemini 的窗口足够装下全部，不该裁')
})

test('输出预留大于窗口时不吃掉全部预算，否则历史每轮只剩 2 条', () => {
  const pairs = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(100) }))
  const out = trimConversation(pairs(10), { chatgptBlockCount: 0, maxModelTokens: 8192, apiMaxToken: 16384 })
  assert.equal(out.length, 10, '窗口被输出上限吃掉时应退回保守预算，而不是砍到 2 条')
})

test('迁移遗留的奇数条 / assistant 起头历史会被收敛成 user 起头且偶数', () => {
  const cfg = { chatgptBlockCount: 500 }
  const mk = (role, i) => ({ role, content: `第${i}条` })
  // 以 assistant 起头的 5 条
  const dirty = [mk('assistant', 0), mk('user', 1), mk('assistant', 2), mk('user', 3), mk('assistant', 4)]
  const out = trimConversation(dirty, cfg, { type: 'gemini' })
  assert.equal(out[0].role, 'user', '首条必须是 user，否则 Gemini 直接 400')
  assert.equal(out.length % 2, 0, '长度必须是偶数才能保证 user/model 交替')
  assert.equal(out.length, 4, '从第一个 user 起算，尾部对齐成偶数对')

  // 正常数据不应被改动
  const clean = [mk('user', 0), mk('assistant', 1), mk('user', 2), mk('assistant', 3)]
  assert.deepEqual(trimConversation(clean, cfg, { type: 'gemini' }), clean)
  // 其他通道不做这层约束，正常数据同样不应被改动
  assert.deepEqual(trimConversation(clean, cfg), clean)
})
