# Claude Code MCP 客户端能力清单（v2.1.76 反混淆源码核实）

总评：支持面最全的参照系，工具/资源/提示词三类能力齐备且运维细节最厚；唯一明显缺口是 sampling（客户端无法代表服务器发起 LLM 调用）。

## 1. 传输方式
- 类型枚举：`stdio / sse / sse-ide / http / ws / sdk`（services/mcp/types.ts:23-25），另有 claudeai-proxy、ws-ide 内部类型（types.ts:69-122）。
- stdio：`command/args/env`，type 可省略（types.ts:28-35）；SSE/HTTP：`url/headers/headersHelper/oauth`（types.ts:58-97）；HTTP 即 Streamable HTTP，SSE 为旧式，两者并存。
- 额外：WebSocket（含 IDE）、SDK 内嵌 InProcessTransport、claude.ai 代理服务器（types.ts:116-122）。

## 2. 鉴权
- OAuth：PKCE 授权码流程 + 本地回调端口（services/mcp/auth.ts、oauthPort.ts），支持自定义 clientId/callbackPort/authServerMetadataUrl（types.ts:43-56）；XAA 跨应用访问（SEP-990）（auth.ts:353-356、xaa.ts）。
- /mcp 面板对 needs-auth 服务器发起登录；token 存 macOS Keychain（auth.ts:42 clearKeychainCache）。
- 自定义 headers 静态配置 + headersHelper 外部脚本动态生成（types.ts:63、headersHelper.ts）。

## 3. 工具发现与刷新
- 连接成功且 capabilities.tools 存在时调 tools/list，LRU 缓存 20 个 server（client.ts:1743-1755、1726）。
- 监听 tools/prompts/resources 三种 list_changed 通知并失效缓存刷新（useManageMCPConnections.ts:616-746）。
- 命名：`mcp__<server>__<tool>`，server 名与工具名做 normalize（mcpStringUtils.ts:40-51、normalization.ts）；SDK 型可经 CLAUDE_AGENT_SDK_MCP_NO_PREFIX 去前缀（client.ts:1761-1763）。

## 4. resources / prompts
- 两者都支持：prompts/list 转为 slash 命令 `mcp__server__prompt`，参数按空格拆分传给 prompts/get（client.ts:2042-2096）。
- resources/list 经 ListMcpResourcesTool、ReadMcpResourceTool 两个内建工具暴露（tools/ListMcpResourcesTool/、tools/ReadMcpResourceTool/），非 @-mention 机制。

## 5. 高级能力
- elicitation：支持，声明 capability（client.ts:999），form 型走交互 handler（elicitationHandler.ts），URL 型 elicitation（错误码 -32042）带重试与 hook 程序化应答（client.ts:2803-3020）。
- roots：支持，声明 capability 并响应 ListRoots 返回启动目录（client.ts:995、1009-1018）。
- sampling：不支持（全仓无 createMessage 处理）。

## 6. 运维
- 连接超时默认 30s（MCP_TIMEOUT 可调，client.ts:456-457）；单请求 60s（client.ts:463）；工具调用超时默认约 27.8 小时（MCP_TOOL_TIMEOUT 可调，client.ts:211-227）。
- 自动重连：仅远程传输（stdio/sdk 不重连），指数退避最多 5 次（useManageMCPConnections.ts:87-88、354-391）。
- /mcp 面板：服务器列表含 connected/failed/needs-auth/pending/disabled 五态（types.ts:180-226），可查看工具/资源明细、重连、OAuth 登录；另有连通性通知 hook（hooks/notifs/useMcpConnectivityStatus.tsx）。
- 单 server 失败：记录为 failed 状态继续运行，stderr 输出截断至 64MB 供调试（client.ts:966-983），不影响其他 server。

## 7. 配置层级
- scope 枚举：local/user/project/dynamic/enterprise/claudeai/managed 七层（types.ts:10-20）；project 即 .mcp.json（config.ts:89），local 存项目级私有配置，user 存全局；enterprise 策略可独占控制并 allowlist/denylist（config.ts:358-411、650-707）。
- 插件携带：插件内 .mcp.json 或 MCPB（.mcpb 打包）自动注册，MCPB 支持用户配置项（utils/plugins/mcpPluginIntegration.ts、mcpbHandler.ts）。

## 8. 权限
- MCP 工具调用默认走权限系统（MCPTool.checkPermissions 为 passthrough 即需批准，tools/MCPTool/MCPTool.ts:56-61）。
- 规则形状：`mcp__server1` 匹配整 server，`mcp__server1__tool1` 精确匹配，支持 `mcp__server1__*` 通配（utils/permissions/permissions.ts:236-259）。
- 额外一层：project scope（.mcp.json）服务器首次加载需弹窗批准（services/mcpServerApproval.tsx:11-19）。
