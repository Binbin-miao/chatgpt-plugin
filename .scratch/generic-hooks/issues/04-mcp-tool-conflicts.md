# 04: MCP 工具名冲突防护

**What to build:** 两个 MCP server 提供同名工具时，不再静默互相覆盖：先连接者保持远端原名不变，后连接者的重名工具被拒绝加载并明确 warn 列出冲突对；主人可用条目级 `include` / `exclude`（工具名数组）裁剪某 server 的工具面来绕开冲突。无冲突时一切与现状一致（人设与文档里的裸工具名不受影响）。依据 `.scratch/generic-hooks/spec.md` 票 ③ 与 ADR 0016 的相关取舍。

**Blocked by:** None (can start immediately)

**Status:** done（feat 83feb42；2026-11-06 用户对验收清单点头收官）

- [x] 无同名冲突时所有工具保持远端原名，行为与现状完全一致
- [x] 同名冲突：后连接 server 的重名工具拒绝加载，warn 明确列出 server 名与工具名；先连接者的工具原名不变
- [x] 被拒载的工具只影响自己：该 server 的其余工具与其余 server 不受影响
- [x] mcpServers 条目新增可选 `include` / `exclude`，过滤生效（include 为白名单、exclude 为黑名单，两者并存时先 include 后 exclude）
- [x] 锅巴 mcpServers 的 GSubForm schema 新增 include/exclude 编辑字段
- [x] 冲突检测与过滤的纯函数单测（无冲突/冲突拒后/include/exclude/并存），`node --check` 与 `check` 全绿

## 实现记录（2026-11-05）

- `utils/mcpToolFilter.js`（新增）：两个纯函数。`filterMcpToolsByListRules(tools, include, exclude)`——include 白名单、exclude 黑名单，并存先 include 后 exclude；规则未配置（undefined/null/非数组）原样返回入参（引用不变，无冲突路径行为与改动前完全一致）；显式空数组 include 是空白名单（一个不加载），锅巴序列化侧留空即不写该键，面板用户碰不到空白名单。`pickLoadableMcpTools(tools, loadedIndex)`——对照已加载索引（工具名→加载它的 server 名）挑出可加载者，重名进 conflicts 并带 existingServer 供调用方 warn；只读不写索引。独立成模块原因同 `utils/mcpHeaders.js`：`utils/mcp.js` 顶层 import SDK 与 Config（宿主依赖链），无宿主环境不可单测。
- `utils/mcp.js`：init 的 listTools 装载循环改为「先按条目 include/exclude 裁剪 → 再对幸存者做同名检测 → warn 冲突对（后连 server 名 + 工具名 + 先连 server 名，附 include/exclude 绕开提示）→ 只装载可加载者并登记索引」。新增 `loadedToolOwners` 索引跨 server 累积，先连接者优先。发生过滤或拒载时补一行汇总 info（跳过 N 个）。
- `utils/mcpServersGuoba.js`：`formatMcpServersForGuoba` 行对象新增 `include`/`exclude`（数组→多行文本）；`stringifyMcpServersFromGuoba` 通用段（stdio 与 http/sse 都生效）用 `splitLines` 解析，空即不写键；`isEmptyMcpServerRow` 字段列表加两项。
- `guoba.support.js`：mcpServers GSubForm schema 在 headers 后新增 `include`/`exclude` 两个 InputTextArea（白/黑名单语义与冲突绕开方式写进 helpMessage）。
- `package.json`：`test:mcpToolFilter` 脚本挂进 `check` 链末尾（lint 规则 3/5）。

两个实现取向（spec 未逐字写明、按票面语义定的诠释，验收时请复核）：

1. **先裁剪后判冲突**：被 include/exclude 裁掉的工具不参与冲突判定。票面「可用 include/exclude 裁剪工具面绕开冲突」只有在这个顺序下才成立——反向顺序时无论怎么排除都释放不了工具名。
2. **冲突只跨 server**：单 server 的 listTools 自带重名工具（远端自身病态）不判冲突，两个都加载、下游 funcMap 仍后者覆盖——与改动前行为一致。票面只要求跨 server 场景，未加码。

## 验证记录（2026-11-05）

- TDD：`test/mcpToolFilter.test.mjs` 先红（ERR_MODULE_NOT_FOUND）后绿，11/11——未配置原样返回（含引用不变断言）、include 白名单、exclude 黑名单、并存先白后黑（含同名同列被剔）、显式空 include、规则项 trim 且按远端原名精确匹配、非数组容错；无冲突全过且索引只读、冲突拒后列出工具名与 existingServer、拒载只影响自己、缺省容错。
- `checkSyntax`（全仓 `node --check` + 相对导入核实）/ `pathLeak` / `lint` 全绿；`test:mcpToolFilter`、`test:mcpHeaders`、`test:contextInjection`、`test:env` 全绿（前票无回归）。
- `npm run check` 跑到 `test:config` 挂：缺 Yunzai 宿主依赖的既有环境问题（票 02/03 验证记录同款），与本票无关，留给 CI。
- 两轴评审（并发前台派生）：规格轴六条验收逐条落实、无缺失无 scope 漂移（skip 汇总 info 一行被点名为票面外，作为排障辅助保留待用户裁定）；规范轴发现 1 处硬违规已修——`mcpToolFilter.js` 头注释把「不做整体前缀」决策错引 ADR 0016（该 ADR 全文无此内容，真实出处 spec.md 票 ③），已改指 spec。评审中对「单 server 自带重名会 warn 与自己冲突」的担忧经核对代码不成立：索引在装载后才登记、同批次重名不会触发 warn（见实现取向 2）。
- 上游引用断链已闭环：复盘（2026-11-05）给 ADR 0016 后果节补了「MCP 工具名不整体加前缀」一行，spec.md 票 ③ 的悬空引用随之落定。
- 提交：83feb42（用户明示提交）；这批推送的 CI 首跑抓到 configGroupReply 分组清单未同步票 02 面板改版的旧账，已修（5b6911d）。
- 验收（2026-11-06）：用户对六条验收清单点头，本票转 done——纯函数单测 + CI 覆盖，无真实链路依赖。
