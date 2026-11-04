/**
 * 重任务互斥锁：迁移 / 校验 / 清理 / 立即提取 同时只允许一个。
 *
 * 为什么需要：这些操作要遍历几十个群、几十万条原文，耗时几分钟，用户看不到反馈就会重复触发。
 * 重复不加快，反而会让两次迁移各持一份「文件已有 id」快照，把同一批行写两遍
 * （2026-11-04 实测连发两次确认多写了 78,673 行）。
 *
 * 放在独立模块：面板切换触发的自动迁移（utils/memory/autoMigrate.js）与群指令
 * （apps/memoryManage.js）必须共用同一把锁，否则两边并发同样会重复写。
 */
let owner = ''

export function acquireHeavyTask(label) {
  if (owner) return false
  owner = label
  return true
}

export function releaseHeavyTask() {
  owner = ''
}

/** 当前持锁者（空串表示空闲） */
export function heavyTaskOwner() {
  return owner
}
