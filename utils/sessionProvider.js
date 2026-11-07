import { randomUUID } from 'node:crypto'
import { MODEL_FIELDS } from './providerProfiles.js'

/**
 * 会话分流（按群 / 私聊指定模型提供商）的纯逻辑层。
 *
 * 这里**不** import `Config` 与 `logger`：规则归一、索引、命中判定、面板槽位合并与保存期校验
 * 全部是可测的纯函数，读配置与打日志留给调用方（`apps/chat.js` 的运行时、`guoba.support.js`
 * 的保存路径）。这样配错规则时"只降级不阻断"的责任边界也清楚：本模块只负责抛错或返回 null。
 */

/** 面板可视化的槽位数；第 6 条起靠手改 config.json，面板保存时原样保留 */
export const SESSION_RULE_SLOTS = 5

/** 私聊账号允许的字符集：QQ 号、其他适配器的完整 id 都在其中 */
const PRIVATE_USER_RE = /^[A-Za-z0-9_@.-]+$/

/**
 * 群号归一：兼容 `[{ groupId }]` 旧形态与逗号/空白分隔的字符串，只留数字串并去重。
 * 运行期也要走一遍——用户可能直接手改 config.json 写成字符串。
 */
function normalizeGroupIds(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,，;；|\s]/)
  const ids = list
    .map(item => (item && typeof item === 'object' ? item.groupId : item))
    .map(item => String(item ?? '').trim())
    .filter(item => /^\d+$/.test(item))
  return [...new Set(ids)]
}

/** 私聊账号归一：拆分隔符、剥掉白名单老写法的 `^` 前缀、去重，只留字符集内的条目 */
function normalizePrivateUsers(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,，;；|\s]/)
  const ids = list
    .map(item => String(item ?? '').trim().replace(/^\^+/, ''))
    .filter(item => PRIVATE_USER_RE.test(item))
  return [...new Set(ids)]
}

/**
 * 面板提交的那串私聊账号里第一个不合格的条目；全部合格时返回空串。
 *
 * 归一会把不合格的条目过滤掉，但保存路径不能这么静默——用户填错了看不到任何提示，
 * 只会觉得"分流没生效"。所以锅巴在落盘前先用这个函数拦一次。
 *
 * @param {unknown} value 面板输入框原文
 * @returns {string}
 */
export function findInvalidPrivateUser(value) {
  const entries = (Array.isArray(value) ? value : String(value ?? '').split(/[,，;；|\s]/))
    .map(item => String(item ?? '').trim().replace(/^\^+/, ''))
    .filter(Boolean)
  return entries.find(entry => !PRIVATE_USER_RE.test(entry)) || ''
}

/**
 * 把配置里的原始数组归一成规则行：只保留四个合法字段，缺省补空值。
 * 空 `providerId` 的槽位照样保留——它就是"本槽不生效"，保留它才能让规则序号与面板一致。
 *
 * @param {unknown} raw `config.json` 里的 `sessionProviderRules`
 * @returns {Array<{ id: string, providerId: string, model: string, groups: string[], privateUsers: string[] }>}
 */
export function normalizeSessionRules(raw) {
  const list = Array.isArray(raw) ? raw : []
  return list.map(row => ({
    id: String(row?.id ?? '').trim(),
    providerId: String(row?.providerId ?? '').trim(),
    model: String(row?.model ?? '').trim(),
    groups: normalizeGroupIds(row?.groups),
    privateUsers: normalizePrivateUsers(row?.privateUsers)
  }))
}

/**
 * 会话键：`group:<群号>` 或 `private:<账号>`；取不到身份时返回空串（不参与匹配）。
 */
function sessionTarget(e) {
  if (e?.isGroup || e?.group_id) {
    const groupId = String(e?.group?.group_id ?? e?.group_id ?? '').trim()
    return groupId ? `group:${groupId}` : ''
  }
  const userId = String(e?.user_id ?? e?.sender?.user_id ?? '').trim()
  return userId ? `private:${userId}` : ''
}

/**
 * 建立会话到规则的索引，**first-wins**：同一群/私聊出现在多条规则时只有第一条进入 Map。
 * `providerId` 为空的槽位不参与匹配（它就是"不启用"）。
 *
 * 每次命中都重建一次而不是缓存：规则通常只有几条，建 Map 的成本远低于一次对话；
 * 而且运行时拿到的是 `structuredClone` 的配置快照，按数组引用缓存永远不会命中。
 *
 * @param {ReturnType<typeof normalizeSessionRules>} rules
 * @returns {Map<string, object>}
 */
export function buildSessionIndex(rules) {
  const index = new Map()
  for (const rule of rules) {
    if (!rule.providerId) continue
    for (const groupId of rule.groups) {
      const key = `group:${groupId}`
      if (!index.has(key)) index.set(key, rule)
    }
    for (const userId of rule.privateUsers) {
      const key = `private:${userId}`
      if (!index.has(key)) index.set(key, rule)
    }
  }
  return index
}

/**
 * 这条消息属于哪个会话规则；未命中返回 null。
 *
 * @param {object} e 消息事件
 * @param {ReturnType<typeof normalizeSessionRules>} rules 已归一的规则数组
 * @returns {object | null}
 */
export function pickSessionRule(e, rules) {
  const target = sessionTarget(e)
  if (!target) return null
  return buildSessionIndex(rules).get(target) || null
}

/**
 * 规则里写了模型就覆盖该协议的模型字段。
 *
 * **必须同时把覆盖回写到 `source` 里同一行**：`Core.sendMessage` 拿到的 `providerSource` 会
 * `resolveProvider(profile.id, source)` 重新解析一遍再 `providerConfig(row, source)` 取模型，
 * 只改返回的副本时覆盖在重解析那一步就丢了——结果是 connectionVersion 已按新模型算过
 * （该群历史清零），请求却仍用提供商自带模型。
 *
 * `source` 是 `structuredClone(Config.getConfig())` 出来的请求级快照，改它不会污染运行配置。
 *
 * @param {object} row 提供商条目（`resolveProvider` 的返回值，已是副本）
 * @param {object} rule 命中的规则
 * @param {object} [source] 本次请求的配置快照
 * @returns {object} 同一个 row，便于链式使用
 */
export function applyRuleModel(row, rule, source) {
  const field = MODEL_FIELDS[row?.type]
  if (!field || !rule?.model) return row
  row[field] = rule.model
  const target = source?.modelProviders?.[row.type]?.find(item => item?.id === row.id)
  if (target) target[field] = rule.model
  return row
}

/**
 * 运行时路由：总开关打开且命中规则时返回命中信息，否则 null（交由调用方用全局默认）。
 *
 * @param {object} e 消息事件
 * @param {object} source 配置快照
 * @param {(id: string, source: object) => object} resolveProvider 提供商解析（注入，本模块不碰配置）
 * @returns {{ rule: object, slot: number, profile: object } | null}
 */
export function pickSessionProfile(e, source, resolveProvider) {
  if (!source?.enableSessionProviderRule) return null
  const rules = normalizeSessionRules(source.sessionProviderRules)
  const rule = pickSessionRule(e, rules)
  if (!rule) return null
  const profile = applyRuleModel(resolveProvider(rule.providerId, source), rule, source)
  return { rule, slot: rules.indexOf(rule) + 1, profile }
}

/**
 * 这个会话该用哪条提供商条目：命中分流用规则的，否则全局默认。
 *
 * 会话管理类指令（`#结束对话`、`#清除最近N条`、`#对话列表`）必须用它算 key——它们和
 * `abstractChat` 存的会话是同一份，按全局默认去算只会操作一个不存在的 key：分流群里
 * 删不掉、清不掉，也看不到自己的会话。
 *
 * @param {object} e 消息事件
 * @param {object} source 配置快照
 * @param {(id: string, source: object) => object} resolveProvider
 * @returns {object} 提供商条目
 */
export function sessionProfile(e, source, resolveProvider) {
  const routed = pickSessionProfile(e, source, resolveProvider)
  return routed ? routed.profile : resolveProvider(source.defaultProviderId, source)
}

/**
 * 本次是否允许启用失败回退。
 *
 * `model/core.js` 对备用有硬校验：协议类型必须与主条目一致且不能是同一条目，否则整轮直接抛错。
 * 规则把某个群指到另一种协议的提供商后，全局备用就成了定时炸弹——这里提前关掉本次回退，
 * 而不是让那个群每次对话都失败。
 *
 * @param {object} profile 本次真正使用的提供商条目
 * @param {object} source 配置快照
 * @param {(id: string, source: object) => object} resolveProvider
 * @returns {boolean}
 */
export function allowFallbackFor(profile, source, resolveProvider) {
  if (!source?.fallbackProviderId) return false
  let backup
  try {
    backup = resolveProvider(source.fallbackProviderId, source)
  } catch {
    // 备用已被删除：本次不启用回退即可，谈不上失败；真正用不到它时不该打扰对话
    return false
  }
  return backup.type === profile.type && backup.id !== profile.id
}

/**
 * 用面板提交的槽位内容重建规则数组。
 *
 * 前 `SESSION_RULE_SLOTS` 条按槽位重建（槽位 i 沿用第 i 条的 `id`，槽位换内容不串号），
 * 第 6 条起归一后拼回——面板看不见它们，但手改配置写的规则不能被一次保存抹掉。
 * 尾段也必须归一：手写第 6 条常常缺 `privateUsers` 或把 `groups` 写成字符串，带着这种形态
 * 去校验会 TypeError 或误报重复，于是"每次保存都失败"且改不动。
 * 空槽位保留成 `providerId: ''` 的停用行，这样数组下标与面板「规则 N」始终是同一个号。
 *
 * @param {unknown} existing 现有规则数组
 * @param {Record<number, { providerId?: string, model?: string, groups?: unknown, privateUsers?: unknown }>} slots 面板提交的槽位内容，key 为 1..5
 * @returns {ReturnType<typeof normalizeSessionRules>}
 */
export function mergePanelSlots(existing, slots) {
  const previous = Array.isArray(existing) ? existing : []
  const rebuilt = []
  for (let slot = 1; slot <= SESSION_RULE_SLOTS; slot++) {
    const base = previous[slot - 1] || {}
    const rule = normalizeSessionRules([{ ...base, ...(slots[slot] || {}) }])[0]
    rule.id = String(base.id || '').trim() || `r_${randomUUID().slice(0, 8)}`
    rebuilt.push(rule)
  }
  return [...rebuilt, ...normalizeSessionRules(previous.slice(SESSION_RULE_SLOTS))]
}

/**
 * 保存期强校验：拦在落盘之前，配错的规则不会进 `config.json`。
 *
 * 不用 `normalizeProviders` 的 `requireRef` 是因为这里的报错要带规则序号，部署者才知道去改哪一条。
 *
 * @param {ReturnType<typeof normalizeSessionRules>} rules 已归一的规则（数组下标 + 1 即规则号）
 * @param {(id: string) => boolean} hasProvider 该提供商是否仍然存在
 * @returns {void}
 * @throws {Error} 校验不通过时抛出面向部署者的中文文案
 */
export function validateSessionRules(rules, hasProvider) {
  const claimed = new Map()
  rules.forEach((rule, index) => {
    const slot = index + 1
    if (!rule.providerId) {
      if (rule.groups.length || rule.privateUsers.length) throw new Error(`分流规则 ${slot} 已选群但未选提供商`)
      return
    }
    if (!rule.groups.length && !rule.privateUsers.length) throw new Error(`分流规则 ${slot} 必须至少选一个群或填一个私聊账号`)
    if (!hasProvider(rule.providerId)) throw new Error(`分流规则 ${slot} 引用的模型提供商不存在，请先改选再删除`)
    for (const [label, ids] of [['群', rule.groups], ['私聊', rule.privateUsers]]) {
      for (const id of ids) {
        // 群号与 QQ 号可能同值，去重键必须带上种类
        const key = `${label}:${id}`
        const owner = claimed.get(key)
        if (owner) throw new Error(`${label} ${id} 已出现在规则 ${owner}，请只保留一条`)
        claimed.set(key, slot)
      }
    }
  })
}
