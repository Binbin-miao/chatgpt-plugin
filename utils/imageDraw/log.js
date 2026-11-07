/**
 * 绘图的日志出口。
 *
 * 仓库里 logger 是 Yunzai 的全局对象，纯 Node 测试环境下不存在；
 * 统一走可选链，模块才能脱离运行时被单测直接 import。
 */

const PREFIX = '[ChatGPT][绘图]'

export function logMark(message) {
  globalThis.logger?.mark?.(`${PREFIX} ${message}`)
}

export function logInfo(message) {
  globalThis.logger?.info?.(`${PREFIX} ${message}`)
}

export function logWarn(message) {
  globalThis.logger?.warn?.(`${PREFIX} ${message}`)
}

export function logError(message) {
  globalThis.logger?.error?.(`${PREFIX} ${message}`)
}
