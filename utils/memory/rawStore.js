/**
 * 群消息原文的文件后端（NDJSON，按群按天）
 *
 * 布局：`<baseDir>/<群号>/<YYYY-MM-DD>.ndjson`，一行一条 JSON，字段与 redis 版原文 payload 一致。
 *
 * 约定：
 * - 只追加；读取按日期文件逐行解析，坏行跳过并计数（一次 warn），不影响其余行
 * - 日期取**消息时间的北京时间**，与提炼窗口（dailyTask）同口径，不依赖宿主时区
 * - 写入经 `this.q` 串行化：并发 append 不会交错写出半行
 * - 单实例假设：多实例同时写同一群目录不做并发控制（文档已注明，本期不支持多实例）
 * - 只用 `node:fs` / `node:path`，不引入依赖
 */

import fs from 'node:fs'
import path from 'node:path'

/** 北京时间偏移（中国无夏令时） */
const BJT_OFFSET = 8 * 3600 * 1000
const DAY_SEC = 86400
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/

/**
 * 秒级时间戳 → 北京时间自然日 YYYY-MM-DD
 * 与 `dailyTask.dayKey`、`store.dayKeyOf` 同口径：文件分天、提炼窗口、游标都用同一个日期键。
 */
export function dayKeyOf(tsSec) {
  const d = new Date(Number(tsSec) * 1000 + BJT_OFFSET)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 北京时间日期键 → 该日 00:00 的秒级时间戳 */
function dayStartSec(day) {
  return Math.floor(Date.parse(`${day}T00:00:00+08:00`) / 1000)
}

export class RawStore {
  /**
   * @param {Object} [options]
   * @param {string} [options.baseDir] 原文根目录，默认 `<cwd>/data/chatgpt/memory/raw`；测试注入 fs.mkdtemp 的临时目录
   */
  constructor({ baseDir } = {}) {
    this.baseDir = baseDir || path.join(process.cwd(), 'data', 'chatgpt', 'memory', 'raw')
    /** 追加队列：`this.q = this.q.then(...)` 保证同进程内写入串行 */
    this.q = Promise.resolve()
  }

  groupDir(groupId) {
    return path.join(this.baseDir, String(groupId))
  }

  /** 追加一条原文；返回值是这一行落盘完成的 promise（调用方可以 await） */
  append(groupId, row) {
    // payload 与 redis 版逐字段一致（time 缺失记 0），只用「当天」做文件名：
    // T-06 的迁移校验要比对两边内容，任何一处规范化都会让比对出现假差异
    const payload = { ...row, time: Number(row.time) || 0 }
    const day = dayKeyOf(payload.time || Math.floor(Date.now() / 1000))
    const line = `${JSON.stringify(payload)}\n`
    const file = path.join(this.groupDir(groupId), `${day}.ndjson`)
    // 队列复位：上一次写失败（磁盘瞬时打满等）不能毒化后续所有写入，
    // 先 catch 掉历史的 rejection 再串本次；本次的异常仍然抛给 await 的调用方。
    this.q = this.q.catch(() => {}).then(async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.appendFile(file, line, 'utf8')
    })
    return this.q
  }

  /** 已有的群目录（文件模式清理/清空用；目录不存在返回空数组） */
  async listGroups() {
    try {
      const entries = await fs.promises.readdir(this.baseDir, { withFileTypes: true })
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      return []
    }
  }

  /** 该群已有的日期文件（升序，只认 `YYYY-MM-DD.ndjson`） */
  async days(groupId) {
    let names = []
    try {
      names = await fs.promises.readdir(this.groupDir(groupId))
    } catch {
      return [] // 目录还不存在 = 没有原文
    }
    return names
      .map(name => DAY_FILE_RE.exec(name)?.[1])
      .filter(Boolean)
      .sort()
  }

  /**
   * 读取单个日期文件里落在 [fromSec, toSec] 的行；坏行跳过并计数
   * @param {Set<string>} seen 已返回过的 messageId（跨天共用）：redis 版 `set` 是幂等覆盖，
   *   文件版是追加，重复开启补录会把同一批消息再写一遍，必须在读取侧按 messageId 去重
   */
  async _readDay(groupId, day, fromSec, toSec, skipped, seen) {
    const file = path.join(this.groupDir(groupId), `${day}.ndjson`)
    let content = ''
    try {
      content = await fs.promises.readFile(file, 'utf8')
    } catch {
      return []
    }
    const rows = []
    // 缓冲读快于 readline 流式（逐行 I/O 分片成本高于收益），勿改回流式；
    // 单日文件上限远小于「解析会卡住事件循环」的量级，不在这里手工切片。
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      let row = null
      try {
        row = JSON.parse(line)
      } catch {
        skipped.count++
        continue
      }
      const time = Number(row?.time) || 0
      if (time < fromSec || time > toSec) continue
      const id = row?.messageId === undefined || row?.messageId === null ? '' : String(row.messageId)
      if (id) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      rows.push(row)
    }
    return rows
  }

  /**
   * 读取某群 [fromSec, toSec] 内的原文，按时间升序（跨天文件按日期升序拼接）
   * 坏行只丢自己：整次读取不会因为一行坏数据失败。
   */
  async readRange(groupId, fromSec, toSec) {
    const from = Number(fromSec) || 0
    const to = Number.isFinite(Number(toSec)) ? Number(toSec) : Number.MAX_SAFE_INTEGER
    const skipped = { count: 0 }
    const seen = new Set()
    const rows = []
    for (const day of await this.days(groupId)) {
      const start = dayStartSec(day)
      // 整个日期文件都在范围外就跳过，避免无谓读盘
      if (start > to || start + DAY_SEC - 1 < from) continue
      rows.push(...await this._readDay(groupId, day, from, to, skipped, seen))
    }
    if (skipped.count > 0) {
      logger?.warn?.(`[MemoryV2] 群 ${groupId} 的原文文件有 ${skipped.count} 行无法解析，已跳过`)
    }
    rows.sort((a, b) => a.time - b.time)
    return rows
  }

  /**
   * 最近的原文（时间倒序），供 #at图谱 使用
   * 与 redis 版同口径：最多 limit 条、`limited` 表示还有更多、`limit` 原样回传。
   */
  async readRecent(groupId, endTime, limit = 20000) {
    const to = Number.isFinite(Number(endTime)) ? Number(endTime) : Number.MAX_SAFE_INTEGER
    const skipped = { count: 0 }
    const seen = new Set()
    const rows = []
    const days = (await this.days(groupId)).reverse() // 新→旧，够 limit 条就停
    for (const day of days) {
      if (dayStartSec(day) > to) continue
      const dayRows = await this._readDay(groupId, day, 0, to, skipped, seen)
      dayRows.sort((a, b) => b.time - a.time)
      rows.push(...dayRows)
      if (rows.length > limit) break
    }
    if (skipped.count > 0) {
      logger?.warn?.(`[MemoryV2] 群 ${groupId} 的原文文件有 ${skipped.count} 行无法解析，已跳过`)
    }
    return { rows: rows.slice(0, limit), limited: rows.length > limit, limit }
  }

  /**
   * 该群原文的**物理行数**（按非空行计，含重复 messageId）
   *
   * 注意与读取侧的区别：`readRange` 会按 messageId 去重（补录重复只算一次）。
   * 迁移脚本要与 Redis `rawIdx` 成员数对账时，用 `readRange(...)` 的长度才是「消息条数」口径；
   * 这里保留行数口径，用于发现重复追加造成的文件膨胀。
   */
  async count(groupId) {
    let total = 0
    for (const day of await this.days(groupId)) {
      const file = path.join(this.groupDir(groupId), `${day}.ndjson`)
      try {
        total += (await fs.promises.readFile(file, 'utf8')).split('\n').filter(line => line.trim()).length
      } catch { /* 文件刚被清理：跳过 */ }
    }
    return total
  }

  /**
   * 删除过期日期文件
   * - `retentionDays <= 0` → 永久保留，一条不删
   * - 只删「整个日期都早于截止点」的文件（当天文件整只保留，宁可多留一天也不误删）
   * @returns {Promise<number>} 删除的原文条数
   */
  async cleanup(groupId, retentionDays, now = Date.now()) {
    if (!(Number(retentionDays) > 0)) return 0
    const cutoffDay = dayKeyOf(now / 1000 - Number(retentionDays) * DAY_SEC)
    let removed = 0
    for (const day of await this.days(groupId)) {
      if (day >= cutoffDay) continue
      const file = path.join(this.groupDir(groupId), `${day}.ndjson`)
      try {
        removed += (await fs.promises.readFile(file, 'utf8')).split('\n').filter(line => line.trim()).length
        await fs.promises.unlink(file)
      } catch { /* 并发删除：忽略 */ }
    }
    return removed
  }

  /** 删除整群目录（clearGroup 用）；目录不存在不报错 */
  async removeGroup(groupId) {
    await fs.promises.rm(this.groupDir(groupId), { recursive: true, force: true })
  }
}
