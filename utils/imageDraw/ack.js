/**
 * 绘图回执文案：把「等多久」和「今天还能画几张」翻译成人话，
 * 再从几条口语模板里随机挑一条。
 *
 * 纯函数、零副作用（不读 Config、不打日志）：模板与随机源都可注入，方便测试，
 * 也避免回执这种小事把配置模块拖进导入链。
 */

/** 一段时长说成人话：180 → '3分钟'；200 → '3分20秒'；45 → '45秒' */
export function formatDrawSpan (seconds) {
  const total = Math.round(Number(seconds))
  if (!Number.isFinite(total) || total <= 0) return '一会儿'
  if (total < 60) return `${total}秒`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return rest ? `${minutes}分${rest}秒` : `${minutes}分钟`
}

/**
 * 等待区间：没人能保证准点，所以报一个下界 + 超时上限。
 *
 * 25 → '25秒内'（比下界还短就不必再画区间）；180 → '30秒~3分钟'。
 */
export function formatWaitWindow (seconds) {
  const total = Math.round(Number(seconds))
  if (!Number.isFinite(total) || total <= 0) return '一会儿'
  if (total <= 30) return `${total}秒内`
  return `30秒~${formatDrawSpan(total)}`
}

/**
 * 每条模板都同时带称呼与等待窗口：语气不同，信息一致，随机只是换口气。
 * 尾部留给「还剩几张」这类补充，没有补充时接得上一句完整的话。
 */
const ACK_TEMPLATES = [
  (who, window, tail) => `${who}收到啦，${window}之内交图，等我一下${tail}～`,
  (who, window, tail) => `${who}开工！${window}里给你端上来，先想想要不要加滤镜${tail}～`,
  (who, window, tail) => `${who}把笔蘸好墨了，${window}内出图，别催别催${tail}～`,
  (who, window, tail) => `${who}记下了，${window}保证送到，不用一直刷新${tail}～`,
  (who, window, tail) => `${who}这就去画，${window}就好，画完直接发给你${tail}～`,
  (who, window, tail) => `${who}领到题目了，${window}内交作业，求别打断我${tail}～`,
  (who, window, tail) => `${who}已经在画了，${window}出图，画好直接甩给你${tail}～`,
  (who, window, tail) => `${who}收到收到，${window}内给你，这期间可以去喝口水${tail}～`
]

/**
 * 剩余次数的几种口语说法。
 *
 * 回执里的数**含正在画的这张**（回执在扣额度之前发），所以说「还能画 N 张」；
 * 返图报的是扣完之后的值，那边才用「还剩」——两个数各自都真，不会被读成丢了一张。
 */
const REMAINING_PHRASES = [
  remaining => `今天还能画 ${remaining} 张`,
  remaining => `算上这张，今天还能画 ${remaining} 张`,
  remaining => `今天还能画 ${remaining} 次`
]

/** 随机源不可信（可能返回 1 或 NaN），落点夹回合法下标 */
function pickIndex (pick, length) {
  const roll = Number(pick())
  if (!Number.isFinite(roll)) return 0
  return Math.min(length - 1, Math.max(0, Math.floor(roll * length)))
}

/** 外部传进来的剩余次数只信到「非负整数或 null」为止，剩下的在边界归一 */
function normalizeRemaining (remaining) {
  if (remaining === null || remaining === undefined) return null
  const count = Math.round(Number(remaining))
  return Number.isFinite(count) ? Math.max(0, count) : null
}

/** 尾部补充：不限额度（null）什么都不说；0 说「最后一张」；其余报张数 */
function remainingTail (remaining, index) {
  if (remaining === null) return ''
  if (remaining <= 0) return '，今天是最后一张啦'
  return `，${REMAINING_PHRASES[index % REMAINING_PHRASES.length](remaining)}`
}

/**
 * 规则段：每天几张、间隔几分钟。
 *
 * 与上面那句「今天还能画 N 张」不是一回事：那句是本次还剩多少，这段是规则本身。
 * 不限额度（null 或 0）时整段不出现，主人与不限额的人不该被规则打扰。
 */
function ruleNote (dailyLimit, cooldownMinutes) {
  const limit = Math.round(Number(dailyLimit))
  if (!Number.isFinite(limit) || limit <= 0) return ''
  const minutes = Math.round(Number(cooldownMinutes))
  const gap = Number.isFinite(minutes) && minutes > 0 ? `，间隔 ${minutes} 分钟` : ''
  return `（每天 ${limit} 张${gap}）`
}

/**
 * 拼一句回执。
 *
 * @param {object} [options]
 * @param {string} [options.name] 称呼（机器人昵称）；空则用「我」
 * @param {number} [options.timeoutSeconds] 单次生成超时
 * @param {number|null} [options.remaining] 当日剩余次数快照；null 表示不限额度/主人
 * @param {number|null} [options.dailyLimit] 每日张数上限；null 或 0 表示不限，不报规则
 * @param {number|null} [options.cooldownMinutes] 出图冷却分钟数；0 表示不冷却
 * @param {() => number} [options.pick] 0~1 的随机源，注入后结果稳定可测
 * @returns {string}
 */
export function buildAckText ({ name = '', timeoutSeconds = 180, remaining = null, dailyLimit = null, cooldownMinutes = null, pick = Math.random } = {}) {
  const who = String(name || '').trim() || '我'
  const index = pickIndex(pick, ACK_TEMPLATES.length)
  const tail = remainingTail(normalizeRemaining(remaining), index)
  return ACK_TEMPLATES[index](who, formatWaitWindow(timeoutSeconds), tail) + ruleNote(dailyLimit, cooldownMinutes)
}

/** 测试与排障用的模板条数，避免文案被删到只剩一条「在画了」 */
export const ACK_TEMPLATE_COUNT = ACK_TEMPLATES.length
