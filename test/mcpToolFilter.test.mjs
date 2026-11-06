/**
 * MCP 工具列表过滤与同名冲突检测纯函数单测
 *
 * 覆盖 utils/mcpToolFilter.js（generic-hooks 票 ③，依据 docs/adr/0016）：
 *  1. filterMcpToolsByListRules：未配置时原样保留（无冲突场景与现状一致的前提）、
 *     include 白名单、exclude 黑名单、并存时先 include 后 exclude
 *  2. pickLoadableMcpTools：无冲突全过、同名冲突拒后到者并明确列出归属、
 *     拒载只影响自己、已加载索引只读不被改动
 *  3. McpTool.sanitizeArgs：不向远端 MCP 透传宿主注入键（sender/isAdmin/groupId/
 *     mode），按远端 inputSchema 白名单清洗且不误伤业务同名字段；远端未声明
 *     inputSchema 时回退为仅剥离注入键
 *
 * 运行：node --test test/mcpToolFilter.test.mjs
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.logger) {
  globalThis.logger = { info() {}, warn() {}, error() {}, debug() {} }
}

import { filterMcpToolsByListRules, pickLoadableMcpTools } from '../utils/mcpToolFilter.js'
import { McpTool } from '../utils/tools/McpTool.js'

/** 造一个 listTools 形状的工具条目 */
const tool = name => ({ name, description: `tool ${name}`, inputSchema: { type: 'object', properties: {} } })
const namesOf = tools => tools.map(t => t.name)

describe('include/exclude 过滤（filterMcpToolsByListRules）', () => {
  test('未配置规则（undefined / null / 非数组）时原样保留全部，元素引用不变', () => {
    const remote = [tool('memory_search'), tool('weather')]
    assert.deepEqual(filterMcpToolsByListRules(remote), remote)
    assert.deepEqual(filterMcpToolsByListRules(remote, undefined, undefined), remote)
    assert.deepEqual(filterMcpToolsByListRules(remote, null, null), remote)
    // 引用不变：未配置时不重建数组，行为与改动前完全一致
    assert.equal(filterMcpToolsByListRules(remote), remote)
    // 规则形状写错（字符串）视为未配置，不抛错
    assert.deepEqual(filterMcpToolsByListRules(remote, 'memory_search', 'weather'), remote)
  })

  test('include 白名单：只保留列出的工具，顺序保持远端顺序', () => {
    const remote = [tool('a'), tool('memory_search'), tool('b'), tool('weather')]
    const kept = filterMcpToolsByListRules(remote, ['memory_search', 'weather'], undefined)
    assert.deepEqual(namesOf(kept), ['memory_search', 'weather'])
    assert.equal(kept[0], remote[1])
    assert.equal(kept[1], remote[3])
  })

  test('exclude 黑名单：剔除列出的工具，其余保留', () => {
    const remote = [tool('a'), tool('legacy_tool'), tool('b')]
    const kept = filterMcpToolsByListRules(remote, undefined, ['legacy_tool'])
    assert.deepEqual(namesOf(kept), ['a', 'b'])
  })

  test('并存时先 include 后 exclude：白名单内的黑名单项也会被剔除', () => {
    const remote = [tool('a'), tool('b'), tool('c'), tool('d')]
    const kept = filterMcpToolsByListRules(remote, ['a', 'b', 'c'], ['b'])
    assert.deepEqual(namesOf(kept), ['a', 'c'])
    // 同名同时出现在 include 与 exclude：exclude 后生效，被剔除
    const kept2 = filterMcpToolsByListRules(remote, ['a', 'b'], ['b', 'c'])
    assert.deepEqual(namesOf(kept2), ['a'])
  })

  test('include 为显式空数组是空白名单：一个都不加载', () => {
    const remote = [tool('a'), tool('b')]
    assert.deepEqual(filterMcpToolsByListRules(remote, [], undefined), [])
  })

  test('规则项做 trim、忽略空白项；工具名按远端原名精确匹配', () => {
    const remote = [tool('memory_search'), tool('weather')]
    const kept = filterMcpToolsByListRules(remote, ['  memory_search  ', '   '], undefined)
    assert.deepEqual(namesOf(kept), ['memory_search'])
    // 远端原名带空白时不做 trim 凑合匹配：'weather ' 与 'weather' 是两个名字
    const remote2 = [tool('weather '), tool('weather')]
    const kept2 = filterMcpToolsByListRules(remote2, ['weather'], undefined)
    assert.deepEqual(namesOf(kept2), ['weather'])
  })

  test('容错：tools 非数组返回空数组，不抛错', () => {
    assert.deepEqual(filterMcpToolsByListRules(undefined, ['a'], undefined), [])
    assert.deepEqual(filterMcpToolsByListRules(null, undefined, ['a']), [])
    assert.deepEqual(filterMcpToolsByListRules('nope', undefined, undefined), [])
  })
})

describe('同名冲突检测（pickLoadableMcpTools，先连接者优先）', () => {
  test('无冲突：全部可加载，conflicts 为空，已加载索引不被改动', () => {
    const remote = [tool('memory_search'), tool('weather')]
    const loadedIndex = new Map([['unrelated_tool', 'nocturne_memory']])
    const { loadable, conflicts } = pickLoadableMcpTools(remote, loadedIndex)
    assert.deepEqual(namesOf(loadable), ['memory_search', 'weather'])
    assert.deepEqual(conflicts, [])
    // 纯函数只读：候选里的同名工具不该被写进索引（登记是调用方的事）
    assert.equal(loadedIndex.get('weather'), undefined)
  })

  test('同名冲突：后到者进 conflicts 并明确列出工具名与已加载的 server 名', () => {
    const remote = [tool('memory_search'), tool('weather')]
    const loadedIndex = new Map([['memory_search', 'nocturne_memory']])
    const { loadable, conflicts } = pickLoadableMcpTools(remote, loadedIndex)
    assert.deepEqual(namesOf(loadable), ['weather'])
    assert.deepEqual(conflicts, [{ name: 'memory_search', existingServer: 'nocturne_memory' }])
  })

  test('拒载只影响自己：同批其余工具与其余名字照常可加载', () => {
    const remote = [tool('x'), tool('y'), tool('z')]
    const loadedIndex = new Map([['y', 'serverA'], ['x', 'serverB']])
    const { loadable, conflicts } = pickLoadableMcpTools(remote, loadedIndex)
    assert.deepEqual(namesOf(loadable), ['z'])
    assert.deepEqual(conflicts, [
      { name: 'x', existingServer: 'serverB' },
      { name: 'y', existingServer: 'serverA' }
    ])
  })

  test('容错：tools 非数组或索引缺省时按空处理，不抛错', () => {
    assert.deepEqual(pickLoadableMcpTools(undefined, new Map()), { loadable: [], conflicts: [] })
    const remote = [tool('a')]
    // 索引缺省（首台 server 场景调用方可能传 undefined）视为空，无冲突
    assert.deepEqual(namesOf(pickLoadableMcpTools(remote, undefined).loadable), ['a'])
  })
})

describe('McpTool 参数清洗（不向远端 MCP 透传宿主鉴权字段）', () => {
  function makeMockClient() {
    const calls = []
    return {
      calls,
      async callTool(req) {
        calls.push(req)
        return { content: [{ type: 'text', text: 'ok' }] }
      }
    }
  }

  test('零参数 schema（如 Ombre-Brain breath）：剥离 sender/mode/isAdmin/groupId，转发空对象 {}', async () => {
    const client = makeMockClient()
    const breathTool = new McpTool('ombre-brain', client, {
      name: 'breath',
      description: '无参浮现',
      inputSchema: { type: 'object', properties: {}, title: 'breathArguments' }
    })
    assert.equal(breathTool.isMcpTool, true)
    const out = await breathTool.func({
      sender: '4018425614_9F0132CB823E4AA3156E56F2937463C5',
      mode: 'gemini',
      isAdmin: false,
      groupId: '20001'
    })
    assert.equal(out, 'ok')
    assert.deepEqual(client.calls, [{ name: 'breath', arguments: {} }])
  })

  test('带声明字段的严格对象 schema：仅保留 properties 白名单且剔除宿主注入的 mode=gemini/claude', async () => {
    const client = makeMockClient()
    const searchTool = new McpTool('ombre-brain', client, {
      name: 'breath_search',
      description: '检索记忆',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          mode: { type: 'string', default: 'manual' }
        },
        required: ['query']
      }
    })
    // 兜底路径：即便上层误把宿主字段合并进 args，McpTool 仍剔除 sender/isAdmin/groupId 与插件注入的 mode='gemini'
    await searchTool.func({
      query: '柠檬塔',
      sender: '10001',
      isAdmin: true,
      groupId: '20001',
      mode: 'gemini',
      undeclaredField: 123
    })
    assert.deepEqual(client.calls[0], {
      name: 'breath_search',
      arguments: { query: '柠檬塔' }
    })

    // 正常路径：模型显式传入合法业务 mode（如 automatic/manual）原样保留
    await searchTool.func({ query: '约定', mode: 'automatic' })
    assert.deepEqual(client.calls[1], {
      name: 'breath_search',
      arguments: { query: '约定', mode: 'automatic' }
    })
  })

  test('开放 schema（additionalProperties: true）仍剥离未声明的 sender/isAdmin/groupId，保留其余动态字段', async () => {
    const client = makeMockClient()
    const dynamicTool = new McpTool('custom-mcp', client, {
      name: 'dynamic_call',
      description: '开放参数',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string' } },
        additionalProperties: true
      }
    })
    await dynamicTool.func({
      action: 'ping',
      extraPayload: { a: 1 },
      sender: '10001',
      isAdmin: false,
      groupId: '20001'
    })
    assert.deepEqual(client.calls[0], {
      name: 'dynamic_call',
      arguments: { action: 'ping', extraPayload: { a: 1 } }
    })
  })

  test('远端未声明 inputSchema：回退为仅剥离宿主注入键，业务参数保留', async () => {
    const client = makeMockClient()
    const legacyTool = new McpTool('legacy-srv', client, {
      name: 'legacy_call',
      description: '未声明 schema 的老工具'
    })
    assert.equal(legacyTool.isMcpTool, true)
    await legacyTool.func({
      city: '北京',
      extra: { a: 1 },
      sender: '10001',
      isAdmin: false,
      groupId: '20001',
      mode: 'gemini'
    })
    assert.deepEqual(client.calls[0], {
      name: 'legacy_call',
      arguments: { city: '北京', extra: { a: 1 } }
    })
  })
})
