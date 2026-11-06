# 浮现注入走 system 终点而非 prompt 前置

状态：已采纳（2026-11-05）。需求与决策过程见 `.scratch/ombre-breath-hook/spec.md`。

插件以纯 MCP 直连形态接入外部记忆服务 Ombre-Brain（16 个记忆工具交给模型自主调用）。该形态解决了「会不会用」，没解决「会不会主动想起来用」：记忆浮现完全依赖模型每轮自觉调用 `breath()`。为补上这个缺口，新增「浮现注入」：每轮把消息发给模型之前，HTTP GET 记忆服务的 `/breath-hook` 端点，把返回的分节浮现文本（`=== 核心准则 ===` 等）追加进当轮请求的上下文。

链路调查（`.scratch/ombre-hook/chatgpt-plugin-注入点调查.md`）给出两个候选插入点：

- **prompt 前置**：在 `apps/chat.js` 的 `abstractChat` 里照抄记忆召回注入的写法（`apps/chat.js:1022-1038`），`prompt = hookText + '\n\n' + prompt`。一处改动覆盖全部 provider 与全部入口。
- **system 终点**：在 `model/core.js` 四个 provider 分支拼装 system 的终点、`resolveTurnSystem`（`utils/quotedImage.js:47`）缓存之前追加，抽公共 helper 四处调用。

## 决定

- **走 system 终点（第二候选）**。分节浮现文本语义上是常驻指令，属于 system；prompt 前置的注入文本会随 `apps/chat.js:1103-1106` 的历史落库逐轮累积重复——记忆召回也累积，但其内容按相关性每轮变化，固定的分节文本堆积起来不可接受。
- system 注入的额外收益：不进对话历史（换 provider、清历史、跨天都不残留）；工具调用轮的每次请求都带同一份 system，注入内容对工具轮持续可见；`prepared.system` 的缓存语义（`utils/quotedImage.js:47-50`）保证一轮只拉取一次、主备 provider 重试复用同一份。
- 四个分支的接入点：claude（`core.js:389` 前）、gemini（`core.js:470` 前）、responses（`buildResponsesInstructions` 内，含上下文超限重建路径 `core.js:566-567`）、OpenAI `api`（`buildOpenAISystem`，`core.js:661-664`）。
- 每轮注入、全部入口生效；失败/超时/401/空结果静默跳过，不阻塞消息发出；体积控制在服务端（`hooks.max_tokens`）而非插件侧截断。

## 与 prompt 前置候选的对比

| | prompt 前置 | system 终点（本 ADR） |
| --- | --- | --- |
| 改动范围 | 一处（`abstractChat`） | 四处（四个 provider 分支） |
| 历史累积 | 随落库逐轮重复 | 不进历史，零累积 |
| 落点权威性 | user 消息内 | system |
| 工具轮可见性 | 仅首轮 prompt 携带 | 每次请求（含工具轮）持续可见 |
| 拉取次数 | 每轮一次 | 一轮一次（`prepared.system` 缓存，主备复用） |

## 后果

- 四处分支必须逐个核对后接入：本仓已有「跨 provider 分支全称断言」失实的翻车史（见 AGENTS.md），不能只核对自己刚改的那一处。
- responses 分支的 instructions 在上下文超限重试时会重建，注入必须放在重建函数内才能在重试后保留。
- 插件侧不做内容截断：它不知道哪条浮现更重要，带优先级的截断只能由服务端做；体积偏大时调 Ombre 的 `hooks.max_tokens`（默认 10000，范围 500–50000）。
- `/breath-hook` 有每来源限流（Ombre `src/web/hooks.py:41-42`，来源 10 次/窗口、全局 60）；正常对话频率足够，429 与其他失败同样静默跳过。
- 需要服务端启用 `hooks.token` 鉴权（留空时该端点只接受 Dashboard 登录态，插件进程无法通过）。
