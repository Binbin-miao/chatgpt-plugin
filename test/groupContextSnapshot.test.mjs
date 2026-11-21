/**
 * 群记录快照的重建判定（B2 双阈值）
 *
 * 契约（任一满足即重建）：
 * - 条数：攒够 **5 条新消息**，**与窗口大小无关**（20/50/60 一律 5）
 * - 时间：距上次**重建**超过 **180 秒**
 * 于是滞后上界是双上界：≤4 条新消息、≤180 秒 + 一次拉取耗时。
 *
 * 期望值写死在本文件里，不从 `utils/groupSnapshot.js` 的实现反推。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  rebuildThreshold, countNewerMessages, shouldRebuildSnapshot,
  REBUILD_NEW_MESSAGES, REBUILD_MAX_AGE_MS
} from '../utils/groupSnapshot.js'

/** 构造按时间升序的群记录，message_id 从 1 开始，共 count 条 */
function makeChats(count) {
  return Array.from({ length: count }, (_, index) => ({
    message_id: String(index + 1),
    raw_message: `第 ${index + 1} 条`
  }))
}

const NOW = 1_800_000_000_000
const snapshotOf = ({ newestMessageId, rebuiltAt = NOW, fetchedAt = NOW }) => ({
  text: '\nthe group name is 测试群, group id is 591272224。', newestMessageId, fetchedAt, rebuiltAt
})

test('阈值固定 5 条，不随窗口折算（20 / 50 / 60 窗口行为完全一致）', () => {
  assert.equal(REBUILD_NEW_MESSAGES, 5)
  assert.equal(rebuildThreshold(), 5)
  for (const window of [20, 50, 60]) {
    const chats = makeChats(window)
    // 4 条新消息：还不换（滞后上界就是 4）
    assert.equal(shouldRebuildSnapshot(snapshotOf({ newestMessageId: String(window - 4) }), chats, NOW), false,
      `窗口 ${window}：4 条新消息不许重建`)
    // 5 条：换
    assert.equal(shouldRebuildSnapshot(snapshotOf({ newestMessageId: String(window - 5) }), chats, NOW), true,
      `窗口 ${window}：攒够 5 条必须重建`)
  }
})

test('滞后上界 = 4 条新消息（判据是 ≥，差一错误在这里最容易犯）', () => {
  const chats = makeChats(60)
  for (let newer = 0; newer <= 4; newer++) {
    assert.equal(shouldRebuildSnapshot(snapshotOf({ newestMessageId: String(60 - newer) }), chats, NOW), false,
      `${newer} 条新消息不该重建`)
  }
  assert.equal(shouldRebuildSnapshot(snapshotOf({ newestMessageId: '55' }), chats, NOW), true, '5 条必须重建')
})

test('时间阈值：距上次重建满 180 秒就换，即使一条新消息都没有（冷群兜底）', () => {
  assert.equal(REBUILD_MAX_AGE_MS, 180 * 1000)
  const chats = makeChats(60)
  // 同一份窗口：newestMessageId 就是最后一条，0 条新消息
  const fresh = snapshotOf({ newestMessageId: '60', rebuiltAt: NOW - 179_999 })
  assert.equal(shouldRebuildSnapshot(fresh, chats, NOW), false, '179.999 秒还不换')
  const stale = snapshotOf({ newestMessageId: '60', rebuiltAt: NOW - 180_000 })
  assert.equal(shouldRebuildSnapshot(stale, chats, NOW), true, '满 180 秒必须换')
})

test('时间锚点是 rebuiltAt 而不是 fetchedAt（拉取每 30 秒刷新 fetchedAt，用它算会永远不触发）', () => {
  const chats = makeChats(60)
  // fetchedAt 很新（刚拉过），但上次重建是 10 分钟前 —— 必须换
  const cached = snapshotOf({ newestMessageId: '60', fetchedAt: NOW - 1_000, rebuiltAt: NOW - 600_000 })
  assert.equal(shouldRebuildSnapshot(cached, chats, NOW), true)
})

test('拉取失败（chats 为 null）一律复用旧快照，哪怕已经超过 180 秒', () => {
  const cached = snapshotOf({ newestMessageId: '60', rebuiltAt: NOW - 600_000 })
  assert.equal(shouldRebuildSnapshot(cached, null, NOW), false, '拿不到新内容就不许把 system 截短')
})

test('拉到空数组时同样复用旧快照，也不许按时间阈值重建', () => {
  const cached = snapshotOf({ newestMessageId: '60', rebuiltAt: NOW - 600_000 })
  assert.equal(shouldRebuildSnapshot(cached, [], NOW), false)
})

test('没有缓存时首次必建', () => {
  assert.equal(shouldRebuildSnapshot(undefined, makeChats(10), NOW), true)
})

test('countNewerMessages：lastId 在窗口索引 40（共 60 条）时有 19 条更新', () => {
  const chats = makeChats(60)
  assert.equal(countNewerMessages(chats, '41'), 19)
})

test('countNewerMessages：lastId 是最后一条时没有新消息', () => {
  const chats = makeChats(60)
  assert.equal(countNewerMessages(chats, '60'), 0)
})

test('countNewerMessages：lastId 已滑出窗口时视为全部为新增', () => {
  const chats = makeChats(60)
  assert.equal(countNewerMessages(chats, '9001'), 60)
})

test('countNewerMessages：lastId 为空时视为全部为新增', () => {
  const chats = makeChats(60)
  assert.equal(countNewerMessages(chats, ''), 60)
})

test('countNewerMessages：空数组没有新消息', () => {
  assert.equal(countNewerMessages([], '60'), 0)
})

test('countNewerMessages：数字 message_id 与字符串 lastId 按 String() 等同匹配', () => {
  const chats = makeChats(10).map(chat => ({ ...chat, message_id: Number(chat.message_id) }))
  // message_id 为数字 3 的那条在索引 2，其后还有 7 条
  assert.equal(countNewerMessages(chats, '3'), 7)
})
