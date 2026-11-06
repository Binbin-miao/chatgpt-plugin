/**
 * 上下文注入（Context Injection）
 *
 * 把 Bot 主人在 hookServers 里配置的任意 HTTP 端点响应，按条目追加进
 * 本轮 system 提示末尾：when: "turn" 每轮拉取，when: "session" 仅会话
 * 首轮拉取。Ombre 浮现注入（docs/adr/0015）是本机制的一条配置实例。
 *
 * 设计要点（见 docs/adr/0016-context-injection-hooks.md 与
 * .scratch/generic-hooks/spec.md）：
 * - 注入文本是本轮常量：以 prepared（sendMessage 级共享对象）做记忆，
 *   主备 provider 与上下文超限重建路径复用同一份，一轮只对每个条目发一次 HTTP。
 * - 失败不阻塞对话：超时 / 网络错误 / 非 2xx 一律 logger.warn 恰好一行后
 *   跳过该条目，其余条目照常，消息照常发出。可观测性以部署核对为先
 *   （部署复盘教训：静默路径曾让 session 语义无法验证——会话首轮标志不随
 *   插件重启重置，且 /breath-hook 等端点存在插件以外的消费方，服务端 200
 *   未必是插件拉的）：成功注入 info 一行（条目、时机与字符数）；session
 *   非首轮跳过、session 首轮空结果各 info 一行；响应是 JSON 对象但缺
 *   additionalContext 字段 warn 一行（纯文本服务请勿返回 JSON 形状的文本）。
 *   turn 条目的空结果仍按正常态静默。配置解析失败整段放弃，error 一行降级为空。
 * - 输出双兼容协议：响应按 JSON 解析取 hookSpecificOutput.additionalContext，
 *   解析失败按纯文本全文注入（约定纯文本服务不要返回 JSON 形状的文本）。
 * - 体积插件侧兜底：maxChars 硬截断并加提示后缀；带优先级的截断仍应由
 *   服务端做，条目作者应控制输出体积。
 */

import { interpolateEnvVars } from './envInterpolate.js'
import { parseHookServersConfig } from './hookServersGuoba.js'
import { parseMcpServersConfig } from './mcpServersGuoba.js'

const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_MAX_CHARS = 10000

/**
 * 把上下文注入文本追加到本轮 system 上
 *
 * @param {object} prepared sendMessage 级共享的准备态（主备复用同一个对象）
 * @param {{enableHooks?: boolean, hookServers?: string, mcpServers?: string}} config
 * @param {string} system 本次构建的基础 system
 * @param {{isNewConversation?: boolean}} [conversation] 调用方按「Redis 中无该会话」
 *   先例标记的会话首轮标志（apps/chat.js 设置）；未提供时 session 条目视为非首轮
 * @returns {Promise<string>} 追加后的 system；开关关闭或全部条目无内容时原样返回
 */
export async function withContextInjection(prepared, config, system, conversation = {}) {
  if (!config?.enableHooks) return system
  // 失败（null）同样记忆：本轮不再重试，避免主备/重建路径放大故障
  if (!('contextInjection' in prepared)) {
    prepared.contextInjection = await collectInjection(config, conversation)
  }
  const injection = prepared.contextInjection
  if (!injection) return system
  return system ? `${system}\n\n${injection}` : injection
}

/**
 * 拉取本轮所有参与的注入条目并按配置顺序拼接
 *
 * 参与集合在本轮第一次调用时确定（含 session 标志），结果整体记忆在
 * prepared 上；之后即使 conversation 标志变化也不重拉。
 */
async function collectInjection(config, conversation) {
  const entries = resolveHookEntries(config)
  const texts = []
  for (const entry of entries) {
    // when:"session" 只在会话首轮注入：复用「Redis 中无该会话」判定先例，
    // 会话过期或 #结束对话 后下一条消息重新触发。未提供标志时保守视为非首轮。
    // 首轮标志不随插件重启重置（Redis 会话独立存活），静默跳过会让部署无法
    // 区分「机制在跳过」与「条目坏了」，故 info 一行。
    if (entry.when === 'session' && !conversation.isNewConversation) {
      logger.info(`[ContextInjection] ${entry.url} 跳过（session 非会话首轮）`)
      continue
    }
    const text = await fetchEntry(entry)
    if (text) {
      logger.info(`[ContextInjection] ${entry.url} 已注入（${entry.when}，${text.length} 字符）`)
      texts.push(text)
    }
  }
  return texts.length ? texts.join('\n\n') : null
}

/**
 * 解析条目列表并归一化字段
 *
 * - JSON 解析失败整段放弃（parse 内 error 一行）；
 * - enabled:false 条目跳过（不删除配置，随时可再打开）；
 * - server 引用只取 mcpServers 同名条目的配置值 url，不依赖其连接状态；
 *   url 与 server 并存时 url 优先；解析不到 url 的条目 warn 一行跳过；
 * - headers 值完成 ${ENV} 插值（密钥不落 config.json）。
 */
function resolveHookEntries(config) {
  const rawEntries = parseHookServersConfig(config?.hookServers)
  if (!rawEntries.length) return []

  const mcpServers = parseMcpServersConfig(config?.mcpServers)
  const entries = []
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object') continue
    if (raw.enabled === false) continue

    let url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (!url) {
      const refName = typeof raw.server === 'string' ? raw.server.trim() : ''
      const refUrl = refName ? mcpServers[refName]?.url : ''
      url = typeof refUrl === 'string' ? refUrl.trim() : ''
      if (!url) {
        logger.warn(`[ContextInjection] 条目（server: ${refName || '未填'}）解析不到 url，本轮跳过该条目`)
        continue
      }
    }

    const headers = {}
    if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
      for (const [key, value] of Object.entries(raw.headers)) {
        const name = String(key).trim()
        if (!name) continue
        headers[name] = String(interpolateEnvVars(value ?? ''))
      }
    }

    entries.push({
      url,
      headers,
      timeout: positiveNumber(raw.timeout, DEFAULT_TIMEOUT_MS),
      maxChars: positiveNumber(raw.maxChars, DEFAULT_MAX_CHARS),
      when: raw.when === 'session' ? 'session' : 'turn'
    })
  }
  return entries
}

/** 数字字段读取：0 与负数无业务语义（0ms 必超时、0 字符截成空），一律回默认值 */
function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * 拉取单个条目。成功返回截断后的注入文本；关闭态之外的一切失败返回 null。
 * 空结果（服务端本轮无内容）是正常状态：turn 条目静默返回 null；session 条目
 * 首轮拉取每会话仅此一次，空结果 info 一行（部署复盘教训：浮现池为空时整条
 * 链路完全不可见，无法区分「池空」与「没拉」）。其余失败 warn 一行。
 */
async function fetchEntry(entry) {
  try {
    const res = await fetch(entry.url, {
      headers: entry.headers,
      signal: AbortSignal.timeout(entry.timeout)
    })
    if (!res.ok) {
      // 401 最常见：headers 里的凭证与服务端不一致
      logger.warn(`[ContextInjection] ${entry.url} 返回 HTTP ${res.status}，本轮跳过该条目`)
      return null
    }
    const body = (await res.text()).trim()
    if (!body) {
      if (entry.when === 'session') {
        logger.info(`[ContextInjection] ${entry.url} 本轮无内容（session 首轮，服务端返回为空）`)
      }
      return null
    }
    const { text: context, jsonWithoutField } = extractAdditionalContext(body)
    if (jsonWithoutField) {
      logger.warn(`[ContextInjection] ${entry.url} 返回 JSON 但缺少 hookSpecificOutput.additionalContext，视为无内容（纯文本服务请勿返回 JSON 形状的文本）`)
      return null
    }
    if (!context) {
      if (entry.when === 'session') {
        logger.info(`[ContextInjection] ${entry.url} 本轮无内容（session 首轮，additionalContext 为空）`)
      }
      return null
    }
    return truncateContext(context, entry.maxChars)
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? `超时（${entry.timeout}ms）`
      : err?.cause?.code || err?.message || String(err)
    logger.warn(`[ContextInjection] ${entry.url} 拉取失败（${reason}），本轮跳过该条目`)
    return null
  }
}

/**
 * 双兼容协议：JSON 且带 hookSpecificOutput.additionalContext 时取其值；
 * 解析失败按纯文本全文注入。
 * 返回 { text, jsonWithoutField }：jsonWithoutField 为真表示响应是 JSON 对象
 * 但没有 additionalContext 字段——违反「纯文本服务不要返回 JSON 形状的文本」
 * 约定的形状，调用方 warn（静默丢弃会让接入方无从发现）。JSON 数组 / 标量与
 * additionalContext 为空都视为服务端本轮无内容，不打标。
 */
function extractAdditionalContext(body) {
  try {
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const context = parsed.hookSpecificOutput?.additionalContext
      if (typeof context === 'string') return { text: context.trim(), jsonWithoutField: false }
      return { text: '', jsonWithoutField: true }
    }
    return { text: '', jsonWithoutField: false }
  } catch {
    return { text: body, jsonWithoutField: false }
  }
}

/** maxChars 硬截断，尾部加提示后缀（Claude Code 同款做法） */
function truncateContext(text, maxChars) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}[output truncated - exceeded ${maxChars} characters]`
}
