# Claude Code hooks 机制源码核实

来源：GitHub 镜像 nadonghuang/claude-code（v2.1.76 反混淆 TS，commit d0a2351），原克隆于工作区根的 hook-repos/claude-code（未随本仓入库，按 commit 可复现）。以下行号均指该镜像。

## 1. 事件清单（coreTypes.ts:25 起）
HOOK_EVENTS 共 27 个：PreToolUse、PostToolUse、PostToolUseFailure、Notification、UserPromptSubmit、SessionStart、SessionEnd、Stop、StopFailure、SubagentStart、SubagentStop、PreCompact、PostCompact、PermissionRequest、PermissionDenied、Setup、TeammateIdle、TaskCreated、TaskCompleted、Elicitation、ElicitationResult、ConfigChange、WorktreeCreate、WorktreeRemove、InstructionsLoaded、CwdChanged、FileChanged。文档称「30 余个」与源码不符。

## 2. 处理器类型（schemas/hooks.ts:176-189）
配置 schema 为判别联合，仅 4 种：command / prompt / agent / http。文档所列 mcp_tool 不是配置里的 hook 类型（src 中 mcp_tool 仅作为分析元数据出现，services/analytics/metadata.ts:68）。内部另有 callback 型（types/hooks.ts:211）供 SDK/内部钩子使用，不可持久化。
- command 型独有字段：shell（bash/powershell）、statusMessage、once、async、asyncRewake（asyncRewake 在退出码 2 时唤醒模型，hooks.ts:205）。
- prompt/agent 型：prompt 支持 $ARGUMENTS 占位符，可选 model；agent 型为「agentic verifier」。
- `if` 字段（schemas/hooks.ts:19）：权限规则语法（如 "Bash(git *)"），按 tool_name/tool_input 预过滤，不匹配则不生成子进程。文档通用字段描述正确。
- 响应额外支持 {async: true, asyncTimeout}（types/hooks.ts:171）。

## 3. matcher 匹配（utils/hooks.ts:1340-1380）
空或 '*' 匹配全部；只含 `|` 的简单串按管道分隔精确匹配；其余按正则 new RegExp(matcher).test()——是部分匹配而非全匹配。无效正则记日志后返回 false。

## 4. http 型实现（utils/hooks/execHttpHook.ts）
- 请求：axios.post(url, jsonInput)，body 为 hook 输入 JSON 原文，Content-Type: application/json（158-201 行）。maxRedirects: 0；任意状态码均接受（validateStatus: () => true），ok = 2xx（227 行）。
- 响应解析在调用方 hooks.ts:470：body 必须是 JSON，否则报 "HTTP hook must return JSON"，非 2xx 时 stderr 报错。文档未提「响应必须为 JSON」这一硬约束。
- 安全机制：SSRF 防护（ssrfGuardedLookup，拦私有/链路本地地址，放行 loopback）；allowedHttpHookUrls URL 白名单（通配符 *）；headers 值支持 $VAR/${VAR} 插值但必须列在 allowedEnvVars，未列入的替换为空串；插值后剥离 CR/LF/NUL 防头注入（76-79 行）。
- 默认超时 10 分钟（12 行），与 command 型一致。

## 5. UserPromptSubmit 注入路径
additionalContext 不进 system prompt：转成 isMeta: true 的 user 消息并包 system-reminder 标签（utils/messages.ts:4040-4054）。command 型 stdout（退出码 0）走 hook_success attachment，经 applyTruncation 后作为 attachment 消息进入上下文（processUserInput.ts:243-262）；JSON 输出走 hookSpecificOutput.additionalContext（同文件 226-240 行）。阻止时返回 system 警告消息并附原始 prompt（194-208 行），preventContinuation 则插入一条 user 消息并停止（213-224 行）。

## 6. 10000 字符溢出（processUserInput.ts:272-279）
MAX_HOOK_OUTPUT_LENGTH = 10000，超出即硬截断并加后缀 "… [output truncated - exceeded 10000 characters]"。不写文件。磁盘溢出（TaskOutput.ts:9，8MB 上限 spillToDisk）只用于后台任务输出落盘，与 hook 上下文注入无关。

## 7. 超时默认值
通用默认 TOOL_HOOK_EXECUTION_TIMEOUT_MS = 600 秒（hooks.ts:166），非文档常见的 60 秒。SessionEnd 单独收紧为 1500ms，可用 CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS 覆盖（hooks.ts:175-182）。agent 型 schema 描述称默认 60 秒（schemas/hooks.ts:148），两种默认并存。

## 文档与源码不一致汇总
1. 处理器类型：文档列 5 种含 mcp_tool；源码仅 4 种持久化类型，mcp_tool 不存在。
2. onFailure：源码全库无此字段，文档描述的 http 型 onFailure 行为无实现。
3. 事件数量：源码 27 个，文档称 30 余个；PostToolUseFailure、StopFailure、PostCompact、TeammateIdle、Elicitation 等多为未入文档的内部事件。
4. 10000 字符：源码为硬截断加提示后缀，并非溢出转文件。
5. additionalContext 注入：进 meta user 消息（system-reminder 包装），不是 system prompt。
6. http 响应：文档未说明必须为合法 JSON，且任意状态码都不抛错（只影响 ok 标记）。
7. 默认超时：源码 600 秒；agent 型另有 60 秒默认。
