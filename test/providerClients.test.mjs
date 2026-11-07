import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createAttemptHistory, runProviderFallback } from '../utils/providerFallback.js'
import { createToolForwardMock } from './fixtures/toolForwardMock.mjs'

// 仅替换宿主、媒体发送和网络边界，执行四种协议客户端的真实响应解析。
const Config = { geminiMaxOutputTokens: 1024, gemini_temperature: 0.3, llm_maxToolRounds: 3 }
mock.module('../utils/config.js', { namedExports: { Config } })
mock.module('../utils/common.js', { namedExports: { makeForwardMsg() {} } })
mock.module('../utils/paimonFuction.js', { namedExports: { splitString_Enter() {} } })
// toolForward 统一测试桩（fixtures/toolForwardMock.mjs）：该模块新增导出只需改工厂一处
const toolForwardMock = createToolForwardMock()
mock.module('../utils/toolForward.js', { namedExports: toolForwardMock.namedExports })
mock.module('../utils/face.js', { namedExports: { convertFacesAndCQCode: text => [text] } })
mock.module('../utils/proxy.js', { namedExports: { newFetch() { throw new Error('不应请求真实网络') } } })
globalThis.logger = { info() {}, warn() {}, error() {}, debug() {} }
const { ChatGPTAPI } = await import('../utils/openai/chatgpt-api.js')
const { ResponsesAPI } = await import('../utils/openai/responses-api.js')
const { ClaudeAPIClient } = await import('../client/ClaudeAPIClient.js')
const { CustomGoogleGeminiClient } = await import('../client/CustomGoogleGeminiClient.js')
const { McpTool } = await import('../utils/tools/McpTool.js')

const refusals = {
  api: { id: 'a', choices: [{ message: { role: 'assistant', refusal: '拒绝回答' }, finish_reason: 'stop' }] },
  responses: { id: 'r', output: [{ type: 'message', content: [{ type: 'refusal', refusal: '拒绝回答' }] }] },
  claude: { role: 'assistant', stop_reason: 'refusal', content: [{ type: 'text', text: '拒绝回答' }] },
  gemini: { candidates: [{ finishReason: 'SAFETY', content: { role: 'model', parts: [{ text: '' }] } }] }
}

function createClient(type, fetch, onToolStart = () => {}, history = createAttemptHistory(type)) {
  const options = { apiKey: 'fixture-key', key: 'fixture-key', fetch, onToolStart, config: Config,
    model: 'fixture-model', ...history, maxModelTokens: 8192, maxResponseTokens: 1024 }
  if (type === 'api') return new ChatGPTAPI({ ...options, completionParams: { model: 'gpt-4o-mini' } })
  if (type === 'responses') return new ResponsesAPI(options)
  if (type === 'claude') return new ClaudeAPIClient(options)
  return new CustomGoogleGeminiClient(options)
}

test('四协议明确拒绝均停止整轮重试，Gemini 空文本安全拦截也不回退', async () => {
  for (const [type, body] of Object.entries(refusals)) {
    let calls = 0
    const run = runProviderFallback({ id: 'main' }, { id: 'backup' }, async (row, state) => {
      const client = createClient(type, async () => { calls++; state.requested = true; return Response.json(body) })
      return client.sendMessage('问题', {})
    })
    if (type === 'gemini') await assert.rejects(run, /模型拒绝回答/)
    else assert.equal((await run).refused, true)
    assert.equal(calls, 1, type)
  }
})

test('Gemini 与 Claude 原生工具响应标记为已执行，不因空正文再次请求', async () => {
  const payloads = {
    gemini: { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: '' }] }, groundingMetadata: { webSearchQueries: ['测试查询'] } }] },
    claude: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'server_tool_use', id: 'tool', name: 'web_search', input: {} }] }
  }
  for (const [type, body] of Object.entries(payloads)) {
    let calls = 0, tools = 0
    await runProviderFallback({ id: 'main' }, { id: 'backup' }, async (row, state) => {
      const client = createClient(type, async () => { calls++; state.requested = true; return Response.json(body) }, () => { tools++; state.irreversible = true })
      return client.sendMessage('搜索', {})
    })
    assert.equal(calls, 1, type)
    assert.equal(tools, 1, type)
  }
})

test('Gemini 使用条目温度，显式 0 不被默认值覆盖', async () => {
  const bodies = []
  const client = createClient('gemini', async (url, options) => {
    bodies.push(JSON.parse(options.body))
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: '回答' }] } }] })
  })
  await client.sendMessage('问题')
  await client.sendMessage('问题', { temperature: 0 })
  assert.equal(bodies[0].generationConfig.temperature, 0.3)
  assert.equal(bodies[1].generationConfig.temperature, 0)
})

test('Gemini 重建 50 条本地历史时仅发送协议字段，完整携带旧问答', async () => {
  const messages = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `历史消息${i}` }))
  const history = createAttemptHistory('gemini', messages)
  let request
  const client = new CustomGoogleGeminiClient({
    key: 'fixture-key', model: 'fixture-model', config: { ...Config, chatgptBlockCount: 50 }, ...history,
    fetch: async (url, options) => {
      request = JSON.parse(options.body)
      // Google Content 协议只接受 role、parts，不能混入插件自己的 text/content/链指针。
      const invalid = request.contents.some(message => Object.keys(message).some(key => !['role', 'parts'].includes(key)))
      if (invalid) return new Response('Unknown name in Content', { status: 400 })
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: '记得' }] } }] })
    }
  })
  const result = await client.sendMessage('继续', { parentMessageId: history.parentMessageId })
  assert.equal(result.text, '记得')
  assert.deepEqual(request.contents.slice(0, -1), messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })))
  assert.equal(request.contents.length, 51)
})

test('Gemini 工具回填保持完整历史链，不截断之前的用户上下文', async () => {
  const messages = [{ role: 'user', content: '我叫小明' }, { role: 'assistant', content: '记住了' }, { role: 'user', content: '我喜欢蓝色' }, { role: 'assistant', content: '好的' }]
  const history = createAttemptHistory('gemini', messages)
  const requests = []
  const client = new CustomGoogleGeminiClient({
    key: 'fixture-key', model: 'fixture-model', config: Config, ...history,
    e: { user_id: '123', sender: { user_id: '123', role: 'member' }, reply: async () => {} },
    fetch: async (url, options) => {
      requests.push(JSON.parse(options.body))
      const parts = requests.length === 1 ? [{ functionCall: { name: 'lookup', args: {} } }] : [{ text: '小明喜欢蓝色' }]
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] })
    }
  })
  let called = 0
  client.addTools([{ name: 'lookup', function: () => ({ name: 'lookup', description: '查询', parameters: { type: 'object', properties: {} } }), func: async () => { called++; return '查询完成' } }])
  const result = await client.sendMessage('查完后说出我的名字和喜好', { parentMessageId: history.parentMessageId })
  assert.equal(result.text, '小明喜欢蓝色')
  assert.equal(called, 1)
  assert.equal(requests.length, 2)
  for (const request of requests) assert.deepEqual(request.contents.slice(0, 4).map(message => message.parts[0].text), messages.map(message => message.content))
  assert.ok((await history.getMessageById(history.parentMessageId)).parentMessageId)
})

for (const { label, ...systemOptions } of [
  { label: '非空', system: '保持原始系统前缀\n按工具结果回答。' },
  { label: '空', system: '' },
  { label: '未提供' }
]) {
  test(`Gemini 连续工具回填保持${label} system、完整历史和原始结果，上限 NONE 优先于 ANY`, async () => {
    const messages = [{ role: 'user', content: '我喜欢蓝色' }, { role: 'assistant', content: '记住了' }]
    const history = createAttemptHistory('gemini', messages)
    const requests = []
    const called = []
    const toolResults = [
      { name: 'searchImage', content: '蓝色图片查询完成' },
      { name: 'searchMusic', content: { tracks: ['蓝色乐曲'], count: 1 } }
    ]
    const functionCalls = toolResults.map(({ name }, index) => ({ name, args: {}, thoughtSignature: `signature-${index}` }))
    const client = new CustomGoogleGeminiClient({
      key: 'fixture-key', model: 'fixture-model', config: { ...Config, llm_maxToolRounds: 1 }, ...history,
      e: { user_id: '123', sender: { user_id: '123', role: 'member' }, reply: async () => {} },
      fetch: async (url, options) => {
        const functionCall = functionCalls[requests.length]
        requests.push(JSON.parse(options.body))
        const parts = functionCall ? [{ functionCall }] : [{ text: '已找到蓝色图片和乐曲' }]
        return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] })
      }
    })
    client.addTools(toolResults.map(({ name, content }) => ({
      name,
      function: () => ({ name, description: '查询', parameters: { type: 'object', properties: {} } }),
      func: async () => { called.push(name); return content }
    })))
    const result = await client.sendMessage('查询图片和乐曲', { parentMessageId: history.parentMessageId, ...systemOptions })
    assert.equal(result.text, '已找到蓝色图片和乐曲')
    assert.deepEqual(called, toolResults.map(({ name }) => name))
    assert.equal(requests.length, 3)
    assert.deepEqual(requests.map(request => request.toolConfig.functionCallingConfig.mode), ['AUTO', 'ANY', 'NONE'])
    const expectedContents = [
      ...messages.map(({ role, content }) => ({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] })),
      { role: 'user', parts: [{ text: '查询图片和乐曲' }] }
    ]
    for (const [index, request] of requests.entries()) {
      if (index > 0) {
        const { name, content } = toolResults[index - 1]
        const functionCall = functionCalls[index - 1]
        expectedContents.push(
          { role: 'model', parts: [{ functionCall }] },
          { role: 'user', parts: [{ functionResponse: { name, response: { name, content }, thoughtSignature: functionCall.thoughtSignature } }] }
        )
      }
      assert.deepEqual(request.contents, expectedContents, `第 ${index + 1} 轮只能追加原始工具协议消息`)
      assert.deepEqual(request.system_instruction, systemOptions.system ? { parts: [{ text: systemOptions.system }] } : undefined)
      assert.equal(Object.hasOwn(request, 'system_instruction'), Boolean(systemOptions.system))
    }
  })
}

/** 沿 parentMessageId 走完存储链，用于断言「落库内容里没有 base64」 */
async function collectStoredChain(history, startId) {
  const chain = []
  let cursor = startId
  while (cursor) {
    const message = await history.getMessageById(cursor)
    if (!message) break
    chain.push(message)
    cursor = message.parentMessageId
  }
  return chain
}

test('Gemini 工具轮回放本轮引用图：图片只在用户轮出现一次', async () => {
  const IMAGE_BYTES = 'iVBORw0KGgo='
  const history = createAttemptHistory('gemini')
  const requests = []
  const client = new CustomGoogleGeminiClient({
    key: 'fixture-key', model: 'fixture-model', config: Config, ...history,
    e: { user_id: '123', sender: { user_id: '123', role: 'member' }, reply: async () => {} },
    fetch: async (url, options) => {
      requests.push(JSON.parse(options.body))
      const parts = requests.length === 1 ? [{ functionCall: { name: 'lookup', args: {} } }] : [{ text: '看完了' }]
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] })
    }
  })
  client.addTools([{ name: 'lookup', function: () => ({ name: 'lookup', description: '查询', parameters: { type: 'object', properties: {} } }), func: async () => 'ok' }])
  const result = await client.sendMessage('这张图里是什么', {
    parentMessageId: history.parentMessageId,
    medias: [{ mimeType: 'image/png', data: IMAGE_BYTES }]
  })
  assert.equal(requests.length, 2)
  assert.ok(JSON.stringify(requests[0]).includes(IMAGE_BYTES), '用户轮必须带图')
  // 工具回调轮不能丢图，也不能把图挪到 functionResponse 那一轮：图回到最初那条用户消息，恰好一次
  assert.equal(JSON.stringify(requests[1]).split(IMAGE_BYTES).length - 1, 1, '第二次请求里图片只出现一次')
  const userTurn = requests[1].contents[0]
  assert.equal(userTurn.role, 'user')
  assert.equal(userTurn.parts[0].text, '这张图里是什么')
  assert.deepEqual(userTurn.parts[1], { inline_data: { mime_type: 'image/png', data: IMAGE_BYTES } })
  const callbackParts = requests[1].contents.at(-1).parts
  assert.ok(callbackParts.every(part => !part.inlineData && !part.inline_data), '回调轮不得带图')
  // 存储形态不变：落库内容仍然只有文本占位符
  const stored = await collectStoredChain(history, result.parentMessageId)
  assert.ok(stored.length > 0)
  assert.ok(stored.every(message => !JSON.stringify(message).includes(IMAGE_BYTES)), '落库内容不得包含 base64')
  assert.ok(stored.some(message => JSON.stringify(message).includes('[多媒体附件: image/png]')), '落库内容应保留媒体占位')
})

test('OpenAI Chat 工具轮回放本轮引用图：图片只在用户轮出现一次', async () => {
  const IMAGE_BYTES = 'iVBORw0KGgo='
  const history = createAttemptHistory('api')
  const requests = []
  const client = createClient('api', async (url, options) => {
    requests.push(JSON.parse(options.body))
    const message = requests.length === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }
      : { role: 'assistant', content: '看完了' }
    return Response.json({ id: `resp-${requests.length}`, choices: [{ message, finish_reason: 'stop' }] })
  }, () => {}, history)
  const messageContent = [
    { type: 'text', text: '这张图里是什么动物' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE_BYTES}` } }
  ]
  const first = await client.sendMessage(messageContent, { parentMessageId: history.parentMessageId })
  // 复刻 model/core.js 的工具轮组装：用户消息 id 只在第一轮响应之后可取
  await client.sendMessage(null, {
    parentMessageId: first.id,
    appendMessages: [{
      id: first.id, role: 'assistant', text: first.text || '', originalContent: first.originalContent ?? (first.text || null),
      parentMessageId: first.parentMessageId, conversationId: first.conversationId, functionCall: first.functionCall, toolCalls: first.toolCalls
    }, {
      id: 'tool-message-1', role: 'tool', text: '工具返回', originalContent: '工具返回',
      parentMessageId: first.id, conversationId: first.conversationId, toolCallId: 'call_1'
    }],
    turnContent: { id: first.parentMessageId, content: messageContent },
    // 全局提示会原地改请求消息的首个 text part；调用方持有的数组不得被写回
    paimon_globalInnerOs: 'OS-BLOCK'
  })
  assert.equal(requests.length, 2)
  assert.equal(messageContent[0].text, '这张图里是什么动物', '调用方的原始 content 不得被同步提示改写')
  assert.match(JSON.stringify(requests[1]), /OS-BLOCK/, '全局提示应写进本次请求')
  assert.equal(JSON.stringify(requests[1]).split(IMAGE_BYTES).length - 1, 1, '第二次请求里图片只出现一次')
  const userMessage = requests[1].messages.find(message => message.role === 'user')
  assert.ok(Array.isArray(userMessage.content), '工具轮的用户消息必须是多模态数组')
  assert.deepEqual(userMessage.content.at(-1), { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE_BYTES}` } })
  const stored = await collectStoredChain(history, first.parentMessageId)
  assert.ok(stored.length > 0)
  assert.ok(stored.every(message => !JSON.stringify(message).includes(IMAGE_BYTES)), '落库内容不得包含 base64')
  assert.ok(stored.some(message => JSON.stringify(message).includes('[图片]')), '落库内容应保留媒体占位')
})

// ===== 思维链识别（各 provider → thinking_text，由 forwardReasoning 开关决定是否转发）=====

/** 构造 SSE 流式响应，供 OpenAI 兼容流式思维链用例使用 */
function sseResponse(chunks) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

test('Gemini 思考 part 拆分为 thinking_text，不再与正文拼接', async () => {
  const client = createClient('gemini', async () => Response.json({
    candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [
      { text: '思考中：先分析问题', thought: true },
      { text: '正式回复内容' }
    ] } }]
  }))
  const result = await client.sendMessage('问题', {})
  assert.equal(result.text, '正式回复内容')
  assert.equal(result.thinking_text, '思考中：先分析问题')
})

test('Gemini 工具轮不把思考当工具间回复，思考跨轮累积到 thinking_text', async () => {
  const history = createAttemptHistory('gemini')
  const replies = []
  toolForwardMock.forwardCalls.length = 0
  let calls = 0
  const client = new CustomGoogleGeminiClient({
    key: 'fixture-key', model: 'fixture-model', config: Config, ...history,
    e: {
      user_id: '123', sender: { user_id: '123', role: 'member' },
      reply: async (msg) => { replies.push(Array.isArray(msg) ? msg.join('') : msg) }
    },
    fetch: async () => {
      calls++
      const parts = calls === 1
        ? [{ text: '第一轮思考', thought: true }, { text: '我先查一下' }, { functionCall: { name: 'lookup', args: {} } }]
        : [{ text: '第二轮思考', thought: true }, { text: '查到了答案' }]
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] })
    }
  })
  client.addTools([{
    name: 'lookup',
    function: () => ({ name: 'lookup', description: '查询', parameters: { type: 'object', properties: {} } }),
    func: async () => '查询完成'
  }])
  const result = await client.sendMessage('查一下', {})
  assert.equal(calls, 2)
  assert.equal(result.text, '查到了答案')
  assert.equal(result.thinking_text, '第一轮思考第二轮思考')
  // 工具轮文本以合并转发立即单独外发，不再裸发群消息
  assert.deepEqual(toolForwardMock.forwardCalls.flat().map(x => x.text), ['我先查一下'])
  assert.deepEqual(replies, [])
})

test('Gemini 工具轮独白重归类为 thinking，不作为工具轮回复外发', async () => {
  const history = createAttemptHistory('gemini')
  const replies = []
  toolForwardMock.forwardCalls.length = 0
  let calls = 0
  const client = new CustomGoogleGeminiClient({
    key: 'fixture-key', model: 'fixture-model', config: Config, ...history,
    e: {
      user_id: '123', sender: { user_id: '123', role: 'member' },
      reply: async (msg) => { replies.push(Array.isArray(msg) ? msg.join('') : msg) }
    },
    fetch: async () => {
      calls++
      const parts = calls === 1
        ? [{ text: "(wait, I should call lookup ...). Let's call lookup!" }, { functionCall: { name: 'lookup', args: {} } }]
        : [{ text: '查到了答案' }]
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] })
    }
  })
  client.addTools([{
    name: 'lookup',
    function: () => ({ name: 'lookup', description: '查询', parameters: { type: 'object', properties: {} } }),
    func: async () => '查询完成'
  }])
  const result = await client.sendMessage('查一下', {})
  assert.equal(result.text, '查到了答案')
  assert.equal(toolForwardMock.forwardCalls.length, 0)
  assert.match(result.thinking_text, /Let's call lookup/)
  assert.deepEqual(replies, [])
})

test('Claude 工具轮文本立即单独外发，思考跨轮并入 thinking_text', async () => {
  const history = createAttemptHistory('claude')
  const replies = []
  toolForwardMock.forwardCalls.length = 0
  let calls = 0
  const client = new ClaudeAPIClient({
    key: 'fixture-key', model: 'fixture-model', config: Config, ...history,
    e: {
      user_id: '123', sender: { user_id: '123', role: 'member' },
      reply: async (msg) => { replies.push(Array.isArray(msg) ? msg.join('') : msg) }
    },
    fetch: async () => {
      calls++
      const content = calls === 1
        ? [{ type: 'thinking', thinking: '第一轮思考' }, { type: 'text', text: '我先查一下' }, { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} }]
        : calls === 2
          ? [{ type: 'thinking', thinking: '第二轮思考' }, { type: 'text', text: '再查一次' }, { type: 'tool_use', id: 'tool-2', name: 'lookup', input: {} }]
          : [{ type: 'thinking', thinking: '第三轮思考' }, { type: 'text', text: '查到了答案' }]
      return Response.json({ id: 'fixture-msg', role: 'assistant', stop_reason: calls < 3 ? 'tool_use' : 'end_turn', content })
    }
  })
  client.addTools([{
    name: 'lookup',
    function: () => ({ name: 'lookup', description: '查询', parameters: { type: 'object', properties: {} } }),
    func: async () => '查询完成'
  }])
  const result = await client.sendMessage('查一下', {})
  assert.equal(calls, 3)
  assert.equal(result.text, '查到了答案')
  assert.equal(result.thinking_text, '第一轮思考第二轮思考第三轮思考')
  // 每一个工具轮的文本都以合并转发立即单独外发，不再被丢弃
  assert.deepEqual(toolForwardMock.forwardCalls.flat().map(x => x.text), ['我先查一下', '再查一次'])
  assert.deepEqual(replies, [])
})

test('OpenAI 兼容非流式思维链按 reasoning_content → reasoning → reasoning_details 兜底', async () => {
  const cases = [
    [{ role: 'assistant', content: '答案', reasoning_content: '思考A' }, '思考A'],
    [{ role: 'assistant', content: '答案', reasoning: '思考B' }, '思考B'],
    [{ role: 'assistant', content: '答案', reasoning_details: [
      { type: 'reasoning.text', text: '思考C1' },
      { type: 'reasoning.summary', summary: '思考C2' },
      { type: 'reasoning.encrypted', data: 'ignored' }
    ] }, '思考C1\n思考C2']
  ]
  for (const [message, expected] of cases) {
    const client = createClient('api', async () => Response.json({ id: 'x', choices: [{ finish_reason: 'stop', message }] }))
    const result = await client.sendMessage('问题', {})
    assert.equal(result.text, '答案')
    assert.equal(result.thinking_text, expected)
  }
})

test('OpenAI 兼容流式按 delta.reasoning_content / delta.reasoning 累积思维链', async () => {
  const client = createClient('api', async () => sseResponse([
    { id: 'x', choices: [{ delta: { role: 'assistant' } }] },
    { id: 'x', choices: [{ delta: { reasoning_content: '思考一' } }] },
    { id: 'x', choices: [{ delta: { content: '正' } }] },
    { id: 'x', choices: [{ delta: { reasoning: '思考二' } }] },
    { id: 'x', choices: [{ delta: { content: '文' } }] }
  ]))
  const result = await client.sendMessage('问题', { stream: true })
  assert.equal(result.text, '正文')
  assert.equal(result.thinking_text, '思考一思考二')
})

test('Responses 思维链 summary 优先，content.reasoning_text 兜底', async () => {
  const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案' }] }
  const cases = [
    [[{ type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: '摘要1' }] }, message], '摘要1'],
    [[{ type: 'reasoning', id: 'r2', summary: ['摘要2'] }, message], '摘要2'],
    [[{ type: 'reasoning', id: 'r3', summary: [], content: [{ type: 'reasoning_text', text: '原始CoT' }] }, message], '原始CoT']
  ]
  for (const [output, expected] of cases) {
    const client = createClient('responses', async () => Response.json({ id: 'resp', output }))
    const result = await client.sendMessage('问题', {})
    assert.equal(result.text, '答案')
    assert.equal(result.thinking_text, expected)
  }
})

// ===== 连接级重试：responses / claude 与 openai / gemini 对齐（最多 3 次、每次间隔 60 秒）=====

test('Responses 与 Claude 连接错误按 3×60s 重试：三次失败后恢复，穷尽上限如实抛错', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)) }
  const payloads = {
    responses: { id: 'r', output: [{ type: 'message', content: [{ type: 'output_text', text: '恢复' }] }] },
    claude: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '恢复' }] }
  }
  for (const [type, payload] of Object.entries(payloads)) {
    let calls = 0
    const client = createClient(type, async () => {
      calls++
      if (calls < 4) {
        const error = new Error('socket hang up')
        error.code = 'ECONNRESET'
        throw error
      }
      return Response.json(payload)
    })
    const run = client.sendMessage('问题', {})
    await flush()
    assert.equal(calls, 1, type)
    t.mock.timers.tick(59999)
    await flush()
    assert.equal(calls, 1, `${type} 未满 60 秒不得重试`)
    t.mock.timers.tick(1)
    await flush()
    assert.equal(calls, 2, type)
    t.mock.timers.tick(60000)
    await flush()
    assert.equal(calls, 3, type)
    t.mock.timers.tick(60000)
    await flush()
    assert.equal(calls, 4, type)
    assert.equal((await run).text, '恢复')
  }
  for (const type of Object.keys(payloads)) {
    let calls = 0
    const client = createClient(type, async () => {
      calls++
      const error = new Error('socket hang up')
      error.code = 'ECONNRESET'
      throw error
    })
    const run = assert.rejects(client.sendMessage('问题', {}), /socket hang up/)
    for (let i = 0; i < 3; i++) {
      await flush()
      t.mock.timers.tick(60000)
    }
    await flush()
    await run
    assert.equal(calls, 4, `${type} 重试上限为 3 次`)
  }
})

test('Responses 与 Claude HTTP 状态错误立即失败，不进入连接级重试', async () => {
  for (const type of ['responses', 'claude']) {
    let calls = 0
    let outcome = ''
    const client = createClient(type, async () => {
      calls++
      return new Response('bad request', { status: 400 })
    })
    const run = client.sendMessage('问题', {}).then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(outcome, 'rejected', `${type} HTTP 状态错误应立即抛错`)
    assert.equal(calls, 1, type)
    await run
  }
})

test('提供商报错只向上抛，不把错误文案写进消息历史', async () => {
  const history = createAttemptHistory('claude')
  const upserts = []
  const client = new ClaudeAPIClient({
    key: 'fixture-key',
    model: 'fixture-model',
    config: Config,
    getMessageById: history.getMessageById,
    upsertMessage: async (message) => { upserts.push(message) }
  })
  client.getHistory = async () => []
  client._createMessage = async () => {
    throw new Error('OpenAI error 429: {"error":{"message":"upstream rate limit reached"}}')
  }
  await assert.rejects(() => client.sendMessage('你好', {}), /429/)
  assert.deepEqual(upserts, [], '失败轮不得把错误文案或占位回复写入会话历史')
})

test('api 与 gemini 提供商报错也只抛错，不写入消息历史', async () => {
  const cases = [
    ['api', async () => { throw new Error('429 upstream rate limit reached') }],
    ['gemini', async () => new Response(
      JSON.stringify({ error: { code: 429, message: '429 upstream rate limit reached' } }),
      { status: 429, headers: { 'content-type': 'application/json' } }
    )]
  ]
  for (const [type, fetchImpl] of cases) {
    const history = createAttemptHistory(type)
    const upserts = []
    const client = createClient(type, fetchImpl)
    // ChatGPTAPI 走构造函数注入的 _upsertMessage，Gemini 用 this.upsertMessage；
    // ResponsesAPI 没有持久化钩子（历史由调用方管），故不在此列
    if (type === 'api') client._upsertMessage = async (message) => { upserts.push(message) }
    else client.upsertMessage = async (message) => { upserts.push(message) }
    await assert.rejects(
      () => client.sendMessage('你好', { parentMessageId: history.parentMessageId }),
      /429|rate limit/,
      type
    )
    assert.deepEqual(upserts, [], `${type} 失败轮不得写入任何消息`)
  }
})

test('Gemini 与 Claude 调用 McpTool 时不注入 sender/isAdmin/groupId，也不用 mode 覆盖业务参数', async () => {
  const mcpCalls = []
  const mcpClient = {
    async callTool(req) {
      mcpCalls.push(req)
      return { content: [{ type: 'text', text: '检索完成' }] }
    }
  }
  const breathTool = new McpTool('ombre-brain', mcpClient, {
    name: 'breath',
    description: '无参浮现',
    inputSchema: { type: 'object', properties: {} }
  })
  const searchTool = new McpTool('ombre-brain', mcpClient, {
    name: 'breath_search',
    description: '检索记忆',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        mode: { type: 'string', default: 'manual' }
      },
      required: ['query']
    }
  })

  // 1. Gemini 分支：同时覆盖零参 breath 与带同名 mode 参数的 breath_search
  const geminiHistory = createAttemptHistory('gemini')
  let geminiRound = 0
  const gemini = new CustomGoogleGeminiClient({
    key: 'fixture-key',
    model: 'fixture-model',
    config: Config,
    ...geminiHistory,
    e: { user_id: '4018425614', group_id: '90001', sender: { user_id: '4018425614', role: 'owner' }, reply: async () => {} },
    fetch: async () => {
      geminiRound++
      const parts = geminiRound === 1
        ? [
            { functionCall: { name: 'breath', args: {} } },
            { functionCall: { name: 'breath_search', args: { query: '约定', mode: 'automatic' } } }
          ]
        : [{ text: 'Gemini 完成' }]
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] })
    }
  })
  gemini.addTools([breathTool, searchTool])
  const geminiRes = await gemini.sendMessage('看看记得什么', { parentMessageId: geminiHistory.parentMessageId })
  assert.equal(geminiRes.text, 'Gemini 完成')
  assert.deepEqual(mcpCalls, [
    { name: 'breath', arguments: {} },
    { name: 'breath_search', arguments: { query: '约定', mode: 'automatic' } }
  ])

  // 2. Claude 分支：不得把 mode='claude' 或 groupId/sender/isAdmin 混入 MCP 入参
  mcpCalls.length = 0
  const claudeHistory = createAttemptHistory('claude')
  let claudeRound = 0
  const claude = new ClaudeAPIClient({
    key: 'fixture-key',
    model: 'fixture-model',
    config: Config,
    ...claudeHistory,
    e: { user_id: '4018425614', group_id: '90001', sender: { user_id: '4018425614', role: 'admin' }, reply: async () => {} },
    fetch: async () => {
      claudeRound++
      const body = claudeRound === 1
        ? {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'breath', input: {} },
              { type: 'tool_use', id: 'tu_2', name: 'breath_search', input: { query: '柠檬塔', mode: 'manual' } }
            ]
          }
        : {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Claude 完成' }]
          }
      return Response.json(body)
    }
  })
  claude.addTools([breathTool, searchTool])
  const claudeRes = await claude.sendMessage('查一下柠檬塔', { parentMessageId: claudeHistory.parentMessageId })
  assert.equal(claudeRes.text, 'Claude 完成')
  assert.deepEqual(mcpCalls, [
    { name: 'breath', arguments: {} },
    { name: 'breath_search', arguments: { query: '柠檬塔', mode: 'manual' } }
  ])
})

// 群聊环境（群名/成员/聊天记录/message_id/时间）每轮都变，只能作为本轮请求里的
// 一条 user 消息，system 必须保持稳定——上游只认「整段 system 一字不差」的缓存。
const turnContextFixture = '<group_context>\n群聊环境\n</group_context>'

const turnContextReplies = {
  api: { choices: [{ message: { role: 'assistant', content: '回答' }, finish_reason: 'stop' }] },
  responses: { id: 'r', output: [{ type: 'message', content: [{ type: 'output_text', text: '回答' }] }] },
  claude: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '回答' }] },
  gemini: { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: '回答' }] } }] }
}

test('四种协议都把本轮群聊环境放进请求，system 保持原样', async () => {
  const bodies = {}
  for (const type of ['api', 'responses', 'claude', 'gemini']) {
    const client = createClient(type, async (url, options) => {
      bodies[type] = JSON.parse(options.body)
      return Response.json(turnContextReplies[type])
    })
    await client.sendMessage('问题', {
      system: '稳定 system',
      systemMessage: '稳定 system',
      instructions: '稳定 system',
      turnContext: turnContextFixture
    })
  }

  // api：system 不动，群聊环境在提问之前，且只出现一次
  assert.equal(bodies.api.messages[0].role, 'system')
  assert.equal(bodies.api.messages[0].content, '稳定 system')
  const apiContext = bodies.api.messages.findIndex(m => m.content === turnContextFixture)
  const apiQuestion = bodies.api.messages.findIndex(m => m.content === '问题')
  assert.ok(apiContext > 0 && apiContext < apiQuestion, 'api 群聊环境必须排在提问之前')
  assert.equal(bodies.api.messages.filter(m => m.content === turnContextFixture).length, 1)

  // responses：instructions 不动，input 里多一条 user 项
  assert.equal(bodies.responses.instructions, '稳定 system')
  assert.deepEqual(bodies.responses.input.map(item => item.content), [turnContextFixture, '问题'])

  // claude：system 内容不动；上下文并入本轮 user，保持 user/assistant 交替
  assert.equal(bodies.claude.system[0].text, '稳定 system')
  assert.equal(bodies.claude.system.length, 1)
  assert.deepEqual(bodies.claude.messages.map(m => m.role), ['user'])
  assert.deepEqual(bodies.claude.messages[0].content.map(block => block.text), [turnContextFixture, '问题'])

  // gemini：system_instruction 不动，群聊环境并入本轮 user 的第一个 part
  assert.equal(bodies.gemini.system_instruction.parts[0].text, '稳定 system')
  const geminiTurn = bodies.gemini.contents.at(-1)
  assert.equal(geminiTurn.role, 'user')
  assert.deepEqual(geminiTurn.parts.map(part => part.text), [turnContextFixture, '问题'])
})

test('api 的全局破限提示仍然落在用户提问上，不被群聊环境顶替', async () => {
  let body
  const client = createClient('api', async (url, options) => {
    body = JSON.parse(options.body)
    return Response.json(turnContextReplies.api)
  })
  await client.sendMessage('问题', {
    systemMessage: '稳定 system',
    turnContext: turnContextFixture,
    paimon_globalInnerOs: '破限词'
  })
  const context = body.messages.find(m => m.content === turnContextFixture)
  const question = body.messages.at(-1)
  assert.doesNotMatch(context.content, /破限词/)
  assert.equal(question.content, '问题\n\n[os]\n破限词\n[/os]\n')
})

test('OpenAI 兼容通道按配置带上 prompt_cache_retention，隔几分钟再说话也能复用前缀', async () => {
  let body
  // 默认值由配置层决定（core.js 读 Config.promptCacheRetention），客户端不再兜默认，
  // 否则记忆抽取等子调用会绕过全局开关
  const client = new ChatGPTAPI({
    apiKey: 'fixture-key',
    apiBaseUrl: 'https://retention-default.example/v1',
    providerName: 'default-on',
    promptCacheRetention: '24h',
    completionParams: { model: 'gpt-4o-mini' },
    ...createAttemptHistory('api'),
    maxModelTokens: 8192,
    maxResponseTokens: 1024,
    fetch: async (url, options) => {
      body = JSON.parse(options.body)
      return Response.json({ id: 'x', choices: [{ message: { role: 'assistant', content: '回答' }, finish_reason: 'stop' }] })
    }
  })
  await client.sendMessage('问题', {})
  assert.equal(body.prompt_cache_retention, '24h')
})

test('客户端不传 promptCacheRetention 时不发送该参数（子调用不绕过全局开关）', async () => {
  let body
  const client = new ChatGPTAPI({
    apiKey: 'fixture-key',
    apiBaseUrl: 'https://retention-absent.example/v1',
    providerName: 'absent',
    completionParams: { model: 'gpt-4o-mini' },
    ...createAttemptHistory('api'),
    maxModelTokens: 8192,
    maxResponseTokens: 1024,
    fetch: async (url, options) => {
      body = JSON.parse(options.body)
      return Response.json({ id: 'x', choices: [{ message: { role: 'assistant', content: '回答' }, finish_reason: 'stop' }] })
    }
  })
  await client.sendMessage('问题', {})
  assert.equal(body.prompt_cache_retention, undefined)
})

test('上游拒绝 prompt_cache_retention 时去掉参数重试，且同通道后续不再发送', async () => {
  const bodies = []
  const client = new ChatGPTAPI({
    apiKey: 'fixture-key',
    apiBaseUrl: 'https://retention-reject.example/v1',
    providerName: 'reject',
    promptCacheRetention: '24h',
    completionParams: { model: 'gpt-4o-mini' },
    ...createAttemptHistory('api'),
    maxModelTokens: 8192,
    maxResponseTokens: 1024,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body)
      bodies.push(body)
      if (body.prompt_cache_retention) {
        return new Response(JSON.stringify({ error: { message: 'Unsupported parameter: prompt_cache_retention' } }), { status: 400 })
      }
      return Response.json({ id: 'x', choices: [{ message: { role: 'assistant', content: '回答' }, finish_reason: 'stop' }] })
    }
  })
  const first = await client.sendMessage('问题', {})
  assert.equal(first.text, '回答')
  assert.equal(bodies.length, 2, '第一次带参数被拒后应自动重试一次')
  assert.equal(bodies[0].prompt_cache_retention, '24h')
  assert.equal(bodies[1].prompt_cache_retention, undefined)

  await client.sendMessage('再问', {})
  assert.equal(bodies.length, 3, '同通道后续请求不应再白白失败一轮')
  assert.equal(bodies[2].prompt_cache_retention, undefined)
})

test('上游只回 400 Invalid request 不点名参数时，也要去参重试而不是让整条通道失败', async () => {
  const bodies = []
  const client = new ChatGPTAPI({
    apiKey: 'fixture-key',
    apiBaseUrl: 'https://retention-opaque.example/v1',
    providerName: 'opaque',
    promptCacheRetention: '24h',
    completionParams: { model: 'gpt-4o-mini' },
    ...createAttemptHistory('api'),
    maxModelTokens: 8192,
    maxResponseTokens: 1024,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body)
      bodies.push(body)
      if (body.prompt_cache_retention) {
        // 常见网关：只回一句 Invalid request，不告诉你是哪个参数错了
        return new Response(JSON.stringify({ error: { message: 'Invalid request' } }), { status: 400 })
      }
      return Response.json({ id: 'x', choices: [{ message: { role: 'assistant', content: '回答' }, finish_reason: 'stop' }] })
    }
  })
  const result = await client.sendMessage('问题', {})
  assert.equal(result.text, '回答', '不点名参数也必须能降级成功，否则整条通道每句话都失败')
  assert.equal(bodies.length, 2)
  assert.equal(bodies[1].prompt_cache_retention, undefined)
})

test('去掉参数仍然 4xx 时不记忆该通道，避免把无关报错误判成参数不支持', async () => {
  const bodies = []
  let calls = 0
  const client = new ChatGPTAPI({
    apiKey: 'fixture-key',
    apiBaseUrl: 'https://retention-unrelated.example/v1',
    providerName: 'unrelated',
    promptCacheRetention: '24h',
    completionParams: { model: 'gpt-4o-mini' },
    ...createAttemptHistory('api'),
    maxModelTokens: 8192,
    maxResponseTokens: 1024,
    fetch: async (url, options) => {
      calls++
      bodies.push(JSON.parse(options.body))
      // 与 retention 无关：模型名不存在，去掉参数也一样失败
      return new Response(JSON.stringify({ error: { message: 'The model does not exist' } }), { status: 400 })
    }
  })
  await assert.rejects(() => client.sendMessage('问题', {}))
  assert.equal(calls, 2, '第一轮会探测一次：先带参数、再去参')
  await assert.rejects(() => client.sendMessage('再问', {}))
  // 第二轮仍会探测：要连续两次失败才认定「这个 400 与参数无关」
  const secondTurn = bodies.slice(2)
  assert.equal(secondTurn.length, 2, '连续两次探测期间仍然先带参数试一次')
  assert.equal(secondTurn[0].prompt_cache_retention, '24h', '无关的 400 不该被记成参数不支持')

  // 连续两次探测都失败 → 之后不再白试，每轮只发一次，避免延迟和配额翻倍
  await assert.rejects(() => client.sendMessage('三问', {}))
  assert.equal(bodies.length, 5, '第三轮起不再探测，只发一次')
  assert.equal(bodies.at(-1).prompt_cache_retention, '24h', '仍然带参数发送，只是不再做降级探测')
})

test('429 限流不触发参数降级，避免白白多打一次', async () => {
  const bodies = []
  const client = new ChatGPTAPI({
    apiKey: 'fixture-key',
    apiBaseUrl: 'https://retention-429.example/v1',
    providerName: 'rate',
    promptCacheRetention: '24h',
    completionParams: { model: 'gpt-4o-mini' },
    ...createAttemptHistory('api'),
    maxModelTokens: 8192,
    maxResponseTokens: 1024,
    fetch: async (url, options) => {
      bodies.push(JSON.parse(options.body))
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })
    }
  })
  await assert.rejects(() => client.sendMessage('问题', {}))
  assert.equal(bodies.length, 1, '429 与参数无关，不应重发')
})

test('promptCacheRetention 传空串时不发送该参数（留出关闭开关）', async () => {
  let body
  const client = new ChatGPTAPI({
    apiKey: 'fixture-key',
    apiBaseUrl: 'https://retention-off.example/v1',
    providerName: 'off',
    promptCacheRetention: '',
    completionParams: { model: 'gpt-4o-mini' },
    ...createAttemptHistory('api'),
    maxModelTokens: 8192,
    maxResponseTokens: 1024,
    fetch: async (url, options) => {
      body = JSON.parse(options.body)
      return Response.json({ id: 'x', choices: [{ message: { role: 'assistant', content: '回答' }, finish_reason: 'stop' }] })
    }
  })
  await client.sendMessage('问题', {})
  assert.equal(body.prompt_cache_retention, undefined)
})
