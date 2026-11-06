# chatgpt-plugin 上下文注入点调查

目标：判定该插件能否实现类似 Claude Code hooks 的「发消息给模型前，自动注入外部内容」——每轮对话前 HTTP GET `http://localhost:18011/breath-hook`，把返回的分节纯文本注入发给模型的 system 或消息序列。调查为只读，未改任何源码。行号基于当前工作区文件。

## 1. 消息 → 模型的完整链路

入口到 provider 的调用顺序：

1. `apps/chat.js:614` `chatgpt()` 命中规则后，走 `apps/chat.js:853` `abstractChat(e, prompt, use, ...)`。
2. `abstractChat` 内部依次做：引用展开与 OCR 前置（`apps/chat.js:887-944`）→ 屏蔽词检查（947）→ 从 Redis 读会话（976-1005）→ 记忆召回注入（1022-1038）→ 首轮 InnerOs 注入（1041-1043）→ `apps/chat.js:1064` 调 `Core.sendMessage.bind(this)(prompt, conversation, profile.id, e, {...})`。
3. `model/core.js:246` `Core.sendMessage()` 解析主备 provider，经 `runProviderFallback`（`core.js:253`）进入 `core.js:271` 调 `Core.prototype.sendWithProvider.call(context, ...)`。
4. `core.js:279` `sendWithProvider()` 按 `use`（即 provider type）走四个分支：`claude`（309）、`gemini`（392）、`responses`（472）、OpenAI Chat Completions `api`（638）。

发给模型的 messages / system 在哪拼装：

- system 字符串：每个 provider 分支各拼一份，源头是 `core.js:285-291` 从配置读入的 `opt.system`（`api: Config.promptPrefixOverride`、`responses: Config.responsesSystemPrompt`、`claude: Config.claudeSystemPrompt`、`gemini: Config.geminiPrompt`）。随后经 `mergeSystemPrompt`（`core.js:187`）、群上下文 `handleSystem`（`core.js:132`，仅 responses/api 分支用；claude/gemini 分支各自内联了一份群历史代码，`core.js:363-384` 与 `434-454`）、工具收集的 `systemAddition`（`core.js:1165-1190`）、`appendGroupAutoReplyPrompt`（`core.js:113`）逐层追加。
- `resolveTurnSystem`（`utils/quotedImage.js:47-50`）用 `prepared.system ??= system` 把本轮基础 system 缓存进 `prepared`，主备 provider 复用同一份：claude `core.js:389`、gemini `core.js:470`、responses `core.js:546`、api `core.js:721`。
- messages 数组：仅 OpenAI `api` 分支有真正的 messages 数组，在 `utils/openai/chatgpt-api.js:606` `_buildMessages()` 拼装——`chatgpt-api.js:613-617` push system 消息，之后沿 parentMessageId 链从 Redis 取历史（`getMessageById`），工具轮通过 `opts.appendMessages`（`chatgpt-api.js:257`）追加 assistant/tool 消息。responses 分支是 `instructions` + `input`（`core.js:572-581`）；claude/gemini 由 `client/ClaudeAPIClient.js`、`client/CustomGoogleGeminiClient.js` 各自组装，system 是单字段。
- 会话历史持久化：`apps/chat.js:1103-1106` 把 `{role:'user', content: prompt}` 与 assistant 回复 `trimConversation` 后写回 Redis。注意：prompt 前置注入的内容会随之进入历史并逐轮累积。

工具调用循环：api 分支 `core.js:787-921` 的 while 循环、responses 分支 `core.js:587-618`；claude/gemini 的循环在各自 client 内部。工具轮的 system 来自同一次构造的 option（api 分支 `sendOpenAIWithContextFallback` 复用 `option.systemMessage`，只在上下文超限重试时才经 `buildOpenAISystem` 重建，`core.js:730`），因此 system 层注入在工具轮持续可见且不会重复执行注入动作。

## 2. 现有的上下文注入点

- 系统提示词：`prompts/` 目录目前为空，它是用户自建设定库（`utils/prompts.js:3` `readPrompts` 读 `prompts/*.txt`，经 `apps/prompts.js` 的指令管理）。选定设定后写入各 provider 的提示词配置项（`Config.promptPrefixOverride` / `geminiPrompt` 等，`apps/prompts.js:164` 等处引用），最终由 `core.js:285-291` 读入、各分支拼进 system。
- 记忆 V2 召回注入：`apps/chat.js:1022-1038`，`enableMemory` 开启时调 `buildMemoryPrompt`（`utils/memory/recall.js:277`），以 `prompt = memoryPrompt + '\n\n' + prompt`（`apps/chat.js:1032`）前置于用户消息。发生在 Core 之前、provider 无关。
- 首轮 InnerOs（面包版思考/全局破限）：`apps/chat.js:1041-1043`，`previousConversation?.num === 0` 时把 `config.paimon_globalInnerOs` 以标记包裹追加到 prompt 末尾。这是现成的「会话级只注入一次」先例。
- `utils/postprocessors/`：`collectProcessors(type)`（`utils/postprocessors/BasicProcessor.js:34`）动态加载该目录下继承 `AbstractPostProcessor` 的类，支持 `pre`/`post`（`BasicProcessor.js:12`），但目录里只有 `ReasonerProcessor.js`（post）。它在 `apps/chat.js:1123` 于模型返回之后处理 `{text, thinking_text}`，不接触模型请求，与「发送前注入」无关。
- MCP 工具挂载：`core.js:1154-1163` 在 `collectTools` 里当 `Config.enableMcp` 时把 `McpManager.getTools()`（`utils/mcp.js:144`）追加进工具表；MCP 客户端在 `utils/mcp.js:20-142` `init()` 连接服务器并拉工具列表。工具只以 schema 交给模型，靠模型自主调用，不带任何自动注入——与现状（16 个 MCP 工具靠模型自己调 `breath()`）一致。
- 群上下文：`handleSystem`（`core.js:132-184`）与 claude/gemini 分支的内联副本，把群历史拼进 system。

## 3. 有没有现成的 hook / 事件 / 生命周期机制

没有。全仓搜索 `presend` / `beforeRequest` / `EventEmitter` / `middleware` / `emit` 均无命中（个别 `on()` 是子进程与 websocket 的 IO 监听）。插件只有云崽平台的 handler 挂载点：`e.runtime.handler` 上注册了 `chatgpt.button.post`、`chatgpt.response.post`（`apps/chat.js:1133-1143`，示例见 `apps/example_handler.js:12`）、`chatgpt.markdown.convert`（`apps/chat.js:1510`）——全部位于模型响应之后，不存在「发送前」钩子。postprocessors 的 `pre` 类型声明了但目录里无实现，且其入参不包含请求上下文，不能直接当 presend 用。

## 4. 最小改动候选插入点

### (a) 每轮对话注入（每条消息发给模型前）

候选 A1：`apps/chat.js` abstractChat，记忆召回之后（`apps/chat.js:1038` 与 1041 之间）
- 做法：仿记忆召回的样子 GET breath-hook，`prompt = hookText + '\n\n' + prompt`（或追加）。
- 理由：一处改动覆盖全部四个 provider 与所有入口（chatgpt、第一人称、自主回复都汇到 abstractChat）；不碰 provider 分支，不碰工具循环；与既有记忆注入同款模式，风格一致。
- 代价：注入文本随 `apps/chat.js:1103-1106` 进入对话历史并逐轮累积重复（记忆注入也有此行为，但它按相关性变化，固定文本会明显堆积）；注入落在 user 消息而非 system，权威性弱一些。

候选 A2：`model/core.js` 各 provider 分支的 system 终点，`resolveTurnSystem` 之前
- 具体：claude 在 `core.js:389` 前、gemini 在 `core.js:470` 前、responses 在 `buildResponsesInstructions`（`core.js:486` 附近）内、api 在 `buildOpenAISystem`（`core.js:661-664`）内，各自 `system += hookText`；建议抽一个 `appendBreathHook(system, e)` helper 供四处调用。
- 理由：进 system，权威且不进对话历史（四个分支的历史持久化都不含 system），零累积；工具调用循环每轮请求都带同一 system，注入内容对工具轮持续可见；`prepared.system` 缓存保证一轮只 GET 一次、主备重试复用同一份。
- 代价：要动四个分支（AGENTS.md 明确警告过「跨 provider 分支全称断言」翻车史，四处插入必须逐个核对）；responses 分支的 instructions 有上下文超限重试重建路径（`core.js:566-567`），注入要放在重建函数内才能在重试后保留。

### (b) 会话级注入（每个对话/群首次时）

候选 B1：`apps/chat.js:1041-1043` 的 InnerOs 位置，复用 `previousConversation?.num === 0` 判定
- 理由：`num === 0` 即「Redis 中无该 scope 的会话」，与本会话首次语义吻合，对话过期或 `#结束对话` 后下一条消息自然重新触发；照抄 InnerOs 先例，改动一处、provider 无关。
- 代价：与 A1 相同，落在 user 消息；另需注意群合并（`groupMerge`）时会话 scope 是群号（`apps/chat.js:976`），「首次」以群为单位而非以用户为单位。

候选 B2：会话默认 system 条目（`apps/chat.js:983-985` 初始化 messages 里的 system 消息）——不推荐：该 messages 数组只在 OpenAI api/responses 无 store 模式下生效，claude/gemini 完全不用，覆盖面残缺。

### 对 breath-hook 场景的建议

「=== 核心准则 ===」这类固定分节准则文本，语义上是常驻指令，适合 system：A2 不累积历史、每轮请求（含工具轮）都新鲜可见，是正确形态。若想先以最小代价验证链路，A1 一处改动即可跑通，接受历史累积。会话级若也需要，B1 与 A2 可并存（不同粒度互不干扰）。HTTP GET 属外部请求，按仓库不变式应设超时与失败跳过（失败不影响对话发出）。

## 5. 配置项模式（加 breathHook.enable / breathHook.url 开关）

- 默认值：`utils/config.js:27` `defaultConfig` 对象里加键（平铺 `breathHookEnable: false` / `breathHookUrl: ''`，或嵌套对象；相邻先例 `enableMemory` 在 `utils/config.js:356`、`enableMcp` 在 `utils/config.js:372`）。合并逻辑在 `utils/config.js:484` `lodash.mergeWith(..., useWholeArray)`，普通键无需额外处理。
- 读取：`Config` 是 Proxy（`utils/config.js:598`），非 provider 字段直接 `Config.breathHookEnable` 透传（`config.js:650`）；abstractChat 处则用 `providerConfig(profile, source)` 产出的 config 对象读（与 `apps/chat.js:1022` 读 `config.enableMemory` 同款）。
- 锅巴面板：需在 `guoba.support.js` 同步 schema 字段，先例 `enableMcp` 在 `guoba.support.js:1942`、`memoryContextLimit` 在 1870；不改面板也可用 config.json 手工配置，只是面板不可见（AGENTS.md 规则：只要求面板公开字段同步锅巴）。
- 保存走 Proxy 的 set / `saveDiff`（`utils/config.js:511-651`），新键自动纳入，无需另写保存逻辑。

## 结论：能不能做，推荐插在哪

能做。插件没有任何现成的 presend hook，但「发送前注入」在链路上有多个已被验证的先例（记忆召回、InnerOs），实现成本很低。推荐：每轮注入插在 `model/core.js` 四个 provider 分支的 system 终点（A2，`resolveTurnSystem` 之前，抽公共 helper 四处调用），不污染对话历史、工具轮持续可见；若追求最小改动先验证，插在 `apps/chat.js` 记忆召回之后 prompt 前置（A1）一处即可。会话级走 `apps/chat.js:1041` 的 `num === 0` 先例（B1）。开关在 `utils/config.js` defaultConfig 加键并在 `guoba.support.js` 补 schema。
