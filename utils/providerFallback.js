import { randomUUID } from 'node:crypto'

/** 每次尝试独占历史缓冲，失败尝试不会污染已完成会话。 */
export function createAttemptHistory(type, messages = []) {
  const store = new Map()
  let parentMessageId
  for (const message of messages) {
    if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') continue
    const id = randomUUID()
    store.set(id, {
      id, parentMessageId, role: type === 'gemini' && message.role === 'assistant' ? 'model' : message.role,
      text: message.content, content: message.content, parts: [{ text: message.content }]
    })
    parentMessageId = id
  }
  return {
    parentMessageId,
    getMessageById: async id => store.get(id),
    upsertMessage: async message => { store.set(message.id, message) }
  }
}

export async function runProviderFallback(main, backup, execute, { enabled = true, onRetry = () => {} } = {}) {
  const state = { irreversible: false, requested: false }
  const attempts = enabled ? [main, main, ...(backup ? [backup] : [])] : [main]
  for (let i = 0; i < attempts.length; i++) {
    state.requested = false
    try {
      const result = await execute(attempts[i], state)
      if (result?.refused) return result
      if (!result?.text?.trim() && !result?.noMsg && !state.irreversible) {
        throw new Error('模型未返回有效回复')
      }
      return result
    } catch (err) {
      if (state.irreversible || !state.requested || err.noRetry || err.name === 'AbortError' && err.userCancelled || i === attempts.length - 1) throw err
      onRetry(attempts[i + 1], i + 1)
    }
  }
}

/** 裁剪时保留的比例：一次裁到 70%，下次裁之前能稳定几十轮 */
const TRIM_RATIO = 0.7

/** 向下取偶：Gemini 的 contents 必须 user/model 交替，奇数会从错误角色开始 */
function evenFloor(n) {
  const v = Math.floor(Number(n) || 0)
  return v - (v % 2)
}

export function trimConversation(messages, config) {
  let result = messages.filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
  const rawCount = Number(config.chatgptBlockCount) || 0
  // 0 表示交给 token 控制；正整数按「至少一对」处理并取偶
  const count = rawCount > 0 ? Math.max(2, evenFloor(rawCount)) : 0
  // 只有涨过上界才裁，且一次裁到 70%：每轮从头部挤掉一两条的写法会让请求前缀
  // 整体前移，提示词缓存整段失效（实测命中率从 85%~90% 掉到个位数）。
  if (count > 0 && result.length > count) {
    result = result.slice(-Math.max(2, evenFloor(count * TRIM_RATIO)))
  }
  // 无条数限制时仍按所选模型上下文预算裁剪完整轮次，避免 Redis 无限增长。
  const budget = Math.max(1, (config.maxModelTokens || config.responsesMaxModelTokens || 128000) - (config.apiMaxToken || config.responsesApiMaxToken || 65536))
  const charCap = Math.max(1, budget * 2)
  let chars = result.reduce((n, m) => n + m.content.length, 0)
  // 预算路径同理：超了再一次砍到 70%，而不是每轮丢一对
  const charTarget = Math.floor(charCap * TRIM_RATIO)
  while (result.length > 2 && chars > charTarget) {
    chars -= result[0].content.length + result[1].content.length
    result = result.slice(2)
  }
  return result
}
