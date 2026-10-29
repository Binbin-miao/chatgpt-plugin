import { listLocalMapKeys, readLocalMap } from './mapStore.js'

/**
 * 把本地留存的地图拍平成召回用的条目。
 *
 * 一条指令一条记录：`aliases` 不再展开成独立条目，所以召回不会再出现
 * 「同一指令的三个写法占满候选」。
 *
 * 字段名对外仍用召回侧的老名字（keys / description / args / ex）：
 * 打分与展示的代码因此一行不用改，改的只是数据从哪来。
 *
 * @returns {{ entries: object[], stats: { plugins: number, total: number } }}
 */
export function loadMapIndex () {
  const entries = []
  let plugins = 0

  for (const key of listLocalMapKeys()) {
    const map = readLocalMap(key)
    if (!map) continue

    const list = Array.isArray(map.instructions) ? map.instructions : []
    if (!list.length) continue

    plugins += 1
    const pluginName = firstText(map.plugin?.display, map.plugin?.key, key)
    for (const instruction of list) {
      const entry = toEntry(key, pluginName, instruction)
      if (entry) entries.push(entry)
    }
  }

  return { entries, stats: { plugins, total: entries.length } }
}

/**
 * @param {string} pluginKey
 * @param {string} pluginName
 * @param {object} instruction
 * @returns {object | null} 没有写法的条目没有检索价值，直接跳过
 */
function toEntry (pluginKey, pluginName, instruction) {
  const command = firstText(instruction?.command, '')

  const keywords = [
    command.replace(/^#/, ''),
    ...toStrings(instruction.keywords),
    ...toStrings(instruction.aliases)
  ].filter(Boolean)

  // 没有确定写法但有关键词或描述的条目照样收：它是「任意含某词的消息都会触发」那类能力，
  // 丢掉会让 AI 断言「没这个功能」
  if (!command && !keywords.length && !firstText(instruction?.summary, '')) return null

  return {
    plugin: pluginName,
    pluginKey,
    command,
    keys: [...new Set(keywords)],
    description: firstText(instruction.summary, instruction.title, ''),
    risk: firstText(instruction.risk, ''),
    permission: firstText(instruction.permission, ''),
    args: paramsToArgs(instruction.params),
    ex: firstText(instruction.example, ''),
    preconditions: toStrings(instruction.preconditions),
    pitfalls: toStrings(instruction.pitfalls),
    longForm: firstText(instruction.longForm, '')
  }
}

/** 展示层要的是 `{ 参数名: 说明 }`；地图里是数组，这里做一次形状转换 */
function paramsToArgs (params) {
  if (!Array.isArray(params)) return {}
  const args = {}
  for (const item of params) {
    const name = firstText(item?.name, '')
    if (!name) continue
    const desc = firstText(item?.desc, '')
    args[name] = item?.required ? `${desc}（必填）` : desc
  }
  return args
}

function toStrings (value) {
  if (!Array.isArray(value)) return []
  return value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
}

function firstText (...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}
