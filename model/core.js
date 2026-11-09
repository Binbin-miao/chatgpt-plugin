import { resolveProvider, providerConfig } from '../utils/providers.js'
import { PROMPT_FIELDS, KEY_FIELDS, providerLabel, connectionVersion } from '../utils/providerProfiles.js'
import { createAttemptHistory, runProviderFallback } from '../utils/providerFallback.js'
import {
  Config
} from '../utils/config.js'
import McpManager from '../utils/mcp.js'
import {
  extractContentFromFile,
  formatDate,
  parseSourceImg,
  getUin,
  getUserData,
  normalizeChatMode,
  // isCN
} from '../utils/common.js'
import { KeyvFile } from 'keyv-file'
// import { getChatHistoryGroup } from '../utils/chat.js'
import { msgHistoryMgr } from '../model/Onebot11_MessageHistoryManager.js'
import { APTool } from '../utils/tools/APTool.js'
import { mergeTrustedToolArgs } from '../utils/tools/AbstractTool.js'
import { ClaudeAPIClient } from '../client/ClaudeAPIClient.js'
import { getMessageById, upsertMessage } from '../utils/history.js'
import { withContextInjection } from '../utils/contextInjection.js'
import { shouldRebuildSnapshot, GROUP_SNAPSHOT_MIN_INTERVAL } from '../utils/groupSnapshot.js'
import { v4 as uuid } from 'uuid'
import fetch from 'node-fetch'
import { CustomGoogleGeminiClient } from '../client/CustomGoogleGeminiClient.js'
import { QueryStarRailTool } from '../utils/tools/QueryStarRailTool.js'
import { WebsiteTool } from '../utils/tools/WebsiteTool.js'
import { SendPictureTool } from '../utils/tools/SendPictureTool.js'
import { SendVideoTool } from '../utils/tools/SendBilibiliTool.js'
import { BilibiliSearchVideoTool } from '../utils/tools/SearchBilibiliTool.js'
import { SendAvatarTool } from '../utils/tools/SendAvatarTool.js'
import { DrawImageTool } from '../utils/tools/DrawImageTool.js'
import { SerpImageTool } from '../utils/tools/SearchImageTool.js'
import { SendNetEaseMusicTool } from '../utils/tools/SendNetEaseMusicTool.js'
import { SendMessageToSpecificGroupOrUserTool } from '../utils/tools/SendMessageToSpecificGroupOrUserTool.js'
import { QueryGenshinTool } from '../utils/tools/QueryGenshinTool.js'
import { WeatherTool } from '../utils/tools/WeatherTool.js'
import { QueryUserinfoTool } from '../utils/tools/QueryUserinfoTool.js'
import { EditCardTool } from '../utils/tools/EditCardTool.js'
import { JinyanTool } from '../utils/tools/JinyanTool.js'
import { KickOutTool } from '../utils/tools/KickOutTool.js'
import { SetTitleTool } from '../utils/tools/SetTitleTool.js'
import { GetGroupNoticeTool } from '../utils/tools/GetGroupNoticeTool.js'
// import { GroupTodoTool } from '../utils/tools/GroupTodoTool.js' // 群待办暂停注册：协议端暂未实现读取接口，等支持后恢复（见 groupAdminToolMap 处注释）
import { SerpIkechan8370Tool } from '../utils/tools/SerpIkechan8370Tool.js'
import { azureSerpTool } from '../utils/tools/SerpTool.js'
import common from '../../../lib/common/common.js'
import { SendDiceTool } from '../utils/tools/SendDiceTool.js'
import { EliMovieTool } from '../utils/tools/EliMovieTool.js'
import { EliMusicTool } from '../utils/tools/EliMusicTool.js'
import { HandleMessageMsgTool } from '../utils/tools/HandleMessageMsgTool.js'
import { ProcessPictureTool } from '../utils/tools/ProcessPictureTool.js'
import { ImageCaptionTool } from '../utils/tools/ImageCaptionTool.js'
import { ChatGPTAPI } from '../utils/openai/chatgpt-api.js'
import { ResponsesAPI } from '../utils/openai/responses-api.js'
import { getEnabledHostedBuiltinTools } from '../utils/hostedTools.js'
import { newFetch } from '../utils/proxy.js'
import Keyv from 'keyv'
import crypto from 'crypto'
import { loadQuotedImages, appendMediaFailureHint, resolveTurnSystem } from '../utils/quotedImage.js'
import { buildOpenAIContent, buildResponsesInput } from '../utils/visionPayload.js'
import { sendToolCallForwardMsg, sendToolRoundTextForwardMsg } from '../utils/toolForward.js'
import { normalizeModelText } from '../utils/thinking.js'
import { redactArgsForLog, maskSecret } from '../utils/toolArgRedaction.js'
import { GithubAPITool } from '../utils/tools/GithubTool.js'
import { Misaka_WebSearchTool } from '../utils/tools/Misaka_WebSearchTool.js'
import { TavilySearchAndExtractTool } from '../utils/tools/TavilySearchAndExtractTool.js'
import { TavilyTool } from '../utils/tools/TavilyTool.js'
import { TavilyExtractTool } from '../utils/tools/TavilyExtractTool.js'
import { Sf_image_edit } from '../utils/tools/Sf_image_edit.js'
import { GeminiSearchTool } from '../utils/tools/GeminiSearchTool.js'
import { SerpImageTool_by_baidu } from '../utils/tools/SearchImageTool_by_baidu.js'
import { SerpImageTool_by_bing } from '../utils/tools/SerpImageTool_by_bing.js'
import { BlockUserTool } from '../utils/tools/Block_User.js'
import { AtOtherUserTool } from '../utils/tools/At_otherUser.js'
import { SendGroupPokeTool } from '../utils/tools/SendGroupPoke.js'
import { SandboxJSTool } from '../utils/tools/Sandbox_JS.js'
import { LocalSandboxTool } from '../utils/tools/LocalSandboxTool.js'
import { RemoteSandboxTool } from '../utils/tools/RemoteSandboxTool.js'
import { VercelSandboxTool } from '../utils/tools/VercelSandboxTool.js'
import { GetPixivApiLoliconTool } from '../utils/tools/GetPixivApiLoliconTool.js'
import { RecognitionResultsByGeminiTool } from '../utils/tools/RecognitionResultsByGeminiTool.js'
import { ViewForwardMsgTool } from '../utils/tools/ViewForwardMsgTool.js'
import { EmojiTool } from '../utils/tools/EmojiTool.js'
import { MemoryTool } from '../utils/tools/MemoryTool.js'
import { EmojiLikeTool } from '../utils/tools/EmojiLikeTool.js'
import { CommandLookupTool } from '../utils/tools/CommandLookupTool.js'
import { CommandRunTool } from '../utils/tools/CommandRunTool.js'
import { syncEnabled, delegateEnabled } from '../utils/capability/switches.js'
import { loadEntries, buildPromptAddon, readMapState } from '../utils/capability/map.js'
import { AnythingLLMQueryTool } from '../utils/anythingllm/AnythingLLMQueryTool.js'
import { AnythingLLMWorkspaceTool } from '../utils/anythingllm/AnythingLLMWorkspaceTool.js'
import { ScheduleTaskTool } from '../utils/tools/ScheduleTaskTool.js'
import { TTSAudioTool } from '../utils/tools/TTSAudioTool.js'
import { SendQQMusicTool } from '../utils/tools/SendQQMusicTool.js'
import { BaiduAISearchTool } from '../utils/tools/BaiduAiSearchTool.js'
import { OpenCodeWebSearchTool } from '../utils/tools/OpenCodeWebSearchTool.js'
import { ExaWebFetchTool } from '../utils/tools/ExaWebFetchTool.js'
import { ParallelWebFetchTool } from '../utils/tools/ParallelWebFetchTool.js'
import { GenerateMarkmapTool } from '../utils/tools/GenerateMarkmapTool.js'
import { UserProfileTool } from '../utils/tools/UserProfileTool.js'
import { GenerateMathRenderTool } from '../utils/tools/GenerateMathRenderTool.js'
import { GenerateGraphCalculatorTool } from '../utils/tools/GenerateGraphCalculatorTool.js'
import { GenerateHtmlTool } from '../utils/tools/GenerateHtmlTool.js'
import { DefaultMessageTriggerTool } from '../utils/tools/DefaultMessageTriggerTool.js'

export const roleMap = {
  owner: 'group owner',
  admin: 'group administrator'
}

const defaultPropmtPrefix = ', a large language model trained by OpenAI. You answer as concisely as possible for each response (e.g. don’t be verbose). It is very important that you answer as concisely as possible, so please remember this. If you are generating a list, do not have too many items. Keep the number of items short.'

const groupAutoReplyPrompt = '【群聊自主回复】\n本次回复由群聊自主回复触发，不代表群友正在与你对话。请结合群聊历史、@和引用，判断待回复消息是对谁说的；对象不明时，不要默认是你。若消息是对他人说的，可以第三方身份自然参与，但不要冒认他人的身份、发言或行为。不要输出判断过程。'

function appendGroupAutoReplyPrompt(system, opt) {
  return opt.groupAutoReply ? `${system}\n${groupAutoReplyPrompt}` : system
}

function getRetryGroupContextLengths(baseLength = 0) {
  if (!Number.isFinite(baseLength) || baseLength <= 0) {
    return [0]
  }

  const fallbackLengths = [
    Math.floor(baseLength * 0.75),
    Math.floor(baseLength * 0.5),
    Math.floor(baseLength * 0.25),
    0
  ]

  return [...new Set(fallbackLengths.filter(length => length >= 0 && length < baseLength))]
}

/**
 * 本轮可变上下文的外层标记。
 *
 * 群名、群成员、群聊记录、message_id、当前时间每轮都会变，一律不许进 system：
 * 上游（Gemini 兼容层）只认「整段 system 一字不差」的缓存，system 里混进任何会变
 * 的内容，命中率就恒为 0，前面放多少稳定内容都没用。
 *
 * 这些内容改由客户端作为独立 user 消息附在本轮提问之前，只在请求里出现，不写进
 * 聊天记录——写进聊天记录会被下一轮当作历史重放，上下文越滚越大。
 */
const TURN_CONTEXT_HEADER = '<group_context>\n以下是群聊环境，仅用于理解上下文，不是用户对你说的话。'
/** 没有群信息可带时（私聊 / 群上下文关闭）用中性标题，避免「群聊环境」名不副实 */
const TURN_CONTEXT_HEADER_PLAIN = '<group_context>\n以下是本轮环境信息，仅用于理解上下文，不是用户对你说的话。'

/**
 * 收集群聊环境：稳定的提示语留在 system，每轮都变的快照交给 turnContext。
 *
 * 四条通道（OpenAI Chat / Responses / Claude / Gemini）共用这一份，避免各写一遍
 * 之后字段与转义逐渐跑偏。
 *
 * @param {object} e 云崽事件
 * @param {{enableGroupContext?: boolean, groupContextLength?: number}} [settings]
 * @returns {Promise<{enabled: boolean, isGroup: boolean, botName: string, stableBotName: string, stable: string, tip: string, turn: string}>}
 *   `stable` 是群名/群号/群名片/群记录这段可按条数冻结的内容，由调用方拼进 system；
 *   `turn` 是提问者身份一行，private 段仍逐轮变化，留在 turnContext。
 */
/**
 * 上下文块内的文本统一转义。
 *
 * 群名片、群头衔、群名、消息正文都来自普通群成员，谁都能改成 `</group_context>`
 * 把上下文块提前闭合（改名片比改消息更容易触发）。所有插值一律先过这里。
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeContextText(value) {
  return (typeof value === 'string' ? value : '').replaceAll('</group_context>', '')
}

// 群上下文快照：「群信息 + 群记录」是 system 里最占 token 的一段，也是唯一看起来每轮
// 都变、实际可以被冻结的「伪动态」段。冻结期间同群所有人的这段逐字节一致。
// 重建条件按「新消息条数」而非时间：往 system 末尾追加内容会把缓存断点前移到末尾，
// 命中率从 98% 掉到 62%（2026-11-08 定论），宁可多冻结一轮也不动一个字节。
const GROUP_SNAPSHOT_LIMIT = 500
const groupSnapshotCache = new Map()

/** 仅测试用：清空群上下文快照，避免用例之间互相污染 */
export function clearGroupSnapshotCache() {
  groupSnapshotCache.clear()
}

/**
 * 拉一轮群记录；失败返回 null，调用方据此沿用旧快照。
 *
 * 绝不能把异常抛给上层去清空缓存：system 一旦变短会立刻跌破缓存门槛，比多带一轮旧记录亏得多。
 */
async function fetchGroupHistory(e, groupContextLength) {
  try {
    return await msgHistoryMgr.getGroupHistoryContext(e, groupContextLength, { fromLatest: true })
  } catch (err) {
    logger.warn('获取群聊聊天记录失败，沿用已有群记录快照', err)
    return null
  }
}

// 依赖 adapter 提供 message_id。缺失时 newestMessageId 恒为空串，
// countNewerMessages 会把每轮拉到的记录都判成「全部新增」，退化成每 30 秒重建一次 system。
// 只掉缓存命中率，不损回答正确性；接入新 adapter 前先确认它带 message_id。
/**
 * 把群信息与群记录渲染成 system 里那段稳定文本。chats 为空时只给群名/群号/群名片。
 */
function formatGroupSnapshotText({ groupName, groupId, botName, chats }) {
  let text = `\nthe group name is ${groupName}, group id is ${groupId}。`
  if (botName) text += `Your nickname is ${sanitizeContextText(botName)} in the group,`
  // 一条记录都没拉到时不能只留引导句：模型会看到一个没有下文的「这是群记录」。
  // 群名、群号、群名片本机就有，不依赖拉取，一律照给。
  if (chats.length > 0) {
    text += 'There is the conversation history in the group, you must chat according to the conversation history context"'
    text += chats
      .map(chat => {
        const sender = chat.sender || {}
        // 历史条目由各 adapter 的接口返回，字段并不总是齐全（NapCat 是必填，别家未必）：
        // 直接 startsWith 会抛错，整段群历史被 catch 丢弃，日志只剩「获取群聊聊天记录失败」。
        const rawMessage = typeof chat.raw_message === 'string' ? chat.raw_message : ''
        if (rawMessage.startsWith('建议的回复')) {
          // 建议的回复太容易污染设定导致对话太固定跑偏了
          return ''
        }
        const card = sanitizeContextText(sender.card || sender.nickname)
        const area = sanitizeContextText(sender.area)
        const title = sanitizeContextText(sender.title)
        const message = sanitizeContextText(rawMessage)
        return `【${card}】(qq：${sender.user_id}, ${roleMap[sender.role] || 'normal user'}，${area ? 'from ' + area + ', ' : ''} ${sender.age} years old, 群头衔：${title}, gender: ${sender.sex}, time：${formatDate(new Date(chat.time * 1000))}, messageId: ${chat.message_id}) 说：${message}`
      })
      .join('\n')
  }
  return text
}

/**
 * 写入快照并维持 map 上限，超限时淘汰最久未更新的那条。fetchedAt 只用于拉取频率保护。
 */
function cacheGroupSnapshot(snapshotKey, { text, newestMessageId }) {
  groupSnapshotCache.set(snapshotKey, { text, newestMessageId, fetchedAt: Date.now() })
  if (groupSnapshotCache.size <= GROUP_SNAPSHOT_LIMIT) return
  let oldestKey = null
  let oldestAt = Infinity
  for (const [key, entry] of groupSnapshotCache) {
    if (entry.fetchedAt < oldestAt) {
      oldestAt = entry.fetchedAt
      oldestKey = key
    }
  }
  if (oldestKey) groupSnapshotCache.delete(oldestKey)
}

export async function collectGroupContext(e, settings = {}) {
  const result = { enabled: false, isGroup: false, botName: '', stableBotName: '', stable: '', tip: '', turn: '' }
  if (!settings.enableGroupContext) return result

  try {
    const groupId = e.group_id
    const member = e.isGroup ? e.group?.pickMember?.(getUin(e)) : null
    const botName = e.isGroup ? (member?.card || member?.nickname) : e.bot?.nickname
    result.enabled = true
    // 只有真的构建了群环境才算群聊：群上下文关闭时即便带着 group_id，
    // 也没有群名群历史可讲，标题必须回落到中性措辞。
    result.isGroup = Boolean(groupId)
    result.botName = botName || ''
    // 人设里的 [name] 只能用场景无关的机器人昵称：群名片（botName）在群聊和私聊是两个值，
    // 拿它替换会让 system 结尾重新分叉，私聊↔群聊的缓存前缀又从第 0 字节断掉。
    // 群名片的信息量由 turnContext 的「Your nickname is X in the group」承载，不丢。
    result.stableBotName = e.bot?.nickname || ''
    // 私聊没有群可看：不注入「你在 QQ 群里」这类错误描述，但必须说清「这是私聊」——
    // 否则模型只能从「没有群名、没有群历史」反推，容易拿群聊口吻（At 人、说「群里」）答话。
    // 这段进 turnContext 不进 system，私聊与群聊的 system 才能逐字一致、共享缓存前缀。
    if (!groupId) {
      const senderName = sanitizeContextText(e.sender?.card || e.sender?.nickname)
      const senderId = e.sender?.user_id
      result.turn = 'Attention, you are currently chatting in a private message (one-on-one), not a qq group.'
      if (senderName || senderId) {
        result.turn += ` The one who asks you now is ${senderName}(${senderId})。`
      }
      return result
    }

    result.tip = Config.groupContextTip
    const senderName = sanitizeContextText(e.sender.card || e.sender.nickname)
    const groupName = sanitizeContextText(e.group?.name || e.group_name)
    const groupContextLength = settings.groupContextLength ?? Config.groupContextLength

    // 公共段（群信息 + 群记录）走快照；提问者身份放到最末尾。
    // 群里 A、B、C 交替提问时，公共段完全一致，前缀能一路吃到群记录末尾；
    // 身份一旦排在前面，从第 300 个 token 就分叉，后面 14k 群记录全白搭。
    //
    // 窗口固定取「群内最新 N 条」。以本条消息为起点向前取的话，每个提问者的窗口都不一样
    // （引用旧消息时更甚），快照按人分叉，等于没做快照。固定的代价是引用旧消息时模型看到
    // 的是最新群记录而非旧消息之前的记录——记录只用来理解「群里在聊什么」，旧消息本身
    // 仍在 prompt 里随引用带入，信息不缺。
    const snapshotKey = `${e.self_id}:${groupId}:${groupContextLength}:${botName}:${groupName}`
    const cachedSnapshot = groupSnapshotCache.get(snapshotKey)
    // fetchedAt 是「上次实际拉取时刻」：频率保护看它，内容新旧看 newestMessageId。
    // dueFetch 区分「没到时间没拉」和「拉了但失败」：成功失败都续期，
    // 否则 adapter 一抛错就变成每轮都卡在一次超时上。
    const dueFetch = !cachedSnapshot || Date.now() - cachedSnapshot.fetchedAt >= GROUP_SNAPSHOT_MIN_INTERVAL
    const chats = dueFetch ? await fetchGroupHistory(e, groupContextLength) : null
    if (dueFetch && cachedSnapshot) {
      cachedSnapshot.fetchedAt = Date.now()
    }
    // 拉取失败或返回空时 newer 恒为 0，直接落到「沿用旧快照」：缓存既不清空也不缩短。
    const shouldRebuild = shouldRebuildSnapshot(cachedSnapshot, chats, chats?.length || 0)
    let publicText
    if (shouldRebuild) {
      // 拉取失败或返回空也照样写一份「只有群名群号」的快照：这三样本机就有，丢了只会让
      // system 变短、更容易跌破上游门槛。从无到有只会让 system 变一次，代价可接受。
      const reached = Array.isArray(chats) ? chats : []
      publicText = formatGroupSnapshotText({ groupName, groupId, botName, chats: reached })
      cacheGroupSnapshot(snapshotKey, {
        text: publicText,
        newestMessageId: reached.length > 0 ? String(reached[reached.length - 1]?.message_id ?? '') : ''
      })
    } else {
      // 冻结期内逐字节取缓存，不重新拼一遍（重拼会引入时区、名片变更等噪声）
      publicText = cachedSnapshot.text
    }

    // 群记录快照是「伪动态」段：冻结期内逐字节不变，前移进 system 才能吃到缓存断点。
    // 提问者身份仍留在 turnContext，每轮不同也不会污染前缀。
    // 标签只在出口加：缓存里存的是不带标签的 publicText，逐字节比较不受影响。
    // 少了这层边界，system 里一大段「群友说：…」会被模型当成人设的一部分去模仿。
    result.stable = publicText ? `<group_context>\n${publicText.trimStart()}\n</group_context>` : ''
    result.turn = 'Attention, you are currently chatting in a qq group.' +
      `\nThe one who asks you now is ${senderName}(${e.sender.user_id})。`
  } catch (err) {
    // 私聊也要留下痕：静默吞掉会让「为什么这轮没带上下文」无从查起
    logger.warn(`获取${e.isGroup ? '群聊聊天记录' : '私聊环境信息'}失败，本次对话不携带该段上下文`, err)
  }
  return result
}

/**
 * 把本轮可变内容包成一个整体，交给客户端插到本轮提问之前。
 *
 * @param {string} [body] 本轮环境正文（群聊：自检提示 + 群名群历史；私聊：身份与场景说明）
 * @param {Array<string|undefined>} [extraParts] 其余每轮变化的内容，空的分段自动丢弃
 * @param {boolean} [isGroup] 决定外层标题措辞：群聊「群聊环境」，私聊用中性的「本轮环境信息」
 * @returns {string}
 */
function wrapTurnContext(body, extraParts = [], isGroup = false) {
  // 统一收口：任何来源的文本（群名片、群名、头衔、消息正文、以后新增的字段）
  // 都在这里再剥一次闭合标记。逐字段转义是防御纵深，这里是最后一道，漏不掉。
  const content = [body, ...extraParts]
    .filter(Boolean)
    .join('\n')
    .replaceAll('</group_context>', '')
  if (!content) return ''
  const header = isGroup ? TURN_CONTEXT_HEADER : TURN_CONTEXT_HEADER_PLAIN
  return `${header}\n${content}\n</group_context>`
}

/**
 * 拼出 turnContext 的正文：群聊自检提示在前、群环境在后；私聊只有身份说明。
 *
 * `group.tip` 是给「群聊记录」配的使用说明，曾经直接拼进 system——私聊拿不到它、
 * 群聊有它，两种场景的 system 长度就差出约 290 token，而缓存只认逐字节相同的前缀，
 * 于是私聊与群聊来回切换时命中恒为 0。挪到 turnContext 后 system 跨场景一致，
 * 前缀能一路吃到历史末尾（2026-11-07 实测：63,495 的请求由 0 变为可命中约 51.7k）。
 *
 * @param {{tip?: string, turn?: string}} group collectGroupContext 的返回值
 * @returns {string}
 */
function groupContextBody(group) {
  return [group.tip, group.turn].filter(Boolean).join('\n')
}

/**
 * 合并插件用系统提示词——**只合并稳定段**。
 *
 * 这里的追加项在同一会话里内容不变，是 prompt 缓存唯一能命中的那一段。当前时间与对话
 * 时间线每轮都变，必须走 `buildDynamicSystemSuffix()` 并排在所有稳定内容之后。
 */
function mergeSystemPrompt(systemPrompt, e) {
  // 呆毛版 在 prompt 中替换文本使用 e.sender 信息
  if (Config.isReplacePromptForSenderMsg) {
    systemPrompt = replacePromptForSenderMsg(e, systemPrompt);
  }
  // 呆毛版 连接画图插件
  if (Config.drawByJsonToPlugin) {
    systemPrompt += '\nIt is important that If I ask you to create a picture prompt or painting, please respond in English in a format suitable for Stable Diffusion. The prompt should include: {Character Description}, {Scene}, {Mood}, {Camera Angle}, {Lighting}, {Art Style}, {Architectural Style}. 其中角色使用词条形式，例如 `klee (genshin impact)`。 Return the message in JSON format like this:```json{"Tools": "Stable_Diffusion", "tags": "Your painting prompt in English", "msg": "Your role assistant content."}```'
  }
  // 呆毛版 CQ At 群友
  if (Config.isProcessCQAtCode) {
    systemPrompt += "\n如果你想要At某个用户，请在回复中使用格式 [CQ:at,id=用户id号]，例如 [CQ:at,id=123456]。注意：使用At码后不要再重复写用户昵称，直接继续你的回复内容即可。"
  }
  // 已不可用
  if (Config.enableChatSuno) {
    systemPrompt += '如果我要求你生成音乐或写歌，你需要回复适合Suno生成音乐的信息。请使用Verse、Chorus、Bridge、Outro和End等关键字对歌词进行分段，如[Verse 1]。音乐信息需要使用markdown包裹的JSON格式回复给我，结构为```json{"option": "Suno", "tags": "style", "title": "title of the song", "lyrics": "lyrics"}```。'
  }
  return systemPrompt
}

/**
 * 动态段：当前时间与对话时间线。
 *
 * 这两样每轮都变，只能追加在所有稳定内容之后。原实现把它们并进 `mergeSystemPrompt()`，
 * 而调用方随后才拼插件清单——清单被挡在时间戳之后，永远进不了缓存前缀。按真实地图实测：
 * 稳定前缀只剩 basePrompt 的 17 tokens，远低于 OpenAI 的 1024 门槛，缓存命中因此恒为 0；
 * 把动态段挪到末尾后稳定前缀可达 1890 tokens。
 *
 * @param {object} [opt]
 * @param {number[]} [opt.replyTimestamps] 本轮引用到的时间戳
 * @returns {string}
 */
function buildDynamicSystemSuffix (opt = {}) {
  if (!Config.getCurrentTime) return ''
  let suffix = `\nCurrent time: ${formatDate(new Date())}.`
  const timestamps = Array.isArray(opt.replyTimestamps) ? opt.replyTimestamps : []
  if (timestamps.length) {
    suffix += '\nConversation timeline:\n' + timestamps
      .map(ts => `- ${formatDate(new Date(ts))}`)
      .join('\n')
  }
  return suffix
}

/**
 * 取本轮引用图
 *
 * 四家 provider 分支共用：非 Orignal 模式直接空结果，否则统一走 quotedImage
 * （10MB 上限、代理、CQ 还原、格式探测与 2MB 转码）。
 *
 * @param {object} e 云崽事件
 * @param {object} [prepared] 本轮共享的准备态（主备 provider 复用）
 * @returns {Promise<{medias: Array<{mimeType: string, data: string}>, failed: number}>}
 */
async function collectQuotedImages(e, prepared) {
  if (Config.mediaRecognitionSource !== 'Orignal') return { medias: [], failed: 0 }
  // 一轮只取一次：prepared 在主备 provider 之间共享，切换时不重复下载
  return await loadQuotedImages(e, prepared)
}

/**
 * 把引用图挂到本次请求选项上；没有图时保持原样，避免给客户端传空数组
 *
 * @param {object} option 客户端 sendMessage 的选项
 * @param {Array<object>} medias
 */
function applyQuotedMedias(option, medias) {
  if (medias.length) option.medias = medias
}

class Core {
  async sendMessage(prompt, conversation = {}, use, e, opt = {}) {
    const source = opt.providerSource || structuredClone(Config.getConfig())
    const main = resolveProvider(use || source.defaultProviderId, source)
    const backup = opt.allowFallback && source.fallbackProviderId ? resolveProvider(source.fallbackProviderId, source) : null
    if (backup && (backup.type !== main.type || backup.id === main.id)) throw new Error('失败回退配置与主模型不匹配，请在锅巴重新选择')
    const prepared = {}
    const owner = this
    return runProviderFallback(main, backup, async (row, state) => {
      if (!String(row[KEY_FIELDS[row.type]] || '').split(/[,，;]/).some(key => key.trim())) throw new Error(`${providerLabel(row)} 尚未配置密钥`)
      const cfg = providerConfig(row, source)
      cfg[PROMPT_FIELDS[row.type]] = main[PROMPT_FIELDS[main.type]]
      const history = createAttemptHistory(row.type, conversation.messages)
      const nextConversation = { ...conversation, parentMessageId: history.parentMessageId,
        previousResponseId: conversation.actualProviderId === row.id && conversation.actualProviderVersion === connectionVersion(row) ? conversation.previousResponseId : undefined }
      const context = Object.create(owner)
      context.reply = async (...args) => { state.irreversible = true; return owner.reply(...args) }
      const event = Object.create(e)
      event.modelProviderId = row.id
      event.reply = async (...args) => { state.irreversible = true; return e.reply(...args) }
      const request = async (...args) => {
        const url = new URL(args[0])
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型提供商地址需要使用 http 或 https')
        state.requested = true
        return newFetch(...args)
      }
      const result = await Core.prototype.sendWithProvider.call(context, prompt, nextConversation, row.type, event,
        { ...opt, prepared, history, request, providerName: row.name, onToolStart: () => { state.irreversible = true } }, cfg)
      if (result?.refused && !result.text) result.text = '模型拒绝回答'
      if (result) { result.actualProviderId = row.id; result.actualProviderVersion = connectionVersion(row); result.actualStore = cfg.responsesStore === true }
      return result
    }, { enabled: opt.allowFallback === true, onRetry: (row, n) => logger.warn(`[ChatGPT] 模型请求失败，开始第 ${n + 1} 次尝试：${row.name}`) })
  }

  async sendWithProvider(prompt, conversation, use, e, opt, Config) {
    const { getMessageById, upsertMessage } = opt.history

    opt = {
      enableSmart: Config.smartMode,
      ...opt,
      system: {
        api: Config.promptPrefixOverride,
        responses: Config.responsesSystemPrompt,
        claude: Config.claudeSystemPrompt,
        gemini: Config.geminiPrompt,
        ...opt.system
      },
      settings: {
        replyPureTextCallback: undefined,
        enableGroupContext: Config.enableGroupContext,
        forceTool: false,
        ...opt.settings
      }
    }
    // 调用方可按次禁用工具，不能临时修改全局配置而影响并发普通对话。
    if (opt.disableTools) opt.enableSmart = false
    use = normalizeChatMode(use)
    // 兜底 null：调用方总是传对象，超时由下面各分支自行决定
    conversation = conversation || {}
    if (Config.debug) {
      logger.mark(`using ${use} mode`)
    }
    const userData = await getUserData(e.user_id)
    const useCast = userData.cast || {}
    if (use === 'claude') { // 使用接口 ##############################
      // slack已经不可用，移除
      let keys = Config.claudeApiKey?.split(/[,;]/).map(key => key.trim()).filter(key => key)
      let choiceIndex = Math.floor(Math.random() * keys.length)
      let key = keys[choiceIndex]
      logger.info(`使用API Key：${maskSecret(key)}`)
      {
        let errorMessage = ''
        const client = new ClaudeAPIClient({
          config: Config, fetch: opt.request, onToolStart: opt.onToolStart, ...opt.history,
          key,
          model: Config.claudeApiModel || 'claude-3-sonnet-20240229',
          debug: Config.debug,
          baseUrl: Config.claudeApiBaseUrl,
          providerName: opt.providerName,
          e
          // temperature: Config.claudeApiTemperature || 0.5
        })
        let promptForClaude = prompt
        // 稳定段在前，动态段（群上下文 / message_id / 时间）统一排到最后，
        // 否则每轮都变的内容会把后面的稳定内容挡在缓存前缀之外。
        let system = mergeSystemPrompt(opt.system.claude || '', e)
        let claudeSystemDynamic = ''
        let option = {
          stream: false,
          parentMessageId: conversation.parentMessageId,
          conversationId: conversation.conversationId,
          max_tokens: Config.claudeApiMaxToken,
          temperature: Config.claudeApiTemperature
        }
        let claudeTools = []
        if (opt.enableSmart) {
          const {
            funcMap,
            promptAddition,
            systemAddition,
            systemDynamic
          } = await collectTools(e)
          claudeTools = Object.keys(funcMap).map(k => funcMap[k].tool)
          promptAddition && (promptForClaude += promptAddition)
          systemAddition && (system += systemAddition)
          claudeSystemDynamic = systemDynamic || ''

          const forceToolByKeyword = Config.enableForceToolKeywords !== false &&
            Config.geminiForceToolKeywords?.find(k => promptForClaude?.includes(k) || e.msg?.includes(k))
          option.toolMode = (opt.settings.forceTool || forceToolByKeyword) ? 'ANY' : 'AUTO'
        }

        // 托管内置工具（服务商云端执行），不依赖智能模式
        const hostedClaudeTools = opt.disableTools ? [] : getEnabledHostedBuiltinTools('claude', Config)
        if (hostedClaudeTools.length > 0) {
          // 避免与本地搜索工具重名（如 misaka_WebSearchTool 的 name 也是 web_search）
          claudeTools = claudeTools.filter(tool => tool.name !== 'web_search')
          claudeTools.push(...hostedClaudeTools.map(tool => tool.requestTool))
        }
        if (claudeTools.length > 0) {
          client.addTools(claudeTools)
        }
        // 群聊记录、message_id、当前时间、群聊自检提示每轮/每场景都可能变，一律不进 system
        // ——Anthropic 的缓存断点打在 system 末尾，混进会变的内容整段就缓存不了。
        const group = await collectGroupContext(e, opt.settings)
        if (group.enabled) {
          system = system.replaceAll('[name]', group.stableBotName || 'Claude')
        }
        // 群记录快照拼在 [name] 替换之后：群友聊天正文里的 [name] 字面量不得被换成人设名，
        // 而缓存断点要一路覆盖到群记录末尾（群记录是伪动态，不再走 turnContext）。
        if (group.stable) {
          system += '\n' + group.stable
        }
        option.system = system
        // 断点打在整段 system 末尾：群记录快照已拼进稳定段，缓存必须一路覆盖到它末尾
        option.systemStableLength = option.system.length
        option.turnContext = wrapTurnContext(groupContextBody(group), [
          claudeSystemDynamic,
          buildDynamicSystemSuffix({ replyTimestamps: conversation.replyTimestamps })
        ], group.isGroup)
        const quoted = await collectQuotedImages(e, opt.prepared)
        applyQuotedMedias(option, quoted.medias)
        // 上下文注入：文本记忆在 prepared 上，一轮只拉取一次（docs/adr/0016）
        option.system = await withContextInjection(opt.prepared, Config, option.system, conversation)
        // 缓存存基础 system（含上下文注入文本）；提示按本次尝试单独追加（prepared 跨主备复用）
        option.system = appendGroupAutoReplyPrompt(resolveTurnSystem(opt.prepared, option.system, quoted.failed > 0), opt)
        return await client.sendMessage(promptForClaude, option)
      }
    } else if (use === 'gemini') { // 使用接口 ##############################
      let client = new CustomGoogleGeminiClient({
        config: Config, fetch: opt.request, onToolStart: opt.onToolStart, ...opt.history,
        e,
        userId: e.sender.user_id,
        key: Config.getGeminiKey,
        model: Config.geminiModel,
        baseUrl: Config.geminiBaseUrl,
        providerName: opt.providerName,
        debug: Config.debug
      })
      let option = {
        stream: false,
        onProgress: (data) => {
          if (Config.debug) {
            logger.info(JSON.stringify(data, null, 2))
          }
        },
        parentMessageId: conversation.parentMessageId,
        conversationId: conversation.conversationId,
        search: !opt.disableTools && Config.geminiEnableGoogleSearch, // Gemini 原生搜索，开启后无法使用智能模式，默认关闭
        codeExecution: !opt.disableTools && Config.geminiEnableCodeExecution, // Gemini 原生代码执行，开启后无法使用智能模式，默认关闭
        paimon_globalInnerOs: Config.paimon_globalInnerOs,
        thinkingLevel: Config.geminiThinkingLevel || ''
      }

      // 记录点: opt.medias —— 引用图统一走 quotedImage
      const quoted = await collectQuotedImages(e, opt.prepared)
      applyQuotedMedias(option, quoted.medias)
      const quotedFailed = quoted.failed > 0

      /**
       * 工具收集顺带产出的 systemAddition（地图清单、群管要用的 message_id）此前在这一支被整块丢掉：
       * 只解构了 funcMap。Gemini 用户因此既看不到插件清单，也拿不到「最近一条消息 id」。
       * 先接住，等下面 system 拼完再追加——与 OpenAI / Claude 两支口径一致。
       */
      let geminiSystemAddition = ''
      let geminiSystemDynamic = ''
      if (opt.enableSmart) {
        const {
          funcMap,
          systemAddition,
          systemDynamic
        } = await collectTools(e)
        let tools = Object.keys(funcMap).map(k => funcMap[k].tool)
        client.addTools(tools)
        geminiSystemAddition = systemAddition || ''
        geminiSystemDynamic = systemDynamic || ''
      }

      // system 只放稳定段：人设 → 插件清单 → 常量提示；
      // 群聊记录、message_id、当前时间走 turnContext，不参与 system。
      let system = mergeSystemPrompt(opt.system.gemini, e)
      system += geminiSystemAddition

      const group = await collectGroupContext(e, opt.settings)
      if (group.enabled) {
        system = system.replaceAll('[name]', group.stableBotName || 'GeminiPro')
      }
      // 群记录快照拼在 [name] 替换之后、上下文注入之前
      if (group.stable) {
        system += '\n' + group.stable
      }
      option.system = system
      option.turnContext = wrapTurnContext(groupContextBody(group), [
        geminiSystemDynamic,
        buildDynamicSystemSuffix({ replyTimestamps: conversation.replyTimestamps })
      ], group.isGroup)
      option.replyPureTextCallback = opt.settings.replyPureTextCallback || (async (msg) => {
        if (msg) {
          await e.reply(msg, true)
        }
      })
      const forceToolByKeyword = Config.enableForceToolKeywords !== false &&
        Config.geminiForceToolKeywords?.find(k => prompt?.includes(k))
      option.toolMode = (opt.settings.forceTool || forceToolByKeyword) ? 'ANY' : 'AUTO'

      // 导入更多 gemini config
      option.temperature = Config.gemini_temperature
      option.sf_markdownPic = Config.sf_markdownPic
      option.auto_makeForwardMsg = Config.auto_makeForwardMsg

      option.system = await withContextInjection(opt.prepared, Config, option.system, conversation)
      option.system = appendGroupAutoReplyPrompt(resolveTurnSystem(opt.prepared, option.system, quotedFailed), opt)
      return await client.sendMessage(prompt, option)
    } else if (use === 'responses') { // OpenAI Responses API ##############################
      const completionParams = {}
      if (Config.responsesModel) completionParams.model = Config.responsesModel
      if (Config.responsesReasoningEffort) completionParams.reasoning_effort = Config.responsesReasoningEffort
      if (typeof Config.responsesTemperature === 'number') completionParams.temperature = Config.responsesTemperature

      let extraSystemMessage = '' // 稳定段：插件清单
      let extraSystemDynamic = '' // 动态段：message_id
      let quotedFailed = false
      const buildResponsesInstructions = async (groupContextLength = Config.groupContextLength) => {
        // 稳定段只放人设、插件清单与常量提示；群聊记录、message_id、当前时间走 turnContext。
        const group = await collectGroupContext(e, {
          ...opt.settings,
          groupContextLength
        })
        let instructions = mergeSystemPrompt(opt.system.responses || Config.responsesSystemPrompt, e)
        if (extraSystemMessage) instructions += extraSystemMessage
        if (group.enabled) {
          instructions = instructions.replaceAll('[name]', group.stableBotName || 'ChatGPT')
        }
        // 群记录快照在上下文注入之前拼进 system：注入文本来自外部端点、每轮可能变
        if (group.stable) {
          instructions += '\n' + group.stable
        }
        // 上下文注入来自外部端点、每轮可能变，放在稳定段之后
        instructions = await withContextInjection(opt.prepared, Config, instructions, conversation)
        instructions = appendGroupAutoReplyPrompt(instructions, opt)
        const turnContext = wrapTurnContext(groupContextBody(group), [
          extraSystemDynamic,
          buildDynamicSystemSuffix({ replyTimestamps: conversation.replyTimestamps })
        ], group.isGroup)
        return { instructions, turnContext }
      }

      const client = new ResponsesAPI({
        apiBaseUrl: Config.responsesApiBaseUrl,
        apiKey: Config.responsesApiKey,
        debug: false,
        fetch: opt.request,
        maxResponseTokens: Config.responsesApiMaxToken,
        maxModelTokens: Config.responsesMaxModelTokens,
        providerName: opt.providerName
      })
      const builtInstructions = await buildResponsesInstructions()
      let instructions = builtInstructions.instructions
      let responsesTurnContext = builtInstructions.turnContext

      const quoted = await collectQuotedImages(e, opt.prepared)
      const quotedMedias = quoted.medias
      quotedFailed = quoted.failed > 0

      let isAdmin
      let sender
      let funcMap = {}
      if (opt.enableSmart) {
        isAdmin = ['admin', 'owner'].includes(e.sender.role)
        sender = e.sender.user_id
        const { funcMap: collectedFuncMap, promptAddition, systemAddition, systemDynamic } = await collectTools(e)
        funcMap = collectedFuncMap
        promptAddition && (prompt += promptAddition)
        extraSystemMessage = systemAddition || ''
        extraSystemDynamic = systemDynamic || ''
        const rebuiltForTools = await buildResponsesInstructions()
        instructions = rebuiltForTools.instructions
        responsesTurnContext = rebuiltForTools.turnContext
        completionParams.tools = Object.values(funcMap).map(({ function: definition }) => ({
          type: 'function',
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          // 现有工具 schema 并不全部满足 strict 模式约束，保留 Chat API 的最佳努力行为。
          strict: false
        }))
        if (Config.enableForceToolKeywords !== false && Array.isArray(Config.geminiForceToolKeywords)) {
          const inputText = prompt || e.msg || ''
          if (Config.geminiForceToolKeywords.some(keyword => inputText.includes(keyword))) {
            completionParams.tool_choice = 'required'
          }
        }
      }

      // 托管内置工具（服务商云端执行），不依赖智能模式
      const hostedResponsesTools = opt.disableTools ? [] : getEnabledHostedBuiltinTools('responses', Config)
      if (hostedResponsesTools.length > 0) {
        completionParams.tools = [
          ...(Array.isArray(completionParams.tools) ? completionParams.tools : []),
          ...hostedResponsesTools.map(tool => tool.requestTool)
        ]
      }

      let initialInput = quotedMedias.length
        ? buildResponsesInput(prompt || '请描述这张图片', quotedMedias)
        : prompt
      const currentInput = Array.isArray(initialInput) ? initialInput : [{ role: 'user', content: initialInput }]
      if (!Config.responsesStore || !conversation.previousResponseId) initialInput = [...(conversation.messages || []).filter(m => ['user', 'assistant'].includes(m.role)), ...currentInput]
      instructions = resolveTurnSystem(opt.prepared, instructions, quotedFailed)
      const statelessToolInput = Array.isArray(initialInput)
        ? [...initialInput]
        : [{ role: 'user', content: initialInput }]

      const sendResponsesWithContextFallback = async (input, sendOptions) => {
        const retryLengths = !opt.allowFallback && opt.settings.enableGroupContext
          ? getRetryGroupContextLengths(Config.groupContextLength)
          : []
        for (let i = 0; i <= retryLengths.length; i++) {
          try {
            const result = await client.sendMessage(input, sendOptions)
            // 官网已执行的内置工具同样不能随整轮重试重复执行。
            if (result.responseOutput?.some(item => item.type !== 'function_call' && item.type?.endsWith('_call'))) opt.onToolStart()
            return result
          } catch (err) {
            const isContextExceeded = err.message?.includes('context_length_exceeded')
            if (!isContextExceeded || i >= retryLengths.length) throw err
            const nextGroupContextLength = retryLengths[i]
            logger.warn(`[chatgpt][Responses] 上下文超限，压缩群聊记录后重试，groupContextLength=${nextGroupContextLength}`)
            const rebuilt = await buildResponsesInstructions(nextGroupContextLength)
            sendOptions.instructions = quotedFailed ? appendMediaFailureHint(rebuilt.instructions) : rebuilt.instructions
            sendOptions.turnContext = rebuilt.turnContext
          }
        }
      }

      const sendOptions = {
        timeoutMs: 600000,
        instructions,
        turnContext: responsesTurnContext,
        completionParams,
        store: Config.responsesStore === true,
        previousResponseId: Config.responsesStore ? conversation.previousResponseId : undefined
      }

      try {
        let msg = await sendResponsesWithContextFallback(initialInput, sendOptions)
        let toolRoundCount = 0
        /** 工具轮思考（含被重归类的独白），跨轮累积后并入最终 thinking_text */
        let toolRoundThinking = ''
        const maxToolRounds = Config.llm_maxToolRounds

        while (msg.toolCalls?.length > 0 && toolRoundCount < maxToolRounds) {
          opt.onToolStart()
          toolRoundCount++
          // 工具轮附带文本：归一化后以合并转发立即单独外发，不再裸发群消息
          if (msg.text) {
            const normalized = normalizeModelText(msg.text.replace(/\n{2,}/g, '\n').trim(), {
              toolNames: msg.toolCalls.map(toolCall => toolCall.function?.name),
              inToolRound: true
            })
            if (normalized.thinking) {
              toolRoundThinking += normalized.thinking
            }
            if (normalized.text) {
              await sendToolRoundTextForwardMsg(e, [{
                text: normalized.text,
                provider: 'OpenAI Responses API',
                round: toolRoundCount
              }])
            }
          }

          const toolResults = await executeResponsesToolCalls(this, e, msg.toolCalls, funcMap, isAdmin, sender, toolRoundCount)
          if (completionParams.tool_choice === 'required') delete completionParams.tool_choice

          if (Config.responsesStore) {
            sendOptions.previousResponseId = msg.id
            msg = await sendResponsesWithContextFallback(toolResults, sendOptions)
          } else {
            statelessToolInput.push(...msg.responseOutput, ...toolResults)
            msg = await sendResponsesWithContextFallback(statelessToolInput, sendOptions)
          }
        }

        if (msg.toolCalls?.length > 0 && toolRoundCount >= maxToolRounds) {
          logger.warn(`Responses API 工具调用已达最大轮次上限 ${maxToolRounds} 轮，强制终止工具循环`)
          msg.toolCalls = undefined
          msg.functionCall = undefined
        }
        if (toolRoundThinking) {
          msg.thinking_text = toolRoundThinking + (msg.thinking_text || '')
        }
        return msg
      } catch (err) {
        if (!opt.allowFallback && err.message?.includes('context_length_exceeded')) {
          logger.warn(err)
          await this.reply('字数超限啦，将为您自动结束本次对话。')
          return null
        }
        logger.error(err)
        throw err
      }
    } else { // 使用接口 ##############################
      // openai api
      let completionParams = {}
      if (typeof Config.temperature === 'number') completionParams.temperature = Config.temperature
      if (Config.model) {
        completionParams.model = Config.model
      }
      if (Config.reasoningEffort) {
        completionParams.reasoning_effort = Config.reasoningEffort
      }
      const currentDate = new Date().toISOString().split('T')[0]
      let promptPrefix = `You are ${Config.tts_First_person} ${useCast?.api || opt.system.api || defaultPropmtPrefix}
        Current date: ${currentDate}`
      // let maxModelTokens = getMaxModelTokens(completionParams.model)
      // let system = promptPrefix
      let extraSystemMessage = '' // 稳定段：插件清单
      let extraSystemDynamic = '' // 动态段：message_id
      let quotedFailed = false
      const buildOpenAIRequest = async (groupContextLength = Config.groupContextLength) => {
        // 稳定段只放人设、插件清单与常量提示；群聊记录、message_id、当前时间走 turnContext。
        const group = await collectGroupContext(e, {
          ...opt.settings,
          groupContextLength
        })
        let system = mergeSystemPrompt(promptPrefix, e)
        if (extraSystemMessage) {
          system += extraSystemMessage
        }
        if (group.enabled) {
          system = system.replaceAll('[name]', group.stableBotName || 'ChatGPT')
        }
        // 群记录快照在上下文注入之前拼进 system：注入文本来自外部端点、每轮可能变
        if (group.stable) {
          system += '\n' + group.stable
        }
        // 上下文注入来自外部端点、每轮可能变，放在稳定段之后
        system = await withContextInjection(opt.prepared, Config, system, conversation)
        system = appendGroupAutoReplyPrompt(system, opt)
        const turnContext = wrapTurnContext(groupContextBody(group), [
          extraSystemDynamic,
          buildDynamicSystemSuffix({ replyTimestamps: conversation.replyTimestamps })
        ], group.isGroup)
        return { system, turnContext }
      }
      // 引用图先取：失败提示按每次尝试单独追加（缓存存基础 system，含上下文注入文本）
      const quoted = await collectQuotedImages(e, opt.prepared)
      const quotedMedias = quoted.medias
      quotedFailed = quoted.failed > 0
      const builtRequest = await buildOpenAIRequest()
      const system = builtRequest.system

      logger.debug(system)
      let opts = {
        apiBaseUrl: Config.openAiBaseUrl,
        apiKey: Config.apiKey,
        debug: false,
        upsertMessage,
        getMessageById,
        systemMessage: system,
        completionParams,
        fetch: opt.request,
        maxModelTokens: Config.maxModelTokens,
        maxResponseTokens: Config.apiMaxToken,
        chatgptBlockCount: Config.chatgptBlockCount,
        promptCacheRetention: Config.promptCacheRetention,
        providerName: opt.providerName,
      }

      this.chatGPTApi = new ChatGPTAPI(opts)
      let option = {
        timeoutMs: 600000,
        completionParams,
        stream: Config.apiStream,
        onProgress: (data) => {
          if (Config.debug) {
            logger.info(JSON.stringify((data?.text || data.functionCall || data), null, 2))
          }
        }
        // systemMessage: promptPrefix
      }
      option.systemMessage = system
      option.turnContext = builtRequest.turnContext
      option.paimon_globalInnerOs = Config.paimon_globalInnerOs
      if (conversation) {
        if (!conversation.conversationId) {
          conversation.conversationId = uuid()
        }
        option = Object.assign(option, conversation)
      }
      // Chat Completions 的图片走 messageContent（buildOpenAIContent），option 上没有 medias 字段

      /** 定义OpenAI格式请求 */
      const sendOpenAIWithContextFallback = async (messageContent, sendOption) => {
        const retryLengths = !opt.allowFallback && opt.settings.enableGroupContext
          ? getRetryGroupContextLengths(Config.groupContextLength)
          : []

        for (let i = 0; i <= retryLengths.length; i++) {
          try {
            // logger.mark(`messageContent:\n` + JSON.stringify(messageContent, null, 2))
            // logger.mark(`sendOption:\n` + JSON.stringify(sendOption, null, 2))
            // 第 0 次走缓存；压缩重试后的 system 是本次特意重建的，必须绕过缓存
            sendOption.systemMessage = resolveTurnSystem(opt.prepared, sendOption.systemMessage, quotedFailed, { useCache: i === 0 })
            return await this.chatGPTApi.sendMessage(messageContent, sendOption)
          } catch (err) {
            const isContextExceeded = err.message?.indexOf('context_length_exceeded') > 0
            if (!isContextExceeded || i >= retryLengths.length) {
              throw err
            }
            const nextGroupContextLength = retryLengths[i]
            logger.warn(`[chatgpt] 上下文超限，压缩群聊记录后重试，groupContextLength=${nextGroupContextLength}。若频繁出现，请检查锅巴中的“回复内容最大Token数(apiMaxToken)”与“模型总上下文Token数(maxModelTokens)”配置是否过紧。`)
            const rebuilt = await buildOpenAIRequest(nextGroupContextLength)
            sendOption.systemMessage = rebuilt.system
            sendOption.turnContext = rebuilt.turnContext
          }
        }
      }

      if (opt.enableSmart) {
        let isAdmin = ['admin', 'owner'].includes(e.sender.role)
        let sender = e.sender.user_id
        const {
          funcMap,
          promptAddition,
          systemAddition,
          systemDynamic
        } = await collectTools(e)
        if (!option.completionParams) {
          option.completionParams = {}
        }
        promptAddition && (prompt += promptAddition)
        systemAddition && (option.systemMessage += systemAddition)
        extraSystemDynamic = systemDynamic || ''
        option.completionParams.tools = Object.keys(funcMap).map(k => ({
          type: "function",
          function: funcMap[k].function
        }))
        extraSystemMessage = systemAddition || ''
        const rebuiltForTools = await buildOpenAIRequest()
        option.systemMessage = rebuiltForTools.system
        option.turnContext = rebuiltForTools.turnContext

        let msg
        /** 工具轮思考（含被重归类的独白），跨轮累积后并入最终 thinking_text */
        let toolRoundThinking = ''
        try {
          // 强制调用工具 // 可能有用吧
          if (Config.enableForceToolKeywords !== false && Config.geminiForceToolKeywords && Array.isArray(Config.geminiForceToolKeywords)) {
            let inputText = prompt || e.msg || "";
            if (Config.geminiForceToolKeywords.some(keyword => inputText.includes(keyword))) {
              // "required" 是 OpenAI 官方参数，意为强制模型必须调用 tools 里的至少一个工具
              option.completionParams.tool_choice = "required";
            }
          }

          // 有引用图时重组为多模态数组；无图保持纯字符串
          let messageContent = quotedMedias.length
            ? buildOpenAIContent(prompt || '请描述这张图片', quotedMedias)
            : prompt;

          msg = await sendOpenAIWithContextFallback(messageContent, option)

          // 本轮用户消息的 id 只在这里可靠：进入工具轮后 msg.parentMessageId 已经是 tool 消息。
          // 只在本轮真的带了引用图时才记录，普通路径不带这个字段。
          const userTurnId = quotedMedias.length ? msg.parentMessageId : undefined

          if (Config.debug) // 避免控制台刷屏
            logger.info(JSON.stringify(msg, null, 2))

          /** 工具调用轮次计数器 */
          let toolRoundCount = 0
          /** 工具调用最大轮次数 */
          const maxToolRounds = Config.llm_maxToolRounds
          // 只要模型返回了需要调用工具，且没有超过最大轮次，就继续循环
          while ((msg.functionCall || (msg.toolCalls && msg.toolCalls.length > 0)) && toolRoundCount < maxToolRounds) {
            opt.onToolStart()
            toolRoundCount++

            if (msg.text) {
              // 工具轮附带文本：归一化后以合并转发立即单独外发，不再裸发群消息
              const normalized = normalizeModelText(msg.text.replace(/\n{2,}/g, '\n').trim(), {
                toolNames: msg.toolCalls?.length
                  ? msg.toolCalls.map(toolCall => toolCall.function?.name)
                  : (msg.functionCall?.name ? [msg.functionCall.name] : []),
                inToolRound: true
              })
              if (normalized.thinking) {
                toolRoundThinking += normalized.thinking
              }
              if (normalized.text) {
                await sendToolRoundTextForwardMsg(e, [{
                  text: normalized.text,
                  provider: 'OpenAI API',
                  round: toolRoundCount
                }])
              }
            }

            const pendingToolCalls = msg.toolCalls?.length
              ? msg.toolCalls
              : (msg.functionCall
                ? [{
                  id: `legacy_${crypto.randomUUID()}`,
                  type: 'function',
                  function: msg.functionCall
                }]
                : [])

            if (pendingToolCalls.length === 0) {
              break
            }

            const toolMessages = [{
              id: msg.id,
              role: 'assistant',
              text: msg.text || '',
              originalContent: msg.originalContent ?? (msg.text || null),
              parentMessageId: msg.parentMessageId,
              conversationId: msg.conversationId,
              functionCall: msg.functionCall,
              toolCalls: pendingToolCalls
            }]
            let previousMessageId = msg.id
            const toolForwardRecords = []

            for (const toolCall of pendingToolCalls) {
              let name = toolCall.function.name
              let args
              try {
                args = JSON.parse(toolCall.function.arguments)
              } catch (e) {
                args = {}
              }

              // 控制台日志保持明文（docs/adr/0002-tool-log-channel-and-redaction.md）；redactArgsForLog 仅用于会发送到会话的合并转发
              logger.info(`[Chatgpt][API][工具调用][${name}]: ${JSON.stringify(args)}`)
              const toolArgsForForward = redactArgsForLog(name, args)

              let functionResult = ''
              try {
                const entry = funcMap[name.trim()]
                if (entry) {
                  let execArgs
                  if (entry.tool?.isMcpTool) {
                    execArgs = Object.assign({}, args)
                  } else {
                    if (!args.groupId) {
                      args.groupId = e.group_id + '' || e.sender.user_id + ''
                    }
                    try {
                      parseInt(args.groupId)
                    } catch (err) {
                      args.groupId = e.group_id + '' || e.sender.user_id + ''
                    }
                    execArgs = mergeTrustedToolArgs(args, {
                      isAdmin,
                      sender
                    })
                  }
                  functionResult = await entry.exec.bind(this)(execArgs, e)
                  logger.info(`[Chatgpt][API][工具返回][${name}]: ${JSON.stringify(functionResult)}`)
                } else {
                  functionResult = `Function ${name} not found.`
                  logger.warn(functionResult)
                }
              } catch (err) {
                functionResult = `Error executing function ${name}: ${err.message}`
                logger.error(functionResult)
              }

              toolForwardRecords.push({
                platform: 'OpenAI API',
                round: toolRoundCount,
                name,
                args: toolArgsForForward,
                result: functionResult
              })

              const toolMessageId = crypto.randomUUID()
              toolMessages.push({
                id: toolMessageId,
                role: 'tool',
                text: String(functionResult),
                originalContent: String(functionResult),
                parentMessageId: previousMessageId,
                conversationId: msg.conversationId,
                toolCallId: toolCall.id
              })
              previousMessageId = toolMessageId
            }

            sendToolCallForwardMsg(e, toolForwardRecords, 'OpenAI API工具调用与返回')

            option.parentMessageId = msg.id
            option.appendMessages = toolMessages
            if (userTurnId) {
              // 库里的用户消息已被 _stripImages 换成媒体占位；这里把「本轮原始内容」显式交给
              // 客户端，让工具轮请求仍能带上原图（只作用于请求，不改变存储内容）
              option.turnContent = { id: userTurnId, content: messageContent }
            }

            // 拿到工具结果后重置 tool_choice 参数，允许大模型输出自然语言回答，防止死循环无限调用工具
            if (option.completionParams && option.completionParams.tool_choice === "required") {
              delete option.completionParams.tool_choice
            }

            // 不然普通用户可能会被openai限速
            await common.sleep(300)

            // 将所有并行工具的结果一次性POST回给API，进入下一轮
            msg = await sendOpenAIWithContextFallback(null, option)

            if (Config.debug)
              logger.info(JSON.stringify(msg, null, 2))
          }

          // 判断退出原因，如果是达到最大轮次强制退出的，打印警告
          if ((msg.functionCall || (msg.toolCalls && msg.toolCalls.length > 0)) && toolRoundCount >= maxToolRounds) {
            logger.warn(`工具调用已达最大轮次上限 ${maxToolRounds} 轮，强制终止工具循环`)
            // 清除残留的 tool_calls，防止返回含 tool_calls 但无对应 tool response 的消息破坏对话历史
            msg.functionCall = undefined
            msg.toolCalls = undefined
            // 同步更新 Redis 中已存储的消息副本，防止下一轮加载历史时仍携带 tool_calls
            upsertMessage(msg).catch(err => logger.warn('[chatgpt] 清理存储中的工具调用记录失败', err))
          }
        } catch (err) {
          if (!opt.allowFallback && err.message?.indexOf('context_length_exceeded') > 0) {
            logger.warn(err)
            await redis.del(`CHATGPT:CONVERSATIONS:${e.sender.user_id}`)
            await redis.del(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`)
            await this.reply('字数超限啦，将为您自动结束本次对话。')
            return null
          } else {
            logger.error(err)
            throw err
          }
        }
        if (toolRoundThinking) {
          msg.thinking_text = toolRoundThinking + (msg.thinking_text || '')
        }
        return msg
      } else {
        let msg
        try {
          let messageContent = quotedMedias.length
            ? buildOpenAIContent(prompt || '请描述这张图片', quotedMedias)
            : prompt;
          msg = await sendOpenAIWithContextFallback(messageContent, option)
        } catch (err) {
          if (!opt.allowFallback && err.message?.indexOf('context_length_exceeded') > 0) {
            logger.warn(err)
            await redis.del(`CHATGPT:CONVERSATIONS:${e.sender.user_id}`)
            await redis.del(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`)
            await this.reply('字数超限啦，将为您自动结束本次对话。')
            return null
          } else {
            logger.error(err)
            throw err
          }
        }
        return msg
      }
    }
  }
}

/** 执行 Responses API 请求的本地工具，并转换成 function_call_output items。 */
async function executeResponsesToolCalls(core, e, toolCalls, funcMap, isAdmin, sender, round) {
  const toolForwardRecords = []
  const toolResults = []

  for (const toolCall of toolCalls) {
    const name = toolCall.function?.name || ''
    let args
    try {
      args = JSON.parse(toolCall.function?.arguments || '{}')
    } catch {
      args = {}
    }

    logger.info(`[Chatgpt][Responses][工具调用][${name}]: ${JSON.stringify(args)}`)
    const toolArgsForForward = redactArgsForLog(name, args)
    let functionResult = ''
    try {
      const entry = funcMap[name.trim()]
      if (entry) {
        let execArgs
        if (entry.tool?.isMcpTool) {
          execArgs = Object.assign({}, args)
        } else {
          if (!args.groupId) args.groupId = e.group_id + '' || e.sender.user_id + ''
          try {
            parseInt(args.groupId)
          } catch {
            args.groupId = e.group_id + '' || e.sender.user_id + ''
          }
          execArgs = mergeTrustedToolArgs(args, { isAdmin, sender })
        }
        functionResult = await entry.exec.bind(core)(execArgs, e)
        logger.info(`[Chatgpt][Responses][工具返回][${name}]: ${JSON.stringify(functionResult)}`)
      } else {
        functionResult = `Function ${name} not found.`
        logger.warn(functionResult)
      }
    } catch (err) {
      functionResult = `Error executing function ${name}: ${err.message}`
      logger.error(functionResult)
    }

    toolForwardRecords.push({
      platform: 'OpenAI Responses API',
      round,
      name,
      args: toolArgsForForward,
      result: functionResult
    })
    toolResults.push({
      type: 'function_call_output',
      call_id: toolCall.callId || toolCall.id,
      output: String(functionResult)
    })
  }

  sendToolCallForwardMsg(e, toolForwardRecords, 'OpenAI Responses API工具调用与返回')
  return toolResults
}

/**
 * 收集tools
 * @param e
 * @return {Promise<{systemAddition, funcMap: {}, promptAddition: string}>}
 */
async function collectTools(e) {
  /** 搜索/网络来源 总工具 */
  const serpToolMap = {
    'geminiSearchTool': GeminiSearchTool,
    'tavily_search': TavilyTool,
    'misaka_WebSearchTool': Misaka_WebSearchTool,
    'ikechan8370': SerpIkechan8370Tool, // 该工具使用的 url 不再提供服务
    'azure': azureSerpTool,
    'local_WebsiteTool': WebsiteTool,
    'tavily_WebsiteTool': TavilyExtractTool,
    'Weather_Tool': WeatherTool,
    'Send163_MusicTool': SendNetEaseMusicTool,
    'SendQQ_MusicTool': SendQQMusicTool,
    'BaiduAI_SearchTool': BaiduAISearchTool,
    'opencode_WebSearchTool': OpenCodeWebSearchTool,
    'exa_WebFetchTool': ExaWebFetchTool,
    'parallel_WebFetchTool': ParallelWebFetchTool,
    'GithubAPI': GithubAPITool,
  }
  /** 搜索/网络来源 */
  let serpTools = Object.entries(serpToolMap)
    .filter(([key]) => Config.serpSourceArr.includes(key))
    .map(([_, ToolClass]) => new ToolClass());

  /** 默认工具 */
  const defaultToolMap = {
    'SendPicture': SendPictureTool,
    'SendVideo': SendVideoTool,
    'QueryUserinfo': QueryUserinfoTool,
    'BlockUser': BlockUserTool,
  }
  let defaultTools = Object.entries(defaultToolMap)
    .filter(([key]) => Config.toolDefaultArr.includes(key))
    .map(([_, ToolClass]) => new ToolClass());

  /** 游戏查询工具 */
  const gameQueryToolMap = {
    'QueryStarRail': QueryStarRailTool,
    'QueryGenshin': QueryGenshinTool,
  }
  let gameQueryTools = Object.entries(gameQueryToolMap)
    .filter(([key]) => Config.toolGameQueryArr.includes(key))
    .map(([_, ToolClass]) => new ToolClass());

  /** 群管理工具 */
  const groupAdminToolMap = {
    'EditCard': EditCardTool,
    'Jinyan': JinyanTool,
    'KickOut': KickOutTool,
    'SetTitle': SetTitleTool,
    'HandleMsg': HandleMessageMsgTool,
    // 'GroupTodo': GroupTodoTool, // 群待办暂停注册：协议端（如 NapCat）暂未实现 get_group_todo_list，读取不可用；等支持后恢复注册，见 .scratch/group-notice-todo/napcat-group-todo.md
  }

  /** 图片/视频搜索工具（由搜索/网络来源配置控制） */
  const serpExtraToolMap = {
    'SerpImageTool_Baidu': SerpImageTool_by_baidu,
    'SerpImageTool_Bing': SerpImageTool_by_bing,
    'Bilibili_SearchVideoTool': BilibiliSearchVideoTool,
  }
  let serpExtraTools = Object.entries(serpExtraToolMap)
    .filter(([key]) => Config.serpSourceArr.includes(key))
    .map(([_, ToolClass]) => new ToolClass());

  /**
   * 本轮真正可用的工具集：按上下文（群聊/私聊、Bot 是否为群管）与配置过滤后组装。
   * 它既是广告给模型的 schema 来源，也是唯一的执行查找表——模型点名不在其中的工具时，
   * 四个 provider 分支都拒绝执行、不会进入工具内部（错误措辞各异：OpenAI 两分支与 Claude 回
   * `Function <name> not found.`，Gemini 回 `Function <name> doesn't exist`）。
   */
  let /** @type{AbstractTool[]} **/ tools = [
    new APTool(),
    ...defaultTools,
    ...gameQueryTools,
    ...serpExtraTools,
    ...serpTools,
  ]

  /** 可选工具 */
  const optionalTools = [
    { condition: !Config.disable_sendMessage_tool, ToolClass: SendMessageToSpecificGroupOrUserTool },
    { condition: !Config.disable_SendAvatarTool, ToolClass: SendAvatarTool },
    // 绘图工具与「仅主人可用」开关都在注册层拦一道：关掉开关时模型根本看不到这个工具
    { condition: Config.imageDrawEnable && (!Config.imageDrawOnlyMaster || e.isMaster), ToolClass: DrawImageTool },
    { condition: Config.switch_atOtherUserTool, ToolClass: AtOtherUserTool },
    { condition: Config.poke_userIDs, ToolClass: SendGroupPokeTool },
    { condition: Config.agent_MarkmapToolSwitch, ToolClass: GenerateMarkmapTool },
    { condition: Config.agent_SandboxSwitch, ToolClass: SandboxJSTool },
    { condition: Config.agent_LocalSandboxSwitch && (!Config.localSandboxMasterOnly || e.isMaster), ToolClass: LocalSandboxTool },
    { condition: Config.agent_RemoteSandboxSwitch && (!Config.remoteSandboxMasterOnly || e.isMaster), ToolClass: RemoteSandboxTool },
    { condition: Config.agent_VercelSandboxSwitch && (!Config.vercelSandboxMasterOnly || e.isMaster), ToolClass: VercelSandboxTool },
    { condition: Config.getPixivTool, ToolClass: GetPixivApiLoliconTool },
    { condition: Config.switch_EmojiTool, ToolClass: EmojiTool },
    { condition: Config.enableMemory, ToolClass: MemoryTool },
    { condition: Config.enableMemory, ToolClass: UserProfileTool },
    { condition: Config.enableEmojiLikeTool, ToolClass: EmojiLikeTool },
    { condition: Config.mediaRecognitionGeminiTool, ToolClass: RecognitionResultsByGeminiTool },
    { condition: Config.viewForwardMsgTool, ToolClass: ViewForwardMsgTool },
    { condition: Config.ScheduleTask_Tool, ToolClass: ScheduleTaskTool },
    { condition: Config.TTSAudio_Tool, ToolClass: TTSAudioTool },
    /** 群公告是群内公开的只读信息：工具清单必须与场景无关，否则私聊↔群聊的缓存前缀
     *  从 tools 处就分叉（tools 排在 system 之前）。私聊调用由 resolveGroupToolContext
     *  返回「该工具只能在群聊中使用」，不会崩。 */
    { condition: Config.toolGroupAdminArr.includes('GroupNotice'), ToolClass: GetGroupNoticeTool },
    { condition: Config.generateMathRender_ToolSwitch, ToolClass: GenerateMathRenderTool },
    { condition: Config.generateHtml_ToolSwitch, ToolClass: GenerateHtmlTool },
    { condition: Config.generateGraphCalculator_ToolSwitch, ToolClass: GenerateGraphCalculatorTool },
    { condition: Config.anythingllm_enable, ToolClass: AnythingLLMQueryTool },
    { condition: Config.anythingllm_enable, ToolClass: AnythingLLMWorkspaceTool },
    /**
     * 指令地图：查询由地图开关控制，代执行是叠在它上面的第二道闸。
     * 没有地图时查询只回一句「还没拉取」，有地图时是唯一准确写法的来源；不联网、不执行。
     * 关掉地图开关就连查询一起收起来——半开着只会让模型拿到一份不再更新的清单。
     */
    { condition: syncEnabled(Config), ToolClass: CommandLookupTool },
    /**
     * 代执行：默认关，主人显式打开才给。`__commandMapNested` 是代执行派发出去的事件打上的标记，
     * 带着它的回合不再注册本工具——否则「让 AI 执行一条会唤起 AI 的指令」会自己套自己。
     */
    { condition: syncEnabled(Config) && delegateEnabled(Config) && !e?.__commandMapNested, ToolClass: CommandRunTool },
  ];

  optionalTools.forEach(({ condition, ToolClass }) => {
    if (condition) {
      tools.push(new ToolClass())
    }
  });


  if (Config.enableDefaultMessageTriggerTool) {
    const defaultMessageTool = new DefaultMessageTriggerTool(e)
    if (defaultMessageTool.allowedKeywords.size > 0) {
      tools.push(defaultMessageTool)
    }
  }

  // 加载已启用的通用 MCP 工具
  if (Config.enableMcp) {
    try {
      const mcpTools = McpManager.getTools()
      mcpTools.forEach(mcpTool => {
        tools.push(mcpTool)
      })
    } catch (err) {
      logger.error(`[Chatgpt][mcp] 加载 MCP 工具到对话失败: ${err.message}`)
    }
  }

  let systemAddition = '' // 稳定段：插件清单，同一份地图下内容不变
  let systemDynamic = '' // 动态段：每条消息都变的 message_id，只能排在稳定段之后
  if (e.isGroup) {
    let botInfo = await e.bot?.pickMember?.(e.group_id, getUin(e)) || await e.bot?.getGroupMemberInfo?.(e.group_id, getUin(e))
    if (['admin', 'owner'].includes(botInfo.role)) {
      /** 当Bot是管理员才给这些工具（不用担心误伤，普通群成员只能对自己禁言>_<） */
      const allowedAdminKeys = ['EditCard', 'Jinyan', 'SetTitle']
      /** 当Bot是管理员+当用户是管理员才给这些工具 */
      const masterOnlyKeys = ['KickOut', 'HandleMsg'] // 'GroupTodo'（群待办）暂停注册期间一并移除，恢复时加回
      Object.entries(groupAdminToolMap)
        .filter(([key]) => Config.toolGroupAdminArr.includes(key))
        .filter(([key]) => {
          if (masterOnlyKeys.includes(key)) {
            return e.isMaster || ['admin', 'owner'].includes(e.sender.role)
          }
          return allowedAdminKeys.includes(key)
        })
        .forEach(([_, ToolClass]) => tools.push(new ToolClass()))
      // 用于撤回和加精的id
      if (e.source?.seq) {
        let source = (await e.group.getChatHistory(e.source?.seq, 1)).pop()
        systemDynamic += `\nthe last message is replying to ${source.message_id}"\n`
      } else {
        systemDynamic += `\nthe last message id is ${e.message_id}. `
      }
    }
  }

  let promptAddition = ''
  // let img = await parseSourceImg(e)
  if (e.img?.length > 0) {
    // tools.push(new ImageCaptionTool())
    // tools.push(new ProcessPictureTool())

    // 检查 e.img 的大小，如果太大可能是 base64 那么就不附加上了
    const isImgUrlValid = Array.isArray(e?.img) && !e.img.some(item => typeof item === 'string' && item.length > 1000);
    if (isImgUrlValid) {
      promptAddition += `\nthe url of the picture(s) above: ${e.img.join(', ')}`;
    }
  }

  /**
   * 本机插件清单进系统提示词，只到「插件 + 一句话 + 条数」这一级——固定成本跟插件数量走，
   * 不跟指令总数走。没有地图时 addon 是空串，静默降级，不是错误；此时也不必去读状态文件。
   */
  if (syncEnabled(Config)) {
    const { entries } = loadEntries()
    if (entries.length) {
      systemAddition += buildPromptAddon({
        entries,
        // 嵌套回合没注册代执行工具，提示词就不能叫模型去用它
        delegated: delegateEnabled(Config) && !e?.__commandMapNested,
        missing: readMapState().missing
      })
    }
  }

  const buildFuncMap = (toolArray) => {
    return Object.fromEntries(
      toolArray.map(tool => [
        tool.name,
        { exec: tool.func, function: tool.function(), tool }
      ])
    )
  }

  return {
    funcMap: buildFuncMap(tools),
    systemAddition,
    systemDynamic,
    promptAddition
  }
}

/** 呆毛版 在 prompt 中替换文本使用 e.sender 信息 */
function replacePromptForSenderMsg(e, systemMsg = "") {
  const getCurrentDate = () => {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  const getCurrentTime = () => {
    const date = new Date();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  };
  systemMsg = systemMsg.replace(/_sender_name_/igm, e.sender.card || e.sender.nickname)
  systemMsg = systemMsg.replace(/_sender_id_/igm, e.sender.user_id)
  systemMsg = systemMsg.replace(/_sender_gender_/igm, e.sender.sex)
  systemMsg = systemMsg.replace(/_sender_age_/igm, e.sender.age)
  systemMsg = systemMsg.replace(/_sender_area_/igm, e.sender.area)
  systemMsg = systemMsg.replace(/_sender_role_/igm, `${e.sender.role == "owner" ? '群主' : `${e.sender.role == "admin" ? '管理员' : ''}`}`)
  systemMsg = systemMsg.replace(/_sender_title_/igm, e.sender.title)
  systemMsg = systemMsg.replace(/_date_/igm, getCurrentDate())
  systemMsg = systemMsg.replace(/_time_/igm, getCurrentTime())
  systemMsg = systemMsg.replace(/_sender_groupid_/igm, e.group_id || e.sender.user_id)
  return systemMsg;
}

export default new Core()
