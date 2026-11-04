# 08: 热路径提速，并把「卸载清理」改成连续三轮确认

**What to build:** 第二轮审查（对标 AstrBot + 性能实测 + 主动挖 bug）后落地的三项，全部要求行为不变、测试锁死。

**Blocked by:** 07

**Status:** done

## 背景数据（真实 31 份地图 / 1411 条指令）

| 函数 | 改前 p50 | 改后 p50 | 倍数 |
|---|---|---|---|
| `loadEntries()` 缓存命中 | 0.908ms | **0.021ms** | 43× |
| `searchEntries '签到'` | 7.104ms | **0.928ms** | 7.7× |
| `searchEntries '帮我点个赞'` | 7.416ms | **0.853ms** | 8.7× |
| `searchEntries '原神面板'` | 7.473ms | **0.955ms** | 7.8× |
| `buildPromptAddon` | 0.043ms | 0.043ms | 不动（本来就不是瓶颈） |

一条带查询的消息固定开销从约 **8.0ms 降到 0.95ms**。

## 做了什么

1. **加载期预建归一化字段**（`map.js` `flattenEntries`）
   每条条目带 `_norm`（归一化写法/关键词/描述/场景、插件名去括注与去后缀、key/分类小写）与 `_lower`。
   `scoreEntries` / `isSamePlugin` / `commandWeight` / `loosePlugin` 改为只读预计算值；没有预计算字段的
   条目（测试里手工构造）走 `viewOf()` 的等价现场计算。真实数据逐条对账，歧义率与命中结果与改前完全一致。

2. **条目表缓存改「写侧置空 + 目录指纹 + 低频复核」**
   `writeEntry` / `pruneUninstalled` 成功后 `invalidateEntries()`；`loadEntries()` 每次只 stat 地图目录
   本身（1 次 IO），10 秒才做一次 31 份文件的完整签名复核。取代了原先每条消息 31 次 statSync。
   取舍见 `docs/adr/0016-command-map-load-time-index.md`。

3. **卸载清理改连续 3 轮确认，移除票 07 的 30% 比例阈值**
   票 07 的「清单骤减就不清理」实测有死区：2→1、3→2、5→3、10→6 的正常卸载全部被误拦，
   缓存永远清不掉。改为在 `map-state.json` 的 `absent` 里记每个目录连续缺了几轮，满 3 才删；
   中途又扫到就清零。`#指令地图状态` 增加「等待确认卸载」一行。
   不传 `absent` 时 `pruneUninstalled` 仍立即删除，供测试与手工清理用。

## 验收

- `node --test --test-force-exit test/commandMap.test.mjs test/commandLookupTool.test.mjs test/commandRunTool.test.mjs` → **126 passed / 0 failed**
- `lint.check` / `checkSyntax`(343 文件) / `pathLeak.check`(473 文件) 全过
- 真实数据回归：去掉 `#` 的歧义率仍为 **0%**，串条仍为 4 条（大小写变体），风险解析结果与改前一致
- 新增 3 条回归：连续确认（含中途出现清零）、2→1 小数量卸载、预计算字段存在性

## Comments

- 用户曾问「索引整段发给 AI 会不会更准」：全库 1411 条塞进每轮提示词是几万 token，且缺少前置条件/
  风险档反而更容易挑错；现有「插件级摘要常驻 + 按需查单条」更准更省。单插件整段返回现有 `plugin`
  模式已经支持（最多 40 条）。本票不新增「整段发给 AI」的能力。
- 未做（留到后续评估）：`resolveCommand` 的 `dedupeByCommand` 预建（1.6ms）、`suggestEntries` 的
  bigram 倒排（4.1ms）、全量精确索引 O(1) 短路。理由见 ADR-0016。
- 外部数据契约仍待改进：地图的 `permission` 是自由文本，AstrBot 用枚举；长期应推动地图仓枚举化，
  才能去掉 `TRUSTED_PERMISSION_RE` 的猜测。
