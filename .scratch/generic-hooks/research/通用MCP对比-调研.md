# 通用 MCP 能力对比：本仓 vs 四大 agent（源码核实版）

对比本仓 chatgpt-plugin 的通用 MCP（`utils/mcp.js` + `utils/tools/McpTool.js`）与 Claude Code、Codex、hermes-agent、OpenCode 的 MCP 客户端能力。四家分稿在 `.scratch/hook-compare/`（`mcp-` 前缀四篇，全部带文件:行号）；本仓部分为直接源码阅读。背景：用户怀疑「本仓通用 MCP 可能不太完善」，本文核实差距并分级。

## 一、总览

| | 本仓 | Claude Code | Codex | hermes-agent | OpenCode |
|---|---|---|---|---|---|
| 传输 | stdio / SSE / Streamable HTTP（官方 SDK） | + ws / sdk / 代理，最全 | stdio / Streamable HTTP（无 SSE） | 三种（HTTP 先探测自动选型） | stdio / Streamable HTTP（无 SSE 回退） |
| 鉴权 | **无任何字段，裸连** | headers + headersHelper 动态头 + 完整 PKCE OAuth + Keychain | OAuth 全家桶 + `bearer_token_env_var`（内联禁用）+ 企业 EMA | headers + OAuth 2.1 全流程（PKCE/动态注册/磁盘缓存/401 自愈）+ 客户端证书 | headers + OAuth（动态注册，可关探测） |
| 工具发现 | 连接时 `listTools()` **仅一次** | LRU 缓存 + 三种 list_changed 自动刷新 | 启动缓存 + ToolListChangedNotification（feature 开关） | 启动 + 动态刷新 + schema 磁盘缓存 + lazy 首调 | connect 时列 + list_changed 防抖刷新 |
| 命名/冲突 | **直接用远端名，跨 server 冲突无防护** | `mcp__<server>__<tool>` + normalize | `mcp__` 前缀 + 消毒/去重/截断 ≤128B | `mcp__<server>__<tool>` + include/exclude 过滤 + 冲突消解 | `{server}_{tool}` + 非法字符替换 |
| resources/prompts | 无（capabilities 声明为空） | 两者都支持（prompts→slash 命令） | resources 支持；**prompts 不支持** | 都支持但折算成 utility tools | 都支持（含模板与变更通知） |
| elicitation | 无 | URL 全链路（-32042 + hook 应答） | 支持（策略仲裁） | 支持 | 支持（url 模式 + 新旧协议） |
| sampling | 无 | 无 | 无 | 有（含限速与 token 上限） | 无 |
| 超时 | 未显式配置，依赖 SDK 默认 | 连接 30s / 请求 60s / 工具调用可调（默认极长） | 启动 30s / 工具 300s，可按 server 覆盖 | 连接 60s / server 120s / 调用 300s / keepalive | 三段：startup 30s / catalog 30s / execution 12h |
| 重连/健康 | **无** | 远程传输指数退避 5 次 | 标记不可用 + 引导重新 login | 指数退避 + keepalive 探测 + suspect 降级 | Mcp-Session-Id 失效自动重连重放 + 凭据变更重连 |
| 审批/权限 | MCP 工具直接交模型（走插件统一注入开关，无 per-server/per-tool 审批） | MCPTool 默认需批准 + `mcp__server__tool` 规则 | AskForApproval 策略 + 信任服务器白名单 | trust 分级审批 + readOnlyHint + 花费限额 + OSV 恶意包预检 | 每次调用 Permission.assert |
| 失败隔离 | 逐条 try/catch ✅ | failed 状态继续运行 | 不致命 + TUI 引导 | PID 账本 + 按 profile 隔离 | 异步 fork + 状态机 |
| 配置形态 | `mcpServers` JSON 字符串（Claude Desktop 兼容）+ 条目 enabled | 七层 scope（local/user/project/enterprise…） | config.toml `[mcp_servers.*]` | config.yaml `mcp_servers:` 段 | `mcp.servers` + **配置热重载** |

## 二、本仓现状（直接源码阅读）

`utils/mcp.js`：`enableMcp` 总开关 + `mcpServers` JSON（兼容裸对象与 `{mcpServers}` 包装，:32-39）；条目 `enabled:false` 跳过（:51）；type 缺省按 url/command 推断（:65）；stdio 的 python→python3 映射（:93）与相对路径解析（:98-105）；逐条 try/catch 连接失败继续（:135-137）；`destroy()` 优雅关闭（:148）。`utils/tools/McpTool.js`：远端工具原样取名（:8），`callTool` 结果合并 text content（:20-26），错误转 `Error calling…` 文本（:30）。

做得不差的：三传输齐、配置格式与 Claude Desktop 生态兼容、失败隔离、平台兼容细节。**用户的怀疑部分成立**——但有几处比预想的好：失败隔离和传输覆盖不输 OpenCode。

## 三、差距清单（按严重度分级）

**P0（功能性硬伤，接常见服务就会撞上）：**
1. **HTTP/SSE 无鉴权字段**：`StreamableHTTPClientTransport(new URL(url))`（mcp.js:78）没传 requestInit——headers、bearer、OAuth 全无从配置。四家全部支持 headers，三家有 OAuth。接任何要 token 的远端 server 都接不上（Ombre `/mcp` 恰好无鉴权所以能跑）。
2. **工具名无命名空间**：`McpTool` 直接用远端 `mcpTool.name`（McpTool.js:8），两个 server 提供同名工具时 `collectTools` 的 funcMap 相互覆盖。四家全有 `mcp__server__tool` 式前缀 + 消毒。

**P1（运维健壮性）：**
3. **`listTools()` 仅连接时一次**（mcp.js:124）：不处理 `tools/list_changed`，服务端加改工具需重启。四家全支持动态刷新。
4. **无重连/健康检查**：连接断开即永久失效直到重启。四家全有（Claude 退避重试、hermes keepalive+suspect、OpenCode 会话失效重放）。
5. **超时未显式配置**：connect/callTool 依赖 SDK 默认（initialize 请求默认 60s）。四家都是分级显式超时（连接/发现/调用分离）。

**P2（按需）：**
6. **无工具调用审批**：MCP 工具与内置工具一起直接交模型。四家全有审批层。本仓有「提问者闸/Bot 闸」工具注入体系可挂接，但 per-server/per-tool 粒度没有。
7. resources/prompts/elicitation：本仓全无。prompts 对 QQ bot 场景意义有限；resources/elicitation 属锦上添花，四家实现也各不齐。

**不算掉队的：**
- **sampling 缺失不丢人**：四家里 Claude、Codex、OpenCode 三家都没有，只有 hermes 有。
- 多 scope 配置层级（Claude 七层）与热重载（OpenCode）是规模化的产物，本仓场景单层配置 + 重启生效够用（面板文案已注明）。

## 四、建议（供后续评审，不拍板）

1. **P0-1 鉴权**：最小改法是给 http/sse 条目加 `headers` 键值对透传 requestInit；进阶学 Codex 用 `bearer_token_env_var`（环境变量引用而非内联密钥），与仓库「不硬编码密钥」不变式一致。
2. **P0-2 命名空间**：改 `McpTool` 取名为 `mcp__<server>__<tool>`（与 Claude/Codex/hermes 一致，模型圈通用），存量配置里的工具名变化要评估对人设/日志的影响。
3. **P1 三项**（刷新/重连/超时）可打包成一次「MCP 运维健壮性」迭代；`list_changed` 与重连都只需在现有 client 上挂 handler，官方 SDK 支持现成。
4. 审批层若做，挂本仓既有「提问者闸」体系按 `mcp__server` 粒度，不必新造权限模型。
5. sampling / resources / prompts / 多 scope：明确不做或排最低优先，避免为对齐而膨胀。

一句话：本仓通用 MCP 是「三传输 + 兼容配置 + 隔离」的合格底座，但鉴权与命名空间是接真实外部服务前必须补的两块板，刷新/重连/超时是第二轮健壮性欠账。
