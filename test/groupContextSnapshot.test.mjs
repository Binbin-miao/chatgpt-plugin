/**
 * 群记录快照的重建判定（工单 t2）
 *
 * 覆盖 SPEC「快照重建判定」：阈值按实际拉到的条数折算（60→40、10→7、2→3），
 * newestMessageId 找不到时视为全部为新增，以及各种空输入容错。
 * 期望值写死在本文件里，不从 `utils/groupSnapshot.js` 的实现反推。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { rebuildThreshold, countNewerMessages, shouldRebuildSnapshot } from '../utils/groupSnapshot.js'

/** 构造按时间升序的群记录，message_id 从 1 开始，共 count 条 */
function makeChats(count) {
  return Array.from({ length: count }, (_, index) => ({
    message_id: String(index + 1),
    raw_message: `第 ${index + 1} 条`
  }))
}

test('rebuildThreshold：拉满 60 条窗口时阈值为 40（吃 2/3）', () => {
  assert.equal(rebuildThreshold(60), 40)
})

test('rebuildThreshold：拉满 3/4 窗口时阈值按比例折算', () => {
  assert.equal(rebuildThreshold(45), 30)
})

test('rebuildThreshold：只拉到 10 条时阈值为 ceil(10/1.5)=7', () => {
  assert.equal(rebuildThreshold(10), 7)
})

test('rebuildThreshold：2 条时折算值被下限 3 兜底', () => {
  assert.equal(rebuildThreshold(2), 3)
})

test('rebuildThreshold：空窗口不低于下限 3', () => {
  assert.equal(rebuildThreshold(0), 3)
})

test('rebuildThreshold：undefined 容错取下限', () => {
  assert.equal(rebuildThreshold(undefined), 3)
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

// 拉取失败是唯一会把 system 变短的路径：一旦误判为「重建」，缓存会被清成空/残缺快照，
// 缓存断点立刻跌破上游门槛。下面两条是这条路径的守门测试。
const cachedSnapshot = { text: '\nthe group name is 测试群, group id is 591272224。', newestMessageId: '60', fetchedAt: 0 }

test('shouldRebuildSnapshot：没有缓存时首次必建', () => {
  assert.equal(shouldRebuildSnapshot(undefined, makeChats(10), 10), true)
})

test('shouldRebuildSnapshot：拉取抛错（chats 为 null）时必须复用旧快照', () => {
  assert.equal(shouldRebuildSnapshot(cachedSnapshot, null, 0), false)
})

test('shouldRebuildSnapshot：拉到空数组时同样复用旧快照', () => {
  assert.equal(shouldRebuildSnapshot(cachedSnapshot, [], 0), false)
})
