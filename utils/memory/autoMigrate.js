/**
 * 面板把「原文存储后端」切到文件时，后台自动完成迁移并切配置。
 *
 * 为什么要自动：手动流程要求主人先在群里发迁移指令、再回面板切换，
 * 两次操作之间新采集的原文会落在另一个后端，最容易出现「切过去发现历史少了」。
 *
 * 时序（关键）：
 *   1. 面板保存时先把 memoryStorage 落回 redis（新消息继续写 Redis，不丢）
 *   2. 本模块跑一遍全量迁移，再跑一遍增量（补第 1 步之后写入的新消息，幂等）
 *   3. 两次都成功**且没有群失败**才切到 file
 *   4. 任一步失败：保持 redis，不改配置，通知主人
 *
 * 为什么「有群失败也不切」：runMigration 是逐群 try/catch，它只把失败记进 failed、从不抛错。
 * 一旦带着失败切到 file，file 模式的读路径只读文件、不回退 Redis，那些群的历史会当场读不到，
 * 而 Redis 里其实是完整的——主人看到「已切到文件」就再也不会去救它。
 */
import { Config } from '../config.js'
import { MemoryStore } from './store.js'
import { runMigration } from './migrateRawToFile.js'
import { acquireHeavyTask, releaseHeavyTask, heavyTaskOwner } from './heavyTask.js'

const LOCK_LABEL = '原文迁移（面板切换）'

/** 通知失败不能影响迁移结果：拿不到主人 QQ、发送超时都只是少一条消息 */
function safeNotify(notify, text) {
  if (!notify) return
  try {
    notify(text)
  } catch (err) {
    logger?.warn?.(`[MemoryV2] 迁移通知发送失败（不影响结果）：${err?.message || err}`)
  }
}

/** 写配置失败不推翻已经落盘的数据：文件那边已是完整副本，内存值也对，下次保存会重试 */
function commitStorage(value, save) {
  try {
    Config.memoryStorage = value
  } catch (err) {
    logger?.warn?.(`[MemoryV2] 写 memoryStorage=${value} 失败：${err?.message || err}`)
  }
  try {
    save()
  } catch (err) {
    logger?.warn?.(`[MemoryV2] 保存配置失败（不影响已迁移数据）：${err?.message || err}`)
  }
}

/** 两遍各自返回一次群列表，合并去重后才是这次实际覆盖的群数 */
function groupCount(...passes) {
  const ids = new Set()
  for (const pass of passes) for (const g of pass?.groups || []) ids.add(g.groupId)
  return ids.size
}

/**
 * @param {Object} [options]
 * @param {Object} [options.store] 注入用；默认 `new MemoryStore()`
 * @param {Object} [options.rawStore] 注入用；默认取 store.rawStore
 * @param {Function} [options.notify] 结果通知（接 QQ 或日志）
 * @param {Function} [options.saveConfig] 注入用；默认 `Config.save()`
 * @returns {Promise<{ok: boolean, appended?: number, failed?: Array, reason?: string, error?: any}>}
 */
export async function migrateRawOnSwitch(options = {}) {
  // 已经是文件后端就直接返回：再跑两遍是几分钟的浪费，而失败分支会把配置写回 redis——
  // file 模式下 Redis 里的原文可能早被清理过（#记忆存储 清理），这一降级会让历史整体读不到
  if (Config.memoryStorage === 'file') {
    safeNotify(options.notify, '当前已经是文件后端，无需迁移')
    return { ok: true, reason: 'already' }
  }
  if (!acquireHeavyTask(LOCK_LABEL)) {
    safeNotify(options.notify, `已有「${heavyTaskOwner()}」在跑，本次切换未执行；等它结束后重新保存一次即可`)
    return { ok: false, reason: 'busy' }
  }
  try {
    return await migrateAndSwitch(options)
  } finally {
    releaseHeavyTask()
  }
}

async function migrateAndSwitch({ store, rawStore, notify, saveConfig } = {}) {
  const save = saveConfig || (() => Config.save())

  let first
  let second
  try {
    const s = store || new MemoryStore()
    const rs = rawStore || s.rawStore
    first = await runMigration({ store: s, rawStore: rs })
    second = await runMigration({ store: s, rawStore: rs })
  } catch (err) {
    // 迁移本身抛错：一条数据都不动，继续用 Redis
    commitStorage('redis', save)
    safeNotify(notify, `❌ 迁移失败，已保持 Redis 后端：${err?.message || err}`)
    return { ok: false, error: err }
  }

  // 同一个群两遍都失败只算一次：否则文案会写成「2 个群未迁完（300、300）」，把一处故障说成两处
  const failedByGroup = new Map()
  for (const f of [...(first.failed || []), ...(second.failed || [])]) failedByGroup.set(f.groupId, f)
  const failed = [...failedByGroup.values()]
  const appended = (first.appended || 0) + (second.appended || 0)

  if (failed.length > 0) {
    const groups = failed.slice(0, 5).map(f => f.groupId).join('、')
    commitStorage('redis', save)
    safeNotify(notify, `❌ ${failed.length} 个群未迁完（${groups}），已保持 Redis 后端，历史都能读；稍后重新保存一次会重试`)
    return { ok: false, failed, appended }
  }

  commitStorage('file', save)
  safeNotify(notify, `✅ 已切到文件后端：${groupCount(first, second)} 个群、迁移 ${appended} 条`)
  return { ok: true, appended, failed }
}

/** 面板保存时调用：不阻塞保存响应，后台跑完再切 */
export function scheduleRawMigration(options) {
  setImmediate(() => {
    migrateRawOnSwitch(options).catch(() => { /* 内部已通知并回滚，这里只防未捕获拒绝 */ })
  })
}
