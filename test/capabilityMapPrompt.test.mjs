import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { mapPromptAddon } from '../utils/capability/mapPrompt.js'
import { saveLocalMap } from '../utils/capability/mapStore.js'
import { writeSyncState } from '../utils/capability/syncState.js'

/**
 * 注入文本（次缝）。
 *
 * 磁盘切临时目录。要守住：只到插件级、没有地图就整段为空、未覆盖插件单独一行、
 * 硬规则措辞仍在。
 */

const mapOf = (key, { display, summary, count = 1 } = {}) => ({
  plugin: { key, display, summary, version: '1.0.0' },
  instructions: Array.from({ length: count }, (_, index) => ({ id: `${key}/${index}`, command: '#cmd' }))
})

let originalCwd
let tmp

before(() => {
  originalCwd = process.cwd()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-prompt-'))
  process.chdir(tmp)
})

after(() => {
  process.chdir(originalCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(path.join(tmp, 'data'), { recursive: true, force: true })
})

describe('注入插件级摘要', () => {
  test('一份地图都没有时返回空串，调用方不加任何内容', () => {
    assert.equal(mapPromptAddon(), '')
  })

  test('每个插件一行：名字、一句话、条数', () => {
    saveLocalMap('sign-plugin', mapOf('sign-plugin', { display: '签到', summary: '每日签到领积分', count: 3 }))
    saveLocalMap('star-plugin', mapOf('star-plugin', { display: '星穹铁道', summary: '角色与深渊查询', count: 51 }))

    const text = mapPromptAddon()

    assert.match(text, /【签到】每日签到领积分 （3 条）/)
    assert.match(text, /【星穹铁道】角色与深渊查询 （51 条）/)
  })

  test('插件没写摘要时不留空洞，直接用插件名', () => {
    saveLocalMap('plain-plugin', mapOf('plain-plugin', { display: '示例插件' }))

    const text = mapPromptAddon()

    assert.match(text, /【示例插件】（1 条）/)
    assert.doesNotMatch(text, /【示例插件】\s+（/)
  })

  test('未覆盖插件单独一行，并说明后果', () => {
    saveLocalMap('sign-plugin', mapOf('sign-plugin', { display: '签到' }))
    writeSyncState({ failStreak: 0, missing: ['ghost-plugin', 'another-ghost'] })

    const text = mapPromptAddon()

    assert.match(text, /云端没有地图/)
    assert.match(text, /ghost-plugin、another-ghost/)
    assert.match(text, /只能由用户自己手打/)
  })

  test('硬规则仍在，且指向两个工具', () => {
    saveLocalMap('sign-plugin', mapOf('sign-plugin', { display: '签到' }))

    const text = mapPromptAddon()

    assert.match(text, /禁止凭记忆编造/)
    assert.match(text, /lookupPluginCapability/)
    assert.match(text, /runPluginCommand/)
  })
})
