/**
 * 会话键的**唯一**实现。
 *
 * 键只回答一个问题：这是谁在跟我聊。通道（provider id / 连接版本 / model / baseUrl / key）
 * 一律**不进键名**——它们进了键名，用户改个模型就换桶，历史当场断掉。通道信息降级成
 * value 里的元信息（见 `CHATGPT:CONVERSATION_V3` 的迁移说明）。
 *
 * 因此本模块不 import `Config`、不 import `resolveProvider`：键与当前配置无关，
 * 任何调用点都不该再自己拼 `CHATGPT:CONVERSATION…` 字符串（`test/lint.check.mjs` 有静态守卫）。
 *
 * 零值约定：**取不到身份就返回空串**，调用方必须据此拒绝本轮读写，绝不能拿空串去 `redis.get`
 * 或 `redis.set`（`redis.set('', …)` 不会报错，只会把历史写到一个谁也读不回来的位置）。
 *
 * 边界：本模块只管**会话历史**键。`CHATGPT:CONVERSATIONS_BING:<uin>` 是另一族（bing token），
 * 与历史无关，不要顺手合并进来。
 */

/** 键前缀。改它等于全量换桶，必须配迁移。 */
export const CONVERSATION_KEY_PREFIX = 'CHATGPT:CONVERSATION_V3'

function warn(message) {
  globalThis.logger?.warn?.(message)
}

/**
 * 这次对话落在谁的桶里。
 *
 * @param {object} e 消息事件
 * @param {boolean} groupMerge 是否群内共用一份上下文（`Config.groupMerge`）
 * @param {string|number} [targetUserId] 显式指定目标账号（`@某人` 类指令用），优先于发言者
 * @returns {string} scope；取不到身份时为空串
 */
export function conversationScope(e, groupMerge, targetUserId) {
  if (groupMerge && e?.isGroup) {
    const groupId = String(e?.group_id ?? '').trim()
    if (groupId) return groupId
    // 不允许拼出 `CHATGPT:CONVERSATION_V3:` 这种尾空 scope：宁可退回发言者，也要留痕
    warn('[Chatgpt][ConversationKey] groupMerge 已开启但取不到 group_id，回落到发言者账号')
  }
  const target = String(targetUserId ?? '').trim()
  if (target) return target
  return String(e?.sender?.user_id ?? '').trim()
}

/**
 * scope → 完整键。空 scope 返回空串（零值护栏，见文件头）。
 *
 * @param {string|number} scope
 * @returns {string}
 */
export function conversationKeyOf(scope) {
  const normalized = String(scope ?? '').trim()
  if (!normalized) return ''
  return `${CONVERSATION_KEY_PREFIX}:${normalized}`
}

/**
 * 事件 → 完整键。这是绝大多数调用点该用的入口。
 *
 * @param {object} e 消息事件
 * @param {boolean} groupMerge 是否群内共用一份上下文
 * @param {string|number} [targetUserId] 显式目标账号
 * @returns {string} 取不到身份时为空串
 */
export function conversationKeyFor(e, groupMerge, targetUserId) {
  return conversationKeyOf(conversationScope(e, groupMerge, targetUserId))
}

/** 扫全部会话用的 MATCH（`#对话列表`、`#结束全部会话全部`）。 */
export function conversationScanPattern() {
  return `${CONVERSATION_KEY_PREFIX}:*`
}

/**
 * 从键里取回 scope；不是本前缀的键返回空串。
 * 展示与迁移都要用它，避免第三处再写一遍切串逻辑。
 *
 * @param {string} key
 * @returns {string}
 */
export function conversationScopeOfKey(key) {
  const text = String(key ?? '')
  const prefix = `${CONVERSATION_KEY_PREFIX}:`
  return text.startsWith(prefix) ? text.slice(prefix.length) : ''
}
