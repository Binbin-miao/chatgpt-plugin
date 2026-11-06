/**
 * Minimal client for OpenAI-compatible Responses APIs.
 * It intentionally keeps the Responses item protocol separate from the
 * Chat Completions message protocol used by chatgpt-api.js.
 */
import { fetchWithConnectionRetry } from '../network-retry.js'
import { pickCacheUsage } from './cacheUsage.js'

/** 已经打过「上游没给缓存字段」日志的 provider。客户端是每条消息新建的，标志不能挂在实例上 */
const usageShapeLogged = new Set()

/**
 * 把本轮群聊环境插到本轮提问之前（只进请求，调用方落库的聊天记录不受影响）。
 *
 * system/instructions 一旦混进每轮都变的群聊记录，上游就完全不认缓存；反过来把它
 * 放进请求里的独立 user 项，instructions 才能稳定下来。
 *
 * @param {string | Array<object>} input Responses input（字符串或 item 列表）
 * @param {string} [turnContext] 本轮群聊环境，空串/未提供时原样返回
 * @returns {string | Array<object>}
 */
function appendTurnContext(input, turnContext) {
  if (!turnContext) return input
  const item = { role: 'user', content: turnContext }
  if (typeof input === 'string') return [item, { role: 'user', content: input }]
  if (!Array.isArray(input)) return input
  const items = [...input]
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.role === 'user') {
      items.splice(i, 0, item)
      return items
    }
  }
  // 工具回填轮的 input 只有 function_call_output，没有用户轮可挂；
  // 硬塞到末尾会打乱工具链顺序，这里保持原样（与 Gemini 工具轮一致）。
  return input
}

/**
 * 增量续聊（store）模式下把上下文并进本轮 user 项，不新增条目。
 *
 * 该模式的 input 会被上游存进服务端会话：多塞一条 user 项等于每轮往会话历史里
 * 留一份完整群记录，越聊越大；合并进本轮内容则与「用户这轮说了什么」同生命周期。
 *
 * @param {string | Array<object>} input
 * @param {string} [turnContext]
 * @returns {string | Array<object>}
 */
function mergeTurnContext(input, turnContext) {
  if (!turnContext) return input
  if (typeof input === 'string') return `${turnContext}\n\n${input}`
  if (!Array.isArray(input)) return input
  const items = [...input]
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.role !== 'user') continue
    const content = items[i].content
    items[i] = {
      ...items[i],
      content: typeof content === 'string'
        ? `${turnContext}\n\n${content}`
        : [{ type: 'input_text', text: turnContext }, ...(Array.isArray(content) ? content : [])]
    }
    return items
  }
  return input
}

export class ResponsesAPI {
  constructor (opts = {}) {
    const {
      apiKey,
      apiBaseUrl = 'https://api.openai.com/v1',
      debug = false,
      providerName = '',
      fetch = globalThis.fetch,
      maxResponseTokens,
      maxModelTokens
    } = opts

    if (!apiKey) throw new Error('Responses API missing required apiKey')
    if (typeof fetch !== 'function') throw new Error('Invalid environment; fetch is not defined')

    this._apiKey = apiKey
    this._apiBaseUrl = apiBaseUrl.replace(/\/+$/, '')
    this._providerName = providerName
    this._debug = debug
    this._fetch = fetch
    this._maxResponseTokens = maxResponseTokens
    this._maxModelTokens = maxModelTokens
  }

  _extractOutputText (response) {
    if (typeof response.output_text === 'string') return response.output_text

    return (response.output || [])
      .filter(item => item.type === 'message')
      .flatMap(item => item.content || [])
      .filter(item => item.type === 'output_text' || item.type === 'text')
      .map(item => item.text || '')
      .join('')
  }

  _extractReasoningText (response) {
    return (response.output || [])
      .filter(item => item.type === 'reasoning')
      .flatMap(item => {
        const parts = []
        // summary 优先：形态可能是 [{ type: 'summary_text', text }]，也可能是字符串数组或单个字符串
        if (typeof item.summary === 'string') {
          parts.push(item.summary)
        } else if (Array.isArray(item.summary)) {
          for (const summary of item.summary) {
            if (typeof summary === 'string') parts.push(summary)
            else if (summary && typeof summary.text === 'string') parts.push(summary.text)
          }
        }
        // summary 为空时回退原始 CoT（gpt-oss 等模型会返回 content[].reasoning_text）
        if (!parts.some(Boolean) && Array.isArray(item.content)) {
          parts.length = 0
          for (const content of item.content) {
            if (content && content.type === 'reasoning_text' && typeof content.text === 'string') parts.push(content.text)
          }
        }
        return parts
      })
      .filter(Boolean)
      .join('\n')
  }

  _extractToolCalls (response) {
    return (response.output || [])
      .filter(item => item.type === 'function_call')
      .map(item => ({
        id: item.call_id,
        callId: item.call_id,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.arguments || ''
        },
        item
      }))
  }

  /**
   * @param {string | Array<object>} input Responses input string or item list
   * @param {object} opts Request overrides
   */
  async sendMessage (input, opts = {}) {
    const {
      instructions,
      turnContext,
      completionParams = {},
      store = false,
      previousResponseId,
      timeoutMs
    } = opts
    const {
      reasoning_effort: reasoningEffort,
      max_output_tokens: configuredMaxOutputTokens,
      ...requestParams
    } = completionParams

    const controller = timeoutMs ? new AbortController() : undefined
    const timeout = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined
    const body = {
      ...requestParams,
      input: store ? mergeTurnContext(input, turnContext) : appendTurnContext(input, turnContext),
      instructions,
      store: Boolean(store),
      stream: false
    }

    const maxOutputTokens = configuredMaxOutputTokens || this._maxResponseTokens
    if (maxOutputTokens) body.max_output_tokens = maxOutputTokens
    if (reasoningEffort) body.reasoning = { effort: reasoningEffort }
    if (store && previousResponseId) body.previous_response_id = previousResponseId

    const url = `${this._apiBaseUrl}/responses`
    if (this._debug) logger.info('[Chatgpt][Responses] request:', JSON.stringify(body, null, 2))

    try {
      const res = await fetchWithConnectionRetry(this._fetch, url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this._apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller?.signal
      }, {
        onRetry: ({ error, retry, maxRetries, delayMs }) => {
          logger.warn(`[Chatgpt][Responses] 连接失败 (${error.code || error.message})，${delayMs / 1000} 秒后进行第 ${retry}/${maxRetries} 次重试`)
        }
      })
      if (!res.ok) {
        const reason = await res.text()
        const error = new Error(`Responses API error ${res.status || res.statusText}: ${reason}`)
        error.statusCode = res.status
        error.statusText = res.statusText
        throw error
      }

      const response = await res.json()
      if (this._debug) logger.info('[Chatgpt][Responses] response:', JSON.stringify(response, null, 2))

      const usage = response.usage || {}
      const inputTokens = usage.input_tokens ?? usage.prompt_tokens
      const outputTokens = usage.output_tokens ?? usage.completion_tokens
      // 字段映射统一走 pickCacheUsage：OpenAI / Anthropic / DeepSeek / 中转的写法都要认
      const { read: reportedCacheReadTokens, write: reportedCacheWriteTokens } = pickCacheUsage(usage)
      const cacheReadTokens = reportedCacheReadTokens ?? 0
      const cacheWriteTokens = reportedCacheWriteTokens ?? 0
      const reportedReasoningTokens = usage.output_tokens_details?.reasoning_tokens
        ?? usage.completion_tokens_details?.reasoning_tokens
        ?? usage.reasoning_tokens
      const reasoningTokens = reportedReasoningTokens ?? 0
      const rawOutputTokens = outputTokens ?? 0
      const answerTokens = rawOutputTokens >= reasoningTokens
        ? rawOutputTokens - reasoningTokens
        : rawOutputTokens
      if (typeof inputTokens === 'number') {
        const cachedInputTokens = cacheReadTokens + cacheWriteTokens
        const freshInputTokens = inputTokens >= cachedInputTokens
          ? inputTokens - cachedInputTokens
          : inputTokens
        const cacheableInputTokens = freshInputTokens + cachedInputTokens
        const cacheHitRate = cacheableInputTokens > 0
          ? (cacheReadTokens / cacheableInputTokens) * 100
          : 0
        const totalTokenCount = usage.total_tokens ?? inputTokens + (outputTokens ?? 0)
        const cacheWriteInfo = reportedCacheWriteTokens == null
          ? ''
          : ` | 缓存写入(${cacheWriteTokens})`
        // 首次没有缓存字段时打出 usage 键名，用于分辨真 0 / 假 0（按 provider 只打一次）
        const shapeKey = this._providerName || 'default'
        if (reportedCacheReadTokens == null && !usageShapeLogged.has(shapeKey)) {
          usageShapeLogged.add(shapeKey)
          logger.info(`[Chatgpt][Responses] 本次响应没有缓存字段；上游 usage 键：${Object.keys(usage).join(', ') || '(空)'}`)
        }
        const reasoningInfo = reportedReasoningTokens == null
          ? ''
          : ` | 推理Token(${reasoningTokens})`
        const cacheReadInfo = reportedCacheReadTokens == null
          ? ''
          : ` | 缓存命中(${cacheReadTokens}, ${cacheHitRate.toFixed(1)}%)`
        logger.info(`[Chatgpt][Responses]${this._providerName ? `[${this._providerName}]` : ''} 输入Token(${inputTokens})${maxOutputTokens ? ` | 回复上限(${maxOutputTokens})` : ''} | 回答Token(${answerTokens})${reasoningInfo} | 累计Token(${totalTokenCount})${cacheWriteInfo}${cacheReadInfo}`)
        if (this._maxModelTokens && maxOutputTokens && inputTokens + maxOutputTokens > this._maxModelTokens) {
          logger.warn(`[Chatgpt][Responses] 当前 token 配置边界过紧：输入Token(${inputTokens}) + 回复上限(${maxOutputTokens}) > 总上下文(${this._maxModelTokens})。请检查锅巴中的 Responses Token 配置。`)
        }
      }

      const toolCalls = this._extractToolCalls(response)
      return {
        id: response.id,
        role: 'assistant',
        text: this._extractOutputText(response) || (response.output || []).flatMap(item => item.content || []).find(item => item.type === 'refusal')?.refusal || '',
        refused: (response.output || []).some(item => item.content?.some(part => part.type === 'refusal')),
        thinking_text: this._extractReasoningText(response),
        originalContent: response.output,
        toolCalls,
        functionCall: toolCalls[0]?.function,
        detail: response,
        responseOutput: response.output || [],
        usage: response.usage
      }
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}
