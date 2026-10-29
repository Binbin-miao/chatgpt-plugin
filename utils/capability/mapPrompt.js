import { listLocalMapKeys, readLocalMap } from './mapStore.js'
import { readSyncState } from './syncState.js'

/**
 * 拼进系统提示词的那一段：硬规则 + 插件级摘要。
 *
 * 措辞是硬规则而不是软引导：软引导下模型经常跳过查询、直接编。
 * 没有可用地图时返回空串，调用方据此不加任何东西（静默降级，不是错误）。
 *
 * 摘要只到「插件 + 一句话 + 条数」这一级：单条指令的细节靠查询工具按需取，
 * 每次请求的固定成本跟着插件数量走，而不是跟着指令总数走。
 */

/** 注入给模型的硬规则。措辞沿用本机生成时代的口径，只改了入口名与数据来源说明 */
const RULES = [
  '1. 用户询问「你能干什么」「有什么功能」、询问某功能怎么用、或输入的指令疑似打错时，必须先看这份清单再回答，禁止凭记忆编造。',
  '2. 清单里只到插件类这一级。要回答具体指令，必须调用 lookupPluginCapability 工具：传插件类名可列出该类全部指令，传关键词可搜具体指令。',
  '3. 清单没列出，不等于不存在：可能属于未展开的插件类或框架内置指令。不要断言「没有这个功能」。',
  '   换关键词重查**最多一次**。如果前面已经拿到语义吻合的候选，就直接用它执行——',
  '   不要因为换了个说法查不到，就把已经找到的答案丢掉。',
  '4. 纠正用户时给出正确写法与所属插件类；拿不准就说不确定，不要现编一个像样的指令。',
  '5. 用户直接让你替他做某件事（「帮我签个到」「给我点个赞」「刷新面板」）时，**必须**调用 runPluginCommand，把用户原话放进 query 参数，一步做完。',
  '   不用先查写法——工具会自己匹配。只回复写法、或改用其它工具，都算没完成任务。',
  '   有副作用的指令工具会自动要求确认，你照它的提示做即可；执行后插件会自己把结果发到群里，你不用复述。',
  '   正确示范：用户「给我点个赞」→ runPluginCommand{query:"给我点个赞"}。',
  '   如果你已经知道写法，也可以用 command，但它只能是指令本身（#点赞）：不要拼 QQ 号、参数或被 @ 的人，目标由插件自己从 @ 里取。',
  '   错误示范（一律禁止）：回一句「你可以发送 #点赞」；或改用 emojiLike 给消息贴表情充数。',
  '6. 主人 @ 了某个人再让你做事（「@张三 签到」）时，工具会自动以那个人的身份执行，你直接把指令交给 runPluginCommand，不要追问「要操作谁」。',
  '7. 工具返回插件报错时，用一句大白话说清「为什么不能用」，不要贴堆栈、路径、代码或原始英文报错；转述前把路径、密钥、QQ 号这类信息去掉。',
  '8. 你自己的联网搜索、图片生成等能力与本地插件重叠时，**优先本地插件**：候选里有能直接满足的指令就先执行它（更快、免费、结果更贴合本群）。只有目录里确实没有、或用户明确要实时/外部信息时才用自己的工具。',
  '9. 「点赞」要分清对象，这是最容易搞错的一处：',
  '   - 给**QQ 名片 / 个人资料卡**点赞（「名片赞」「赞我」「给我点个赞」「给某人点赞」）= 插件指令（本机是 #点赞），走 runPluginCommand；',
  '   - 给**某条聊天消息**贴表情回应才是 emojiLike。用户说的是名片赞时，调 emojiLike 等于做错事。',
  '   查到吻合写法后没有执行、却拿别的工具充数，比直接说不会更糟：用户会以为办好了。'
]

/**
 * @param {{ allowRun?: boolean }} [options] allowRun 为 false 时（代执行开关关着），
 *   在第 5/6/9 条前加一句说明，免得模型去调用一个没注册的工具
 * @returns {string} 没有可用地图时返回空串
 */
export function mapPromptAddon ({ allowRun = true } = {}) {
  const lines = []
  for (const key of listLocalMapKeys()) {
    const map = readLocalMap(key)
    if (!map) continue
    lines.push(formatPluginLine(key, map))
  }
  if (!lines.length) return ''

  const missing = readSyncState().missing
  if (missing.length) {
    const preview = missing.slice(0, 10).join('、')
    lines.push(
      `- 以下插件本机已装但云端没有地图，AI 无法代执行、只能由用户自己手打：${preview}${missing.length > 10 ? ' 等' : ''}`
    )
  }

  return [
    '',
    '',
    '【本机插件能力目录】',
    '下面是本机已安装的第三方插件清单（插件名 + 一句话功能 + 指令条数）。',
    '规则（必须遵守）：',
    ...(allowRun ? [] : ['（本机未开启代执行：你只能告诉用户正确写法，不能替用户执行；下面第 5、6、9 条不适用。）']),
    ...RULES,
    '',
    lines.join('\n')
  ].join('\n')
}

function formatPluginLine (key, map) {
  const display = firstText(map.plugin?.display, map.plugin?.key, key)
  const summary = firstText(map.plugin?.summary, '')
  const count = Array.isArray(map.instructions) ? map.instructions.length : 0
  return `- 【${display}】${summary ? `${summary} ` : ''}（${count} 条）`
}

function firstText (...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}
