# ADR-0017：把动态内容移出系统提示词的稳定前缀

- 状态：已采纳（2026-11-06）；2026-11-07 追加「群上下文快照 + 提问者身份后置」（见决策 4），本地回归通过，生产待部署验证
- 涉及：`model/core.js`、`client/ClaudeAPIClient.js`、`client/CustomGoogleGeminiClient.js`、`utils/openai/cacheUsage.js`

## 背景

用户反馈「调用模型时缓存 0%」，日志形如 `缓存命中(0, 0.0%)`。

排查发现了前缀布局与缓存观测问题；不能据此断言某协议必然缓存为 0：

**1. 上游对照**：对第三方聚合中转与自建 gcli2api 做 A/B 对照，结论一致：

| 请求条件 | 缓存结果 |
| --- | --- |
| 与上一次请求逐字节相同 | 命中约 2000 token |
| system 里群历史多一行 | 0 |
| system 只改末尾一行 `Current time` | 0 |

也就是说，这两条上游**只有整段 system 一字不差才可能命中**，不是「前缀相同就能续用」。把稳定内容排在 system 前面因此不够——system 本身不能含每轮变化的内容。

历史实验中的 system 拼接顺序曾是：

```
basePrompt（默认一句英文）        17 tok   ← 稳定
Current time（每分钟变）          10 tok
Conversation timeline（每轮变）   19 tok
last message id（每条消息都变）    9 tok
插件清单（1874 tok，本来是稳定的）          ← 被前三段挡在缓存前缀之外
```

用 31 份真实地图 / 1411 条指令的历史样本测得**稳定前缀只有 17 tokens**；这是该样本和拼接路径的结果，不代表生产请求只有这么长。仅把动态段后置、把插件清单提前，仍然不足以让上述上游命中。

**2. Claude**：原 `_createMessage` 把 `body.system` 直接作为字符串，未主动声明缓存断点；本插件因此缺少显式控制稳定段缓存边界的能力，但不能推导任意上游都不会返回缓存 usage。

**3. Gemini**：原生客户端已解析 `cachedContentTokenCount`。本次确认的问题是工具递归请求会在 system 开头插入 30 字符临时说明，破坏与首轮共享的前缀；群历史等动态内容仍需后置。原生 Gemini 并非不支持缓存，某次日志为 0 不能代表协议能力。

## 决策

### 1. 每轮变化的内容一律不进 system

四条通道（OpenAI Chat / Responses / Claude / Gemini）统一拆成两份：

| 位置 | 内容 | 变化频率 |
| --- | --- | --- |
| `system` / `instructions` | 人设、`Current date`、插件规则、工具清单、自动回复提示 | 每天；**私聊与群聊逐字相同** |
| 本轮 `turnContext` | 提问者、群名群号、群聊记录、群聊自检提示（`group.tip`）、私聊场景说明、`message_id`、引用消息 id、`Current time`、对话时间线 | 每轮 |

`handleSystem()` 拆成 `collectGroupContext()`（返回 `{ isGroup, botName, stableBotName, tip, turn }`）与 `wrapTurnContext()`，四条通道共用一份，避免各写一遍后逐渐跑偏。

`group.tip`（群聊自检提示）曾是本决策的漏网之鱼：它只在群聊赋值，私聊恒为空串，于是群聊
`system` 比私聊多 419 字（约 290 token）。而会话历史是**按人**存的——`apps/chat.js` 的
`providerConversationKey` 在 `groupMerge` 未配置时回落到 `sender.user_id`，同一个人私聊与群聊
共用同一份 Redis 历史。历史相同、`system` 差一截，公共前缀就在 `system` 末尾断掉，达不到上游
有效缓存块，`cached_tokens` 恒为 0（2026-11-07 实测：私聊 53,614 / 群聊 63,495，两次都是 0，
而两者的差值 9,881 恰好等于群 `turnContext` 加这 293 token）。

因此 `group.tip` 与群历史一起进 `turnContext`，`system` 只保留与场景无关的稳定段。私聊也不再
「什么都不说」：此前私聊既无 `tip` 也无 `turn`，模型只能从「没有群名」反推自己在私聊；现在
`turnContext` 会明确写出 `chatting in a private message (one-on-one), not a qq group` 与对方身份。

标题措辞由 `collectGroupContext` 返回的 `isGroup` 决定，**不能用 `e.group_id` 判断**：群上下文
关闭时事件仍带 `group_id`，但没有任何群环境可讲，标题必须回落为中性措辞。

**前缀的真正起点是 `tools`，不是 `system`。** 修好 `system` 之后，私聊↔群聊在 2026-11-07
14:13:56（57,762）/ 14:14:50（68,969）仍然两次 0：`getGroupNotice` 的注册条件带 `e?.isGroup`，
群聊请求比私聊多一个工具定义，而 tools 在请求里排在 system 之前，公共前缀从第 0 个 token 就
分叉。因此工具注册条件必须与场景无关，私聊误调时由工具自身的 `resolveGroupToolContext` 返回
「该工具只能在群聊中使用」。同理，人设里的 `[name]` 只能用场景无关的机器人昵称 `e.bot?.nickname`
替换，原实现用 `group.botName`（群聊取群名片、私聊取昵称），人设一旦写入 `[name]`，`system`
结尾又会长出两个值；群名片的信息量并未丢失，`turnContext` 的 `Your nickname is X in the group`
仍带着它。

无法消除的残余差异：Bot 在某个群是管理员时，`groupAdminToolMap` 会额外注册 5–7 个群管工具，
其中部分只在 `e.isMaster` 或提问者是管理员时出现。这类工具的可用性本来就跟「谁在哪个群说话」
绑定，统一到私聊没有意义，属于该场景下固有的 0 命中，不在本决策的优化范围内。

`turnContext` 由客户端在**请求组包阶段**插入，且只存在于请求里、不写回会话历史——写回会被下一轮当历史重放，上下文会越滚越大。插入位置各协议不同：

| 协议 | 插入方式 |
| --- | --- |
| OpenAI Chat | 在最后一条 user 消息之前插一条 `{ role: 'user' }`，并计入上下文预算 |
| Responses | 在 `input` 里最后一条 user 项之前插一项 |
| Claude | 按 `turnMessageIndex` 在 `messages` 里插一条 user |
| Gemini | 并入本轮 user 的 `parts` 首位（协议要求 user/model 交替，不能多插一轮） |

顺序上，OpenAI 的插入发生在 `syncInnerOs()`（全局破限/思考模式）之后，否则破限提示会落进群聊记录块而不是用户提问里。工具回填轮不重复注入：OpenAI 按「最后一条 user」定位，Gemini 在 `functionResponse` 轮跳过。

`Current date` 仍留在 system，因此跨天会有一次缓存失效；这是刻意保留的可读性代价。`withContextInjection()` 若启用（`enableHooks`）仍写在 system 末尾，属于已知的剩余变量，默认关闭。

Gemini 工具返回已通过 `functionResponse` 续接，递归请求不再改写 system；非空、空和未提供 system 的语义分别保持，原工具轮次上限及 `NONE` 限制不变。

已核验版本参考（不代表最新版本）：
- [dsh-qqbot@14d5eef（2026-11-03，0.5.5）](https://github.com/tencent-connect/dsh-qqbot/blob/14d5eef97274e47f34f91dcaa833be994ba2a770/src/prompt/install.ts#L44-L65) 把 section 规则、人设与 extra 和动态 context 背景分开；[deepseek-harness@fcc0ad4](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/system-prompt/src/index.ts#L78-L90) 把 context 定义为持久 user-role 快照。本次采纳的正是「动态上下文走 user 角色」这一层，但不照搬其快照持久化策略——本插件每轮重建，不落库。
- [AstrBot@86c24e8 的 Gemini 测试](https://github.com/AstrBotDevs/AstrBot/blob/86c24e846c0de78830f6a0bc402049edb0f0c671/tests/test_gemini_source.py#L175-L208) 验证 `usage_metadata.cached_content_token_count` 将输入 100、缓存 30 拆分为非缓存 70 / 缓存 30；生产 Gemini 源码未完整核查，不据此断言有无显式缓存。以上布局与观测参考均不证明本插件经任意中转必然命中。

### 2. Claude 的缓存断点打在 system 末尾

system 现在只剩稳定段，`core.js` 直接把 `option.systemStableLength` 设为整段长度；`ClaudeAPIClient` 据此把 system 切成稳定块并加 `cache_control: { type: 'ephemeral' }`。未传 `systemStableLength` 时保留单块 + 末尾断点的既有兼容行为。

### 3. 缓存字段解析统一到 `pickCacheUsage()`

各家字段名并不统一：

| 来源 | 字段 |
| --- | --- |
| OpenAI | `prompt_tokens_details.cached_tokens` |
| Anthropic | `cache_read_input_tokens` / `cache_creation_input_tokens` |
| DeepSeek | 顶层 `prompt_cache_hit_tokens` |
| 部分中转 | 顶层 `cached_tokens` |

少认一个字段，真命中也会被算成 0。函数返回 `undefined` 而不是 0，用于区分「上游没给这个字段」与「上游明确给了 0」。首次遇到「没有缓存字段」时打印上游 usage 的键名（仅一次），便于分辨真 0 与假 0。

### 4. 群聊记录按群快照，提问者身份排到最后

前两处修好后，命中率从 0 升到 88.6%–97%，但 2026-11-07 15:40–19:50 的 89 次调用整体只有
35.4%，且呈现「同一个人连问有缓存、群里换人就没」的形态。19:32:33 那次命中 86.3%
（16,551 / 19,175）；4 秒后另一个人发言，prompt 19,165（只差 10 token），cached = 0。
19:41:11–19:42:39 五人交替提问，五次全 0。

`turnContext` 的插入位置已经证明没问题（OpenAI 在最后一条 user 之前插，Gemini 并入 parts
首位），所以断点在 `turnContext` **内部**，且是两处叠加：

**其一，提问者身份排在第二个分句。** 原拼接是「你在群里，现在问你的人是 X（QQ）」，紧接着
才是群名、群号、以及约 14k token 的群记录。换个人提问，从第 300 个 token 就分叉，后面
所有群记录全部作废。因此 `turnContext` 拆成「公共段（群名群号 + 群记录）+ 末行提问者身份」，
身份放在**最末尾**，公共段才有机会被整段复用。

**其二，群记录窗口以「本条消息」为起点，天然按人分叉。** `getGroupHistoryContext(e, 60)`
在 `fromLatest` 为假时以提问消息为锚点向前取 59 条再补上本条，于是群成员 A、B、C 各自拿到
一份彼此错开一条的窗口，公共段永远对不上。现在四条通道统一传 `fromLatest: true`，固定读
群内最新 N 条；`groupContextFromLatest` 这个 settings 参数随之删除——窗口只有一种语义，
留着这个开关只会让人以为还能配。自主回复本来就用最新窗口，因此两者现在共用同一份快照。

公共段按 `${e.self_id}:${groupId}:${groupContextLength}` 缓存 **5 分钟**，条目带 `ttl` 字段：

- 键里带 `self_id`、机器人群名片与群名：TRSS 多开时同一个群会有多个机器人实例，群号相同但
  `Your nickname is X in the group` 不同；群名、名片改了而键不变，五分钟内会继续自称旧名。
- **没取满窗口**（一条都没拉到、翻页中途被截断、重试耗尽）只缓存 **30 秒**。按 5 分钟缓存等于
  让一次失败把整群关进「无上下文」五分钟，或把「少了一半的群记录」固化成常态；完全不缓存又
  会让不支持历史的 adapter 每轮都白等一轮带随机休眠的重试。只有 `chats.length >= groupContextLength`
  才按 5 分钟计。
- `GROUP_SNAPSHOT_LIMIT = 500`：单进程最多保留 500 个群快照，超了按 `at` 淘汰最旧的一个。键是
  「机器人 × 群 × 窗口长度 × 名片 × 群名」，量级远小于这个上限，淘汰只是兜底。

生产配置核对（2026-11-07）：`groupContextLength = 60`、`groupMerge` 未设置、`enableGroupContext = true`。
`groupMerge` 未设置意味着会话历史按 `sender.user_id` 存，每人各一份十几 k 的历史——所以「同群换人
提问命中 0」主要是历史分叉，不是群记录分叉；本节的快照只解决**同一个人跨轮**时群记录漂移的问题，
它贡献的是每人自己前缀里那 60 条记录。指望它让不同人共享缓存是误读。

日志实测前缀确实吃到了 turnContext（同一人连续三轮）：28,545→24,722、41,882→28,595、51,403→41,909，
其中 `cached(第 2 轮) = 28,595` 已超过 `prompt(第 1 轮) = 28,545`，说明上一轮整条请求（含群记录）
都被上游当作前缀复用；若 turnContext 落在断点之后，这个数不可能超过上一轮的总长。

代价与残余风险：

- 引用旧消息时，模型看到的是**最新**群记录，而不是旧消息之前的记录。被引用的消息本身仍随
  prompt 带入，缺的不是信息，只是「当时那段上下文」。
- 5 分钟内新进的群消息不会进入上下文，机器人对最新几条可能滞后；正在回答的那条消息始终在
  prompt 里，不受影响。刷新间隔是刻意选的：短了命中率降，长了容易答非所问。
- 群名、机器人群名片在 TTL 内变了不会立刻反映；这类变化一天至多几次，不值得为它缩短 TTL。

## 后果

- 历史实验同一组地图样本中，重排后的稳定前缀从 **17 tokens** 增至 **1890 tokens**；这个样本不能证明当前所有上游都达到门槛，也不是本次生产收益数据。
- 生产非流式 API 日志曾记录输入 12500 / 缓存 10099（80.8%）及输入 33132 / 缓存 30085（90.8%）；随后原生 Gemini 的 0 命中不能证明原生不支持缓存。Gemini 模型经 OpenAI Compatible 中转时，不能直接套用官方直连门槛。
- 是否命中取决于实际上游模型、稳定前缀、缓存窗口及返回的 usage；修复不承诺必命中、省钱或让模型更聪明。Claude 断点也须满足实际上游的缓存条件。
- 本次核心调整保留群上下文内容并重排位置，Gemini 则删除冗余工具回调说明，不能概括成“内容完全未变”。本地修复与回归不等于生产已生效；部署及真实连续请求的 usage、输出质量仍需单独验证。

## 不采纳的方案

- **为提高命中率改用流式输出**：流式本身不修复请求前缀。OpenAI 兼容流式需上游支持 `stream_options.include_usage` 才能据 usage 观测；已有非流式生产日志也能证明命中，无需为本次修复切换传输方式。
- **把全量指令表塞进提示词换取更高命中率**：31 份地图 1411 条指令远超预算，且缺前置条件与风险档时模型更容易挑错。

## 回归

- `test/groupReplyCore.test.mjs`：执行真实 Core 请求组装，检查 API / Responses 的稳定 addon 位于身份与群历史之前、不同群历史共用前缀，以及 0 条历史与压缩重试时的顺序和内容保留。2026-11-07 增补：同一群不同提问者的群上下文公共段逐字一致、快照 5 分钟内只拉一次记录、普通回复与自主回复共用同一份快照、空快照按 30 秒过期（用 `t.mock.timers` 假时钟推进 29s / 31s）。快照是模块级状态，用例间靠导出的 `clearGroupSnapshotCache()` 隔离。
- `test/promptCacheOrder.test.mjs`：作为源码结构辅助守卫，检查动态字段拆分与 Claude 断点切分；不能替代真实请求组装行为测试，也不能据此宣称“四条通道都已稳定”。
- `test/cacheUsage.test.mjs`：锁住既有字段映射与「未提供 vs 明确 0」的区分。
- `test/providerClients.test.mjs`：真实 Gemini 客户端以 3 个参数化用例覆盖非空、空、未提供 system 的连续工具回填，检查共享前缀、完整历史与原始 `functionResponse`，并验证 `NONE` 上限优先于 `ANY`；不修改原工具轮次计数语义。本地回归不验证上游缓存服务。
- 本次针对性红绿结果（实现负责人实跑）：Core 旧实现 37 通过 / 4 失败，修复后 41 / 41 通过；Gemini 旧实现 18 通过 / 3 失败，修复后 21 / 21 通过；既有源码守卫 5 / 5 通过。此记录不是持续保证，也不代表生产已部署。
