# hermes-agent MCP 能力清单

总评：hermes-agent 是受检仓库中 MCP 支持最完整的实现——内置全功能 MCP client（非网关桥接），三传输、OAuth 2.1、sampling/elicitation、动态发现、健康自愈一应俱全，安全边界（信任分级、恶意包预检、花费限额）尤其扎实。

## 1. 接入形态
内置 MCP client：`tools/mcp_tool.py` 为核心（后台事件循环 + 每服务器长驻 Task），拆出约 20 个 `tools/mcp_tool_*.py` 兄弟模块；发现的工具直接注册进 hermes 自有 tool registry（`tools/mcp_tool_registration.py:1-4`）。另附 `optional-mcps/` 官方审核目录（60+ 服务，manifest.yaml 声明式接入，如 `optional-mcps/linear/manifest.yaml`）。

## 2. 传输方式
stdio / Streamable HTTP / SSE 三种（`tools/mcp_tool.py:2-4`）。HTTP 连接前先发 initialize 探测 POST 按响应 content-type 自动选型（`tools/mcp_tool_transport.py:27-34`），SDK 缺新版类型只降特性不降 MCP（`tools/mcp_tool.py:102-111`）。

## 3. 鉴权
- headers 任意配置（config `headers:`，`tools/mcp_tool_transport.py:117-124`）
- OAuth 2.1 全流程：PKCE、动态客户端注册、token 磁盘缓存、mtime 监听外部刷新、401 处理（`tools/mcp_oauth_manager.py:2-6,45`）
- 客户端证书 `_resolve_client_cert`、进程身份头 `_apply_identity_header`（`tools/mcp_tool_transport.py:15`）、live endpoint bearer 注入（`tools/mcp_tool_transport.py:113`）

## 4. 工具发现与刷新
启动发现 + `ToolListChangedNotification` 动态刷新（`tools/mcp_tool.py:108-110`）；schema 磁盘缓存支持 `lazy: true` 首调才连（`cli-config.yaml.example:1644-1649`）；命名 `mcp__<server>__<tool>`（`MCP_TOOL_NAME_PREFIX = "mcp__"`，`tools/mcp_tool_schema.py`）；include/exclude 过滤 + 名称冲突消解（`tools/mcp_tool_registration.py:1-4`）；单轮发现并发默认 4，`mcp.discovery_concurrency` 可调（`tools/mcp_tool_discovery.py:26-29`）。

## 5. resources / prompts / elicitation / sampling
无原生上下文注入，全部折算成 utility tools：`list_resources`/`read_resource`/`list_prompts`/`get_prompt`（`tools/mcp_tool_registration.py:33-37`）。sampling 支持（含 tool-use 子循环、模型白名单、RPM 限速、token 上限，`cli-config.yaml.example:1666-1680`；实现 `tools/mcp_tool_sampling.py`）。elicitation 支持（`ElicitationHandler`，`tools/mcp_tool.py:27`）。另有实验性 webhook 事件订阅工具（`cli-config.yaml.example:1682-1687`）。

## 6. 运维
- 超时：工具调用默认 300s（`tools/mcp_tool_common.py:41`），每服务器 `timeout` 默认 120s、`connect_timeout` 60s、`keepalive_interval`（HTTP 默认 180s，stdio 默认关）（`cli-config.yaml.example:1636-1643`）
- 重连：连接失败指数退避冷却（`tools/mcp_tool_discovery.py:47-53`）；重连预算耗尽则 park；keepalive 探测失败标 suspect，下次调用懒验证再降级重连（`tools/mcp_tool_health.py:171-251`）
- 失败隔离：stdio 子进程 PID 账本 + 死亡监督者（`tools/mcp_tool_transport.py:1-2`）；失败按 profile scope 键隔离，互不遮蔽（`tools/mcp_tool_discovery.py:63-67`）
- 配置：`~/.hermes/config.yaml` 顶层 `mcp_servers:` 段（每服务器 command/args/env 或 url/headers + timeout/trust/sampling 等），全局 `mcp:` 段（discovery_concurrency 等）

## 7. 与 pre/post_tool_call hook 体系的关系
MCP 工具注册进 registry 后走统一分发 `model_tools.handle_function_call`：先插件 `pre_tool_call` 钩子（`model_tools.py:779-799`），再信任审批 gate——`trust: untrusted` 服务器或非 readOnlyHint 工具触发会话级审批，支持 YOLO/免批（`tools/mcp_tool_handlers.py:60-73`），之后 `post_tool_call` 观察钩子（`model_tools.py:687-711`）。即 MCP 调用与内置工具同享 hook/审批管线，无旁路。额外安全层：stdio 启动前 OSV 恶意包预检（`tools/mcp_tool.py:38-53`）、`tool_costs` 花费限额（`tools/mcp_tool_registration.py:64-73`）。
