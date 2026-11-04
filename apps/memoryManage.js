import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'
import { makeForwardMsg } from '../utils/common.js'
import { getStore } from '../utils/memory/v2.js'
import { MemoryStore, normalizeRetentionDays } from '../utils/memory/store.js'
import { RawStore } from '../utils/memory/rawStore.js'
import { planMigration, runMigration, verifyMigration } from '../utils/memory/migrateRawToFile.js'
import { groupCapture } from '../utils/memory/capture.js'
import { dailyConsolidation, normalizeCron } from '../utils/memory/dailyTask.js'
import { MEMORY_INPUT_TOKEN_LIMIT } from '../utils/memory/extractor.js'
import { acquireHeavyTask, releaseHeavyTask, heavyTaskOwner } from '../utils/memory/heavyTask.js'
import { RECALL_MODE_ALL } from '../utils/memory/recallMode.js'
import { findProvider, providerLabel } from '../utils/providerProfiles.js'
import { canDeleteOwnMemory } from '../utils/memory/policy.js'

const KIND_LABELS = {
  identity: '身份',
  preference: '偏好',
  relationship: '关系',
  plan: '计划',
  group_rule: '群规则',
  experience: '经历',
  episode: '事件'
}

const SCOPE_LABELS = {
  user: '🌐跨群个人',
  user_group: '👥本群个人',
  group: '🏘️群公共'
}

/** #清理无效记忆 单轮最多处理的群数：超出部分提示再执行一次 */
const PURGE_MAX_GROUPS = 50

/**
 * 容量目标与夜间整理阈值：#记忆统计 与 #群记忆状态 共用同一份文案，避免两处各写一遍后漂移。
 * 口径：单个作用域有效条数**严格大于** cap×0.95 才触发，目标 ≤ floor(cap×0.7)。
 */
function capacityLines() {
  return [
    `个人记忆上限：${Config.maxMemoriesPerUser} 条（user / user_group，超 95% 夜间整理至 70%）`,
    `群公共上限：${Config.maxMemoriesPerGroup} 条（每群 group，超 95% 夜间整理至 70%）`,
  ]
}

/** 毫秒时间戳 → YYYY-MM-DD HH:mm（状态展示用，缺失/非法返回空串） */
function formatDateTime(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return ''
  const d = new Date(value)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 保留天数的用户可读文案：0 不是「0 天」而是永久（原文永久保留）。
 * 非法值先归一回默认值，避免把 NaN 或「0 天」这种自相矛盾的话发给用户。
 */
function formatRetentionDays(value, fallback) {
  const days = normalizeRetentionDays(value, fallback)
  return days === 0 ? '永久保留' : `${days} 天`
}

/** 召回模式的用户可读名：空串=仅文字匹配，all=按权重导入，current/接口 ID=模型判断 */
function recallModeLabel(value) {
  if (!value) return '仅文字匹配'
  if (value === RECALL_MODE_ALL) return '按权重导入（个人:群公共≈9:1 填满上限）'
  if (value === 'current') return '跟随全局对话模型判断'
  const row = findProvider(Config.getConfig(), value)
  // 接口被删除/改 id 时配置校验会拦住，但状态展示不能因此抛错
  return `指定接口判断（${row ? providerLabel(row) : `已失效的接口 ${value}`}）`
}

export class memoryManage extends plugin {
  constructor(e) {
    super({
      name: 'ChatGPT-Plugin 记忆管理',
      dsc: 'V2 记忆系统管理：查看、删除、清空记忆；群记忆采集指令与每日批量提炼',
      event: 'message',
      // 数字越小优先级越高（TRSS 升序调度）：500 < chat.js(1144)
      priority: 500,
      rule: [
        {
          reg: '^#我的记忆$',
          fnc: 'myMemories'
        },
        {
          reg: '^#群记忆$',
          fnc: 'groupMemories'
        },
        {
          reg: '^#群记忆开启$',
          fnc: 'enableGroupMemory',
          permission: 'master'
        },
        {
          reg: '^#群记忆关闭$',
          fnc: 'disableGroupMemory',
          permission: 'master'
        },
        {
          reg: '^#群记忆状态$',
          fnc: 'groupMemoryStatus',
          permission: 'master'
        },
        {
          reg: '^#立即提取群记忆$',
          fnc: 'extractGroupMemoryNow',
          permission: 'master'
        },
        {
          reg: '^#记忆任务运行$',
          fnc: 'runDailyDebug',
          permission: 'master'
        },
        {
          reg: '^#清理无效记忆(\\s*预览)?$',
          fnc: 'purgeInvalidMemories',
          permission: 'master'
        },
        {
          reg: '^#记忆迁移到文件(\\s*(预览|校验))?$',
          fnc: 'migrateRawToFile',
          permission: 'master'
        },
        {
          reg: '^#记忆存储(\\s*(文件|redis|清理))?$',
          fnc: 'memoryStorage',
          permission: 'master'
        },
        {
          reg: '^#(他|她|TA|ta)的记忆',
          fnc: 'otherMemories',
          permission: 'master'
        },
        {
          reg: '^#清空(他|她|TA|ta)的记忆',
          fnc: 'clearOtherMemories',
          permission: 'master'
        },
        {
          // 不能标 permission: 'master'——成员自助删除开启时它是给所有人用的；
          // 关闭时由处理函数按 allowMemberDeleteOwnMemory 拒绝非主人（rule 是加载期静态注册，
          // 判定必须放在运行期的处理函数里才能跟随锅巴开关实时生效）
          reg: '^#清空我的记忆$',
          fnc: 'clearMyMemories'
        },
        {
          reg: '^#删除记忆',
          fnc: 'deleteMemory',
          permission: 'master'
        },
        {
          reg: '^#清空所有记忆$',
          fnc: 'clearAllMemories',
          permission: 'master'
        },
        {
          reg: '^#记忆统计',
          fnc: 'memoryStats',
          permission: 'master'
        },
        {
          reg: '^#记忆帮助$',
          fnc: 'memoryHelp',
          permission: 'master'
        }
      ]
    })

    this.task = {
      name: '记忆每日提炼',
      cron: normalizeCron(Config.memoryGroupCapture?.cronTime),
      fnc: this.runDaily.bind(this)
    }
  }

  /* ================= 群记忆管理指令（原 groupMemoryManage） ================= */

  /** 开启当前群记忆（授权 + 补录最近24h最多500条，需二次确认） */
  async enableGroupMemory(e) {
    if (!e.isGroup || !e.group_id) {
      await this.reply('此命令仅在群聊中可用', true)
      return
    }
    await this.reply(
      `⚠️ 确定要开启本群记忆采集吗？\n` +
      `将授权采集本群的非Bot消息（含 # 开头的指令，指令只记录、不参与提炼；原文保留 ${formatRetentionDays(Config.memoryGroupCapture?.rawRetentionDays, 30)}）\n` +
      `并补录最近 24 小时、最多 500 条可获取的历史消息，用于每日批量提炼\n` +
      `回复"是"确认，回复其他内容取消`,
      true
    )
    const e_new = await this.awaitContext()
    if (!e_new.msg || !(/^(是|y|yes|确定|确认)$/i).test(e_new.msg.trim())) {
      await this.reply('操作已取消', true)
      return
    }
    const result = await groupCapture.enableGroup(e)
    await this.reply(result.message, true)
  }

  /** 关闭当前群记忆（只停采集 + 打关闭标记，不删数据，需二次确认） */
  async disableGroupMemory(e) {
    if (!e.isGroup || !e.group_id) {
      await this.reply('此命令仅在群聊中可用', true)
      return
    }
    const store = getStore()
    const gid = String(e.group_id)
    const retentionDays = normalizeRetentionDays(Config.memoryGroupCapture?.closedGroupRetentionDays, 90)
    // 明确告知保留什么、多久后清理，避免用户以为关闭等于删除
    let warn = `⚠️ 确定要关闭本群记忆采集吗？\n`
    try {
      const raws = await store.getRawMessages(gid, 0, Math.floor(Date.now() / 1000) + 86400).catch(() => [])
      const memories = await store.countGroupMemories(gid)
      warn += `本群现有原文 ${raws.length} 条、记忆 ${memories} 条，关闭后都原样保留\n`
    } catch { /* 统计失败不阻塞确认 */ }
    warn += retentionDays > 0
      ? `关闭后只停止采集，不会删除任何数据；这些数据会在 ${retentionDays} 天后由每日任务自动清理\n`
      : `关闭后只停止采集，不会删除任何数据；当前「关闭后保留天数」为 0，不会自动清理\n`
    warn += `要立即清理请用 #清理无效记忆\n回复"是"确认，回复其他内容取消`
    await this.reply(warn, true)

    const e_new = await this.awaitContext()
    if (!e_new.msg || !(/^(是|y|yes|确定|确认)$/i).test(e_new.msg.trim())) {
      await this.reply('操作已取消', true)
      return
    }
    const result = await groupCapture.disableGroup(e)
    await this.reply(result.message, true)
  }

  /** 查看群记忆状态 */
  async groupMemoryStatus(e) {
    const store = getStore()
    const gid = e.group_id ? String(e.group_id) : ''
    const groups = Array.isArray(Config.memoryGroupCapture?.groups) ? Config.memoryGroupCapture.groups : []
    const authorized = groups.filter(g => g && g.groupId && g.switchOn)
    const currentAuthorized = authorized.some(g => String(g.groupId) === gid)

    const stats = await store.stats().catch(() => ({ total: 0, byScope: {} }))
    const cfg = Config.memoryGroupCapture || {}

    let lines = []
    lines.push('🧠 V2 记忆系统状态')
    lines.push(`总开关(启用记忆系统)：${Config.enableMemory ? '✅ 已启用' : '❌ 未启用'}`)
    lines.push(`授权采集群：${authorized.length > 0 ? authorized.map(g => g.groupId).join('、') : '（无，可在群内 #群记忆开启）'}`)
    if (gid) {
      lines.push(`本群：${currentAuthorized ? '✅ 已授权采集' : '❌ 未授权'}`)
    }
    lines.push(`每日提炼时间：${cfg.cronTime || '0 0 4 * * ? *'}（修改后重启生效）`)
    // eventRetentionDays 的 0 不是有效值（运行时 Number(...) || 90 会回退），展示成实际生效的 90
    const eventDays = Number(cfg.eventRetentionDays) > 0 ? Math.trunc(Number(cfg.eventRetentionDays)) : 90
    lines.push(`原文保留：${formatRetentionDays(cfg.rawRetentionDays, 30)} | 事件保留：${eventDays} 天（临时 episode/plan 的默认有效期）`)
    // 关闭采集的群与上次到期清理结果：meta 由每日任务写入，从未跑过就显示「暂无」
    let closedInfo = '关闭中：暂无 | 上次清理：暂无'
    try {
      const meta = await store.getMeta()
      const closedCount = await store.countClosedGroups(authorized.map(g => g.groupId))
      const lastSweepAt = formatDateTime(meta.lastSweepAt)
      const lastSweep = lastSweepAt ? `${lastSweepAt} / 清理 ${Number(meta.lastSweepPurged || 0)} 个群` : '暂无'
      closedInfo = `关闭中：${closedCount} 个群 | 上次清理：${lastSweep}`
    } catch { /* 统计失败不能让状态指令整体不可用 */ }
    lines.push(`关闭后保留：${normalizeRetentionDays(cfg.closedGroupRetentionDays, 90)} 天（0 = 不自动清理） | ${closedInfo}`)
    lines.push(`提取 Token：输入 ${MEMORY_INPUT_TOKEN_LIMIT}（常量，不可配置；输出上限跟随模型配置）`)
    lines.push('')
    lines.push('📊 记忆统计（V2）')
    lines.push(`总事实数：${stats.total} 条`)
    lines.push(`  user(跨群)：${stats.byScope?.user || 0} 条`)
    lines.push(`  user_group(本群个人)：${stats.byScope?.user_group || 0} 条`)
    lines.push(`  group(群公共)：${stats.byScope?.group || 0} 条`)
    lines.push('')
    lines.push(...capacityLines())

    if (gid) {
      const tasks = await store.listTasks(gid).catch(() => [])
      const pending = tasks.filter(t => t.status === 'pending').length
      const completed = tasks.filter(t => t.status === 'completed').length
      const failed = tasks.filter(t => t.status === 'failed').length
      lines.push('')
      lines.push(`本群提炼任务：${tasks.length} 个窗口（完成 ${completed} / 待处理 ${pending} / 失败 ${failed}）`)
    }

    await this.reply(lines.join('\n'), true)
  }

  /** 立即提取当前群记忆 */
  async extractGroupMemoryNow(e) {
    if (!e.isGroup || !e.group_id) {
      await this.reply('此命令仅在群聊中可用', true)
      return
    }
    const gid = String(e.group_id)
    if (!acquireHeavyTask('立即提取群记忆')) {
      await this.reply(`「${heavyTaskOwner()}」正在执行，完成会回结果；重复发送不会加快，请等它结束`, true)
      return
    }
    try {
      await this.reply('正在提取本群记忆（含失败任务重试与最近窗口补提炼），请稍候…', true)
      const result = await dailyConsolidation.runImmediate(gid)
      await this.reply(result.message, true)
    } finally {
      releaseHeavyTask()
    }
  }

  /**
   * 立即清理「不在授权采集列表」的群记忆（主人专用，支持「预览」）
   *
   * - `#清理无效记忆 预览`：只列群号与记忆条数，不写任何数据
   * - `#清理无效记忆`：列清单 → 二次确认 → 只清非授权群的记忆
   * - 不删原文（raw:* 归 rawRetentionDays 自动过期），不动 CONVERSATIONS_V2 / MESSAGE
   * - 单轮最多 PURGE_MAX_GROUPS 个群，超出提示再执行一次
   */
  async purgeInvalidMemories(e) {
    if (!Config.enableMemory) {
      await this.reply('记忆系统未启用', true)
      return
    }
    if (!acquireHeavyTask('无效记忆清理')) {
      await this.reply(`「${heavyTaskOwner()}」正在执行，完成会回结果；重复发送不会加快，请等它结束`, true)
      return
    }
    const store = getStore()
    const previewOnly = /预览/.test(String(e.msg || ''))
    try {
      await this.reply('正在统计不在授权列表里的群…（几十个群约需十几秒，完成前请勿重复发送）', true)
      const authorized = MemoryStore.authorizedGroups(Config.memoryGroupCapture?.groups).map(g => g.groupId)
      const { groups, hasMore } = await store.listUnauthorizedGroups(authorized, PURGE_MAX_GROUPS)
      if (groups.length === 0) {
        await this.reply('没有需要清理的群：当前已采集的群都在授权列表里', true)
        return
      }
      const lines = groups.map(g => `群 ${g.groupId}：记忆 ${g.memoryCount} 条`)
      const moreTip = hasMore ? `\n（本轮最多处理 ${PURGE_MAX_GROUPS} 个群，还有更多，清理完请再执行一次）` : ''

      if (previewOnly) {
        await this.reply(
          `🧹 待清理的无效记忆（预览，未删除任何数据）\n${lines.join('\n')}${moreTip}\n` +
          `只清记忆与索引，群原文不受影响（按原文保留天数自然过期）`,
          true
        )
        return
      }

      await this.reply(
        `⚠️ 以下群已不在授权采集列表中，将清空它们的记忆（原文保留）：\n${lines.join('\n')}${moreTip}\n` +
        `此操作不可恢复！回复"是"确认，回复其他内容取消`,
        true
      )
      const e_new = await this.awaitContext()
      if (!e_new.msg || !(/^(是|y|yes|确定|确认)$/i).test(e_new.msg.trim())) {
        await this.reply('操作已取消', true)
        return
      }

      const done = []
      let skipped = 0
      for (const item of groups) {
        // 二次确认期间主人可能在锅巴把群重新勾上：清单是确认前算的，执行前必须重判授权，
        // 否则「先看清单 → 等回复 → 期间授权」这个窗口会把刚恢复的群清掉（TOCTOU）
        if (MemoryStore.isGroupAuthorized(Config.memoryGroupCapture?.groups, item.groupId)) {
          skipped++
          continue
        }
        // 只清记忆与索引：原文归 rawRetentionDays 自然过期，policy 的 lastDailyEnd 也保留（spec D6）
        const result = await store.clearGroupMemories(item.groupId)
        done.push(`群 ${item.groupId}：已清理记忆 ${result.memoryIds} 条`)
        logger.info(`[MemoryV2] 主人 ${e.user_id} 清理无效记忆：群 ${item.groupId} 记忆 ${result.memoryIds} 条`)
      }
      if (done.length === 0) {
        await this.reply(`没有需要清理的群：待清理的 ${skipped} 个群在确认期间已重新授权，未做任何删除`, true)
        return
      }
      const skippedTip = skipped > 0 ? `\n（跳过 ${skipped} 个已重新授权的群）` : ''
      await this.reply(`✅ 已清理 ${done.length} 个群的无效记忆（原文保留）：\n${done.join('\n')}${skippedTip}${moreTip}`, true)
    } catch (err) {
      logger.error('[Memory] 清理无效记忆失败:', err)
      await this.reply('清理无效记忆失败', true)
    } finally {
      releaseHeavyTask()
    }
  }

  /**
   * 把 Redis 里的群原文迁移到文件后端（主人专用，只加不删）
   *
   * - `#记忆迁移到文件 预览`：只统计两侧条数，零写入
   * - `#记忆迁移到文件`：预览 → 二次确认 → 执行（只 append 缺失的 messageId）
   * - `#记忆迁移到文件 校验`：双读比对 messageId / time / text，只报告不写
   *
   * 不自动切换 `memoryStorage`，也不删除 Redis 任何数据；路径复用 store 自带的 rawStore（默认 baseDir）。
   */
  /** 迁移入口：先加锁并立刻回执，避免长任务期间被重复触发 */
  async migrateRawToFile(e) {
    if (!Config.enableMemory) {
      await this.reply('记忆系统未启用', true)
      return
    }
    if (!acquireHeavyTask('记忆迁移')) {
      await this.reply(`「${heavyTaskOwner()}」正在执行，完成会回结果；重复发送不会加快，请等它结束`, true)
      return
    }
    try {
      await this._doMigrateRawToFile(e)
    } finally {
      releaseHeavyTask()
    }
  }

  async _doMigrateRawToFile(e) {
    if (!Config.enableMemory) {
      await this.reply('记忆系统未启用', true)
      return
    }
    const store = getStore()
    const rawStore = store.rawStore || new RawStore()
    const msg = String(e.msg || '')
    try {
      if (/校验/.test(msg)) {
        await this.reply('开始校验：要逐群读取 Redis 与文件两侧的全部原文，几十万条需要几分钟，完成才回结果；期间重复发不会加快', true)
        await this.reply(this.formatMigrationVerify(await verifyMigration({ store, rawStore })), true)
        return
      }

      await this.reply('正在统计各群原文条数…（几十个群约需半分钟，完成前请勿重复发送）', true)
      const plan = await planMigration({ store, rawStore })
      if (plan.totals.groups === 0) {
        await this.reply('Redis 里没有任何群原文，无需迁移', true)
        return
      }
      const lines = [
        '🧮 迁移预览（只统计，未写任何文件）',
        `群数：${plan.totals.groups} 个 | Redis 原文 ${plan.totals.redisCount} 条 | 文件已有 ${plan.totals.fileCount} 条 | 预计待写入 ${plan.totals.toAppend} 条`,
        ...plan.groups.map(g => `群 ${g.groupId}：Redis ${g.redisCount} 条 / 文件 ${g.fileCount} 条`),
      ]
      if (/预览/.test(msg)) {
        await this.reply(lines.join('\n'), true)
        return
      }

      await this.reply(
        `${lines.join('\n')}\n\n` +
        `只追加缺失的原文，不会删除或修改 Redis 里的任何数据；迁移也不会自动切换存储后端。\n` +
        `回复"是"确认，回复其他内容取消`,
        true
      )
      const e_new = await this.awaitContext()
      if (!e_new.msg || !(/^(是|y|yes|确定|确认)$/i).test(e_new.msg.trim())) {
        await this.reply('操作已取消', true)
        return
      }

      await this.reply(`开始迁移：${plan.totals.groups} 个群、待写入 ${plan.totals.toAppend} 条，按群写文件需要几分钟，完成会再回一条汇总；期间不要重复发「是」`, true)
      const result = await runMigration({ store, rawStore })
      const done = [`✅ 迁移完成：处理 ${result.groups.length} 个群，新增 ${result.appended} 条，跳过已存在 ${result.skipped} 条`]
      if (result.failed.length > 0) {
        done.push(`⚠️ ${result.failed.length} 个群未迁移（这些群的文件保持原样）：`)
        for (const item of result.failed) done.push(`  群 ${item.groupId}：${item.reason}`)
      }
      if (result.dbsize.dropped) {
        done.push(`⚠️ Redis 键数从 ${result.dbsize.before} 变为 ${result.dbsize.after}（可能是过期清理或其他实例在操作），请确认没有别的进程在删数据`)
      }
      done.push('下一步：在锅巴把「群消息原文存储后端」切到文件，观察 1~2 天确认召回与提炼正常后，再考虑清理 Redis 里的旧原文。')
      await this.reply(done.join('\n'), true)
    } catch (err) {
      logger.error('[Memory] 迁移原文到文件失败:', err)
      await this.reply(`迁移失败：${err.message}`, true)
    }
  }

  /** 迁移校验结果排版（只展示前 10 条差异，避免刷屏） */
  formatMigrationVerify(result) {
    const lines = [`🔍 迁移校验：${result.ok ? '✅ 两侧一致' : '❌ 发现差异'}（逐字段比对 ${result.checked} 条）`]
    for (const diff of result.diffs.slice(0, 10)) {
      if (diff.kind === 'changed') {
        lines.push(`群 ${diff.groupId} / ${diff.messageId}：${diff.field} 不一致`)
        lines.push(`  Redis：${String(diff.redis).slice(0, 200)}`)
        lines.push(`  文件：${String(diff.file).slice(0, 200)}`)
      } else {
        lines.push(`群 ${diff.groupId} / ${diff.messageId}：${diff.kind === 'missing-in-file' ? '文件缺少这条' : '文件多出这条'}`)
      }
    }
    if (result.diffs.length > 10) lines.push(`……共 ${result.diffs.length} 条差异，仅展示前 10 条`)
    if (!result.ok) lines.push('提示：extra-in-file 是切到文件模式后新采集的原文，属正常；只有 missing-in-file / changed 需要处理（可再执行一次迁移补齐缺失项）。')
    return lines.join('\n')
  }

  /* ================= 存储后端：状态 / 一键切换 / 清理旧原文 ================= */

  /** Redis 侧残留原文数量与内存（清理前后对比用；取不到就给 null） */
  async _redisRawStat(store) {
    const redis = store.redis
    let keys = 0
    if (redis?.scanIterator) {
      for await (const key of redis.scanIterator({ MATCH: 'CHATGPT:MEMORY:V2:raw:*', COUNT: 1000 })) {
        if (String(key).startsWith('CHATGPT:MEMORY:V2:raw:')) keys++
      }
    }
    let used = null
    try {
      const info = await redis.info?.('memory')
      used = /used_memory_human:([\d.]+[KMG]?B)/.exec(String(info))?.[1] || null
    } catch { /* valkey 不支持 info 时忽略 */ }
    return { keys, used, mb: Math.round((keys * 344 / 1048576) * 10) / 10 }
  }

  /** 文件侧规模（群数 / 条数）；读失败按 0 处理，状态展示不因此失败 */
  async _fileRawStat(store) {
    const rawStore = store.rawStore
    let groups = 0
    let rows = 0
    try {
      const list = await rawStore.listGroups()
      groups = list.length
      for (const gid of list) rows += await rawStore.count(gid)
    } catch { /* 忽略 */ }
    return { groups, rows }
  }

  /** #记忆存储 [文件|redis|清理]：状态、一键迁移并切换、清理 Redis 旧原文 */
  async memoryStorage(e) {
    if (!Config.enableMemory) {
      await this.reply('记忆系统未启用', true)
      return
    }
    const store = getStore()
    const sub = (String(e.msg || '').match(/文件|redis|清理/i)?.[0] || '').toLowerCase()
    const current = Config.memoryStorage === 'file' ? 'file' : 'redis'

    if (!sub) {
      const f = await this._fileRawStat(store)
      const r = await this._redisRawStat(store)
      const lines = [
        `🗄️ 原文存储后端：${current === 'file' ? '文件（data/chatgpt/memory/raw）' : 'Redis'}`,
        `文件里：${f.groups} 个群 / ${f.rows} 条`,
        `Redis 里：残留原文 ${r.keys} 条${r.mb > 0 ? `（约 ${r.mb} MB）` : ''}${r.used ? `，已用 ${r.used}` : ''}`,
      ]
      if (current === 'file' && r.keys > 0) lines.push('发 #记忆存储 清理 可释放上面这部分内存（文件里已有副本，不可恢复但不会丢记忆）')
      if (current === 'file' && r.keys === 0) lines.push('Redis 里没有残留原文，无需清理')
      if (current === 'redis' && f.rows > 0) lines.push('发 #记忆存储 文件 可迁移并切换到文件后端')
      if (current === 'redis' && f.rows === 0) lines.push('发 #记忆存储 文件 可迁移并切换到文件后端（当前还没有历史，切换是瞬时的）')
      await this.reply(lines.join('\n'), true)
      return
    }

    if (!acquireHeavyTask('记忆存储操作')) {
      await this.reply(`「${heavyTaskOwner()}」正在执行，完成会回结果；重复发送不会加快，请等它结束`, true)
      return
    }
    try {
      if (sub === '文件') await this._switchToFile(e, store)
      else if (sub === 'redis') await this._switchToRedis(e, store)
      else await this._purgeRedisRaw(e, store)
    } finally {
      releaseHeavyTask()
    }
  }

  /** 迁移 + 切换一条龙：预览 → 确认 → 迁移 → 写配置 */
  async _switchToFile(e, store) {
    if (Config.memoryStorage === 'file') {
      await this.reply('已经是文件后端了。若要释放 Redis 内存，发 #记忆存储 清理', true)
      return
    }
    const rawStore = store.rawStore
    await this.reply('正在统计需要迁移的原文…（完成前请勿重复发送）', true)
    const plan = await planMigration({ store, rawStore })
    const t = plan.totals
    if (t.redisCount === 0 && t.fileCount === 0) {
      Config.memoryStorage = 'file'
      Config.save()
      await this.reply('✅ 没有历史原文，已直接切到文件后端，新消息立即写入 data/chatgpt/memory/raw，无需重启', true)
      return
    }
    await this.reply(
      `🧮 切换到文件后端\n` +
      `群数 ${t.groups} 个 ｜ Redis 原文 ${t.redisCount} 条 ｜ 文件已有 ${t.fileCount} 条 ｜ 预计写入 ${t.toAppend} 条\n\n` +
      `只追加缺失的原文，不删 Redis 任何数据；切换后新消息写文件。\n回复「是」确认，其他内容取消`,
      true
    )
    const e2 = await this.awaitContext()
    if (!/^(是|y|yes|确定|确认)$/i.test(String(e2.msg || '').trim())) {
      await this.reply('操作已取消', true)
      return
    }
    await this.reply(`开始迁移并切换：待写 ${t.toAppend} 条，需要几分钟，完成会再回一条汇总；期间不要重复发「是」`, true)
    const result = await runMigration({ store, rawStore })
    // 有群没迁完就不切：file 模式只读文件、不回退 Redis，切过去那些群的历史会当场读不到
    if (result.failed.length > 0) {
      await this.reply(
        `❌ ${result.failed.length} 个群未迁移（${result.failed.map(f => f.groupId).join('、')}），已保持 Redis 后端，历史都能读。\n` +
        `已写入的 ${result.appended} 条不会重复写；排查后重新发 #记忆存储 文件 会补迁剩下的`,
        true
      )
      return
    }
    Config.memoryStorage = 'file'
    Config.save()
    // 切完再补一遍：迁移跑的这一两分钟里新消息仍在写 Redis，切过去后读路径只读文件，
    // 不补就会静默漏掉这几分钟。切换后 Redis 侧已无新写入，一遍即收敛。
    let tail = { appended: 0, failed: [] }
    try {
      tail = await runMigration({ store, rawStore })
    } catch (err) {
      await this.reply(`⚠️ 已切到文件后端，但补最后几分钟的新原文时出错：${err?.message || err}；这批仍在 Redis，发 #记忆迁移到文件 可补齐`, true)
    }
    const lines = [
      `✅ 已迁移 ${(result.appended || 0) + (tail.appended || 0)} 条、跳过已存在 ${result.skipped} 条`,
      '✅ 存储后端已切到「文件」，新消息立即写入 data/chatgpt/memory/raw，无需重启',
    ]
    if ((tail.failed || []).length > 0) {
      lines.push(`⚠️ ${tail.failed.length} 个群的最后几分钟原文没补上（${tail.failed.map(f => f.groupId).join('、')}），仍在 Redis，可发 #记忆迁移到文件 补齐`)
    }
    const r = await this._redisRawStat(store)
    if (r.keys > 0) lines.push(`Redis 里还有 ${r.keys} 条旧原文${r.mb > 0 ? `（约 ${r.mb} MB）` : ''}，观察 1~2 天后发 #记忆存储 清理 可释放`)
    await this.reply(lines.join('\n'), true)
  }

  /** 切回 Redis：不自动回灌文件历史，必须明确告知 */
  async _switchToRedis(e, store) {
    if (Config.memoryStorage !== 'file') {
      await this.reply('当前已经是 Redis 后端', true)
      return
    }
    const r = await this._redisRawStat(store)
    await this.reply(
      `切回 Redis 后，新消息重新写入 Redis；文件里的历史原文**不会**自动回灌，旧记忆的原文将读不到（记忆本体不受影响）。\n` +
      `Redis 当前残留原文 ${r.keys} 条。\n回复「是」确认，其他内容取消`,
      true
    )
    const e2 = await this.awaitContext()
    if (!/^(是|y|yes|确定|确认)$/i.test(String(e2.msg || '').trim())) {
      await this.reply('操作已取消', true)
      return
    }
    Config.memoryStorage = 'redis'
    Config.save()
    await this.reply('✅ 已切回 Redis 后端，新消息写入 Redis', true)
  }

  /** 清理 Redis 里的旧原文与失效索引（文件已有副本） */
  async _purgeRedisRaw(e, store) {
    if (Config.memoryStorage !== 'file') {
      await this.reply('当前还在 Redis 后端，清理会丢掉唯一副本；先发 #记忆存储 文件 切到文件再来清理', true)
      return
    }
    const before = await this._redisRawStat(store)
    if (before.keys === 0) {
      await this.reply('Redis 里没有残留原文，无需清理', true)
      return
    }
    await this.reply(
      `准备删除 Redis 里的 ${before.keys} 条旧原文${before.mb > 0 ? `（约 ${before.mb} MB）` : ''}与对应索引。\n` +
      `文件里已有完整副本，删除不影响记忆与召回；但 Redis 侧不可恢复。\n回复「是」确认，其他内容取消`,
      true
    )
    const e2 = await this.awaitContext()
    if (!/^(是|y|yes|确定|确认)$/i.test(String(e2.msg || '').trim())) {
      await this.reply('操作已取消', true)
      return
    }
    const redis = store.redis
    const rawStore = store.rawStore
    // 先收集再删：SCAN 迭代期间删键会漏键，漏下的正文就成了新的孤儿（旧实现就有这个坑）
    const rawKeys = []
    for await (const key of redis.scanIterator({ MATCH: 'CHATGPT:MEMORY:V2:raw:*', COUNT: 1000 })) {
      if (String(key).startsWith('CHATGPT:MEMORY:V2:raw:')) rawKeys.push(String(key))
    }
    // 删除前对账：Redis 有、文件没有的原文必须先补迁移，否则删掉就没有第二份
    const byGroup = new Map()
    for (const key of rawKeys) {
      const parts = key.split(':')
      const gid = parts[parts.length - 2]
      const mid = parts[parts.length - 1]
      if (!byGroup.has(gid)) byGroup.set(gid, new Set())
      byGroup.get(gid).add(mid)
    }
    const missing = []
    for (const [gid, ids] of byGroup) {
      const rows = await rawStore.readRange(gid, 0, Number.MAX_SAFE_INTEGER)
      const have = new Set(rows.map(r => String(r?.messageId ?? '')))
      for (const mid of ids) if (!have.has(mid)) missing.push(`${gid}:${mid}`)
    }
    if (missing.length > 0) {
      await this.reply(
        `⛔ 已中止清理：Redis 里有 ${missing.length} 条原文不在文件中（例如 ${missing.slice(0, 3).join('、')}）。\n` +
        `先发 #记忆存储 文件 重新迁移补齐，再回来清理；否则这些原文会永久丢失。`,
        true
      )
      return
    }
    let deleted = 0
    for (let i = 0; i < rawKeys.length; i += 500) {
      deleted += await redis.del(...rawKeys.slice(i, i + 500))
    }
    const idxKeys = []
    for await (const key of redis.scanIterator({ MATCH: 'CHATGPT:MEMORY:V2:rawIdx:*', COUNT: 1000 })) {
      idxKeys.push(String(key))
    }
    for (let i = 0; i < idxKeys.length; i += 500) {
      deleted += await redis.del(...idxKeys.slice(i, i + 500))
    }
    try { await redis.memory?.('PURGE') } catch { /* 非 Redis 或权限不足时忽略 */ }
    const after = await this._redisRawStat(store)
    const leftover = after.keys > 0 ? `\n⚠️ 仍有 ${after.keys} 条残留（SCAN 期间新写入），可再执行一次` : ''
    await this.reply(`✅ 已删除 ${deleted} 个键，Redis 已用 ${after.used || '（取不到）'}${before.used ? `（清理前 ${before.used}）` : ''}${leftover}`, true)
  }

  /* ================= 每日批量提炼任务（原 memoryDailyTask） ================= */

  /** EasyCron 每日任务入口（只处理已结束的北京时间自然日） */
  async runDaily() {
    try {
      const report = await dailyConsolidation.runDaily()
      if (report?.skipped) {
        logger.info(`[MemoryV2] 每日提炼跳过: ${report.reason}`)
      }
    } catch (err) {
      logger.error(`[MemoryV2] 每日提炼异常: ${err.message}`)
    }
  }

  /** 主人手动触发一次每日任务（调试） */
  async runDailyDebug(e) {
    const report = await dailyConsolidation.runDaily()
    await this.reply(`每日提炼执行结果：${JSON.stringify(report)?.slice(0, 800)}`, true)
  }


  async sendChunkedForwardMsg(e, messages, title) {
    // 单条合并转发装 50 个节点：记忆条目一段约 200 字，50 条正文 ≈ 1 万字，
    // 既在协议端单条转发能承载的范围内，也少发几次消息、少刷屏。
    const CHUNK_SIZE = 50
    if (messages.length <= CHUNK_SIZE) {
      await e.reply(await makeForwardMsg(e, messages, title))
      return
    }
    const totalChunks = Math.ceil(messages.length / CHUNK_SIZE)
    for (let i = 0; i < totalChunks; i++) {
      const chunk = messages.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
      const chunkTitle = `${title} [${i + 1}/${totalChunks}]`
      await e.reply(await makeForwardMsg(e, chunk, chunkTitle))
    }
  }

  /**
   * 解析 `#清空他的记忆` / `#他的记忆` 的 @ 目标用户
   *
   * - @自己 或 @Bot（`self_id` / `bot.uin`）：一律视为"操作者本人"。记忆按 user_id 存储，
   *   Bot 账号自身不存在记忆，所以主人 @机器人 的唯一合理语义就是"操作我自己的记忆"
   *   （需求：#清空他的记忆 允许 at Bot主人自己）；
   * - at 段有两种形态：`{ type:'at', qq }` 与 `{ type:'at', data:{ qq } }`（适配器差异）；
   * - 这里不能像 `recall.getMentionedUserId` 那样"跳过 @自己 / @Bot"——那个函数是给召回用的
   *   （@机器人只是触发对话），而本命令要的恰恰是把这两种 @ 解释成"我"。
   * @returns {string|null} 目标 user_id；没有可用 @ 目标时返回 null（调用方再尝试用户ID写法）
   */
  resolveAtTargetUserId(e) {
    if (!Array.isArray(e.message)) return null
    const selfUserId = e.user_id === undefined || e.user_id === null ? '' : String(e.user_id)
    const botId = e.self_id ? String(e.self_id) : (e.bot?.uin ? String(e.bot.uin) : '')
    for (const seg of e.message) {
      if (!seg || seg.type !== 'at') continue
      const qq = seg.qq ?? seg.data?.qq
      if (qq === undefined || qq === null || qq === '') continue
      const qqStr = String(qq)
      if (qqStr === selfUserId) return selfUserId
      if (botId && qqStr === botId) return selfUserId || null
      return qqStr
    }
    return null
  }

  /** 格式化一条 V2 记忆 */
  formatMemory(m, index) {
    const kindLabel = KIND_LABELS[m.kind] || m.kind
    const scopeLabel = SCOPE_LABELS[m.scope] || m.scope
    let msg = `【记忆 ${index}】\n`
    msg += `作用域：${scopeLabel}\n`
    msg += `类型：${kindLabel}\n`
    msg += `事实键：${m.factKey} = ${m.factValue}\n`
    msg += `内容：${m.text}\n`
    msg += `置信度：${Number(m.confidence).toFixed(2)} | 重要性：${Number(m.importance).toFixed(2)}\n`
    if (m.validTo && m.validTo > 0) {
      msg += `有效期至：${new Date(m.validTo * 1000).toLocaleDateString('zh-CN')}\n`
    }
    msg += `来源：${m.source}\n`
    msg += `ID：${m.id}`
    return msg
  }

  /** 查看自己的记忆 */
  async myMemories(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }
    try {
      const store = getStore()
      const memories = await store.listRecallCandidates(e.user_id, e.group_id || '')
      if (memories.length === 0) {
        await e.reply('你还没有任何记忆哦~', true)
        return
      }
      // 全序：同毫秒 updatedAt 用 id 兜底，否则底层 Set 顺序会让展示编号与按序号取用错位
      memories.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.id).localeCompare(String(b.id)))
      const messages = memories.map((m, index) => this.formatMemory(m, index + 1))
      await this.sendChunkedForwardMsg(e, messages, `我的记忆 (共${memories.length}条)`)
    } catch (err) {
      logger.error('[Memory] 获取记忆失败:', err)
      await e.reply('获取记忆失败', true)
    }
  }

  /** 查看当前群记忆统计（主人专用） */
  async groupMemories(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }
    if (!e.isGroup) {
      await e.reply('此命令仅在群聊中可用', true)
      return
    }
    try {
      const store = getStore()
      const gid = String(e.group_id)
      const groupMemories = await store.listByScope({ scope: 'group', ownerId: gid, groupId: gid })
      const userGroupMemories = await store.listUserGroupByGroup(gid)
      if (groupMemories.length === 0 && userGroupMemories.length === 0) {
        await e.reply('本群还没有任何记忆（可 #群记忆开启 采集，或等待每日提炼）', true)
        return
      }
      const messages = []
      messages.push(`本群公共记忆（group）：${groupMemories.length} 条`)
      groupMemories.forEach((m, i) => messages.push(this.formatMemory(m, `G${i + 1}`)))
      messages.push(`本群个人记忆（user_group）：${userGroupMemories.length} 条`)
      await this.sendChunkedForwardMsg(e, messages, `群记忆 (共${groupMemories.length + userGroupMemories.length}条)`)
    } catch (err) {
      logger.error('[Memory] 获取群记忆失败:', err)
      await e.reply('获取群记忆失败', true)
    }
  }

  /** 查看他人的记忆（主人专用） */
  async otherMemories(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }
    let targetUserId = this.resolveAtTargetUserId(e)
    if (!targetUserId) {
      const match = e.msg.match(/^#(?:他|她|TA|ta)的记忆\s+(\S+)/i)
      if (match) targetUserId = match[1]
    }
    if (!targetUserId) {
      await e.reply('请@某人或输入用户ID，例如：#他的记忆 user_123', true)
      return
    }
    try {
      const store = getStore()
      const memories = await store.listRecallCandidates(targetUserId, e.group_id || '')
      if (memories.length === 0) {
        await e.reply(`用户 ${targetUserId} 还没有任何记忆`, true)
        return
      }
      // 全序：同毫秒 updatedAt 用 id 兜底，否则底层 Set 顺序会让展示编号与按序号取用错位
      memories.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.id).localeCompare(String(b.id)))
      const messages = memories.map((m, index) => this.formatMemory(m, index + 1))
      await this.sendChunkedForwardMsg(e, messages, `${targetUserId}的记忆 (共${memories.length}条)`)
    } catch (err) {
      logger.error('[Memory] 获取用户记忆失败:', err)
      await e.reply('获取记忆失败', true)
    }
  }

  /** 清空他人的记忆（主人专用） */
  async clearOtherMemories(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }
    let targetUserId = this.resolveAtTargetUserId(e)
    if (!targetUserId) {
      const match = e.msg.match(/^#清空(?:他|她|TA|ta)的记忆\s+(\S+)/i)
      if (match) targetUserId = match[1]
    }
    if (!targetUserId) {
      await e.reply('请@某人或输入用户ID，例如：#清空他的记忆 user_123', true)
      return
    }
    try {
      const store = getStore()
      // 预检须覆盖全部作用域（含其他群 user_group 与已过期数据）
      const hasMemories = await store.hasUserMemories(targetUserId)
      if (!hasMemories) {
        await e.reply(`用户 ${targetUserId} 没有记忆，无需清空`, true)
        return
      }
      await e.reply(`确定要清空用户 ${targetUserId} 的所有记忆吗？\n回复"是"确认，回复其他内容取消`, true)
      const e_new = await this.awaitContext()
      if (!e_new.msg || !(/^(是|y|yes|确定|确认)$/i).test(e_new.msg.trim())) {
        await e.reply('操作已取消', true)
        return
      }
      const success = await store.clearUser(targetUserId)
      if (success) {
        await e.reply(`已成功清空用户 ${targetUserId} 的所有记忆`, true)
        logger.info(`[Memory] 主人 ${e.user_id} 清空了用户 ${targetUserId} 的记忆`)
      } else {
        await e.reply('清空记忆失败', true)
      }
    } catch (err) {
      logger.error('[Memory] 清空记忆失败:', err)
      await e.reply('清空记忆失败', true)
    }
  }

  /** 清空自己的记忆（成员自助删除关闭时仅主人可用） */
  async clearMyMemories(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }
    // 关闭「允许成员删除自己的记忆」后，非主人失去这条指令；主人保留（也可用
    // #清空他的记忆 @自己 / @Bot 达到同样效果）。该开关只限制**实时主动删除入口**：
    // 每日提炼仍会按后续聊天更新/撤回旧事实，也不影响群公共记忆的管理——产品语义见 utils/memory/policy.js
    if (!canDeleteOwnMemory(e)) {
      await e.reply('成员自助删除记忆已关闭，只有 Bot 主人可以删除记忆', true)
      return
    }
    try {
      const store = getStore()
      // 预检须覆盖全部作用域（含其他群 user_group 与已过期数据），不能用 listRecallCandidates（只查当前群+未过期）
      const hasMemories = await store.hasUserMemories(e.user_id)
      if (!hasMemories) {
        await e.reply('你还没有记忆，无需清空', true)
        return
      }
      await e.reply('确定要清空你的所有记忆吗？此操作不可恢复！\n回复"是"确认，回复其他内容取消', true)
      const e_new = await this.awaitContext()
      if (!e_new.msg || !(/^(是|y|yes|确定|确认)$/i).test(e_new.msg.trim())) {
        await e.reply('操作已取消', true)
        return
      }
      // 二次确认期间主人可能刚把开关关掉，必须在真正执行前重新判定一次：
      // 入口那次检查到这里之间隔着 awaitContext（用户思考的时间），不做这一步就是一个
      // "先通过检查 → 等确认 → 期间撤权 → 仍然执行" 的 TOCTOU 窗口。
      if (!canDeleteOwnMemory(e)) {
        await e.reply('成员自助删除记忆已关闭，只有 Bot 主人可以删除记忆', true)
        return
      }
      const success = await store.clearUser(e.user_id)
      if (success) {
        await e.reply('已成功清空你的所有记忆', true)
        logger.info(`[Memory] 用户 ${e.user_id} 清空了自己的记忆`)
      } else {
        await e.reply('清空记忆失败', true)
      }
    } catch (err) {
      logger.error('[Memory] 清空记忆失败:', err)
      await e.reply('清空记忆失败', true)
    }
  }

  /** 删除指定记忆（主人专用） */
  async deleteMemory(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }
    const match = e.msg.match(/#删除记忆\s+(\S+)\s+[#\s]*([a-zA-Z0-9_\-]+)/i)
    if (!match) {
      await e.reply('格式错误！\n用法1: #删除记忆 用户ID 序号 (例如：#删除记忆 user_123 3)\n用法2: #删除记忆 用户ID 记忆ID', true)
      return
    }
    const targetUserId = match[1]
    const memoryIdentifier = match[2]
    try {
      const store = getStore()
      const memories = await store.listRecallCandidates(targetUserId, e.group_id || '')
      if (memories.length === 0) {
        await e.reply(`用户 ${targetUserId} 没有记忆`, true)
        return
      }
      // 必须用与展示侧（myMemories / otherMemories）完全相同的排序，否则用户看到的
      // 「记忆 N」与这里按下标取到的可能不是同一条——而这是一个破坏性操作。
      // 底层来源含 Redis Set，返回顺序不能当作稳定的展示序号，所以比较器必须是全序。
      memories.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.id).localeCompare(String(b.id)))
      let memoryToDelete = null
      if (/^\d{1,4}$/.test(memoryIdentifier)) {
        const index = parseInt(memoryIdentifier) - 1
        if (index < 0 || index >= memories.length) {
          await e.reply(`序号超出范围，该用户共有 ${memories.length} 条记忆`, true)
          return
        }
        memoryToDelete = memories[index]
      } else {
        memoryToDelete = memories.find(m => m.id === memoryIdentifier)
        if (!memoryToDelete) {
          await e.reply('未找到该记忆ID', true)
          return
        }
      }
      await e.reply(`确定要删除以下记忆吗？\n作用域：${SCOPE_LABELS[memoryToDelete.scope] || memoryToDelete.scope}\n内容：${memoryToDelete.text}\n\n回复"是"确认，回复其他内容取消`, true)
      const e_new = await this.awaitContext()
      if (!e_new.msg || !(/^(是|y|yes|确定|确认)$/i).test(e_new.msg.trim())) {
        await e.reply('操作已取消', true)
        return
      }
      const success = await store.deleteMemory(memoryToDelete.id)
      if (success) {
        await e.reply('记忆已删除', true)
        logger.info(`[Memory] 主人 ${e.user_id} 删除了用户 ${targetUserId} 的记忆: ${memoryToDelete.id}`)
      } else {
        await e.reply('删除记忆失败', true)
      }
    } catch (err) {
      logger.error('[Memory] 删除记忆失败:', err)
      await e.reply('删除记忆失败', true)
    }
  }

  /** 清空所有用户的记忆（主人专用，同时删除残留旧 Hash） */
  async clearAllMemories(e) {
    try {
      const store = getStore()
      const stats = await store.stats()
      if (stats.total === 0) {
        // 可能只剩旧 Hash
        const legacyKeys = await store.listLegacyHashKeys()
        if (legacyKeys.length === 0) {
          await e.reply('当前没有任何记忆', true)
          return
        }
      }
      await e.reply(
        `⚠️ 警告：此操作将清空所有 V2 记忆（含残留旧版 Hash）！\n\n` +
        `当前 V2 记忆数：${stats.total} 条\n` +
        `此操作不可恢复！确定要继续吗？\n` +
        `回复"确定清空所有记忆"以确认，回复其他内容取消`,
        true
      )
      const e_new = await this.awaitContext()
      if (!e_new.msg || e_new.msg.trim() !== '确定清空所有记忆') {
        await e.reply('操作已取消', true)
        return
      }
      const removed = await store.clearAll()
      await e.reply(`✅ 已成功清空所有记忆（删除 ${removed} 个键，含残留旧版 Hash）`, true)
      logger.warn(`[Memory] 主人 ${e.user_id} 清空了所有记忆 (${removed} keys)`)
    } catch (err) {
      logger.error('[Memory] 清空所有记忆失败:', err)
      await e.reply('清空所有记忆失败', true)
    }
  }

  /** 记忆统计（主人专用） */
  async memoryStats(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }
    try {
      const store = getStore()
      const stats = await store.stats()
      const byKindLines = Object.entries(stats.byKind || {})
        .map(([kind, count]) => `  ${KIND_LABELS[kind] || kind}：${count} 条`)
        .join('\n')

      let msg = `📊 V2 记忆统计\n\n`
      msg += `总事实数：${stats.total} 条\n`
      msg += `作用域分布：\n`
      msg += `  🌐 user(跨群个人)：${stats.byScope?.user || 0} 条\n`
      msg += `  👥 user_group(本群个人)：${stats.byScope?.user_group || 0} 条\n`
      msg += `  🏘️ group(群公共)：${stats.byScope?.group || 0} 条\n`
      if (byKindLines) {
        msg += `类型分布：\n${byKindLines}\n`
      }
      msg += `\n配置信息：\n`
      msg += capacityLines().map(line => `  ${line}\n`).join('')
      msg += `  对话记忆数量：${Config.memoryContextLimit} 条（召回模式：${recallModeLabel(Config.memoryRecallProvider)}）\n`
      msg += `  授权采集群：${(Config.memoryGroupCapture?.groups || []).filter(g => g?.switchOn).length} 个`
      await e.reply(msg, true)
    } catch (err) {
      logger.error('[Memory] 获取统计失败:', err)
      await e.reply('获取统计信息失败', true)
    }
  }

  /** 记忆帮助 */
  async memoryHelp(e) {
    const helpMsg = `📚 V2 记忆系统帮助\n\n` +
      `【私聊记忆】\n` +
      `启用记忆系统后，私聊可召回个人记忆、查看和清空自己的记忆（受自助删除开关控制）。\n` +
      `智能模式下可在对话中记录、更新、撤回个人事实及查询已存画像；个人事实与群聊共用。私聊无需群授权，不采集原文做每日提炼。\n\n` +
      `【查看记忆】\n` +
      `#我的记忆 - 查看自己的记忆\n` +
      `#他的记忆 @某人 - 查看某人的记忆(主人)\n` +
      `#群记忆 - 查看当前群的公共/个人记忆统计\n\n` +
      `【删除记忆】\n` +
      `#清空所有记忆 - 清空所有记忆并删除残留旧Hash(主人)\n` +
      `#清空我的记忆 - 清空自己的所有记忆${Config.allowMemberDeleteOwnMemory === false ? '(仅主人：成员自助删除已关闭)' : ''}\n` +
      `#清空他的记忆 @某人 - 清空某人的记忆(主人；@自己或@Bot 即清空自己)\n` +
      `#删除记忆 用户ID 序号 - 删除指定记忆(主人)\n` +
      `成员自助删除：${Config.allowMemberDeleteOwnMemory === false ? '❌ 已关闭（非主人不能使用 #清空我的记忆，对话中也不会接受其个人记忆撤回；每日提炼仍会根据后续聊天更新/撤回旧事实，群公共记忆也不受此开关影响）' : '✅ 已开启（可在锅巴关闭）'}\n\n` +
      `【群记忆采集】\n` +
      `#群记忆开启 - 授权当前群采集并补录最近24h历史(主人)\n` +
      `#群记忆关闭 - 关闭当前群采集（只停采集，不删数据；按「关闭后保留天数」到期清理）(主人)\n` +
      `#清理无效记忆 [预览] - 立即清理不在授权列表的群记忆（不动原文）(主人)\n` +
      `#记忆存储 [文件|redis|清理] - 查看/一键切换原文存储后端；切到文件会自动迁移，清理会删 Redis 旧原文(主人)\n` +
      `#记忆迁移到文件 [预览|校验] - 把 Redis 里的群原文导出到文件后端（只加不删，不自动切换）(主人)\n` +
      `#群记忆状态 - 查看采集状态与统计(主人)\n` +
      `#立即提取群记忆 - 立即提炼当前群记忆(主人)\n\n` +
      `【统计信息】\n` +
      `#at图谱[At群友] - 查看本群 @ 互动图谱；不填查看自己，@成员或填写 QQ 号查看对方\n` +
      `#记忆统计 - 查看记忆统计(主人)\n\n` +
      `记忆作用域：\n` +
      `🌐 user - 私聊与群聊共用的个人事实\n` +
      `👥 user_group - 仅当前群成立的个人事实\n` +
      `🏘️ group - 群规则、共同计划与公共经历\n\n` +
      `说明：记忆由「每日批量提炼 + 对话中 Memory_Tool」写入，单值事实自动替换旧值，相同事实合并证据并提升置信度，明确否定自动撤回（成员自助删除关闭时，对话中非主人的撤回会被拒绝）。`
    await e.reply(helpMsg, true)
  }
}
