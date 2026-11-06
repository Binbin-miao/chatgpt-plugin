# Codex CLI MCP 客户端能力清单

总评：Codex 的 MCP 客户端是自研 rmcp 封装，传输只支持 stdio 与 Streamable HTTP，鉴权体系（OAuth/bearer/headers）非常完善，但明确不支持 MCP prompts，sampling 与 roots 也未实现。

## 1. 传输与配置
- 传输仅两种：`Stdio` 与 `StreamableHttp`，无传统 SSE 传输（SSE 仅作为 HTTP 响应流解析）。`config/src/mcp_types.rs:652-693`
- 配置在 config.toml 的 `[mcp_servers.*]`：`config/src/config_toml.rs:299-301`
- Stdio 字段：command/args/env/env_vars/cwd（mcp_types.rs:654-663）；StreamableHttp 字段：url/bearer_token_env_var/http_headers/env_http_headers/http_headers_helper（mcp_types.rs:666-692）
- 超时：默认启动 30s、工具调用 300s（codex-mcp/src/rmcp_client.rs:122-123），可按服务器 `startup_timeout_sec`/`tool_timeout_sec` 覆盖（mcp_types.rs:281,285）；可选服务器建目录有共享宽限 `mcp_optional_startup_grace_ms` 默认 1000ms（config_toml.rs:328 前后）
- 启动失败不致命：服务器标记为不可用，TUI 提示 "could not connect / Sign in again using codex mcp login"（tui/src/bottom_pane/warnings_view_tests.rs:19 佐证）

## 2. 鉴权
- 完整 OAuth：授权码 + 本地回调端口、PKCE、静默刷新、client credentials、企业 OAuth（rmcp-client/src/perform_oauth_login.rs、oauth_client_credentials.rs、enterprise_oauth_login.rs）；`/mcp login <name>` 触发（tui/src/slash_command.rs:156）
- Streamable HTTP 启动时自动探测 401/WWW-Authenticate 并发现 OAuth 端点（rmcp-client/src/auth_status.rs 导出 `discover_streamable_http_oauth`）
- 凭据存储可选 keyring/file（config_toml.rs `mcp_oauth_credentials_store`）；bearer_token 内联已被禁用，只能用 `bearer_token_env_var`（config/src/mcp_edit.rs:33-43）
- 企业托管认证 EMA：IdP 统一签发（config/src/mcp_ema.rs:228 起）

## 3. 工具发现与刷新
- 启动即 tools/list 并缓存（codex-mcp/src/tool_catalog_cache.rs、rmcp_client.rs:1251）
- 支持运行中刷新：监听 `ToolListChangedNotification` 递增版本号（rmcp-client/src/tool_list_changes.rs:58-70），由 feature 开关 `mcp_tool_list_changed` 控制（features/src/lib.rs:1730）
- 命名：模型可见名走 `mcp__` 前缀 + 消毒/去重/截断 ≤128 字节（codex-mcp/src/tools.rs:22,111-140），协议层用原始名

## 4. resources / prompts
- resources：支持，分页 list/read + 事件订阅（codex-mcp/src/resource_client.rs:186,279）
- prompts：不支持——codex-mcp 全目录无 `prompts/list`/`get_prompt` 调用；`/prompt` 类命令基于本地 markdown 自定义提示词，与 MCP 无关

## 5. 高级能力
- elicitation：支持且较深——初始化声明 elicitation 能力（codex-mcp/src/rmcp_client.rs:1355-1357），有策略仲裁（自动接受/拒绝/上抛审批事件，codex-mcp/src/elicitation.rs），含 userVerification 扩展
- sampling：不支持（无 create_message 路径）
- roots：不支持（初始化能力里未声明，无 roots/* 处理）
- 客户端另声明实验性扩展：网络策略元能力、OpenAI form/elicitation 扩展（codex-mcp/src/client_capabilities.rs）

## 6. 运维与审批
- `/mcp` 面板：列出 MCP 工具，支持 verbose 与 login 子命令（tui/src/slash_command.rs:156）
- 工具调用审批：走完整审批流——按 AskForApproval 策略（Never/OnRequest/UnlessTrusted/Granular）决定是否弹审批，决策含 Approved/Denied/ApprovedForSession 等（core/src/mcp_tool_call.rs:228,278-320,895-913）；有信任服务器白名单（core/src/mcp.rs:387 `is_trusted_chatgpt_mcp_server`）

## 7. 与 hook 系统联动
- hook handler 支持 `McpTool` 类型：配置 server/tool/input 模板（hooks/src/engine/mod.rs:149-159），由 `run_mcp_tool` 展开参数模板并调用已连接的 MCP 工具（hooks/src/engine/mcp_runner.rs:26-33），经 `HookMcpExecutor` trait 解耦（hooks/src/mcp.rs:24-28），输出按命令 hook 语义解析
