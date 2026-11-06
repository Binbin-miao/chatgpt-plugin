# OpenCode（sst/opencode）hook 机制

总评：OpenCode 的插件 hook 是「TS 模块内注册、按域组织的 mutate 事件对象」模型，注入上下文能力完整（system/messages/prompt 均可改写），但仅工具调用前一处可阻塞，无超时隔离。注意：仓库正处于 Effect 重构期，官方文档仍是旧版字符串键 API，两者差异较大。

## 注册方式

- 插件来源：opencode.json 的 `"plugin": ["npm-pkg", {"package": ..., "options": ...}]` 数组（schema/src/config.ts:106；schema/src/config/plugin.ts:7-14），或 `.opencode/plugins/`、`~/.config/opencode/plugins/` 目录自动发现 .ts/.js（core/src/plugin/source-directory.ts:6-8）。npm 包由 Bun 自动装到 `~/.cache/opencode/node_modules/`。
- 模块形状：default export `{id, effect(ctx)}`（Effect 风格）或 `{id, setup(ctx)}`（Promise 风格，经 adapter 转接）（core/src/plugin/module.ts:76-90；plugin/src/promise/adapter.ts）。ctx 上挂约 20 个域，注册即调用：`ctx.session.hook("context", cb)`（plugin/src/effect/plugin.ts:41-75）。

## hook 点全集（按域，plugin/src/effect/*.ts）

- aisdk（aisdk.ts:8-17）：`sdk`、`language`——provider SDK 与 LanguageModel 实例创建时触发，可整体替换实例（core/src/aisdk.ts:350,357）。可按 providerID 限定（registration.ts:13）。
- session（session.ts:188-202）：`prompt`（用户输入入库前，可改写 text/files/agents/skills，core/src/session/prompt.ts:42）；`context`（每次模型请求组装，可改 messages/system/options/tools，core/src/session/model-request.ts:442-445）；`compaction`、`title`（设 `result` 可跳过模型请求直接采用）；`generate`；`model.request`（改 baseURL/headers，model-request.ts:338）；`http.request`/`http.response`（可替换 Request/Response 对象，model-request.ts:359,373）；`experimental.ws.handshake/send/receive`（逐帧改写 WebSocket 帧，session.ts:107-145）；`retry`（决定重试与延迟）；`experimental.idle`（会话空闲时可注入合成消息使其继续）。
- permission（permission.ts:20-21）：`evaluate`——规则判定后、弹窗前，可改写 `effect`(allow/deny/ask) 与 message（core/src/permission.ts:190-196）。
- shell（shell.ts:12-13）：`create.before`——可改写 command/cwd/timeout/shell/env（core/src/shell.ts:284）。
- tool（tool.ts:30-46）：`execute.before`（可改写 input）、`execute.after`（可改写 result.content/output/error）。另有 `tool.transform`（ToolEditor 增删改工具定义）、`agent.transform` 等非 hook 的 transform API。

## 语义

- 注入上下文：明确支持。`session.context` 的 `system`（SystemPart 数组）与 `messages` 是 DeepMutable，可直接塞 system-reminder 或消息；内置 plan 插件即用此法在消息尾部追加模式提醒（core/src/plugin/plan.ts:57-70）。`session.prompt` 可改写用户原始输入。
- 返回值协议：无。回调 mutate 传入的事件对象字段，trigger 顺序执行后把同一对象返回给核心使用（core/src/plugin/hooks.ts:88-95）；如 tool.execute.before 改写后的 `event.input` 会传给实际执行（core/src/tool.ts:182）。
- 阻塞：仅 `tool.execute.before` 可失败，抛 Tool.Error 则拒绝本次工具调用（hooks.ts:23-24、tool.ts:122）；其余 hook 失败通道为 never，抛错即 defect 向上冒泡、中断当前请求。legacy promise 钩子同样只有 execute.before 的 rejection 转为 Tool.Error（plugin/src/promise/adapter.ts:685-691）。
- 超时：无任何超时包装，hook 卡住即卡住整条链路。
- 顺序：按注册顺序同步 await（hooks.ts:75,89-93）；注册顺序取决于插件加载顺序：全局配置 → 项目配置 → 全局插件目录 → 项目插件目录（web/src/content/docs/plugins.mdx:56-62），无显式优先级配置。

## 附注

官方文档 plugins.mdx 仍是旧版形状（导出插件函数、返回字符串键 hooks 对象如 `"tool.execute.before"`、`shell.env`、`experimental.session.compacting`、`tui.*`），这些键在当前源码的 PluginHooks 中已不存在；以源码的域化 API 为准。
