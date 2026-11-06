# 03: MCP headers 鉴权

**What to build:** Bot 主人给 MCP 的 http/sse 条目配置 `headers` 键值对（值支持 `${ENV_VAR}` 插值）后，插件能连上需要鉴权的远端 MCP server（例如带 `Authorization: Bearer <token>` 的服务）；不配 headers 的条目行为与现状完全一致。依据 `.scratch/generic-hooks/spec.md` 票 ②。

**Blocked by:** 01（`${ENV_VAR}` 插值 helper）

**Status:** done（feat 97013a4，2026-11-05 部署实证通过；本机端到端 7 项 + 实际部署环境远端 server 连接确认）

- [x] http 与 sse 条目的 `headers` 键值对透传进传输构造（requestInit）；`${ENV}` 插值生效，未定义变量替换为空串
- [x] stdio 条目与未配置 headers 的条目行为零变化
- [x] 锅巴 mcpServers 的 GSubForm schema 新增 headers 编辑字段，保存后重启生效
- [x] 真实链路手工验证：对带 Bearer 鉴权的远端 MCP server 连接成功并拉到工具（本机已用 SDK 1.32.1 + 本地 Bearer 鉴权 server 端到端实证 7 项，见下；部署环境 2026-11-05 对实际 server ombre-brain 复测通过，见验证记录末条）
- [x] headers 构造的纯函数单测（透传/插值/未定义变量），`node --check` 与 `check` 全绿

## 实现记录（2026-11-05）

- `utils/mcpHeaders.js`（新增）：`buildMcpTransportOptions(headers)` 纯函数——有效 headers 返回 `{ requestInit: { headers } }`（值经 `interpolateEnvVars` 插值、键 trim、空键跳过、null 值空串）；未配置/空配置/非对象返回 `undefined`，调用方保持等价省略构造第二参。独立成模块原因：`utils/mcp.js` 顶层 import SDK 与 Config（宿主依赖链），无宿主环境不可单测（先例 `utils/envInterpolate.js`）。
- `utils/mcp.js`：http/sse 两分支把 `buildMcpTransportOptions(serverConfig.headers)` 的返回值作为传输构造第二参；配置了 headers 时打一行 info（只列键名，值含密钥不打印）。stdio 分支零改动。
- `utils/mcpServersGuoba.js`：`formatMcpServersForGuoba` 行对象新增 `headers`（KEY=value 多行文本）；`stringifyMcpServersFromGuoba` 的 http/sse 分支新增 `parseMcpHeaders`（与同文件 `parseMcpEnv` 同款规则，错误文案沿用本文件英文风格）；`isEmptyMcpServerRow` 字段列表加 `headers`。stdio 分支不保存 headers（与 url 的既有处理一致）。
- `guoba.support.js`：mcpServers GSubForm schema 在 env 字段后新增 `headers` InputTextArea（说明 http/sse 专用、stdio 忽略、支持 `${ENV_VAR}`）。
- `package.json`：`test:mcpHeaders` 脚本挂进 `check` 链末尾（lint 规则 3/5）。
- 传输契约以 SDK 1.32.1 源码为准（GitHub 对应 tag 核实）：`StreamableHTTPClientTransportOptions` / `SSEClientTransportOptions` 均含 `requestInit?: RequestInit`，其 `headers` 在全部请求路径（POST 消息、GET SSE 流、DELETE）与传输默认头合并且用户值优先。SSE 不动 `eventSourceInit`（1.32.1 中其 headers 被 fetch 包装覆盖，`requestInit.headers` 才是两条请求方向的生效路径）。

## 验证记录（2026-11-05）

- TDD：`test/mcpHeaders.test.mjs` 先红（ERR_MODULE_NOT_FOUND）后绿，7/7（透传形状、插值、未定义变量空串、键 trim/空键/null 值、未配置/非对象/空配置返 undefined）。
- `node --check` 五个改动/新增文件全过；`checkSyntax` / `pathLeak` / `lint` 全绿；`test:env`、`test:contextInjection` 绿（票 01/02 无回归）。
- `npm run check` 跑到 `test:config` 卡 lodash：缺 Yunzai 宿主依赖的既有环境问题（票 02 验证记录同款），与本票无关，留给 CI。
- 端到端实证（系统临时目录独立安装 `@modelcontextprotocol/sdk@1.32.1` + zod@3.25.28，与 pnpm-lock 锁定版本一致；本地起带 `Authorization: Bearer` 校验的 MCP server，客户端用仓库真实 `buildMcpTransportOptions` 输出构造，验证后临时目录已删除）：7/7 全过——
  1. http 带 Bearer 连接成功并拉到工具
  2. http `${ENV_VAR}` 插值进真实请求（headers 配置引用环境变量，替换后通过鉴权）
  3. http 不带 headers（等价省略第二参）被 401 拒绝——反证 headers 是生效路径、且未配置行为与改造前一致
  4. http 错误 token 被 401 拒绝
  5. http 未定义环境变量替换为空串，凭证为空被 401 拒绝
  6. sse 带 Bearer 连接成功并拉到工具
  7. sse 不带 headers 被 401 拒绝
- 锅巴 round-trip 冒烟：format → stringify 保真（http 条目 headers 往返一致；无 headers/stdio 条目不带 headers 键零变化；空行静默丢弃；非法格式抛错文案指向 headers；行字段顺序不破坏）。
- 评审：规范轴 + 规格轴均通过（并发前台派生）。规格轴发现 1 处注释措辞与代码不符（「构造保持单参」实为「双参显式传 undefined，与省略等价」），已修正。规范轴低风险备注：mcpServersGuoba 报错文案英文 vs hookServersGuoba 中文为跨模块既有不一致，跟随同文件 `parseMcpEnv` 风格是本票的合理选择，统一文案属独立小任务。
- 按用户规矩本票未提交 git（不主动 add / commit / push）。
- 部署实证（2026-11-05 23:41-23:44，用户实际部署环境）：ombre-brain（Streamable HTTP，`http://127.0.0.1:18011/mcp`）未配 headers 时连接失败 `Streamable HTTP error: Error POSTing to endpoint: {"error": "Unauthorized"}`，服务端 POST /mcp 401——反证 headers 是生效路径；锅巴配置 `Authorization` 后重启，插件日志「已配置自定义请求头: Authorization」→「连接成功！加载了 16 个工具」，服务端 POST /mcp 200 + ListToolsRequest。同批 stdio server（nocturne_memory，7 工具）不受影响，合计 23 个 MCP 工具加载成功。
