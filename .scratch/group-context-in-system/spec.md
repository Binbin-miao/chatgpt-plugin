# 群记录快照前移进 system —— 让连续对话吃到 prompt 缓存

状态：已实现

## 问题

主线模型在连续对话里大量 0 命中。定位到两条叠加原因：

1. **上游门槛远高于文档**。用全新随机前缀各发两次做对照，短前缀两轮全 0，只有长度越过后阈值后才开始命中。官方文档标注的门槛与中转实际行为差距明显。
2. **稳定前缀不够长**。群聊请求里，稳定段（system + 历史）不足门槛；而十几 k 的群记录卡在 turnContext 尾部，位置每轮后移，一个字节都不参与前缀。

把「同一人连发数条全部 0 命中、历史攒长后突然开始命中」这两组现象放在一起，可以闭合到：**缓存只认从第 0 个 token 起逐字节相同的前缀，且缓存池里的前缀必须先达到长度阈值才会被返回。**

`883a0c6`「把易变段全部移出 system」在当时正确（彼时群记录无快照，每轮都变）；但群记录自 `ccf0fc0` 起已有快照，属于「伪动态」，被连坐搬去了尾部。

## 已拍板决策

- **[D1] 群记录快照段前移进 system**。拆 `collectGroupContext` 返回值为 `stable`（群名/群号/群名片/群记录）与 `turn`（提问者身份一行），`stable` 拼进 system，`turn` 继续留在 turnContext。tip、当前时间、messageId、replyTimestamps 一律不搬，仍走尾部。
- **[D2] system 拼在 `[name]` 替换之后**。群友聊天正文里出现 `[name]` 字面量时不得被误换成人设名。
- **[D3] 快照内容冻结，按「新消息条数」重建，不按时间**。去掉「去重拼接增量」——往 system 末尾追加内容会把断点前移到 system 末尾，命中率大幅下降。**阈值 = max(3, ceil(实际条数 / 1.5))，拉满 60 条时为 40**。阈值取窗口 1/3 时 system 翻新过频，而 system 本身已很长，翻新一次就会把长会话里本该命中的历史前缀整段打断；放宽到 2/3 让翻新频率减半，代价是群记录最多滞后 40 条新消息。
- **[D4] 群记录条数维持 60**。system 实际长度低于上游门槛：反推真实群记录约 190 token/条，而非按 340 字符/条估算的结果。60 条因此够不到门槛，短会话仍为 0 命中。若要跨过门槛需 100 条；维持 60 条是已知取舍，接受这批短请求继续 0 命中。
- **[D5] 拉不满 60 条不再按 30 秒缓存**。改为与拉满同一套条数规则，阈值按实际条数折算，最低 3 条。原 30 秒分支会让冷清群每 30 秒重建一次 system，命中率长期趴在 0。
- **[D6] 先灰度一个群，验证达标再全量**。

## 变更矩阵

| File:Line | 模块 | 变更前 | 变更后契约 |
|---|---|---|---|
| `model/core.js` `collectGroupContext` | 群上下文收集 | 返回 `{enabled,isGroup,botName,stableBotName,tip,turn}`；快照按 `at + ttl` 过期（5 分钟 / 30 秒） | 增加 `stable` 字段；快照按「新消息条数」重建，记录 `newestMessageId`；30 秒仅作拉取频率保护，不再触发重建 |
| `model/core.js` `groupContextBody` | 尾部上下文 | `[group.tip, group.turn]` | 不变（`stable` 不进 turnContext） |
| `model/core.js` Claude 分支 | system 组装 | `option.system = system`；`systemStableLength = system.length` | 先拼 `group.stable` 再取长度，断点落在拼完之后 |
| `model/core.js` Gemini 分支 | system 组装 | `option.system = system` | `system = system + '\n' + group.stable` |
| `model/core.js` Responses 分支 | instructions 组装 | `instructions = withContextInjection(...)` | `group.stable` 在 `withContextInjection` 之前拼进 `instructions` |
| `model/core.js` API 分支 | system 组装 | `system = system.replaceAll('[name]', ...)` 后直接注入 | 同上，`group.stable` 紧跟 `[name]` 替换之后 |

拼接顺序固定为：**人设 → `[name]` 替换 → `group.stable` → `withContextInjection`（记忆）→ `appendGroupAutoReplyPrompt` → `resolveTurnSystem`**。

## 快照重建判定

```
threshold = max(3, ceil(实际拉到的条数 / 1.5))   // 拉满 60 条时 = 40
if (缓存存在 && now - cached.fetchedAt < 30_000) → 直接复用（拉取频率保护）
else 拉最新 groupContextLength 条：
     newer = 比 cached.newestMessageId 更新的条数（找不到该 id 视为全部为新增）
     newer >= threshold → 重建，刷新 text / newestMessageId / fetchedAt
     否则               → 复用 cached.text（逐字节冻结）
```

`fetchedAt` 与 `newestMessageId` 语义必须分离：前者管「多久拉一次」，后者管「内容新旧」。混成一个字段会让活跃群永远卡在 30 秒窗口内、快照终身不重建。

拉取失败或抛错：沿用旧快照，**不得**清空缓存（system 一旦变短会立刻跌破门槛）。

## 非目标

- 不改 `trimConversation` 的裁剪比例与 `chatgptBlockCount`；裁剪仍会发生，本方案的目标是让裁剪后 system 段依然可命中。
- 不动记忆召回前缀（`apps/chat.js` 里每条提问前拼的那段）。它让历史增长快，反而帮助过门槛，暂不碰。
- 不动 `groupMerge`（同群换人各一份历史的问题保留，属独立议题）。
- 不改 `promptCacheRetention`、不引入 `prompt_cache_key`（已验证无效）。
- 不改 `[name]` 替换的取值来源（仍用场景无关的 `stableBotName`）。

## 工单

见 `tickets/t1.md` ~ `tickets/t3.md`。

## 验收

- [ ] 群聊连续两轮（间隔 < 30 秒）：第二轮 `缓存命中 > 0`，且命中量 ≈ system + 群记录 + 历史。
- [ ] 单群连续 4 轮：至少 3 轮命中，命中率 ≥ 60%。
- [ ] 历史触发 `trimConversation` 裁剪后，下一轮命中量不低于 system 段长度（不得归零）。
- [ ] 群记录拉不满 60 条时，30 秒内多次请求 system 逐字节相同（可用哈希断言）。
- [ ] 私聊请求：`group.stable` 为空，system 与改造前逐字节一致。
- [ ] 群友发言含 `[name]` 字面量时，该字符串原样出现在 system 中，未被替换成人设名。
- [ ] `npm run test:chat` / `npm run test:providers` / `npm run check:static` 全绿，新增用例覆盖：阈值折算（60→40、10→7、2→3）、newestMessageId 找不到、拉取抛错保留旧快照。
