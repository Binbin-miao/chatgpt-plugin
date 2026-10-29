import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 详情查询工具（工具缝）。
 *
 * 直接在工具入口调用，地图索引被替换成一份假数据：不读文件、不联网。
 * 要守住的是「查得准」与「查不到就说查不到」——后者比前者更重要，
 * 因为模型最容易在查不到时自己编一条指令出来。
 */

const ENTRIES = [
  {
    plugin: '签到插件',
    pluginKey: 'sign',
    command: '#签到',
    keys: ['签到', '打卡'],
    description: '每日签到领积分',
    risk: 'q',
    permission: '',
    args: {},
    ex: ''
  },
  {
    plugin: '签到插件',
    pluginKey: 'sign',
    command: '#我的积分',
    keys: ['我的积分', '我多少积分'],
    description: '查询自己的积分',
    risk: 'q',
    permission: '',
    args: { p1: '页码，可留空' },
    ex: '#我的积分 2'
  },
  {
    plugin: '公告插件',
    pluginKey: 'notice',
    command: '#看公告',
    keys: ['看公告', '群公告'],
    description: '查看本群公告',
    risk: 'q',
    permission: '',
    args: {},
    ex: ''
  },
  {
    plugin: '公告插件',
    pluginKey: 'notice',
    command: '#发公告',
    keys: ['发公告'],
    description: '发布群公告',
    risk: 'w',
    permission: 'admin',
    args: {},
    ex: ''
  }
]

const config = { enableCapabilityMap: true }
let state = ENTRIES

mock.module('../utils/config.js', { namedExports: { Config: config } })
mock.module('../utils/capability/mapIndex.js', {
  namedExports: {
    loadMapIndex: () => ({ entries: state, stats: { plugins: 2, total: state.length } })
  }
})

const { CapabilityLookupTool } = await import('../utils/tools/CapabilityLookupTool.js')

function run (query) {
  return new CapabilityLookupTool().func({ query })
}

test('按指令名命中，展开所属插件类并带上说明', async () => {
  const text = await run('#签到')
  assert.match(text, /插件类【签到插件】共 2 条指令/)
  assert.match(text, /#签到 \[查询\] —— 每日签到领积分/)
})

test('按关键词命中多条', async () => {
  const text = await run('公告')
  assert.match(text, /插件类【公告插件】共 2 条指令/)
  assert.match(text, /#看公告/)
  assert.match(text, /#发公告/)
})

test('权限位与风险档写进结果，避免让普通成员去试管理员指令', async () => {
  const text = await run('#发公告')
  assert.match(text, /需 admin/)
  assert.match(text, /有副作用/)
})

test('参数与示例直接来自地图，不再依赖补丁', async () => {
  const text = await run('#我的积分')
  assert.match(text, /\[查询\]/)
  assert.match(text, /参数：p1=页码，可留空/)
  assert.match(text, /示例：#我的积分 2/)
})

test('查不到时明确否定，并说明「不代表不存在」', async () => {
  const text = await run('原神抽卡')
  assert.match(text, /未在本机已安装的第三方插件里找到/)
  assert.match(text, /不代表该功能不存在/)
})

test('查询词为空时要求补充，不返回整张表', async () => {
  const text = await run('   ')
  assert.match(text, /请给出要查询的指令名或功能关键词/)
})

test('功能开关关闭时不查询', async () => {
  config.enableCapabilityMap = false
  try {
    const text = await run('#签到')
    assert.match(text, /已关闭/)
  } finally {
    config.enableCapabilityMap = true
  }
})

test('没有地图时不去下载，只提示发拉取指令', async () => {
  state = []
  try {
    const text = await run('#签到')
    assert.match(text, /^Error: /)
    assert.match(text, /#chatgpt更新指令地图/)
  } finally {
    state = ENTRIES
  }
})
