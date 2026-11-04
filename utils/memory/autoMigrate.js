/**
 * 面板把「原文存储后端」切到文件时，后台自动完成迁移并切配置。
 *
 * 为什么要自动：手动流程要求主人先在群里发迁移指令、再回面板切换，
 * 两次操作之间新采集的原文会落在另一个后端，最容易出现「切过去发现历史少了」。
 *
 * 时序（关键）：
 *   1. 面板保存时先把 memoryStorage 落回 redis（新消息继续写 Redis，不丢）
 *   2. 本模块跑一遍全量迁移，再跑一遍增量（补第 1 步之后写入的新消息，幂等）
 *   3. 两次都成功后把 memoryStorage 切到 file
 *   4. 任一步失败：保持 redis，不改配置，通知主人
 *
 * 迁移期间读原文仍走 Redis，数据是完整的；切到 file 的那一刻文件里已有全量副本。
 */
import { Config } from '../config.js'
import { MemoryStore } from './store.js'
import { runMigration } from './migrateRawToFile.js'
import { acquireHeavyTask, releaseHeavyTask, heavyTaskOwner } from './heavyTask.js'

const LOCK_LABEL = '原文迁移（面板切换）'

/**
 * @param {Object} [options]
 * @param {Object} [options.store] 注入用；默认 `new MemoryStore()`
 * @param {Object} [options.rawStore] 注入用；默认取 store.rawStore
 * @param {Function} [options.notify] 结果通知（接 QQ 或日志）
 * @param {Function} [options.saveConfig] 注入用；默认 `Config.save()`
 * @returns {Promise<{ok: boolean, appended?: number, failed?: Array, reason?: string, error?: any}>}
 */
export async function migrateRawOnSwitch({ store, rawStore, notify, saveConfig } = {}) {
  if (!acquireHeavyTask(LOCK_LABEL)) {
    notify?.(`已有「${heavyTaskOwner()}」在跑，本次切换未执行；等它结束后重新保存一次即可`)
    return { ok: false, reason: 'busy' }
  }
  const save = saveConfig || (() => Config.save())
  try {
    const s = store || new MemoryStore()
    const rs = rawStore || s.rawStore
    const first = await runMigration({ store: s, rawStore: rs })
    // 再跑一遍：补第一次快照之后新落 Redis 的消息；已迁过的按 messageId 跳过，不会重复写
    const second = await runMigration({ store: s, rawStore: rs })
    const failed = [...(first.failed || []), ...(second.failed || [])]
    const appended = (first.appended || 0) + (second.appended || 0)
    Config.memoryStorage = 'file'
    save()
    notify?.(failed.length
      ? `⚠️ 已切到文件后端，${appended} 条已迁移；但 ${failed.length} 个群未迁完（${failed.slice(0, 5).map(f => f.groupId).join('、')}），这些群的历史仍在 Redis`
      : `✅ 已切到文件后端：${first.groups.length} 个群、迁移 ${appended} 条`)
    return { ok: true, appended, failed }
  } catch (err) {
    // 失败不切配置：继续用 Redis，数据一条不动
    Config.memoryStorage = 'redis'
    save()
    notify?.(`❌ 迁移失败，已保持 Redis 后端：${err?.message || err}`)
    return { ok: false, error: err }
  } finally {
    releaseHeavyTask()
  }
}

/** 面板保存时调用：不阻塞保存响应，后台跑完再切 */
export function scheduleRawMigration(options) {
  setImmediate(() => {
    migrateRawOnSwitch(options).catch(() => { /* 内部已通知并回滚，这里只防未捕获拒绝 */ })
  })
}
