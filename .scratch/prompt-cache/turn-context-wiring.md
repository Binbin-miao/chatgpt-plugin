# 群聊环境与 system 的接线（turnContext）

> 目的：让 `system` / `instructions` 在同一天、同一个群里**一字不差**，把每轮都会变的
> 群聊环境挪进本轮请求。上游（Gemini 兼容层）只认整段 system 完全一致的缓存，
> system 里只要混进一条群消息，命中就恒为 0。

## 1. 数据流

```
QQ 事件 e
   │
   ├─ collectGroupContext(e, settings)            model/core.js:158
   │     ├─ botName / tip（稳定：群聊提示语）
   │     └─ turn（每轮变：提问者、群名群号、60 条群聊记录）
   │
   ├─ mergeSystemPrompt + 插件清单 + [name] 替换 + tip
   │     └─ appendGroupAutoReplyPrompt / withContextInjection
   │           └─ system  ← 只含稳定内容
   │
   └─ wrapTurnContext([turn, message_id, 当前时间/时间线])   model/core.js:210
         └─ turnContext  ← 只进请求，不落库
               │
               ├─ OpenAI Chat  chatgpt-api.js:74  insertTurnContext（innerOs 之后插入）
               ├─ Responses    responses-api.js:22 appendTurnContext（在 input 里插一项）
               ├─ Claude       ClaudeAPIClient.js:305（按 turnMessageIndex 插一条 user）
               └─ Gemini       CustomGoogleGeminiClient.js:273（并入本轮 user 的 parts[0]）
```

## 2. 四条通道的插入位置

| 协议 | 插入点 | 工具回填轮 |
| --- | --- | --- |
| OpenAI Chat | 最后一条 `role:'user'` 之前，且发生在 `syncInnerOs` 之后 | 同一位置，不重复 |
| Responses（本地历史） | `input` 里最后一条 user 项之前，新增一项 | 只有 `function_call_output`，跳过 |
| Responses（`store` 续聊） | 合并进本轮 input 的内容，**不新增会话项** | 跳过 |
| Claude | 并入本轮 user 的第一个 text block，保持 user/assistant 交替 | 每轮同位置重放，不重复 |
| Gemini | 本轮 user 的 `parts[0]`，仅文本轮 | `functionResponse` 轮跳过（混文本会被判非法参数） |

`turnContext` 只在请求副本上拼：`_buildMessages` 产出的 `messages`、`input` 数组都是
当次新建，`currentMessages` 与会话落库不受影响。**这是硬约束**——写进会话历史会被
下一轮当历史重放，上下文越滚越大。

## 3. 为什么不能改在 core 的 prompt 上

`apps/chat.js` 在发送后会把 `{ role: 'user', content: prompt }` 写进
`previousConversation.messages`，core 下一轮又从 `conversation.messages` 重放。
把上下文拼进 prompt 等于每轮都往历史里塞一份群记录。`utils/quotedImage.js` 里
「引用图只能进 system」的注释就是踩过这个坑。

## 4. 上游证据（2026-11-06 实测）

| 请求条件 | 缓存命中 |
| --- | --- |
| 与上次逐字节相同 | ≈2000 token |
| system 里群历史多一行 | 0 |
| system 只改末尾 `Current time` | 0 |

对 `cpa.aichen.qzz.io`（渠道 23「辰」）与自建 gcli2api 各测一轮，结论一致。

## 5. 避坑备忘录

- **上下文块防截断**：群名片、群头衔、群名、消息正文都来自普通群成员，谁都能塞
  `</group_context>` 提前闭合本块。逐字段用 `sanitizeContextText()` 转义，`wrapTurnContext()`
  在拼接后再统一剥一次作为最后一道，新增字段也漏不掉。
- **innerOs 顺序**：`syncInnerOs` 找的是「首条 user 消息」。先插上下文会让全局破限
  提示落进群聊记录块。必须在它之后插（`chatgpt-api.js:329`）。
- **预算**：turnContext 不参与 `_buildMessages` 的 messages，但必须计入 token 预估
  （`chatgpt-api.js` 里的 `turnContextTokens`），否则压缩判断失灵。
- **Gemini 交替**：Gemini 要求 user/model 交替，不能新插一轮；只能并入当前 user 的
  parts。`functionResponse` 轮不要混文本。
- **Claude / Responses store 同理**：Claude 不接受连续两条 user（部分中转直接 400）；
  `store` 续聊的 input 会被上游存进服务端会话，多插一项等于每轮往会话里留一份群记录。
  两者都走「并入本轮内容」，不新增条目。
- **Claude 断点**：system 只剩稳定段后，`systemStableLength` 直接取整段长度。
- **当前日期**：`Current date` 仍在 system，跨天会失效一次，属刻意保留。
- **`withContextInjection`**：启用（`enableHooks`）时仍写 system 末尾，是已知剩余变量，
  默认关闭。

## 6. 回归索引

| 文件 | 覆盖 |
| --- | --- |
| `test/groupReplyCore.test.mjs` | 两轮不同身份/历史/message_id 下 system 字节一致；群历史落在 turnContext；压缩重试只缩短群历史 |
| `test/providerClients.test.mjs` | 四协议真实请求体：system 不动、turnContext 位置正确；innerOs 仍落在用户提问上 |
| `test/providerContext.test.mjs` | 工具回填与会话历史不被上下文污染（上下文在断言前剥离） |
| `test/promptCacheOrder.test.mjs` | 源码结构辅助守卫（Claude 断点取整段长度） |
