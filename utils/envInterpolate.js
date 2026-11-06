/**
 * `${ENV_VAR}` 环境变量插值
 *
 * 把字符串里的 `${VAR}` 占位替换为环境变量的值。供「上下文注入」条目与
 * MCP http/sse 条目的 headers 使用：密钥以环境变量引用，不落 config.json。
 * 这是可选能力——headers 里明文直填同样有效。
 *
 * 设计要点（见 docs/adr/0016-context-injection-hooks.md 与
 * .scratch/generic-hooks/spec.md）：
 * - 未定义的变量替换为空串，不报错、不保留占位符原文，
 *   避免把占位符文本当值泄漏给远端。
 * - 占位符名只认 `[A-Za-z_][A-Za-z0-9_]*`：其余 `${...}` 形状（`${}`、
 *   `${1}`、带空格）与无花括号的 `$VAR` 原样保留，不做猜测——
 *   明文值里恰好含有 `${...}` 字样（比如密码本身）时不能被误清空。
 * - 纯函数：非字符串输入原样返回，不读写任何外部状态。
 */

const ENV_PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * 把字符串中的 `${VAR}` 占位替换为环境变量的值
 *
 * @param {string} value 可能含 `${VAR}` 占位的原始值
 * @returns {string} 替换后的值；不含合法占位符或非字符串输入时原样返回
 */
export function interpolateEnvVars(value) {
  if (typeof value !== 'string') return value
  return value.replace(ENV_PLACEHOLDER_RE, (placeholder, name) => {
    const resolved = process.env[name]
    return resolved === undefined ? '' : resolved
  })
}
