import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { listInstalledPlugins } from '../utils/capability/registry.js'
import { SELF_PLUGIN_ROOT } from '../utils/capability/paths.js'

/**
 * 本机插件清单（次缝）。
 *
 * 真实加载器换成假总表，插件根目录换成临时目录：不依赖框架、不依赖本机装了什么。
 * 要守住三件事：只收第三方插件、版本读不到也不能漏掉这个插件、取不到总表时返回空而不炸。
 */

const SELF_NAME = path.basename(SELF_PLUGIN_ROOT)

/** versions: { 目录名: 版本号 | null（不写 package.json） } */
async function makeRoot (versions) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'capability-list-'))
  for (const [name, version] of Object.entries(versions)) {
    const dir = path.join(root, name)
    await fs.mkdir(dir, { recursive: true })
    if (version !== null) {
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
    }
  }
  return root
}

const loaderWith = items => ({ priority: items })

describe('列出本机已安装的第三方插件', () => {
  test('给出 key、版本号与安装目录', async t => {
    const root = await makeRoot({ 'sign-plugin': '1.2.3' })
    t.after(() => fs.rm(root, { recursive: true, force: true }))

    const list = await listInstalledPlugins({
      loader: loaderWith([{ key: 'sign-plugin' }]),
      pluginsRoot: root
    })

    assert.deepEqual(list, [
      { key: 'sign-plugin', version: '1.2.3', dir: path.resolve(root, 'sign-plugin') }
    ])
  })

  test('没有 package.json 的插件版本为空，其余插件照常返回', async t => {
    const root = await makeRoot({ 'a-plugin': '2.0.0', 'b-plugin': null })
    t.after(() => fs.rm(root, { recursive: true, force: true }))

    const list = await listInstalledPlugins({
      loader: loaderWith([{ key: 'a-plugin' }, { key: 'b-plugin' }]),
      pluginsRoot: root
    })

    assert.deepEqual(list.map(item => [item.key, item.version]), [
      ['a-plugin', '2.0.0'],
      ['b-plugin', '']
    ])
  })

  test('本插件与框架内置插件都不收录', async t => {
    const root = await makeRoot({ [SELF_NAME]: '9.9.9', 'real-plugin': '1.0.0' })
    t.after(() => fs.rm(root, { recursive: true, force: true }))

    const list = await listInstalledPlugins({
      loader: loaderWith([
        { key: SELF_NAME },
        { key: 'real-plugin' },
        { key: 'lib/plugins/system-plugin' }
      ]),
      pluginsRoot: root
    })

    assert.deepEqual(list.map(item => item.key), ['real-plugin'])
  })

  test('同一个 key 只出现一次', async t => {
    const root = await makeRoot({ 'dup-plugin': '1.0.0' })
    t.after(() => fs.rm(root, { recursive: true, force: true }))

    const list = await listInstalledPlugins({
      loader: loaderWith([{ key: 'dup-plugin' }, { key: 'dup-plugin' }]),
      pluginsRoot: root
    })

    assert.equal(list.length, 1)
  })

  test('取不到插件总表时返回空数组而不是抛错', async () => {
    const list = await listInstalledPlugins({ loader: {} })
    assert.deepEqual(list, [])
  })
})
