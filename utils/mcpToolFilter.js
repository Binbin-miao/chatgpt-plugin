/**
 * MCP 工具列表过滤与同名冲突检测（纯逻辑）
 *
 * 两个 MCP server 提供同名工具时，下游 funcMap（model/core.js buildFuncMap）按工具名
 * 建 map，后到者会静默覆盖先到者。utils/mcp.js 在每台 server listTools 之后依次调用
 * 本模块：先按条目 include/exclude 裁剪工具面，再对幸存者做同名检测——被裁掉的工具
 * 不参与冲突判定，裁剪正是主人绕开冲突的手段（后连接者拒载重名工具，先连接者原名
 * 不变；工具名不做整体前缀，人设与文档硬编码裸工具名——决策出处
 * .scratch/generic-hooks/spec.md 票 ③）。
 *
 * 独立成模块的原因：utils/mcp.js 顶层 import SDK 与 Config（宿主依赖链），
 * 无法在无宿主环境单测；本模块纯逻辑（先例 utils/mcpHeaders.js）。
 *
 * 依据 docs/adr/0016-context-injection-hooks.md、.scratch/generic-hooks/spec.md
 * 票 ③（include 白名单、exclude 黑名单，并存时先 include 后 exclude）。
 */

/**
 * 规则数组归一化：元素转字符串并 trim、丢弃空白项；非数组视为未配置返回 null。
 * 注意 include 为显式空数组时返回空数组（空白名单=一个都不加载），与未配置（null，
 * 不限制）语义不同；锅巴序列化侧留空即不写该键，面板用户不会碰到空白名单。
 */
function normalizeNameList(value) {
  if (!Array.isArray(value)) {
    return null
  }
  return value.map(item => `${item ?? ''}`.trim()).filter(Boolean)
}

/**
 * 按条目的 include（白名单）/ exclude（黑名单）裁剪工具列表
 *
 * @param {Array<{name: string}>} tools listTools 返回的工具数组
 * @param {string[]|undefined} include 条目的 include 字段（工具名数组，白名单）
 * @param {string[]|undefined} exclude 条目的 exclude 字段（工具名数组，黑名单）
 * @returns {Array} 过滤后的工具数组；未配置任何规则时原样返回入参（引用不变，
 *   无冲突场景行为与改动前完全一致）。工具名按远端原名精确匹配，规则项 trim。
 */
export function filterMcpToolsByListRules(tools, include, exclude) {
  const list = Array.isArray(tools) ? tools : []
  const includeNames = normalizeNameList(include)
  const excludeNames = normalizeNameList(exclude)

  let result = list
  if (includeNames) {
    const includeSet = new Set(includeNames)
    result = result.filter(t => includeSet.has(`${t?.name ?? ''}`))
  }
  if (excludeNames) {
    const excludeSet = new Set(excludeNames)
    result = result.filter(t => !excludeSet.has(`${t?.name ?? ''}`))
  }
  return result
}

/**
 * 同名冲突检测：与已加载工具重名的候选被拒绝，其余放行
 *
 * @param {Array<{name: string}>} tools 过滤后的候选工具数组
 * @param {Map<string, string>} [loadedIndex] 已加载工具的索引（工具名 → 加载它的
 *   server 名）；缺省视为空索引（首台 server 场景）
 * @returns {{loadable: Array, conflicts: Array<{name: string, existingServer: string}>}}
 *   loadable 是可加载的候选（保持远端原名与顺序）；conflicts 逐条列出被拒的工具名
 *   与先连接的 server 名，供调用方 warn。只读不写：登记新工具由调用方负责。
 */
export function pickLoadableMcpTools(tools, loadedIndex) {
  const list = Array.isArray(tools) ? tools : []
  const index = loadedIndex instanceof Map ? loadedIndex : new Map()

  const loadable = []
  const conflicts = []
  for (const t of list) {
    const owner = index.get(t?.name)
    if (owner !== undefined) {
      conflicts.push({ name: t.name, existingServer: owner })
    } else {
      loadable.push(t)
    }
  }
  return { loadable, conflicts }
}
