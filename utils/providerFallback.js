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

/** 通道行没显式配窗口时，按通道类型给的默认上下文窗口（token） */
const DEFAULT_CONTEXT_WINDOW = { api: 128000, responses: 128000, claude: 200000, gemini: 1000000 }

export function trimConversation(messages, config, provider = null) {
  let result = messages.filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
  const rawCount = Number(config.chatgptBlockCount) || 0
  // 0 表示交给 token 控制；正整数按「至少一对」处理并取偶
  const count = rawCount > 0 ? Math.max(2, evenFloor(rawCount)) : 0
  // 只有涨过上界才裁，且一次裁到 70%：每轮从头部挤掉一两条的写法会让请求前缀
  // 整体前移，提示词缓存整段失效（实测命中率从 85%~90% 掉到个位数）。
  if (count > 0 && result.length > count) {
    // 用整数运算算 70%：`count * 0.7` 在部分 N 上会因浮点误差少留 2 条
    result = result.slice(-Math.max(2, evenFloor(count * 7 / 10)))
  }
  // 无条数限制时仍按所选模型上下文预算裁剪完整轮次，避免 Redis 无限增长。
  //
  // 窗口必须优先取「通道行自己」的配置：claude / gemini 的通道行没有
  // maxModelTokens 字段，若退回全局默认的 128000，会把 200k / 1M 的模型当成
  // 12.8 万来裁，白白丢掉大半可用的历史。
  const type = provider?.type || config.type || 'api'
  const rowWindow = Number(provider?.maxModelTokens || provider?.responsesMaxModelTokens) || 0
  const windowTokens = provider
    ? (rowWindow || DEFAULT_CONTEXT_WINDOW[type] || 128000)
    : (Number(config.maxModelTokens) || 128000)
  const outField = type === 'gemini' ? 'geminiMaxOutputTokens' : type === 'claude' ? 'claudeApiMaxToken' : 'apiMaxToken'
  const rowOut = Number(provider?.[outField]) || 0
  const outTokens = provider ? (rowOut || 65536) : (Number(config.apiMaxToken) || 65536)
  // 输出预留吃掉整个窗口时预算会变成 1，历史被砍到只剩 2 条；照客户端守卫的写法兜住
  const budget = Math.max(1, windowTokens > outTokens ? windowTokens - outTokens : windowTokens - 1)
  // 中文约 1 字 1 token、英文约 4 字符 1 token，按 1.5 折中：宁可裁早一点，也不要把
  // 中文历史算得太乐观而撞上真实上限（api 通道另有真 tokenizer 兜底，不受此影响）
  const charCap = Math.max(1, Math.floor(budget * 1.5))
  let chars = result.reduce((n, m) => n + m.content.length, 0)
  // 与条数分支同构：涨过上界才裁，一次裁到 70%。触发线与目标线必须分开，
  // 否则裁完刚好等于目标线，下一轮加一对又超，等于每轮丢一对——正是要消灭的滑窗。
  if (chars > charCap) {
    const charTarget = Math.floor(charCap * TRIM_RATIO)
    while (result.length > 2 && chars > charTarget) {
      chars -= result[0].content.length + result[1].content.length
      result = result.slice(2)
    }
  }
  // 最后兜一道，仅 Gemini：它要求 contents 严格 user/model 交替，从 assistant 起头会
  // 直接被上游 400。从旧版本迁移过来的历史可能是奇数条或以 assistant 开头，这里收敛成
  // 「首条是 user 且长度为偶数」——正常数据本来就满足，不会被动到。
  // 其他通道容忍任意起始角色，不做这层约束，免得白白少一条历史。
  if (type === 'gemini' && result.length > 2) {
    let start = result.findIndex(m => m.role === 'user')
    if (start < 0) start = 0
    let end = result.length
    if ((end - start) % 2 !== 0) end -= 1
    if (end - start >= 2) result = result.slice(start, end)
  }
  return result
}
