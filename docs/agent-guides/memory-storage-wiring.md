# 原文存储后端：改动接线图

> 一句话：**记忆本体永远在 Redis，只有「原文」多了一个文件后端**；切换点收敛在 `MemoryStore` 的 8 处 `if (file)` 里，上层调用方零改动。

## 1. 组件清单

### 新增

| 文件 | 角色 | 关键接口 |
|---|---|---|
| `utils/memory/rawStore.js` | 文件后端本体（`RawStore`） | `append` / `readRange` / `readRecent` / `count` / `cleanup` / `listGroups` / `days` / `removeGroup` |
| `utils/memory/migrateRawToFile.js` | 一次性迁移 | `planMigration` / `runMigration` / `verifyMigration` |

落盘路径：`<cwd>/data/chatgpt/memory/raw/<群号>/<YYYY-MM-DD>.ndjson`（北京时间分天）

### 改造

| 文件 | 改动 |
|---|---|
| `utils/memory/store.js` | 新增 `memoryStorage()` + 8 处 file 分流；新增迁移专用 `getRawMessagesFromRedis`、`listGroupsWithRaw` |
| `utils/memory/capture.js` | 3 处 `saveRawMessage`（采集入口，本身未改，走分流） |
| `utils/memory/dailyTask.js` | 每日提炼读写原文；**关闭群的原文也在这里过期** |
| `apps/memoryManage.js` | 新增 `#记忆存储` / `#记忆迁移到文件`；重任务互斥锁 + 开始回执 |
| `apps/atGraph.js` · `utils/groupMemberSkillRun.js` | 读最近原文（图谱 / 群成员技能），走同一批接缝 |
| `utils/config.js` · `guoba.support.js` | 三个配置项 + 面板字段 + 保存时自愈 `closedAt` |
| `docs/agent-guides/*` · `GLOSSARY.md` | 文档与术语 |

## 2. 接线图

```
                          ┌──────────────────────────────┐
   群消息 ──► capture.js ─┤ MemoryStore.saveRawMessage   │
                          └───────────┬──────────────────┘
                                      │ memoryStorage()
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
        ┌───────────────────────┐          ┌────────────────────────┐
        │ redis（默认）          │          │ file                   │
        │ ZADD rawIdx           │          │ RawStore.append        │
        │ SET raw / EXPIRE      │          │  └ 串行队列 this.q      │
        └───────────┬───────────┘          │  └ mkdir + appendFile  │
                    │                      └────────────┬───────────┘
                    └──────────────┬────────────────────┘
                                   ▼
                    task:{gid}:{day} 标脏（始终 Redis，不分流）

  读原文（全部经 MemoryStore，调用方不知道后端）
    dailyTask     getRawTimeRange / getRawMessages / cleanupExpiredRaw
    atGraph       getRecentRawMessages
    群成员技能     getRecentRawMessagesPage
    memoryManage  getRawMessages（统计条数）
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
            Redis raw:* + rawIdx:*        <群号>/<日期>.ndjson

  记忆本体 / 索引 / 证据 / 游标 ── 始终 Redis（item / idx / slot / evd / policy / grp）
```

## 3. 四条数据流

### 3.1 写入（每条群消息）
```
capture 过滤 → saveRawMessage → 分流写原文 → 标脏 task
```
- 文件模式只 append，不写任何 `raw:*`
- 标脏逻辑在分流**之外**，两种后端都写 Redis（重提炼靠它）

### 3.2 每日提炼（凌晨一次）
```
runDaily
 ├─ 授权群 ──► processGroupDaily
 │              ├─ cleanupExpiredRaw(gid, rawRetentionDays)   ← 原文按保留期清
 │              ├─ getRawTimeRange / getRawMessages(当天区间)
 │              └─ 提炼 → 写记忆（Redis item/idx/slot/evd）
 └─ 非授权群 ─► sweepClosedGroups
                ├─ 首次发现：只记 closedAt（反悔窗口）
                ├─ 满 N 天：clearGroupMemories（记忆）+ cleanupExpiredRaw（原文）
                └─ 重新授权：清掉 closedAt（自愈）
```

### 3.3 即时召回（每轮对话）
```
对话 → recall.js → Redis item / idx / slot / evd
```
**不读原文、不碰磁盘**，这是文件后端对响应延迟无影响的根本原因。

### 3.4 迁移（手动，一次性）
```
#记忆存储 文件
 └─ planMigration（只统计）→ 回复预览 → 用户回「是」
     └─ runMigration
         ├─ 两侧对比：redis 全量 vs 文件 messageId 集合
         ├─ 只 append 缺失项（幂等，重复执行 appended=0）
         ├─ 额外 SCAN raw:* 补「索引缺失的孤儿原文」
         └─ Config.memoryStorage = 'file' → Config.save()
```

## 4. 配置流转

| 键 | 默认 | 语义 | 读取方 |
|---|---|---|---|
| `memoryStorage` | `redis` | `redis` / `file`，只影响原文 | `store.memoryStorage()` |
| `memoryStorageTailPendingAt` | `0` | 非 0 = 已切成 file 但尾窗还没补完；启动与面板保存据此自愈，**只有尾遍真的成功才清** | `autoMigrate.resumePendingRawTail()` |
| `memoryGroupCapture.rawRetentionDays` | `30` | 原文保留天数，`0` = 永久 | `dailyTask` / `capture` |
| `memoryGroupCapture.closedGroupRetentionDays` | `90` | 关闭群记忆保留天数，`0` = 永不自动清理 | `dailyTask.sweepClosedGroups` |

三条写入路径，同一个 `Config` 单例：
- 锅巴面板 → `Config.commit(candidate)`（保存后对本次新勾选的群清 `closedAt`）
- 指令 → `Config.memoryStorage = 'file'; Config.save()`（立即生效，无需重启）
- 后台迁移 → 面板切「文件」或指令切换时：先立 `memoryStorageTailPendingAt` → 切 file → 补尾窗 → **成功才清标记**

**尾窗为什么要单独标记**：切到 file 之后新消息写文件，但「第一遍读完到切换之间」那段只在 Redis。所以补尾窗必须跑在切换之后（Redis 已冻结，一遍收敛）；若补到一半进程被杀，标记会让下次启动或面板保存再补一次，否则那批消息会随 Redis TTL 静默消失。

## 5. 关键改动点（按风险排序）

| # | 改动 | 为什么 |
|---|---|---|
| 1 | **软关闭**：`#群记忆关闭` 只停采集 + 记 `closedAt`，不删数据 | 原来关闭即清空，误操作不可逆 |
| 2 | **8 个分流接缝**，默认 `redis` | redis 路径逐行等价，升级零行为变化；上层调用方零改动 |
| 3 | **写顺序改为 `ZADD` 先于 `SET`** | 中断只会产生「索引有、正文无」的无害孤儿；反序会产生「正文有、索引无」——迁移看不见，最后被当残留删掉（线上实测 5.3% 就是这么来的） |
| 4 | **迁移只 append、不删、幂等** | Redis 始终是完整副本，可随时切回 |
| 5 | **清理前三重对账** | 先收集键再删（SCAN 期间删键会漏）、删除前逐群比对「Redis 有 / 文件无」、删完自检残留 |
| 6 | **`#记忆存储` 一条命令完成迁移+切换** | 原来要「迁移 → 面板切 → 等一段时间 → 手清 Redis」五步 |
| 7 | **先切后补 + 标记自愈** | 先跑两遍再切关不上窗口：第二遍读完到写盘之间的新消息只落 Redis，切过去后读路径只读文件。改成切完再补（Redis 已冻结，一遍收敛），中途被杀由标记在下次启动补 |
| 7 | **重任务锁 + 开始回执** | 迁移 30 万条要几分钟，无回执会诱发重复确认；两轮并发实测多写 7.8 万行 |
| 8 | **关闭群原文由 sweep 清理** | Redis 有 TTL 兜底，文件没有；不补就会在磁盘上无限增长 |

## 6. 约束与已知缺口

- **单实例假设**：同一群目录不支持多进程同写（`this.q` 只保证进程内串行）
- **无 fsync**：断电可能丢最后几秒的 append（读取侧坏行跳过 = 丢 1 条）
- **读放大**：`readRange` / `readRecent` 是「整文件读入 + 解析」，峰值内存约为文件的 5~10 倍；实测单群 31 天 / 7.9 MB → 79 MB，`163 ms`
- **分页成本**：`getRecentRawMessagesPage` 在文件模式下每页重读最近 `offset+size` 条（无索引），页大小 ≤ 5000，量级可控
- **迁移整群读入内存**：单群 3 万条（约十几 MB）无压力；保留期调到一年以上、单群十万级时需改分批

## 7. 速查

```bash
# 状态：后端 / 文件规模 / Redis 残留
#记忆存储

# 迁移 + 切换（预览 → 确认 → 执行）
#记忆存储 文件

# 删 Redis 残留原文（文件已有副本，删前对账）
#记忆存储 清理

# 切回 Redis（文件历史不回灌）
#记忆存储 redis

# 只迁移或只校验（不切换）
#记忆迁移到文件 [预览|校验]

# 清「已不在授权列表」的群记忆（软关闭配套，不动原文）
#清理无效记忆 [预览]
```

文件位置：容器内 `/root/TRSS_AllBot/TRSS-Yunzai/data/chatgpt/memory/raw`（进程 cwd 是 Yunzai 根目录，不是插件目录）。
