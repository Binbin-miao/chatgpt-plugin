import crypto from 'crypto'
import { newFetch } from '../utils/proxy.js'
import _ from 'lodash'
import { getMessageById, upsertMessage } from '../utils/history.js'
import { BaseClient } from './BaseClient.js'
import { Config } from '../utils/config.js'
import { sendToolCallForwardMsg, sendToolRoundTextForwardMsg } from '../utils/toolForward.js'
import { normalizeModelText } from '../utils/thinking.js'
import { fetchWithConnectionRetry } from '../utils/network-retry.js'
import { redactArgsForLog } from '../utils/toolArgRedaction.js'
import { buildClaudeImageBlocks, pickMediaList } from '../utils/visionPayload.js'

const BASEURL = 'https://api.anthropic.com'

/**
 * @typedef {Object} Content
 * @property {string} model
 * @property {string} system
 * @property {number} max_tokens
 * @property {boolean} stream
 * @property {Array<{
 *   role: 'user'|'assistant',
 *   content: string|Array<{
 *     type: 'text'|'image',
 *     text?: string,
 *     source?: {
 *       type: 'base64',
 *       media_type: 'image/jpeg'|'image/png'|'image/gif'|'image/webp',
 *       data: string
 *     }
 *   }>
 * }>} messages
 *
 * Claude消息的基本格式
 */

/**
 * @typedef {Object} ClaudeResponse
 * @property {string} id
 * @property {string} type
 * @property {number} role
 * @property {number} model
 * @property {number} stop_reason
 * @property {number} stop_sequence
 * @property {number} role
 * @property {boolean} stream
 * @property {Array<{
 *   type: string,
 *   text: string
 * }>} content
 * @property {Array<{
 *   input_tokens: number,
 *   output_tokens: number,
 * }>} usage
 * @property {{
 *   type: string,
 *   message: string,
 * }} error
 * Claude响应的基本格式
 */

export class ClaudeAPIClient extends BaseClient {
  constructor (props) {
    if (!props.upsertMessage) {
      props.upsertMessage = async function umGemini (message) {
        return await upsertMessage(message, 'Claude')
      }
    }
    if (!props.getMessageById) {
      props.getMessageById = async function umGemini (message) {
        return await getMessageById(message, 'Claude')
      }
    }
    super(props)
    this.fetch = props.fetch || newFetch
    this.onToolStart = props.onToolStart || (() => {})
    this.model = props.model
    this.key = props.key
    if (!this.key) {
      throw new Error('no claude API key')
    }
    this.baseUrl = props.baseUrl || BASEURL
    this.supportFunction = true
    this.debug = props.debug
    this.providerName = props.providerName || ''
  }

  async getHistory (parentMessageId, userId = this.userId, opt = {}) {
    const history = []
    let cursor = parentMessageId
    if (!cursor) {
      return history
    }
    do {
      let parentMessage = await this.getMessageById(cursor)
      if (!parentMessage) {
        break
      } else {
        history.push(parentMessage)
        cursor = parentMessage.parentMessageId
        if (!cursor) {
          break
        }
      }
    } while (true)
    return history.reverse()
  }

  _toClaudeTool (tool) {
    // 托管内置工具直接透传 Anthropic server tool 定义，不走 AbstractTool
    if (tool.hosted) {
      return {
        type: tool.type,
        name: tool.name,
        ...(Number.isInteger(tool.max_uses) ? { max_uses: tool.max_uses } : {})
      }
    }
    const fn = tool.function()
    return {
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters || { type: 'object', properties: {} }
    }
  }

  _getToolChoice (toolMode) {
    const modeMap = {
      ANY: 'any',
      AUTO: 'auto',
      NONE: 'none'
    }
    return { type: modeMap[toolMode] || 'auto' }
  }

  async _createMessage (messages, opt = {}, toolMode = opt.toolMode) {
    /**
     * 发送的body
     * @type {Content}
     * @see https://docs.anthropic.com/claude/reference/messages_post
     */
    let body = {}
    if (Array.isArray(opt.system)) {
      body.system = opt.system
    } else if (opt.system) {
      // Anthropic 的 prompt caching 必须显式声明断点：不声明，`cache_read_input_tokens`
      // 永远为空，日志里的「缓存命中」恒为 0。
      //
      // 断点必须落在**稳定段末尾**：本插件的 system 后面还挂着当前时间、message_id 这类
      // 每轮都变的内容，照 AstrBot 那样直接打在整段末尾会永远对不上。core.js 用
      // `systemStableLength` 告诉我们稳定段到哪为止，这里据此切成两块；没传时退化为
      // 单块并把断点打在末尾（与 AstrBot 的 `_apply_explicit_prompt_cache_breakpoints` 一致）。
      // 低于模型最小可缓存长度时 Anthropic 会直接忽略，不产生额外费用，无需预判长度。
      const text = String(opt.system)
      const stableLength = Number.isInteger(opt.systemStableLength)
        ? Math.max(0, Math.min(opt.systemStableLength, text.length))
        : text.length
      if (stableLength === 0) {
        body.system = [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
      } else {
        body.system = [
          { type: 'text', text: text.slice(0, stableLength), cache_control: { type: 'ephemeral' } }
        ]
        const dynamicPart = text.slice(stableLength)
        if (dynamicPart) body.system.push({ type: 'text', text: dynamicPart })
      }
    }
    body = Object.assign(body, {
      model: opt.model || this.model || 'claude-3-opus-20240229',
      max_tokens: opt.max_tokens || 65536,
      messages,
      stream: false
    })
    if (Number.isFinite(opt.temperature)) {
      body.temperature = opt.temperature
    }
    if (this.tools?.length > 0) {
      body.tools = this.tools.map(tool => this._toClaudeTool(tool))
      body.tool_choice = this._getToolChoice(toolMode)
    }
    if (this.debug) {
      logger.info("body: " + JSON.stringify(body, null, 2))
      logger.info(`sendMessage (${messages.length} messages)`, body)
    }
    let url = `${this.baseUrl}/v1/messages`
    let result = await fetchWithConnectionRetry(this.fetch, url, {
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': this.key,
        'content-type': 'application/json'
      },
      method: 'POST',
      body: JSON.stringify(body)
    }, {
      onRetry: ({ error, retry, maxRetries, delayMs }) => {
        logger.warn(`[Chatgpt][Claude] 连接失败 (${error.code || error.message})，${delayMs / 1000} 秒后进行第 ${retry}/${maxRetries} 次重试`)
      }
    })
    if (result.status !== 200) {
      throw new Error(await result.text())
    }
    /**
     * @type {ClaudeResponse}
     */
    let response = await result.json()
    if (this.debug) {
      logger.info("response: " + JSON.stringify(response, null, 2))
    }
    if (response.type === 'error') {
      logger.error(response.error.message)
      throw new Error(response.error.type)
    }
    const inputTokens = response.usage?.input_tokens || 0
    const outputTokens = response.usage?.output_tokens || 0
    const reportedCacheReadTokens = response.usage?.cache_read_input_tokens
    const cacheReadTokens = reportedCacheReadTokens ?? 0
    const reportedCacheWriteTokens = response.usage?.cache_creation_input_tokens
    const cacheWriteTokens = reportedCacheWriteTokens ?? 0
    const totalInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens
    const totalTokens = totalInputTokens + outputTokens
    const cacheHitRate = totalInputTokens > 0
      ? (cacheReadTokens / totalInputTokens) * 100
      : 0
    const cacheWriteInfo = reportedCacheWriteTokens == null
      ? ''
      : ` | 缓存写入(${cacheWriteTokens})`
    const cacheReadInfo = reportedCacheReadTokens == null
      ? ''
      : ` | 缓存命中(${cacheReadTokens}, ${cacheHitRate.toFixed(1)}%)`
    logger.info(`[Chatgpt][Claude]${this.providerName ? `[${this.providerName}]` : ''} 输入Token(${totalInputTokens})${body.max_tokens ? ` | 回复上限(${body.max_tokens})` : ''} | 回答Token(${outputTokens}) | 累计Token(${totalTokens})${cacheWriteInfo}${cacheReadInfo}`)
    return response
  }

  _buildResponseText (response) {
    return Array.isArray(response.content)
      ? response.content
        .filter(item => item?.type === 'text' && typeof item.text === 'string')
        .map(item => item.text)
        .join('\n')
      : ''
  }

  _buildThinkingText (response) {
    return Array.isArray(response.content)
      ? response.content
        .filter(item => item?.type === 'thinking' && typeof item.thinking === 'string')
        .map(item => item.thinking)
        .join('\n')
      : ''
  }

  _getToolUses (response) {
    return Array.isArray(response.content)
      ? response.content.filter(item => item?.type === 'tool_use')
      : []
  }

  _stringifyToolResult (result) {
    if (result === undefined) {
      return 'undefined'
    }
    if (typeof result === 'string') {
      return result
    }
    try {
      return JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value)
    } catch (err) {
      return String(result)
    }
  }

  /**
   *
   * @param text
   * @param {{conversationId: string?, parentMessageId: string?, stream: boolean?, onProgress: function?, functionResponse: FunctionResponse?, system: string?, media: { mimeType: string, data: string }?, model: string?, toolMode: 'AUTO'|'ANY'|'NONE'?}} opt
   * @returns {Promise<{conversationId: string?, parentMessageId: string, text: string, id: string}>}
   */
  async sendMessage (text, opt = {}) {
    let history = await this.getHistory(opt.parentMessageId)
    const idThis = crypto.randomUUID()
    /**
     * @type {Array<{
     *   role: 'user'|'assistant',
     *   content: string|Array<{
     *     type: 'text'|'image',
     *     text?: string,
     *     source?: {
     *       type: 'base64',
     *       media_type: 'image/jpeg'|'image/png'|'image/gif'|'image/webp',
     *       data: string
     *     }
     *   }>
     * }>}
     */
    let thisContent = [{ type: 'text', text }]
    thisContent.push(...buildClaudeImageBlocks(pickMediaList(opt)))
    const thisMessage = {
      role: 'user',
      content: thisContent,
      id: idThis,
      parentMessageId: opt.parentMessageId || undefined
    }
    history.push(_.cloneDeep(thisMessage))
    // 本轮群聊环境只进请求：记下当前轮在 history 里的位置，组包时插在它前面；
    // 落库的仍是原始 thisMessage，上下文不会被下一轮当历史重放。
    const turnMessageIndex = history.length - 1

    let pendingUserMessage = thisMessage
    let toolRoundCount = 0
    let toolMode = opt.toolMode || 'AUTO'
    const maxToolRounds = Config.llm_maxToolRounds || 3
    /** 工具轮思考（含被重归类的独白），跨轮累积后并入最终 thinking_text */
    let toolRoundThinking = ''

    while (true) {
      const messages = history.map(h => { return { role: h.role, content: h.content } })
      if (opt.turnContext) {
        // Anthropic 要求 user/assistant 交替：插一条独立 user 会变成连续两条 user，
        // 部分中转直接 400。并进本轮 user 的第一个 text block，只改请求副本，
        // 落库的 history 仍是原始 thisMessage。
        const turnMessage = messages[turnMessageIndex]
        const turnBlocks = Array.isArray(turnMessage.content)
          ? turnMessage.content
          : [{ type: 'text', text: turnMessage.text || '' }]
        messages[turnMessageIndex] = {
          role: 'user',
          content: [{ type: 'text', text: opt.turnContext }, ...turnBlocks]
        }
      }
      const response = await this._createMessage(messages, opt, toolMode)
      if (response.content?.some(item => item.type === 'server_tool_use' || item.type?.endsWith('_tool_result'))) this.onToolStart()
      const idModel = crypto.randomUUID()
      const respMessage = Object.assign(response, {
        id: idModel,
        parentMessageId: pendingUserMessage.id
      })

      const responseText = this._buildResponseText(response)
      const thinkingText = this._buildThinkingText(response)
      const toolUses = this._getToolUses(response)
      if (toolUses.length === 0) {
        await this.upsertMessage(pendingUserMessage)
        await this.upsertMessage(respMessage)
        return {
          text: responseText,
          refused: response.stop_reason === 'refusal',
          thinking_text: toolRoundThinking + thinkingText,
          conversationId: '',
          parentMessageId: pendingUserMessage.id,
          id: idModel
        }
      }

      if (toolRoundCount >= maxToolRounds) {
        logger.warn(`Claude工具调用已达最大轮次上限 ${maxToolRounds} 轮，返回当前文本并终止工具循环`)
        // 上限轮文本会作为最终回复兜底，同样归一化，防止独白借道最终正文
        const capped = normalizeModelText(responseText, { toolNames: toolUses.map(toolUse => toolUse.name), inToolRound: true })
        const fallbackText = capped.text || `工具调用已达最大轮次上限 ${maxToolRounds} 轮，已停止继续调用工具。`
        const safeRespMessage = Object.assign({}, respMessage, {
          role: 'assistant',
          content: [{ type: 'text', text: fallbackText }]
        })
        await this.upsertMessage(pendingUserMessage)
        await this.upsertMessage(safeRespMessage)
        return {
          text: fallbackText,
          thinking_text: toolRoundThinking + capped.thinking + thinkingText,
          conversationId: '',
          parentMessageId: pendingUserMessage.id,
          id: idModel
        }
      }

      this.onToolStart()
      toolRoundCount++
      await this.upsertMessage(pendingUserMessage)
      await this.upsertMessage(respMessage)
      // 工具轮附带文本：归一化后以合并转发立即单独外发（现状为丢弃）。
      // 发送点在 onToolStart 之后，回退重试已被 irreversible 标记阻断，不会重复投递
      const roundNormalized = normalizeModelText(responseText, { toolNames: toolUses.map(toolUse => toolUse.name), inToolRound: true })
      if (roundNormalized.thinking || thinkingText) {
        toolRoundThinking += roundNormalized.thinking + thinkingText
      }
      if (roundNormalized.text) {
        await sendToolRoundTextForwardMsg(this.e, [{
          text: roundNormalized.text,
          provider: 'Claude',
          round: toolRoundCount
        }])
      }
      const toolResults = []
      const toolForwardRecords = []
      for (const toolUse of toolUses) {
        const name = toolUse.name
        const args = _.cloneDeep(toolUse.input || {})
        const chosenTool = this.tools.find(t => t.name === name)
        let resultContent
        let isError = false
        logger.info(`[Chatgpt][Claude][工具调用][${name}]: ${JSON.stringify(args)}`)
        try {
          if (!chosenTool) {
            isError = true
            resultContent = `Function ${name} not found.`
            logger.warn(resultContent)
          } else {
            let execArgs
            if (chosenTool.isMcpTool) {
              execArgs = Object.assign({}, args)
            } else {
              execArgs = Object.assign({}, args, {
                isAdmin: ['admin', 'owner'].includes(this.e?.sender?.role) || (this.e?.group?.is_admin && this.e?.isMaster),
                sender: this.e?.sender?.user_id,
                mode: 'claude'
              })
              if (!execArgs.groupId) {
                const defaultGroupId = this.e?.group_id || this.e?.sender?.user_id
                if (defaultGroupId) {
                  execArgs.groupId = `${defaultGroupId}`
                }
              }
            }
            resultContent = await chosenTool.func(execArgs, this.e)
            logger.info(`[Chatgpt][Claude][工具返回][${name}]: ${this._stringifyToolResult(resultContent)}`)
          }
        } catch (err) {
          isError = true
          resultContent = `Error executing function ${name}: ${err.message}`
          logger.error(resultContent)
        }
        toolForwardRecords.push({
          platform: 'Claude',
          round: toolRoundCount,
          name,
          args: redactArgsForLog(name, args),
          result: resultContent
        })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: this._stringifyToolResult(resultContent),
          ...(isError ? { is_error: true } : {})
        })
      }
      sendToolCallForwardMsg(this.e, toolForwardRecords, 'Claude工具调用与返回')

      const toolResultMessage = {
        role: 'user',
        content: toolResults,
        id: crypto.randomUUID(),
        parentMessageId: idModel
      }
      await this.upsertMessage(toolResultMessage)
      history.push(_.cloneDeep(respMessage))
      history.push(_.cloneDeep(toolResultMessage))
      pendingUserMessage = toolResultMessage
      toolMode = toolRoundCount >= maxToolRounds ? 'NONE' : 'AUTO'
    }
  }
}
