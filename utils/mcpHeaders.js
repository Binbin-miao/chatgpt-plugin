/**
 * MCP http/sse 条目的 headers → 传输构造第二参数（requestInit）
 *
 * Bot 主人在 mcpServers 的 http/sse 条目里配置 headers 键值对（如
 * Authorization: Bearer <token>）后，插件把它透传进 @modelcontextprotocol/sdk
 * 传输构造的 requestInit。值支持 `${ENV_VAR}` 插值（复用 envInterpolate）：
 * 密钥以环境变量引用，不落 config.json——这是可选能力，明文直填同样有效。
 *
 * 独立成模块的原因：utils/mcp.js 顶层 import SDK 与 Config（宿主依赖链），
 * 无法在无宿主环境单测；本模块纯逻辑（先例 utils/envInterpolate.js）。
 *
 * 依据 docs/adr/0016-context-injection-hooks.md、.scratch/generic-hooks/spec.md
 * 票 ②（不做 OAuth、不做 bearer 专用键，headers 里自己放 Authorization）。
 * 传输侧契约以 SDK 1.32.1 源码为准：StreamableHTTPClientTransport 与
 * SSEClientTransport 均接受第二参数 { requestInit }，其 headers 在全部请求
 * 路径（POST 消息、GET SSE 流、DELETE）与传输默认头合并且用户值优先。
 */

import { interpolateEnvVars } from './envInterpolate.js'

/**
 * 把条目的 headers 配置构造成传输构造第二参数
 *
 * @param {*} headers mcpServers 条目的 headers 字段（键值对，值支持 `${ENV_VAR}`）
 * @returns {{requestInit: {headers: Record<string, string>}}|undefined}
 *   配置了有效 headers 时返回 { requestInit: { headers } }（值已完成插值）；
 *   未配置 / 空配置返回 undefined——调用方保持单参构造，行为与未加此功能前完全一致
 */
export function buildMcpTransportOptions(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return undefined
  }

  const resolved = {}
  for (const [key, value] of Object.entries(headers)) {
    const name = String(key).trim()
    if (!name) continue
    resolved[name] = String(interpolateEnvVars(value ?? ''))
  }
  if (!Object.keys(resolved).length) {
    return undefined
  }
  return { requestInit: { headers: resolved } }
}
