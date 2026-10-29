import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { dailyPluginMapSync, formatManualReport, syncPluginMaps } from '../utils/capability/mapRunner.js'
import { readLocalMeta } from '../utils/capability/mapStore.js'

/**
 * 同步编排与每日任务（次缝）。
 *
 * 网络与通知都是注入的假实现，磁盘切临时目录。
 * 要守住：没有变化时不下地图、没地图的插件算缺失、失败满三次才告警。
 */

const INDEX_URL = 'https://raw.githubusercontent.com/Binbin-miao/command-maps/main/index.json'
const BASE = 'https://raw.githubusercontent.com/Binbin-miao/command-maps/main/'

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

const mapOf = key => JSON.stringify({
  schema: 2,
  plugin: { key, display: key, version: '1.0.0' },
  instructions: [{ id: `${key}/cmd`, command: '#cmd', summary: '示例' }]
})

function fakeFetch ({ index, maps = {} }) {
  const calls = []
  const impl = async target => {
    calls.push(target)
    const url = String(target)
    if (url.includes('index.json')) {
      return { ok: true, status: 200, url, headers: { get: () => null }, text: async () => index }
    }
    const key = Object.keys(maps).find(name => url.endsWith(`maps/${name}.json`))
    if (!key) {
      return { ok: false, status: 404, url, headers: { get: () => null }, text: async () => '' }
    }
    return { ok: true, status: 200, url, headers: { get: () => null }, text: async () => maps[key] }
  }
  impl.calls = calls
  return impl
}

const indexOf = (entries, revision = 7) => JSON.stringify({ schema: 2, revision, plugins: entries })

let originalCwd
let tmp

before(() => {
  originalCwd = process.cwd()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-runner-'))
  process.chdir(tmp)
})

after(() => {
  process.chdir(originalCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(path.join(tmp, 'data'), { recursive: true, force: true })
})

describe('一次完整同步', () => {
  test('本机没地图的插件会被下载，索引里没有的进缺失清单', async () => {
    const mapA = mapOf('a-plugin')
    const fetchImpl = fakeFetch({
      index: indexOf({ 'a-plugin': { file: 'maps/a-plugin.json', version: '1.0.0', sha256: sha256(mapA) } }),
      maps: { 'a-plugin': mapA }
    })

    const result = await syncPluginMaps({
      indexUrl: INDEX_URL,
      fetchImpl,
      plugins: [{ key: 'a-plugin', version: '1.0.0' }, { key: 'ghost-plugin', version: '9.9.9' }]
    })

    assert.equal(result.updated, 1)
    assert.deepEqual(result.missing, ['ghost-plugin'])
    assert.equal(readLocalMeta('a-plugin')?.version, '1.0.0')
  })

  test('版本一致时不下载任何地图，只读一次索引', async () => {
    const mapA = mapOf('a-plugin')
    const index = indexOf({ 'a-plugin': { file: 'maps/a-plugin.json', version: '1.0.0', sha256: sha256(mapA) } })

    // 先跑一次把地图落地
    await syncPluginMaps({
      indexUrl: INDEX_URL,
      fetchImpl: fakeFetch({ index, maps: { 'a-plugin': mapA } }),
      plugins: [{ key: 'a-plugin', version: '1.0.0' }]
    })

    const second = fakeFetch({ index, maps: { 'a-plugin': mapA } })
    const result = await syncPluginMaps({
      indexUrl: INDEX_URL,
      fetchImpl: second,
      plugins: [{ key: 'a-plugin', version: '1.0.0' }]
    })

    assert.equal(result.updated, 0)
    assert.equal(result.upToDate, 1)
    assert.equal(second.calls.length, 1, '只应当请求索引')
  })
})

describe('每日检查的告警节奏', () => {
  const brokenIndex = () => indexOf({
    'a-plugin': { file: 'maps/a-plugin.json', version: '1.0.0', sha256: 'deadbeef' }
  })

  test('有更新时通知一次', async () => {
    const mapA = mapOf('a-plugin')
    const notices = []
    const result = await dailyPluginMapSync({
      indexUrl: INDEX_URL,
      fetchImpl: fakeFetch({
        index: indexOf({ 'a-plugin': { file: 'maps/a-plugin.json', version: '1.0.0', sha256: sha256(mapA) } }),
        maps: { 'a-plugin': mapA }
      }),
      plugins: [{ key: 'a-plugin', version: '1.0.0' }],
      notify: text => notices.push(text)
    })

    assert.equal(result.updated, 1)
    assert.equal(notices.length, 1)
    assert.match(notices[0], /已更新 1 份/)
  })

  test('前两次失败不打扰，第三次才告警', async () => {
    const notices = []
    const options = () => ({
      indexUrl: INDEX_URL,
      fetchImpl: fakeFetch({ index: brokenIndex(), maps: { 'a-plugin': mapOf('a-plugin') } }),
      plugins: [{ key: 'a-plugin', version: '1.0.0' }],
      notify: text => notices.push(text)
    })

    const first = await dailyPluginMapSync(options())
    const second = await dailyPluginMapSync(options())
    const third = await dailyPluginMapSync(options())

    assert.equal(first.failStreak, 1)
    assert.equal(second.failStreak, 2)
    assert.equal(third.failStreak, 3)
    assert.equal(notices.length, 1, '只有第三次该发通知')
    assert.match(notices[0], /连续 3 次/)
  })

  test('索引请求本身失败时计入连败，不抛错', async () => {
    const notices = []
    const result = await dailyPluginMapSync({
      indexUrl: INDEX_URL,
      fetchImpl: async () => {
        throw new Error('ECONNRESET')
      },
      plugins: [{ key: 'a-plugin', version: '1.0.0' }],
      notify: text => notices.push(text)
    })

    assert.equal(result.ok, false)
    assert.equal(result.failStreak, 1)
    assert.equal(notices.length, 0)
  })
})

describe('手动拉取的回执', () => {
  const base = { revision: 7, scanned: 42, updated: 3, upToDate: 38, failed: 0, errors: [], missing: [] }

  test('有缺失插件时列名字、数量与后果', () => {
    const text = formatManualReport({ ...base, missing: ['ghost-plugin', 'another-ghost'] }, '1.2')

    assert.match(text, /本机插件 42 个 ｜ 更新 3 份 ｜ 已最新 38 份 ｜ 失败 0 份/)
    assert.match(text, /云端没有地图的插件（2 个，AI 无法代执行）：ghost-plugin、another-ghost/)
  })

  test('全部覆盖时不出现缺失那一段', () => {
    const text = formatManualReport(base, '0.4')

    assert.doesNotMatch(text, /云端没有地图/)
  })

  test('没有更新也给完整回执，不只回一句「已是最新」', () => {
    const text = formatManualReport({ ...base, updated: 0, upToDate: 42 }, '0.3')

    assert.match(text, /更新 0 份/)
    assert.match(text, /已最新 42 份/)
  })

  test('失败时给出前三条原因', () => {
    const text = formatManualReport({ ...base, failed: 2, errors: ['a: 哈希不符', 'b: 超时', 'c: 忽略'] }, '3')

    assert.match(text, /失败 2 份/)
    assert.match(text, /a: 哈希不符；b: 超时；c: 忽略/)
  })
})
