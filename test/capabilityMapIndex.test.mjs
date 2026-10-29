import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadMapIndex } from '../utils/capability/mapIndex.js'
import { saveLocalMap } from '../utils/capability/mapStore.js'
import { recall } from '../utils/commandMap/recall.js'

/**
 * 地图 → 召回条目（次缝）。
 *
 * 磁盘切临时目录，最后一段直接跑真实召回：证明「换数据源之后，
 * 用户的口语说法仍然找得到指令」这件事不只靠假设。
 */

const signMap = {
  plugin: { key: 'sign-plugin', display: '签到', version: '1.0.0' },
  instructions: [
    {
      id: 'sign-plugin/sign',
      command: '#签到',
      aliases: ['#每日签到'],
      title: '签到',
      summary: '每日签到领积分',
      keywords: ['签到', '打卡'],
      params: [{ name: '无', required: false, desc: '不需要参数' }],
      example: '#签到',
      risk: 'q',
      permission: ''
    },
    {
      id: 'sign-plugin/points',
      command: '#我的积分',
      keywords: ['积分'],
      params: [
        { name: '页码', required: false, desc: '默认第一页' },
        { name: '类型', required: true, desc: '签到分或活跃分' }
      ],
      example: '#我的积分 1 签到分',
      summary: '查询自己的积分',
      risk: 'q'
    }
  ]
}

const likeMap = {
  plugin: { key: 'like-plugin', display: '点赞', version: '2.0.0' },
  instructions: [
    {
      id: 'like-plugin/like',
      command: '#点赞',
      aliases: ['#赞我', '#名片赞'],
      keywords: ['点赞', '名片赞', '赞'],
      summary: '给群友的 QQ 名片点赞',
      risk: 'w',
      permission: ''
    }
  ]
}

let originalCwd
let tmp

before(() => {
  originalCwd = process.cwd()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-index-'))
  process.chdir(tmp)
})

after(() => {
  process.chdir(originalCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(path.join(tmp, 'data'), { recursive: true, force: true })
})

describe('拍平成召回条目', () => {
  test('一条指令一条记录，别名不会拆成多条', () => {
    saveLocalMap('like-plugin', likeMap)

    const { entries, stats } = loadMapIndex()

    assert.equal(stats.plugins, 1)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].command, '#点赞')
    assert.deepEqual(entries[0].keys, ['点赞', '名片赞', '赞', '#赞我', '#名片赞'])
  })

  test('参数从数组转成展示用的键值对，必填会标出来', () => {
    saveLocalMap('sign-plugin', signMap)

    const entry = loadMapIndex().entries.find(item => item.command === '#我的积分')

    assert.equal(entry.args['页码'], '默认第一页')
    assert.equal(entry.args['类型'], '签到分或活跃分（必填）')
    assert.equal(entry.ex, '#我的积分 1 签到分')
  })

  test('没有地图时是空索引，不抛错', () => {
    assert.deepEqual(loadMapIndex().entries, [])
  })

  test('没有确定写法但有描述的条目照样收（command 留空）', () => {
    saveLocalMap('odd-plugin', {
      plugin: { key: 'odd-plugin', display: '怪插件' },
      instructions: [{ id: 'no-command', command: '', summary: '任意含某词的消息都会触发', keywords: ['某词'] }]
    })

    const entries = loadMapIndex().entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].command, '')
    assert.deepEqual(entries[0].keys, ['某词'])
  })

  test('写法、关键词、描述全空的条目才跳过', () => {
    saveLocalMap('empty-plugin', {
      plugin: { key: 'empty-plugin', display: '空插件' },
      instructions: [{ id: 'nothing' }]
    })

    assert.deepEqual(loadMapIndex().entries, [])
  })
})

describe('换数据源后召回仍然管用', () => {
  test('「点个赞」能找到 #点赞', () => {
    saveLocalMap('like-plugin', likeMap)
    saveLocalMap('sign-plugin', signMap)

    const { entries } = loadMapIndex()
    const { matches } = recall('帮我点个赞', entries, { limit: 5 })

    assert.ok(matches.length > 0)
    assert.equal(matches[0].command, '#点赞')
  })

  test('一条指令的多个写法不会占满候选', () => {
    saveLocalMap('like-plugin', likeMap)
    saveLocalMap('sign-plugin', signMap)

    const { entries } = loadMapIndex()
    const { matches } = recall('点赞', entries, { limit: 5 })
    const likeCommands = matches.filter(item => item.plugin === '点赞')

    assert.equal(likeCommands.length, 1)
  })
})
