import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { planMapSync, readMapIndex } from '../utils/capability/mapPlan.js'

/**
 * 拉取计划（次缝）。
 *
 * 网络与磁盘都换成注入的假实现：要守住的是「只读一次索引」「版本一致不重下」
 * 「本地没地图必须拉」「索引缺项算缺失」这四件事。
 */

const URL = 'https://raw.githubusercontent.com/Binbin-miao/command-maps/main/dist/index.json'

function fakeFetch (body) {
  const calls = []
  const impl = async target => {
    calls.push(target)
    return {
      ok: true,
      status: 200,
      url: target,
      headers: { get: () => null },
      text: async () => body
    }
  }
  impl.calls = calls
  return impl
}

const indexText = (plugins, extra = {}) => JSON.stringify({ schema: 2, revision: 5, plugins, ...extra })

describe('读索引', () => {
  test('只发一次请求，拿到修订号与 base 地址', async () => {
    const fetchImpl = fakeFetch(indexText({ 'a-plugin': { file: 'maps/a.json', version: '1.0.0' } }))
    const result = await readMapIndex({ indexUrl: URL, fetchImpl })

    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(result.revision, 5)
    assert.equal(result.base, URL.replace(/index\.json$/, ''))
  })

  test('schema 不是 2 时整体报错，不做部分采用', async () => {
    const fetchImpl = fakeFetch(indexText({}, { schema: 1 }))
    await assert.rejects(() => readMapIndex({ indexUrl: URL, fetchImpl }), /schema/)
  })

  test('缺少 plugins 时报错', async () => {
    const fetchImpl = fakeFetch(JSON.stringify({ schema: 2, revision: 1 }))
    await assert.rejects(() => readMapIndex({ indexUrl: URL, fetchImpl }), /plugins/)
  })

  test('返回内容不是 JSON 时报错', async () => {
    const fetchImpl = fakeFetch('<html>镜像首页</html>')
    await assert.rejects(() => readMapIndex({ indexUrl: URL, fetchImpl }), /不是 JSON/)
  })

  test('没配置地址时直接报错，不发请求', async () => {
    const fetchImpl = fakeFetch('{}')
    await assert.rejects(() => readMapIndex({ indexUrl: '', fetchImpl }), /没有配置/)
    assert.equal(fetchImpl.calls.length, 0)
  })
})

describe('版本比对', () => {
  const index = {
    revision: 5,
    plugins: {
      'a-plugin': { file: 'maps/a.json', version: '1.0.0' },
      'b-plugin': { file: 'maps/b.json', version: '2.1.0' }
    }
  }

  test('版本一致归入已是最新', () => {
    const plan = planMapSync({
      index,
      plugins: [{ key: 'a-plugin', version: '1.0.0' }],
      localVersions: new Map([['a-plugin', '1.0.0']])
    })

    assert.deepEqual(plan.upToDate, ['a-plugin'])
    assert.deepEqual(plan.pending, [])
  })

  test('版本变化归入待下载，并带上本地与云端两个版本', () => {
    const plan = planMapSync({
      index,
      plugins: [{ key: 'b-plugin', version: '2.0.0' }],
      localVersions: new Map([['b-plugin', '2.0.0']])
    })

    assert.equal(plan.pending.length, 1)
    assert.equal(plan.pending[0].reason, 'version-changed')
    assert.equal(plan.pending[0].localVersion, '2.0.0')
    assert.equal(plan.pending[0].cloudVersion, '2.1.0')
  })

  test('本地没有地图时即使版本相同也要拉', () => {
    const plan = planMapSync({
      index,
      plugins: [{ key: 'a-plugin', version: '1.0.0' }]
    })

    assert.equal(plan.pending.length, 1)
    assert.equal(plan.pending[0].reason, 'no-local-map')
  })

  test('索引里没有的插件归入缺失，不混进待下载', () => {
    const plan = planMapSync({
      index,
      plugins: [{ key: 'a-plugin', version: '1.0.0' }, { key: 'ghost-plugin', version: '9.9.9' }],
      localVersions: new Map([['a-plugin', '1.0.0']])
    })

    assert.deepEqual(plan.missing, ['ghost-plugin'])
    assert.deepEqual(plan.upToDate, ['a-plugin'])
    assert.deepEqual(plan.pending, [])
  })
})

test('云端没写 version 时按 sha256 判断，不每轮重拉', () => {
  const index = {
    schema: 2,
    revision: 1,
    plugins: { 'a-plugin': { file: 'maps/a-plugin.json', sha256: 'same-sha', command_count: 1 } }
  }

  const same = planMapSync({
    index,
    plugins: [{ key: 'a-plugin' }],
    localMetas: new Map([['a-plugin', { version: '', sha256: 'same-sha' }]])
  })
  assert.deepEqual(same.upToDate, ['a-plugin'])
  assert.deepEqual(same.pending, [])

  const changed = planMapSync({
    index,
    plugins: [{ key: 'a-plugin' }],
    localMetas: new Map([['a-plugin', { version: '', sha256: 'other-sha' }]])
  })
  assert.equal(changed.pending.length, 1)
  assert.equal(changed.pending[0].reason, 'version-changed')
})
