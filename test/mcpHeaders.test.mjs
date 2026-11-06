/**
 * MCP http/sse 条目 headers 构造纯函数单测
 *
 * 覆盖 utils/mcpHeaders.js 的 buildMcpTransportOptions：
 *  1. 透传：配置的 headers 键值对原样进入传输构造第二参数的 requestInit.headers
 *  2. 插值：值中的 `${ENV_VAR}` 替换为环境变量值（复用 envInterpolate）
 *  3. 未定义变量替换为空串
 *  4. 未配置 / 空配置返回 undefined：mcp.js 据此保持单参构造，行为与改动前完全一致
 *
 * 运行：node --test test/mcpHeaders.test.mjs
 */
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { buildMcpTransportOptions } from '../utils/mcpHeaders.js'

/** 生成 `${NAME}` 形状的占位文本（避免与测试文件自身的模板字符串混淆） */
const ph = name => '${' + name + '}'

/** 测试专用环境变量名，机器上不会真实存在，用完即删 */
const VAR = 'CFGP_TEST_MCP_HEADERS_VAR'

afterEach(() => {
  delete process.env[VAR]
})

describe('MCP headers 构造（透传进传输构造 requestInit）', () => {
  test('headers 键值对原样透传为 { requestInit: { headers } }，明文值不做改动', () => {
    const options = buildMcpTransportOptions({
      Authorization: 'Bearer plain-token.123',
      'X-Custom-Header': 'some=value'
    })
    assert.deepEqual(options, {
      requestInit: {
        headers: {
          Authorization: 'Bearer plain-token.123',
          'X-Custom-Header': 'some=value'
        }
      }
    })
  })

  test('值中的 `${ENV_VAR}` 替换为环境变量值，多处与明文混合均可', () => {
    process.env[VAR] = 'secret-value'
    const options = buildMcpTransportOptions({
      Authorization: `Bearer ${ph(VAR)}`,
      'X-Multi': `${ph(VAR)}:${ph(VAR)}`
    })
    assert.deepEqual(options.requestInit.headers, {
      Authorization: 'Bearer secret-value',
      'X-Multi': 'secret-value:secret-value'
    })
  })

  test('未定义变量替换为空串，不保留占位符原文', () => {
    delete process.env[VAR]
    const options = buildMcpTransportOptions({ Authorization: `Bearer ${ph(VAR)}` })
    assert.deepEqual(options.requestInit.headers, { Authorization: 'Bearer ' })
  })

  test('键做 trim，空键跳过；null 值按空串保留该键', () => {
    const options = buildMcpTransportOptions({
      '  Authorization  ': 'Bearer x',
      '': 'ignored',
      'X-Empty': null
    })
    assert.deepEqual(options.requestInit.headers, {
      Authorization: 'Bearer x',
      'X-Empty': ''
    })
  })
})

describe('MCP headers 未配置时保持现状（返回 undefined，构造保持单参）', () => {
  test('undefined / null / 空对象返回 undefined', () => {
    assert.equal(buildMcpTransportOptions(undefined), undefined)
    assert.equal(buildMcpTransportOptions(null), undefined)
    assert.equal(buildMcpTransportOptions({}), undefined)
  })

  test('非对象（字符串 / 数组）返回 undefined，不抛错', () => {
    assert.equal(buildMcpTransportOptions('Authorization=Bearer x'), undefined)
    assert.equal(buildMcpTransportOptions(['Authorization']), undefined)
  })

  test('只有空键的配置视为未配置，返回 undefined', () => {
    assert.equal(buildMcpTransportOptions({ '': 'v', '   ': 'x' }), undefined)
  })
})
