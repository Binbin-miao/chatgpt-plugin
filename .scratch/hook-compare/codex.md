# OpenAI Codex CLI 的 hook 机制调研

总评：有，且是正式（Stable）功能——完整的用户可配置生命周期 hook，事件覆盖、阻塞、注入、改写均支持；仅插件来源的 hook 仍处于白名单受限状态。

## 配置格式
- 两种写法：config.toml 内联 `[hooks]`（`codex-rs/config/src/config_toml.rs:500-501`），或各配置层目录下的 `hooks.json`（`codex-rs/hooks/src/engine/discovery.rs:390-394`），两者可共存但会告警建议只留一种（discovery.rs:184-194）。
- 事件结构：`HookEventsToml`，每个事件是 `[{ matcher, hooks: [...] }]` 数组（`codex-rs/protocol/src/hooks.rs:9-38,140-146`）。
- 处理器类型：`command`（含 `commandWindows`、`timeout`、`async`、`statusMessage`、`additionalContextLimit`）和 `mcp_tool`（server/tool/input）；`prompt`/`agent` 类型是空占位、尚未实现（`codex-rs/protocol/src/hooks.rs:148-188`）。

## 事件清单（14 个）
PreModelRequest、PostModelRequest、PreToolUse、PermissionRequest、PostToolUse、PreCompact、PostCompact、SessionStart、SessionEnd、UserPromptSubmit、SubagentStart、SubagentStop、Stop、Interrupt（`codex-rs/protocol/src/hooks.rs:10-37`）。

## 执行管线
- 入口引擎 `ClaudeHooksEngine`，从各配置层（低到高优先级）+ 插件 manifest 收集 handler（`codex-rs/hooks/src/engine/discovery.rs:118-239`）。
- 同一事件的多个 handler 并发执行（`FuturesUnordered`，`codex-rs/hooks/src/engine/dispatcher.rs:133-134`），结果按配置顺序上报，但 PreToolUse 的 `updatedInput` 竞争按完成先后取最后者（`codex-rs/hooks/src/events/pre_tool_use.rs:153-171`）。
- 入参经 stdin 传 JSON：含 session_id、turn_id、cwd、transcript_path、model、permission_mode、tool_name、tool_input 等（`codex-rs/hooks/src/events/pre_tool_use.rs:181-197`）。
- 默认超时 600 秒，最小 1 秒（`codex-rs/hooks/src/engine/discovery.rs:968`）；SessionEnd 例外，默认 1 秒（`codex-rs/hooks/src/events/session_end.rs:20`）。

## 输出消费语义（以 PreToolUse 为例）
- 退出码 0 + JSON：`hookSpecificOutput.permissionDecision:"deny"` 或旧式 `decision:"block"` 可阻塞，`reason` 回馈给模型（`codex-rs/hooks/src/events/pre_tool_use.rs:223-259`）。
- 退出码 2 + stderr 非空同样阻塞；其他非零退出码仅记为 Failed，不阻塞（pre_tool_use.rs:268-291）。
- `additionalContext` 注入模型上下文，超过阈值（默认约 2500 token，可配）会转存磁盘（pre_tool_use.rs:230-240；`codex-rs/protocol/src/hooks.rs:162-171`）。
- `permissionDecision:"allow"` + `updatedInput` 可改写工具入参（pre_tool_use.rs:409-431）。
- 只有同步 handler 能产生控制效果（阻塞/改写）；`async: true` 的 handler 仅通知（`codex-rs/hooks/src/engine/mod.rs:194-209`）。
- UserPromptSubmit 输出 `should_stop`/`stop_reason` 与 `additional_contexts`（`codex-rs/hooks/src/events/user_prompt_submit.rs:36-41`）。

## 安全与门控
- 功能开关 `features` key 为 `hooks`，Stable、默认启用（`codex-rs/features/src/lib.rs:1503-1510`）。
- 项目级 hooks 与 exec policy 一样受项目信任门控，未信任项目不加载（`codex-rs/config/src/loader/mod.rs:1148`）。
- hooks 可带 `trusted_hash`/`enabled` 状态（`codex-rs/config/src/hook_config.rs:29-38`）；企业可用 requirements.toml 的 `allow_managed_hooks_only = true` 屏蔽用户/项目 hooks（上游 Codex 仓库 config.md 文档 9-15 行）。

## 最接近但不等同的机制
- 旧 `notify` 配置：turn 结束后把 JSON 作为最后一个 argv 参数调用外部程序，纯通知，已实现为遗留 hook，计划移除（`codex-rs/hooks/src/legacy_notify.rs:1-60`）。
- MCP 工具可作为 hook handler 被调用（`codex-rs/protocol/src/hooks.rs:173-183`）。
- 插件 hook 目前仅放行内置白名单的清理类 hook，其余一律过滤（`codex-rs/core-plugins/src/executor_hooks.rs:31-32,121-152`）。
