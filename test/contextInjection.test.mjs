/**
 * 上下文注入（context injection）helper 单测
 *
 * 覆盖 utils/contextInjection.js 的 withContextInjection：
 *  1. 总开关关闭：不发请求，system 原样返回
 *  2. 条目解析：JSON 失败 error 降级为空、裸数组/包装形态、server 引用与
 *     url 优先、headers ${ENV} 插值、enabled:false 跳过
 *  3. 单条目拉取：双协议（additionalContext / 纯文本）、截断后缀、超时、
 *     401、网络错误、空结果（turn 静默 / session info 一行）、JSON 缺
 *     additionalContext 字段 warn 一行
 *  4. 多条目：按配置顺序双换行拼接、单条失败隔离
 *  5. session 触发：仅 isNewConversation 为真时拉取
 *  6. memoization：同一 prepared（主备/重建路径）只拉取一次，失败也记忆
 *
 * 先例：test/surfaceInjection.test.mjs（其被测对象已由本机制泛化取代）。
 * 运行：node --test test/contextInjection.test.mjs
 */
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.logger) {
  globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {}, trace() {}, log() {} }
}

const { withContextInjection } = await import('../utils/contextInjection.js')
const { stringifyHookServersFromGuoba } = await import('../utils/hookServersGuoba.js')

const realFetch = globalThis.fetch
const realWarn = logger.warn
const realError = logger.error
const realInfo = logger.info

let calls = []
let warnLines = []
let errorLines = []
let infoLines = []

function stubFetch(handler) {
  calls = []
  globalThis.fetch = async (url, options) => {
    const call = { url: String(url), options }
    calls.push(call)
    return handler(call)
  }
}

function okResponse(text) {
  return { ok: true, status: 200, text: async () => text }
}

afterEach(() => {
  globalThis.fetch = realFetch
  logger.warn = realWarn
  logger.error = realError
  logger.info = realInfo
  calls = []
  warnLines = []
  errorLines = []
  infoLines = []
})

function watchWarn() {
  logger.warn = (...args) => { warnLines.push(args.join(' ')) }
}

function watchInfo() {
  logger.info = (...args) => { infoLines.push(args.join(' ')) }
}

function watchError() {
  logger.error = (...args) => { errorLines.push(args.join(' ')) }
}

function watchBoth() {
  watchWarn()
  watchError()
}

/** 构造配置：hookServers 条目列表 + 可选 mcpServers（供 server 引用解析） */
function hookConfig(entries, mcpServers = {}) {
  return {
    enableHooks: true,
    hookServers: JSON.stringify({ hookServers: entries }),
    mcpServers: JSON.stringify({ mcpServers: mcpServers })
  }
}

const disabledConfig = { enableHooks: false, hookServers: '[]', mcpServers: '{}' }

describe('上下文注入', () => {
  describe('总开关', () => {
    test('enableHooks 关闭：不发请求，system 原样返回', async () => {
      watchBoth()
      stubFetch(() => { throw new Error('不应发起请求') })
      const prepared = {}
      const out = await withContextInjection(prepared, disabledConfig, 'base system', {})
      assert.equal(out, 'base system')
      assert.equal(calls.length, 0)
      assert.equal(warnLines.length, 0)
      assert.equal(errorLines.length, 0)
    })

    test('开关关闭时即使条目里写了 url 也不发请求', async () => {
      watchBoth()
      stubFetch(() => { throw new Error('不应发起请求') })
      const cfg = { ...disabledConfig, hookServers: JSON.stringify({ hookServers: [{ url: 'http://x.test/hook' }] }) }
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(out, 'base')
      assert.equal(calls.length, 0)
    })
  })

  describe('条目解析', () => {
    test('JSON 解析失败：error 恰好一行，整段放弃，不发请求', async () => {
      watchBoth()
      stubFetch(() => { throw new Error('不应发起请求') })
      const cfg = { enableHooks: true, hookServers: '{hookServers: [broken', mcpServers: '{}' }
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(out, 'base')
      assert.equal(calls.length, 0)
      assert.equal(errorLines.length, 1)
      assert.ok(errorLines[0].includes('hookServers'))
    })

    test('裸数组与 {hookServers:[...]} 包装形态都接受', async () => {
      stubFetch(() => okResponse('文本'))
      const bare = { enableHooks: true, hookServers: JSON.stringify([{ url: 'http://a.test/hook' }]), mcpServers: '{}' }
      const outBare = await withContextInjection({}, bare, 'base', {})
      assert.equal(calls.length, 1)
      assert.equal(outBare, 'base\n\n文本')
      const wrapped = hookConfig([{ url: 'http://b.test/hook' }])
      const outWrapped = await withContextInjection({}, wrapped, 'base', {})
      assert.equal(calls.length, 2)
      assert.equal(outWrapped, 'base\n\n文本')
    })

    test('server 引用取 mcpServers 同名条目的 url（只取配置值，不依赖连接状态）', async () => {
      stubFetch(() => okResponse('浮现文本'))
      const cfg = hookConfig(
        [{ server: 'ombre' }],
        { ombre: { url: 'http://127.0.0.1:18011/breath-hook' } }
      )
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'http://127.0.0.1:18011/breath-hook')
      assert.equal(out, 'base\n\n浮现文本')
    })

    test('url 与 server 并存时 url 优先', async () => {
      stubFetch(() => okResponse('文本'))
      const cfg = hookConfig(
        [{ url: 'http://url.test/hook', server: 'ombre' }],
        { ombre: { url: 'http://ombre.test/breath-hook' } }
      )
      await withContextInjection({}, cfg, 'base', {})
      assert.equal(calls[0].url, 'http://url.test/hook')
    })

    test('server 引用不存在的 mcpServers 条目：warn 一行并跳过，其他条目照常', async () => {
      watchBoth()
      stubFetch(() => okResponse('文本'))
      const cfg = hookConfig([
        { server: 'missing' },
        { url: 'http://a.test/hook' }
      ])
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'http://a.test/hook')
      assert.equal(out, 'base\n\n文本')
      assert.equal(warnLines.length, 1)
      assert.equal(errorLines.length, 0)
    })

    test('headers 值完成 ${ENV} 插值，未定义变量替换为空串', async () => {
      process.env.CI_CONTEXT_INJECTION_TOKEN = 'secret-env-token'
      try {
        stubFetch(() => okResponse('文本'))
        const cfg = hookConfig([{
          url: 'http://a.test/hook',
          headers: { Authorization: 'Bearer ${CI_CONTEXT_INJECTION_TOKEN}', 'X-Missing': '${CI_NOT_DEFINED_VAR}' }
        }])
        await withContextInjection({}, cfg, 'base', {})
        assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-env-token')
        assert.equal(calls[0].options.headers['X-Missing'], '')
      } finally {
        delete process.env.CI_CONTEXT_INJECTION_TOKEN
      }
    })

    test('enabled:false 条目跳过，不告警不发请求', async () => {
      watchBoth()
      stubFetch(() => okResponse('文本'))
      const cfg = hookConfig([
        { url: 'http://off.test/hook', enabled: false },
        { url: 'http://on.test/hook' }
      ])
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'http://on.test/hook')
      assert.equal(out, 'base\n\n文本')
      assert.equal(warnLines.length, 0)
      assert.equal(errorLines.length, 0)
    })
  })

  describe('单条目拉取', () => {
    test('纯文本响应按原文全文注入', async () => {
      stubFetch(() => okResponse('=== 核心准则 ===\n第一条'))
      const cfg = hookConfig([{ url: 'http://a.test/breath-hook', headers: { Authorization: 'Bearer t' } }])
      const out = await withContextInjection({}, cfg, 'base system', {})
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'http://a.test/breath-hook')
      assert.equal(calls[0].options.headers.Authorization, 'Bearer t')
      assert.equal(out, 'base system\n\n=== 核心准则 ===\n第一条')
    })

    test('hookSpecificOutput.additionalContext JSON 取其值注入', async () => {
      stubFetch(() => okResponse(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'JSON 协议内容' }
      })))
      const cfg = hookConfig([{ url: 'http://a.test/hook' }])
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(out, 'base\n\nJSON 协议内容')
    })

    test('JSON 解析失败按纯文本全文注入', async () => {
      stubFetch(() => okResponse('这不是 JSON { 没闭合'))
      const cfg = hookConfig([{ url: 'http://a.test/hook' }])
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(out, 'base\n\n这不是 JSON { 没闭合')
    })

    test('合法 JSON 但没有 additionalContext：warn 一行指明协议形状，不注入', async () => {
      watchBoth()
      stubFetch(() => okResponse(JSON.stringify({ ok: true })))
      const cfg = hookConfig([{ url: 'http://a.test/hook' }])
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(out, 'base')
      assert.equal(warnLines.length, 1)
      assert.ok(warnLines[0].includes('hookSpecificOutput'))
      assert.ok(warnLines[0].includes('http://a.test/hook'))
      assert.equal(errorLines.length, 0)
    })

    test('maxChars 硬截断并追加提示后缀', async () => {
      stubFetch(() => okResponse('x'.repeat(50)))
      const cfg = hookConfig([{ url: 'http://a.test/hook', maxChars: 10 }])
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(out, `base\n\n${'x'.repeat(10)}[output truncated - exceeded 10 characters]`)
    })

    test('未超过 maxChars 不加后缀', async () => {
      stubFetch(() => okResponse('短文本'))
      const cfg = hookConfig([{ url: 'http://a.test/hook', maxChars: 100 }])
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(out, 'base\n\n短文本')
    })

    test('超时：warn 恰好一行指明超时，system 原样返回，不抛出', async () => {
      watchWarn()
      stubFetch(() => { const err = new Error('The operation was aborted'); err.name = 'TimeoutError'; throw err })
      const cfg = hookConfig([{ url: 'http://a.test/hook', timeout: 1234 }])
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(out, 'base')
      assert.equal(warnLines.length, 1)
      assert.ok(warnLines[0].includes('超时'))
      assert.ok(warnLines[0].includes('1234'))
    })

    test('HTTP 401：warn 恰好一行并跳过条目', async () => {
      watchWarn()
      stubFetch(() => ({ ok: false, status: 401, text: async () => '' }))
      const cfg = hookConfig([{ url: 'http://a.test/hook' }])
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(out, 'base')
      assert.equal(warnLines.length, 1)
      assert.ok(warnLines[0].includes('401'))
    })

    test('网络错误：warn 恰好一行，不抛出', async () => {
      watchWarn()
      stubFetch(() => { throw new Error('connect ECONNREFUSED') })
      const cfg = hookConfig([{ url: 'http://a.test/hook' }])
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(out, 'base')
      assert.equal(warnLines.length, 1)
    })

    test('空响应：system 原样返回，零告警', async () => {
      watchBoth()
      stubFetch(() => okResponse('   \n  '))
      const cfg = hookConfig([{ url: 'http://a.test/hook' }])
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(out, 'base')
      assert.equal(warnLines.length, 0)
      assert.equal(errorLines.length, 0)
    })

    test('system 为空字符串时直接返回注入文本', async () => {
      stubFetch(() => okResponse('注入文本'))
      const cfg = hookConfig([{ url: 'http://a.test/hook' }])
      const out = await withContextInjection({}, cfg, '', {})
      assert.equal(out, '注入文本')
    })
  })

  describe('多条目', () => {
    test('按配置顺序以双换行拼接', async () => {
      stubFetch((call) => okResponse(call.url.includes('a.test') ? '甲条目' : '乙条目'))
      const cfg = hookConfig([
        { url: 'http://a.test/hook' },
        { url: 'http://b.test/hook' }
      ])
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(calls.length, 2)
      assert.equal(out, 'base\n\n甲条目\n\n乙条目')
    })

    test('单条目失败只损失自己，其他条目照常注入', async () => {
      watchWarn()
      stubFetch((call) => {
        if (call.url.includes('bad.test')) return { ok: false, status: 500, text: async () => '' }
        return okResponse(call.url.includes('a.test') ? '甲条目' : '丙条目')
      })
      const cfg = hookConfig([
        { url: 'http://a.test/hook' },
        { url: 'http://bad.test/hook' },
        { url: 'http://c.test/hook' }
      ])
      const out = await withContextInjection({}, cfg, 'base', {})
      assert.equal(calls.length, 3)
      assert.equal(out, 'base\n\n甲条目\n\n丙条目')
      assert.equal(warnLines.length, 1)
    })
  })

  describe('session 触发', () => {
    test('when:session 条目仅在 isNewConversation 为真时拉取', async () => {
      stubFetch(() => okResponse('首轮设定'))
      const cfg = hookConfig([{ url: 'http://a.test/hook', when: 'session' }])
      const first = await withContextInjection({}, cfg, 'base', { isNewConversation: true })
      assert.equal(first, 'base\n\n首轮设定')
      assert.equal(calls.length, 1)

      const second = await withContextInjection({}, cfg, 'base', { isNewConversation: false })
      assert.equal(second, 'base')
      assert.equal(calls.length, 1)

      const third = await withContextInjection({}, cfg, 'base', {})
      assert.equal(third, 'base')
      assert.equal(calls.length, 1)
    })

    test('成功注入打 info 一行（url、时机、字符数）；非首轮打跳过 info 一行', async () => {
      watchInfo()
      stubFetch(() => okResponse('首轮设定'))
      const cfg = hookConfig([{ url: 'http://a.test/hook', when: 'session' }])
      await withContextInjection({}, cfg, 'base', { isNewConversation: true })
      assert.deepEqual(infoLines, ['[ContextInjection] http://a.test/hook 已注入（session，4 字符）'])

      await withContextInjection({}, cfg, 'base', { isNewConversation: false })
      assert.equal(infoLines.length, 2, 'session 非首轮不注入，但打一行跳过日志供部署核对')
      assert.ok(infoLines[1].includes('跳过'))
      assert.ok(infoLines[1].includes('非会话首轮'))
    })

    test('session 首轮空响应：info 一行「本轮无内容」，零告警不注入', async () => {
      watchBoth()
      watchInfo()
      stubFetch(() => okResponse('   \n  '))
      const cfg = hookConfig([{ url: 'http://a.test/hook', when: 'session' }])
      const out = await withContextInjection({}, cfg, 'base', { isNewConversation: true })
      assert.equal(out, 'base')
      assert.equal(calls.length, 1)
      assert.equal(infoLines.length, 1)
      assert.ok(infoLines[0].includes('本轮无内容'))
      assert.ok(infoLines[0].includes('http://a.test/hook'))
      assert.equal(warnLines.length, 0)
      assert.equal(errorLines.length, 0)
    })

    test('when:turn 条目每轮都拉取，不受 isNewConversation 影响', async () => {
      stubFetch(() => okResponse('每轮内容'))
      const cfg = hookConfig([{ url: 'http://a.test/hook', when: 'turn' }])
      await withContextInjection({}, cfg, 'base', { isNewConversation: true })
      assert.equal(calls.length, 1)
      await withContextInjection({}, cfg, 'base', { isNewConversation: false })
      assert.equal(calls.length, 2)
    })

    test('when 未填默认 turn', async () => {
      stubFetch(() => okResponse('默认每轮'))
      const cfg = hookConfig([{ url: 'http://a.test/hook' }])
      const out = await withContextInjection({}, cfg, 'base', { isNewConversation: false })
      assert.equal(out, 'base\n\n默认每轮')
      assert.equal(calls.length, 1)
    })
  })

  describe('memoization', () => {
    test('同一 prepared 只拉取一次：主备/重建路径复用同一份，失败也记忆', async () => {
      watchWarn()
      let fail = true
      stubFetch(() => { if (fail) throw new Error('down'); return okResponse('注入文本') })
      const cfg = hookConfig([{ url: 'http://a.test/hook' }])
      const prepared = {}
      const first = await withContextInjection(prepared, cfg, 'base', {})
      assert.equal(first, 'base')
      assert.equal(calls.length, 1)
      fail = false
      const second = await withContextInjection(prepared, cfg, 'base', {})
      assert.equal(second, 'base')
      assert.equal(calls.length, 1, '失败结果也记忆在同一轮 prepared 上，不重试')

      const third = await withContextInjection(prepared, cfg, 'base', { isNewConversation: true })
      assert.equal(third, 'base')
      assert.equal(calls.length, 1, '参与条目集合在本轮开头已定，session 标志变化不再触发重拉')
    })

    test('成功结果在同一 prepared 上复用，不重复请求', async () => {
      stubFetch(() => okResponse('注入文本'))
      const cfg = hookConfig([{ url: 'http://a.test/hook' }])
      const prepared = {}
      await withContextInjection(prepared, cfg, 'base', {})
      assert.equal(calls.length, 1)
      const out = await withContextInjection(prepared, cfg, 'base', {})
      assert.equal(out, 'base\n\n注入文本')
      assert.equal(calls.length, 1)
    })
  })

  describe('锅巴 GSubForm 序列化', () => {
    test('行数组序列化为 {hookServers:[...]} JSON 字符串，保留字段与顺序', () => {
      const json = stringifyHookServersFromGuoba([
        { enabled: true, url: 'http://a.test/breath-hook', headers: 'Authorization=Bearer t1', timeout: 3000, maxChars: 10000, when: 'turn' },
        { enabled: false, server: 'ombre', headers: '', when: 'session' }
      ])
      const parsed = JSON.parse(json)
      assert.ok(Array.isArray(parsed.hookServers))
      assert.equal(parsed.hookServers.length, 2)
      assert.equal(parsed.hookServers[0].url, 'http://a.test/breath-hook')
      assert.deepEqual(parsed.hookServers[0].headers, { Authorization: 'Bearer t1' })
      assert.equal(parsed.hookServers[1].server, 'ombre')
      assert.equal(parsed.hookServers[1].enabled, false)
      assert.equal(parsed.hookServers[1].when, 'session')
    })

    test('仅默认值的空行被静默跳过，不产生条目也不报错', () => {
      const json = stringifyHookServersFromGuoba([{ enabled: true, timeout: 3000, maxChars: 10000, when: 'turn' }])
      assert.equal(JSON.parse(json).hookServers.length, 0)
    })

    test('填了 headers 但 url/server 都缺：报错（保存被拦截）', () => {
      assert.throws(() => stringifyHookServersFromGuoba([{ headers: 'Authorization=Bearer x' }]), /url|server/)
    })

    test('when 非法取值报错', () => {
      assert.throws(() => stringifyHookServersFromGuoba([{ url: 'http://a.test/hook', when: 'always' }]), /turn|session/)
    })
  })
})
