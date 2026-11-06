# OpenCode MCP 客户端能力清单（源码核实）

总评：opencode 的 MCP 层已完成 Effect 重构且相当成熟（packages/core/src/mcp/），覆盖 local/remote 双传输、OAuth、elicitation、resources/prompts，运维细节（超时分级、会话过期重连、连接池）在同类客户端中属第一梯队；仅 sampling 未实现。

## 1. 传输方式
- local (stdio)：`packages/core/src/mcp/stdio.ts:47`（经 Environment spawner 派生，scope 关闭即杀进程）；配置字段 `command`（数组）、`cwd`、`environment`
- remote：仅 Streamable HTTP（`packages/core/src/mcp/client.ts:349` StreamableHTTPClientTransport），无 SSE 回退传输
- 配置 schema：`packages/schema/src/mcp.ts:26-72`（LocalConfig/RemoteConfig）；字段 `type`、`url`/`command`、`headers`、`environment`、`disabled`（新版取代旧版 `enabled`，见 `packages/core/src/v1/config/mcp.ts:17`）、`codemode`、`timeout`、`protocol`（legacy/auto/2026-07-28）、`pool`（跨目录共享连接）
- mcp 配置入口 `mcp.servers` + 全局 `mcp.timeout`：`packages/core/src/config/plugin/mcp.ts:36-48`；配置变更热重载：同文件 ：23-30

## 2. 鉴权
- headers：RemoteConfig.headers 透传 requestInit（`packages/core/src/mcp/client.ts:347-351`）
- OAuth：支持，remote 服务器自动注册为 OAuth integration（`packages/core/src/mcp/index.ts:242-281`），支持动态客户端注册 RFC 7591、clientId/secret/scope/callbackPort/redirect_uri/auth_server_metadata_url（`packages/schema/src/mcp.ts:45-55`；v1 描述见 `packages/core/src/v1/config/mcp.ts:29-44`）；`oauth: false` 可关闭自动探测（index.ts:243）
- UI 入口为 TUI 的 /mcps 对话框（packages/tui/src/component/dialog-mcp.tsx），`auth login` CLI 命令面向 provider 而非 MCP；凭据变更自动重连：index.ts:693-711

## 3. 工具发现与命名
- 发现：connect 时列 tools（connection.ts:180-213），`notifications/tools/list_changed` 触发刷新（connection.ts:158），工具层防抖 100ms 重载（packages/core/src/tool/mcp.ts:131-141）
- 命名：`{server}_{tool}` 前缀，非法字符替换为 `_`（packages/core/src/tool/runtime.ts:288-293；tool/mcp.ts:23-25）
- attach：插件可挂载 client-hosted 连接并按名堆叠遮蔽（index.ts:588-647）
- codemode：默认 true，把工具暴露给 Code Mode 执行（tool/mcp.ts:57）

## 4. resources / prompts / elicitation / sampling
- resources：支持列出+模板+读取（index.ts:866-904），resources/list_changed 通知（connection.ts:160）
- prompts：支持（index.ts:852-865，prompts changed 刷新 connection.ts:121-128）
- elicitation：支持，含 url 模式与新旧两版协议，表单走 Form 服务（index.ts:312-386；client.ts:282-290）
- instructions：注入系统提示（index.ts:843-851）
- sampling：未实现（mcp 目录无任何 sampling 处理代码）

## 5. 运维
- 超时三段：startup（默认 30s，client.ts:35）、catalog（默认 30s，client.ts:36）、execution（默认 12h，client.ts:37）；可按服务器覆盖（schema/mcp.ts:7-17）
- 启动失败隔离：启动异步 fork 不阻塞主流程（index.ts:662-677），失败置 failed/needs_auth 状态并广播（index.ts:455-460），工具调用遇到未连接服务器返回引导文案（index.ts:84-95）
- 会话恢复：Mcp-Session-Id 失效（404/400）自动重连重放（connection.ts:130-150；client.ts:305-323）
- 审批：每次工具调用经 Permission.assert，action 为 `{server}_{tool}`（tool/mcp.ts:63-69）
- 状态机：pending/connected/disabled/failed/needs_auth（schema/mcp.ts:77-96）

## 6. Effect 重构影响
- MCP 实现已全面 Effect 化：核心在 `packages/core/src/mcp/`（index/connection/client/stdio/oauth/pool），schema 在 `packages/schema/src/mcp.ts`；v1 旧配置经迁移层兼容（core/src/v1/config/migrate.ts）
- 大量使用 Layer/Fiber/Scope/Latch/KeyedMutex，注释详尽、边界处理精细，应视为稳定实现而非过渡态；代价是代码抽象度高，改动需理解 Effect 语义
