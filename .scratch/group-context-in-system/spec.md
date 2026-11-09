# 群记录快照前移进 system —— 让 gemini-3.8-flash 的中短对话吃到缓存

状态：待实现（2026-11-08 拍板）

## 问题

主线模型 `gemini-3.8-flash`（渠道 23「辰」，上游 `binpro/gemini-3.8-flash-high`）在连续对话里大量 0 命中。

2026-11-08 实测定位到两条叠加原因：

1. **上游门槛远高于文档**。全新随机前缀各发两次，7,857 / 11,940 / 16,011 token 两轮全 0；20,437 → 18,385（90.0%）、23,839 → 21,786（91.4%）。官方文档写 Gemini 3.8 Flash 门槛 4,096（Vertex 6,144），该中转实际要 16k~20k。
2. **稳定前缀不够长**。生产 00:53:53–00:56:10 同一人连发四条（群 591272224），prompt 23,373 / 24,278 / 25,605 / 26,951，全部 0 命中。Redis 里该会话历史 10,850 字符，其中每条提问前粘着 2,680 字符「历史记忆参考」。稳定段 = system 1.4k + 历史 10.8k ≈ 12.2k < 门槛；动态尾巴 ≈ 14.7k 群记录卡在 turnContext 尾部，位置每轮后移，一个字节都不参与前缀。

01:01:03 历史攒到 18,761 刚过门槛，立刻命中 62.3%，命中量正好等于稳定段，机制闭合。

`883a0c6`「把易变段全部移出 system」在当时正确（彼时群记录无快照，每轮都变）；但群记录自 `ccf0fc0` 起已有 5 分钟快照，属于「伪动态」，被连坐搬去了尾部。

## 已拍板决策

- **[D1] 群记录快照段前移进 system**。拆 `collectGroupContext` 返回值为 `stable`（群名/群号/群名片/群记录）与 `turn`（提问者身份一行），`stable` 拼进 system，`turn` 继续留在 turnContext。tip、当前时间、messageId、replyTimestamps 一律不搬，仍走尾部。
- **[D2] system 拼在 `[name]` 替换之后**。群友聊天正文里出现 `[name]` 字面量时不得被误换成人设名。
- **[D3] 快照内容冻结，按「新消息条数」重建，不按时间**。宾宾原方案的触发条件保留，但去掉「去重拼接增量」——往 system 末尾追加内容会把断点前移到 system 末尾，命中率从 98% 掉到 62%（2026-11-08 11:54 定论）。**阈值 = max(3, ceil(实际条数 / 1.5))，拉满 60 条时为 40**（2026-11-09 14:xx 由 20 放宽）：上线首日实测，阈值 20 时活跃群约 10 分钟翻新一次 system，而 system 已约 20k，翻新一次就把长会话里本该命中的历史前缀整段打断——50k+ 请求每次未命中 token 从 25,798 涨到 39,778（+54%）。放宽到 2/3 让翻新频率减半，代价是群记录最多滞后 40 条新消息。
- **[D4] 群记录条数维持 60**。~~system + 群记录 ≈ 16,711 token~~ **实测修正（2026-11-09）：system 实为 12.5k~14.4k**。上线全量日志中 `prompt_tokens` 最小值 14,565、无一条低于 14k，反推真实群记录约 190 token/条，而非 spec 撰写时按 340 字符/条估算的 16.7k。60 条因此**够不到 16,000 门槛**：14.5k~20k 区间的 28 条请求命中率仅 3.6%，全 0。若要跨过门槛需 100 条（system ≈ 20k）；宾宾 2026-11-09 拍板**维持 60 条不动**，接受这批请求（约占流量 7%）继续 0 命中。
- **[D5] 拉不满 60 条不再按 30 秒缓存**。改为与拉满同一套条数规则，阈值按实际条数折算，最低 3 条。原 30 秒分支会让冷清群每 30 秒重建一次 system，命中率长期趴在 0。
- **[D6] 先灰度一个群，验证 85%+ 再全量**。

## 变更矩阵

| File:Line | 模块 | 变更前 | 变更后契约 |
|---|---|---|---|
| `model/core.js:186-279` | `collectGroupContext` | 返回 `{enabled,isGroup,botName,stableBotName,tip,turn}`；快照按 `at + ttl` 过期（5 分钟 / 30 秒） | 增加 `stable` 字段；快照按「新消息条数」重建，记录 `newestMessageId` 与 `full`；30 秒仅作拉取频率保护，不再触发重建 |
| `model/core.js:312-320` | `groupContextBody` | `[group.tip, group.turn]` | 不变（`stable` 不进 turnContext） |
| `model/core.js:528-534` | Claude 分支 | `option.system = system`；`systemStableLength = system.length` | 先拼 `group.stable` 再取长度，断点落在拼完之后 |
| `model/core.js:601-607` | Gemini 分支 | `option.system = system` | `system = system + '\n' + group.stable` |
| `model/core.js:646-654` | Responses 分支 | `instructions = withContextInjection(...)` | `group.stable` 在 `withContextInjection` 之前拼进 `instructions` |
| `model/core.js:840-849` | API 分支 | `system = system.replaceAll('[name]', ...)` 后直接注入 | 同上，`group.stable` 紧跟 `[name]` 替换之后 |

拼接顺序固定为：**人设 → `[name]` 替换 → `group.stable` → `withContextInjection`（记忆）→ `appendGroupAutoReplyPrompt` → `resolveTurnSystem`**。

## 快照重建判定

```
threshold = max(3, ceil(实际拉到的条数 / 1.5))   // 拉满 60 条时 = 40
if (缓存存在 && now - cached.at < 30_000)       → 直接复用（防抖动）
else 拉最新 groupContextLength 条：
     newer = 比 cached.newestMessageId 更新的条数（找不到该 id 视为全部为新增）
     newer >= threshold → 重建，刷新 text / newestMessageId / full
     否则               → 复用 cached.text（逐字节冻结）
```

拉取失败或抛错：沿用旧快照，**不得**清空缓存（system 一旦变短会立刻跌破门槛）。

## 非目标

- 不改 `trimConversation` 的裁剪比例与 `chatgptBlockCount`；裁剪仍会发生，本方案的目标是让裁剪后 system 段依然可命中。
- 不动记忆召回前缀（`apps/chat.js:1104-1106` 那 2,680 字符）。它让历史增长快，反而帮助过门槛，暂不碰。
- 不动 `groupMerge`（同群换人各一份历史的问题保留，属独立议题）。
- 不改 `promptCacheRetention`、不引入 `prompt_cache_key`（11-07 已实测无效）。
- 不改 `[name]` 替换的取值来源（仍用场景无关的 `stableBotName`）。

## 工单

见 `tickets/t1.md` ~ `tickets/t3.md`。

## 验收

- [ ] 群聊连续两轮（间隔 < 30 秒）：第二轮 `缓存命中 > 0`，且命中量 ≈ system + 群记录 + 历史。
- [ ] 单群连续 4 轮（模拟 00:53–00:56 场景）：至少 3 轮命中，命中率 ≥ 60%。
- [ ] 历史触发 `trimConversation` 裁剪后，下一轮命中量 ≥ 16,000（不得归零）。
- [ ] 群记录拉不满 60 条时，30 秒内多次请求 system 逐字节相同（可用哈希断言）。
- [ ] 私聊请求：`group.stable` 为空，system 与改造前逐字节一致。
- [ ] 群友发言含 `[name]` 字面量时，该字符串原样出现在 system 中，未被替换成人设名。
- [ ] `npm test` 全绿，新增用例覆盖：阈值折算（60→20、10→4、3→3）、newestMessageId 找不到、拉取抛错保留旧快照。
