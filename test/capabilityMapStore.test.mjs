import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  listLocalMapKeys,
  mapDir,
  readLocalMap,
  readLocalMeta,
  saveLocalMap
} from '../utils/capability/mapStore.js'
import { capabilityMapsDir } from '../utils/capability/paths.js'

/**
 * 地图留存（次缝）。
 *
 * 目录根取 `process.cwd()`，所以整个文件切到临时目录里跑，结束后切回。
 * node:test 为每个测试文件起独立进程，chdir 不会波及别的套件。
 */

let originalCwd
let tmp

const sample = {
  plugin: { key: 'sign-plugin', display: '签到', version: '1.2.3', fingerprint: 'abc123' },
  instructions: [
    { id: 'sign-plugin/sign', command: '#签到', summary: '每日签到', risk: 'q' }
  ]
}

before(() => {
  originalCwd = process.cwd()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-maps-'))
  process.chdir(tmp)
})

after(() => {
  process.chdir(originalCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('地图留存的读写', () => {
  test('写入后能原样读回插件信息与指令', () => {
    saveLocalMap('sign-plugin', sample, { revision: 3, sha256: 'deadbeef' })

    const map = readLocalMap('sign-plugin')
    assert.deepEqual(map?.plugin, sample.plugin)
    assert.deepEqual(map?.instructions, sample.instructions)

    const meta = readLocalMeta('sign-plugin')
    assert.equal(meta?.key, 'sign-plugin')
    assert.equal(meta?.version, '1.2.3')
    assert.equal(meta?.revision, 3)
    assert.equal(meta?.sha256, 'deadbeef')
    assert.ok(meta?.fetchedAt)
  })

  test('旧版结构（schema 1）按缺失处理，返回 null', () => {
    const dir = mapDir('old-plugin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify({ schema: 1, commands: {} }), 'utf8')

    assert.equal(readLocalMap('old-plugin'), null)
  })

  test('JSON 坏掉时返回 null，不抛错', () => {
    const dir = mapDir('broken-plugin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'map.json'), '{ 不是 JSON', 'utf8')

    assert.equal(readLocalMap('broken-plugin'), null)
  })

  test('缺 instructions 字段也算不合规', () => {
    const dir = mapDir('partial-plugin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify({ schema: 2, plugin: {} }), 'utf8')

    assert.equal(readLocalMap('partial-plugin'), null)
  })
})

describe('目录与 key 的安全边界', () => {
  test('带 .. 的 key 不会写出留存目录', () => {
    const target = path.resolve(mapDir('../evil'))
    const root = path.resolve(capabilityMapsDir())
    assert.ok(target.startsWith(root + path.sep), `实际落到 ${target}`)
  })

  test('带分隔符的 key 压成单层目录，但列出来仍是原 key', () => {
    saveLocalMap('example/add', sample)
    assert.ok(!mapDir('example/add').includes(path.sep + 'example' + path.sep))
    assert.ok(listLocalMapKeys().includes('example/add'))
  })

  test('没有任何地图时列出空数组，不抛错', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-empty-'))
    const previous = process.cwd()
    process.chdir(emptyRoot)
    try {
      assert.deepEqual(listLocalMapKeys(), [])
    } finally {
      process.chdir(previous)
      fs.rmSync(emptyRoot, { recursive: true, force: true })
    }
  })
})
