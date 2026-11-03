/**
 * Redis → 文件 原文迁移（T-06，只加不删 + 校验）
 *
 * 运行：node --experimental-test-module-mocks --test test/memoryMigration.test.js
 *
 * 为什么是指令而不是独立脚本：独立进程拿不到云崽运行时的 Redis 客户端，
 * 自己 new 一个就是新增依赖。迁移逻辑放在这个模块里，指令层只负责排版与二次确认。
 *
 * 口径（与设计审查一致）：
 * - Redis 条数 = `rawIdx` 里逐条 get、跳过已过期（null）后计数 —— 不是 `zCard`
 * - 文件条数 = `readRange(...)` 去重后的长度 —— 不是 `count()`（那是物理行数）
 * - 只 append 缺少的 messageId，绝不 DEL / FLUSHDB / KEYS
 * - 某群不一致就整群跳过（先算清再写），其他群继续
 * - 路径完全由调用方注入的 rawStore 决定，模块里没有第二套路径计算
 */

const MAX_SEC = Number.MAX_SAFE_INTEGER
/** 校验逐字段比对的字段（与工单一致） */
const VERIFY_FIELDS = ['time', 'text']

const idOf = row => String(row?.messageId ?? '')
const fieldOf = (row, field) => (field === 'time' ? Number(row?.time) || 0 : String(row?.[field] ?? ''))

/** messageId → row（同一 id 出现多次时保留第一条，与读取侧去重口径一致） */
function indexById(rows) {
  const map = new Map()
  for (const row of rows) {
    const id = idOf(row)
    if (id && !map.has(id)) map.set(id, row)
  }
  return map
}

/** 两侧一起读：Redis 永远读 Redis（不看 memoryStorage），文件读 rawStore */
async function readBothSides(store, rawStore, groupId) {
  const [redisRows, fileRows] = await Promise.all([
    store.getRawMessagesFromRedis(groupId, 0, MAX_SEC),
    rawStore.readRange(groupId, 0, MAX_SEC),
  ])
  return { redisRows, fileRows }
}

/** dbsize 只在客户端支持时取；任何异常都当成「取不到」 */
async function safeDbsize(redis) {
  try {
    return typeof redis?.dbsize === 'function' ? await redis.dbsize() : null
  } catch {
    return null
  }
}

const RAW_KEY_PREFIX = 'CHATGPT:MEMORY:V2:raw:'

/**
 * 扫 `raw:*` 里实际存在的原文 id，按群分组。
 *
 * 为什么不能只信 `rawIdx`：索引成员会因重建/清理/写入中断而缺失，但原文键还在
 * （2026-11-04 实测 343,355 条里有 18,197 条属于这种孤儿，只按索引迁移就会永久漏掉）。
 * 单次全量 SCAN，O(键数) 只付一次；值在真正缺失时才 GET。
 */
async function scanRawIds(redis) {
  const map = new Map()
  if (!redis?.scanIterator) return map
  for await (const key of redis.scanIterator({ MATCH: `${RAW_KEY_PREFIX}*`, COUNT: 1000 })) {
    const parts = String(key).split(':')
    const mid = parts[parts.length - 1]
    const gid = parts[parts.length - 2]
    if (!gid || !mid) continue
    if (!map.has(gid)) map.set(gid, new Set())
    map.get(gid).add(mid)
  }
  return map
}

/**
 * 预览：只统计两侧条数，不做任何写入
 * @returns {Promise<{groups: Array<{groupId: string, redisCount: number, fileCount: number}>, totals: Object, at: number}>}
 */
export async function planMigration({ store, rawStore, now = Date.now() }) {
  const groupIds = await store.listGroupsWithRaw()
  const groups = []
  for (const groupId of groupIds) {
    const { redisRows, fileRows } = await readBothSides(store, rawStore, groupId)
    groups.push({ groupId, redisCount: redisRows.length, fileCount: fileRows.length })
  }
  const totals = {
    groups: groups.length,
    redisCount: groups.reduce((n, g) => n + g.redisCount, 0),
    fileCount: groups.reduce((n, g) => n + g.fileCount, 0),
    toAppend: groups.reduce((n, g) => n + Math.max(0, g.redisCount - g.fileCount), 0),
  }
  return { groups, totals, at: now }
}

/**
 * 执行迁移：按群「先算清、再写入」，只 append 缺少的 messageId
 *
 * 不一致的判定（整群跳过，不动它的文件）：
 * - 同一 messageId 两侧 time/text 不一致（追加只会造出同 id 两个版本，读取侧去重后仍然是旧的）
 * - 文件里「多出」Redis 没有的 messageId 不算冲突：那是切到文件模式后新采集的数据，追加旧行不会串味
 *
 * @param {Function} [onProgress] 每处理完一个群回调一次 `{groupId, status, appended, skipped, reason?}`
 * @returns {Promise<{groups: Array, appended: number, skipped: number, failed: Array, dbsize: Object, at: number}>}
 */
export async function runMigration({ store, rawStore, now = Date.now(), onProgress } = {}) {
  const dbsizeBefore = await safeDbsize(store.redis)
  // 索引外的孤儿原文只扫一次；没有 scanIterator 的 mock 返回空 Map，行为与旧版一致
  const rawIds = await scanRawIds(store.redis)
  const groupIds = await store.listGroupsWithRaw()
  const groups = []
  const failed = []
  let appended = 0
  let skipped = 0

  for (const groupId of groupIds) {
    let progress = { groupId, status: 'ok', appended: 0, skipped: 0 }
    try {
      const { redisRows, fileRows } = await readBothSides(store, rawStore, groupId)
      const redisMap = indexById(redisRows)
      const fileMap = indexById(fileRows)

      // 文件里多出的 messageId 不是错误：那是切到文件模式后新采集的数据。
      // 只按 messageId 追加 Redis 有、文件没有的旧行，不会串味；同 id 不同内容才是真冲突。
      const changed = [...fileMap.keys()].filter(id => {
        const redisRow = redisMap.get(id)
        return redisRow && VERIFY_FIELDS.some(field => fieldOf(redisRow, field) !== fieldOf(fileMap.get(id), field))
      })
      if (changed.length > 0) {
        progress = { groupId, status: 'failed', appended: 0, skipped: 0, reason: `文件里 ${changed.length} 条与 Redis 内容不一致（同 messageId 不同内容），本群未写入` }
      } else {
        const missing = [...redisMap.values()].filter(row => !fileMap.has(idOf(row)))
        // 索引缺失的孤儿原文：raw:* 里有、rawIdx 里没有，只按索引会永久漏掉这段历史
        const orphanIds = [...(rawIds.get(groupId) || [])].filter(id => !redisMap.has(id) && !fileMap.has(id))
        for (const id of orphanIds) {
          const raw = await store.redis.get(`${RAW_KEY_PREFIX}${groupId}:${id}`)
          if (!raw) continue
          try {
            const row = JSON.parse(raw)
            missing.push(row)
            redisMap.set(id, row)
          } catch { /* 坏记录跳过，与读取侧一致 */ }
        }
        // 逐条 append：走 rawStore 自己的串行队列，避免与在线采集并发写坏行。
        // 每次 append 内部都是 mkdir/appendFile 的异步 I/O，循环本身已让出事件循环，无需额外切片。
        for (const row of missing) await rawStore.append(groupId, row)
        appended += missing.length
        skipped += redisMap.size - missing.length
        progress = { groupId, status: 'ok', appended: missing.length, skipped: redisMap.size - missing.length }
      }
    } catch (err) {
      progress = { groupId, status: 'failed', appended: 0, skipped: 0, reason: String(err?.message || err).slice(0, 200) }
    }
    if (progress.status === 'failed') failed.push({ groupId, reason: progress.reason })
    groups.push(progress)
    if (typeof onProgress === 'function') onProgress(progress)
  }

  const dbsizeAfter = await safeDbsize(store.redis)
  return {
    groups,
    appended,
    skipped,
    failed,
    // 只加不删：dbsize 若变小，说明有 TTL 到期或其他进程在删，需要主人知情（不阻断迁移）
    dbsize: { before: dbsizeBefore, after: dbsizeAfter, dropped: dbsizeBefore !== null && dbsizeAfter !== null && dbsizeAfter < dbsizeBefore },
    at: now,
  }
}

/**
 * 校验：双读比对 messageId 是否存在，并按需逐字段比对 time / text
 * 存在性检查覆盖全部行（便宜），字段比对最多 `sample` 条（省 IO）
 * @returns {Promise<{ok: boolean, checked: number, diffs: Array, at: number}>}
 */
export async function verifyMigration({ store, rawStore, now = Date.now(), sample = 100 } = {}) {
  const groupIds = await store.listGroupsWithRaw()
  const diffs = []
  let checked = 0

  for (const groupId of groupIds) {
    const { redisRows, fileRows } = await readBothSides(store, rawStore, groupId)
    const redisMap = indexById(redisRows)
    const fileMap = indexById(fileRows)

    for (const id of redisMap.keys()) {
      if (!fileMap.has(id)) diffs.push({ groupId, messageId: id, kind: 'missing-in-file' })
    }
    for (const id of fileMap.keys()) {
      if (!redisMap.has(id)) diffs.push({ groupId, messageId: id, kind: 'extra-in-file' })
    }
    for (const [id, fileRow] of fileMap) {
      const redisRow = redisMap.get(id)
      if (!redisRow || checked >= sample) continue
      checked++
      for (const field of VERIFY_FIELDS) {
        const expected = fieldOf(redisRow, field)
        const actual = fieldOf(fileRow, field)
        if (expected !== actual) diffs.push({ groupId, messageId: id, kind: 'changed', field, redis: expected, file: actual })
      }
    }
  }

  return { ok: diffs.length === 0, checked, diffs, at: now }
}
