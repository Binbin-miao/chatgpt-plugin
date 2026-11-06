import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const core = fs.readFileSync(new URL('../model/core.js', import.meta.url), 'utf8')
const claudeClient = fs.readFileSync(new URL('../client/ClaudeAPIClient.js', import.meta.url), 'utf8')

/**
 * 缓存能不能命中，只取决于「稳定前缀有多长」。
 * 这些断言锁住的是拼接顺序，不是具体文案——改文案不会红，把动态内容挪回中间会红。
 */

test('动态段（当前时间/时间线）已从 mergeSystemPrompt 移出', () => {
  const start = core.indexOf('function mergeSystemPrompt(')
  assert.ok(start > -1, '找不到 mergeSystemPrompt')
  const open = core.indexOf('{', start)
  const close = core.indexOf('\n}', open)
  assert.ok(open > -1 && close > open, '找不到 mergeSystemPrompt 函数体')

  const stableFn = core.slice(open, close)
  assert.equal(stableFn.includes('Current time'), false, 'mergeSystemPrompt 里不该再有当前时间')
  assert.equal(stableFn.includes('Conversation timeline'), false, 'mergeSystemPrompt 里不该再有对话时间线')
  assert.equal(stableFn.includes('replyTimestamps'), false, 'mergeSystemPrompt 不该再接收 replyTimestamps')
})

test('message_id 归入动态段，不再混进稳定段', () => {
  const start = core.indexOf('async function collectTools')
  assert.ok(start > -1, '找不到 collectTools')
  const body = core.slice(start, core.indexOf('async function', start + 10))

  assert.ok(body.includes("let systemDynamic = ''"), '缺少 systemDynamic 声明')
  assert.ok(body.includes('systemDynamic += `\\nthe last message id is'), 'message_id 没进动态段')
  assert.ok(body.includes('systemDynamic += `\\nthe last message is replying to'), 'reply-to 没进动态段')
  assert.equal(body.includes('systemAddition += `\\nthe last message'), false, 'message_id 仍在稳定段')
})

test('四条通道都先拼稳定段、再追加动态段', () => {
  const re = /buildDynamicSystemSuffix\(\{ replyTimestamps/g
  const hits = []
  let m
  while ((m = re.exec(core))) hits.push(m.index)

  assert.equal(hits.length, 4, `应有 4 处动态段追加（OpenAI / Responses / Claude / Gemini），实际 ${hits.length}`)

  for (const index of hits) {
    const window = core.slice(Math.max(0, index - 3000), index)
    assert.match(
      window,
      /systemAddition|extraSystemMessage/,
      `动态段之前没找到稳定段追加：\n${window.slice(-200)}`
    )
  }
})

test('Claude 分支把稳定段长度交给客户端', () => {
  assert.ok(core.includes('option.systemStableLength = claudeStableLength'), 'Claude 分支没传稳定段长度')
})

test('Claude 客户端的缓存断点按稳定段切分，而不是打在整段末尾', () => {
  assert.ok(claudeClient.includes("cache_control: { type: 'ephemeral' }"), '缺少 cache_control 断点')
  assert.ok(claudeClient.includes('systemStableLength'), '断点没有按稳定段长度切分')
  assert.ok(
    claudeClient.includes('text.slice(0, stableLength)'),
    '稳定段没有单独切出来做断点'
  )
})
