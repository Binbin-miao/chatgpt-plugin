import { AbstractTool } from './AbstractTool.js'

const HOST_INJECTED_KEYS = new Set(['sender', 'isAdmin', 'groupId'])
const HOST_INJECTED_MODES = new Set(['gemini', 'claude', 'openai'])

export class McpTool extends AbstractTool {
  isMcpTool = true

  constructor(serverName, client, mcpTool) {
    super()
    this.serverName = serverName
    this.client = client
    this.name = mcpTool.name
    this.description = mcpTool.description
    this.parameters = mcpTool.inputSchema || { type: 'object', properties: {}, required: [] }
    // 远端是否真的声明了 inputSchema：未声明时业务字段面不可知，清洗退化为「仅剥离
    // 宿主注入键」；若沿用默认空 properties 命中严格白名单，会把模型的全部参数静默
    // 清空（2026-11-06 两轴评审发现，此前未声明的行为）。
    this.hasRemoteSchema = Boolean(mcpTool.inputSchema)
  }

  /**
   * 按远端 MCP 工具声明的 inputSchema 清洗入参，剥离插件内部为云崽群管工具注入的
   * sender / isAdmin / groupId / mode('gemini'|'claude') 等宿主上下文字段，
   * 避免触发远端 MCP 服务端（如开启 extra="forbid" 的严格 schema）的参数校验错误。
   * 远端未声明 inputSchema 时无从判断字段面，回退为仅剥离宿主注入键（不按空
   * properties 严格清空）。已知接受的边角：远端 schema 显式声明 sender/isAdmin 等
   * 同名业务字段时宿主值会按业务字段透传（裁定记录于 .scratch/mcp-tool-arg-sanitize/）。
   */
  sanitizeArgs(rawArgs) {
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return {}
    }
    const props = this.parameters?.properties
    const hasPlainProps = Boolean(props && typeof props === 'object' && !Array.isArray(props))
    const strictProps =
      this.hasRemoteSchema &&
      this.parameters?.type === 'object' &&
      hasPlainProps &&
      this.parameters?.additionalProperties !== true

    const clean = {}
    for (const [key, val] of Object.entries(rawArgs)) {
      if (val === undefined) continue
      if (strictProps) {
        if (!Object.hasOwn(props, key)) continue
      } else if (HOST_INJECTED_KEYS.has(key) && !(hasPlainProps && Object.hasOwn(props, key))) {
        continue
      }
      if (key === 'mode' && HOST_INJECTED_MODES.has(val)) {
        const allowed = hasPlainProps ? props.mode?.enum : undefined
        if (!Array.isArray(allowed) || !allowed.includes(val)) continue
      }
      clean[key] = val
    }
    return clean
  }

  func = async (args) => {
    try {
      const cleanArgs = this.sanitizeArgs(args)
      logger.info(`[Chatgpt][mcp][${this.serverName}] 正在调用工具 ${this.name}，参数: ${JSON.stringify(cleanArgs)}`)
      const response = await this.client.callTool({
        name: this.name,
        arguments: cleanArgs
      })
      if (response && response.content) {
        // 合并文本类型的内容返回
        return response.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n')
      }
      return JSON.stringify(response)
    } catch (err) {
      logger.error(`[Chatgpt][mcp][${this.serverName}] 工具 ${this.name} 调用失败: ${err.message}`)
      return `Error calling MCP tool ${this.name}: ${err.message}`
    }
  }
}
