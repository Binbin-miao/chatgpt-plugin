import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { downloadMaps } from '../utils/capability/mapSync.js'
import { readLocalMap } from '../utils/capability/mapStore.js'

/**
 * 下载与落盘（次缝）。
 *
 * 网络换成按路径分发的假 fetch，磁盘切到临时目录。
 * 要守住：哈希对不上不落盘、一份失败不连累其余、file 不能指向别的主机。
 */

const BASE = 'https://raw.githubusercontent.com/Binbin-miao/command-maps/main/'

const MAP = JSON.stringify({
  schema: 2,
  plugin: { key: 'a-plugin', display: '签到', version: '1.0.0' },
  instructions: [{ id: 'a-plugin/sign', command: '#签到', summary: '每日签到' }]
})

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

/** routes: { 路径后缀: 内容 }；未命中的路径一律 404 */
function fakeFetch (routes) {
  const calls = []
  const impl = async target => {
    calls.push(target)
    const suffix = Object.keys(routes).find(key => String(target).endsWith(key))
    if (!suffix) {
      return { ok: false, status: 404, url: target, headers: { get: () => null }, text: async () => '' }
    }
    return {
      ok: true,
      status: 200,
      url: target,
      headers: { get: () => null },
      text: async () => routes[suffix]
    }
  }
  impl.calls = calls
  return impl
}

const entries = (overrides = {}) => [
  {
    key: 'a-plugin',
    entry: { file: 'maps/a-plugin.json', sha256: sha256(MAP), revision: 3, ...overrides }
  }
]

let originalCwd
let tmp

before(() => {
  originalCwd = process.cwd()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-sync-'))
  process.chdir(tmp)
})

after(() => {
  process.chdir(originalCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

// 每条用例都从空目录开始：否则前一条落的地图会让「不该落盘」的断言假绿
beforeEach(() => {
  fs.rmSync(path.join(tmp, 'data'), { recursive: true, force: true })
})

describe('按清单下载地图', () => {
  test('哈希对得上就落盘，元信息记录来源', async () => {
    const result = await downloadMaps({
      base: BASE,
      pending: entries(),
      fetchImpl: fakeFetch({ 'maps/a-plugin.json': MAP })
    })

    assert.deepEqual(result, { updated: 1, failed: 0, errors: [] })
    assert.equal(readLocalMap('a-plugin')?.plugin.version, '1.0.0')
  })

  test('哈希对不上时判失败，且不留文件', async () => {
    const result = await downloadMaps({
      base: BASE,
      pending: entries({ sha256: 'deadbeef' }),
      fetchImpl: fakeFetch({ 'maps/a-plugin.json': MAP })
    })

    assert.equal(result.updated, 0)
    assert.equal(result.failed, 1)
    assert.equal(readLocalMap('a-plugin'), null)
  })

  test('一份失败不影响其余插件', async () => {
    const good = MAP.replace('a-plugin', 'b-plugin')
    const result = await downloadMaps({
      base: BASE,
      pending: [
        { key: 'a-plugin', entry: { file: 'maps/a-plugin.json', sha256: 'deadbeef' } },
        { key: 'b-plugin', entry: { file: 'maps/b-plugin.json', sha256: sha256(good) } }
      ],
      fetchImpl: fakeFetch({ 'maps/a-plugin.json': MAP, 'maps/b-plugin.json': good })
    })

    assert.equal(result.updated, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.errors.length, 1)
    assert.ok(readLocalMap('b-plugin'))
  })

  test('file 指向索引以外的主机时拒绝下载', async () => {
    const result = await downloadMaps({
      base: BASE,
      pending: [{ key: 'evil', entry: { file: 'https://evil.example/x.json', sha256: sha256(MAP) } }],
      fetchImpl: fakeFetch({ 'x.json': MAP })
    })

    assert.equal(result.updated, 0)
    assert.equal(result.failed, 1)
    assert.match(result.errors[0], /索引以外的主机/)
  })

  test('旧版结构的地图不落盘', async () => {
    const legacy = JSON.stringify({ schema: 1, plugin: { key: 'a-plugin' }, commands: {} })
    const result = await downloadMaps({
      base: BASE,
      pending: [{ key: 'a-plugin', entry: { file: 'maps/a-plugin.json', sha256: sha256(legacy) } }],
      fetchImpl: fakeFetch({ 'maps/a-plugin.json': legacy })
    })

    assert.equal(result.failed, 1)
    assert.equal(readLocalMap('a-plugin'), null)
  })

  test('索引没声明 sha256 时拒绝安装', async () => {
    const result = await downloadMaps({
      base: BASE,
      pending: [{ key: 'a-plugin', entry: { file: 'maps/a-plugin.json' } }],
      fetchImpl: fakeFetch({ 'maps/a-plugin.json': MAP })
    })

    assert.equal(result.failed, 1)
    assert.match(result.errors[0], /sha256/)
  })
})

describe('地图正文与索引对不上', () => {
  test('正文的 plugin.key 与请求的 key 不一致时拒绝落盘', async () => {
    const other = JSON.stringify({
      schema: 2,
      plugin: { key: 'b-plugin' },
      instructions: []
    })
    const result = await downloadMaps({
      base: BASE,
      pending: [{ key: 'a-plugin', entry: { file: 'maps/a-plugin.json', sha256: sha256(other), revision: 1 } }],
      fetchImpl: fakeFetch({ 'maps/a-plugin.json': other })
    })

    assert.equal(result.failed, 1)
    assert.match(result.errors[0], /plugin\.key/)
    assert.equal(readLocalMap('a-plugin'), null)
  })
})
