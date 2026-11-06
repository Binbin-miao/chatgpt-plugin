# ADR-0017：把动态内容移出系统提示词的稳定前缀

- 状态：已采纳（2026-11-06）
- 涉及：`model/core.js`、`client/ClaudeAPIClient.js`、`utils/openai/cacheUsage.js`

## 背景

用户反馈「调用模型时缓存 0%」，日志形如 `缓存命中(0, 0.0%)`。

排查后，三条通道各有各的必然性：

**1. OpenAI / Responses**：prompt caching 是自动的，但要求稳定前缀达到最小可缓存长度（新模型 1024 tokens、旧模型 2048）。原实现的 system 拼接顺序是：

```
basePrompt（默认一句英文）        17 tok   ← 稳定
Current time（每分钟变）          10 tok
Conversation timeline（每轮变）   19 tok
last message id（每条消息都变）    9 tok
插件清单（1874 tok，本来是稳定的）          ← 被前三段挡在缓存前缀之外
```

用 31 份真实地图 / 1411 条指令实测：**稳定前缀只有 17 tokens**，离门槛差两个数量级。

**2. Claude**：Anthropic 的 prompt caching 必须显式声明缓存断点。原 `_createMessage` 里 `body.system` 直接是字符串，全仓 grep 不到 `cache_control`，`cache_read_input_tokens` 永远不会出现。

**3. Gemini**：`cachedContentTokenCount` 的解析本身是对的，但 system 里拼了大量每轮都变的群上下文（群名、成员、聊天记录），且这些内容排在插件清单之后又夹着时间戳，前缀同样不成立。

## 决策

### 1. 系统提示词按「稳定段 / 动态段」两段式拼装

- **稳定段**：人设（`promptPrefixOverride` / `claudeSystemPrompt` 等）、工具说明、插件清单
- **动态段**：当前时间、对话时间线、`message_id`、群上下文

`mergeSystemPrompt()` 只负责稳定段；新增 `buildDynamicSystemSuffix()` 产出时间与时间线；`collectTools()` 把 `message_id` 从 `systemAddition` 拆到新的 `systemDynamic`。四条通道（OpenAI / Responses / Claude / Gemini）统一按「稳定 → 动态」拼装。

### 2. Claude 的缓存断点打在稳定段末尾

`core.js` 用 `option.systemStableLength` 告诉客户端稳定段到哪为止；`ClaudeAPIClient` 据此把 system 切成两块，只给稳定块加 `cache_control: { type: 'ephemeral' }`。

思路取自 AstrBot 的 `_apply_explicit_prompt_cache_breakpoints`，但修掉它的一个盲点：本插件的 system 末尾挂着动态内容，断点若直接打整段末尾会永远失效。未传 `systemStableLength` 时退化为单块 + 末尾断点，与其他调用方兼容。

### 3. 缓存字段解析统一到 `pickCacheUsage()`

各家字段名并不统一：

| 来源 | 字段 |
| --- | --- |
| OpenAI | `prompt_tokens_details.cached_tokens` |
| Anthropic | `cache_read_input_tokens` / `cache_creation_input_tokens` |
| DeepSeek | 顶层 `prompt_cache_hit_tokens` |
| 部分中转 | 顶层 `cached_tokens` |

少认一个字段，真命中也会被算成 0。函数返回 `undefined` 而不是 0，用于区分「上游没给这个字段」与「上游明确给了 0」。首次遇到「没有缓存字段」时打印上游 usage 的键名（仅一次），便于分辨真 0 与假 0。

## 后果

- 实测稳定前缀从 **17 tokens** 提升到 **1890 tokens**，越过 1024 门槛，OpenAI 系与 DeepSeek 的自动缓存才有机会命中。
- Claude 从「结构性不可能命中」变成可命中。低于模型最小可缓存长度时 Anthropic 会忽略断点，不产生额外费用。
- 提示词**内容未变**，只改顺序。插件清单与时间的位置确实变了，需要真机观察一轮输出质量。

## 不采纳的方案

- **改用流式输出**：与缓存无关。缓存匹配的是请求前缀，不是响应传输方式；OpenAI 流式下 `stream_options.include_usage` 同样返回 usage。
- **把全量指令表塞进提示词换取更高命中率**：31 份地图 1411 条指令远超预算，且缺前置条件与风险档时模型更容易挑错。

## 回归

- `test/promptCacheOrder.test.mjs`：锁住「动态段已从 `mergeSystemPrompt` 移出」「`message_id` 归入动态段」「四条通道先稳定后动态」「Claude 断点按稳定段切分」。
- `test/cacheUsage.test.mjs`：锁住四家字段映射与「未提供 vs 明确 0」的区分。
