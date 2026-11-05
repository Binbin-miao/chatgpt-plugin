# 通用上下文注入钩子（含 MCP 鉴权与命名空间）

`Status:` done（2026-11-06 四票收官：01 环境插值 / 02 注入钩子泛化 / 03 MCP headers 鉴权 / 04 工具名冲突防护）

> 上一轮迭代「浮现注入」（`.scratch/ombre-breath-hook/spec.md`，已 superseded）实现了硬编码的 Ombre 浮现注入。本 spec 把它泛化为通用机制，并顺带补上通用 MCP 的两个 P0 缺口。决策依据见 `docs/adr/0016-context-injection-hooks.md`、`docs/adr/0015-surface-injection-into-system.md`，调研底料见 `research/`（`四大agent-hook对比-调研.md`、`通用MCP对比-调研.md`、`通用hook-调研.md`，2026-11-05 自工作区收编）与 `.scratch/hook-compare/` 分稿。

## Problem Statement

Bot 主人想把外部记忆/知识服务的内容自动送进对话上下文，但现在只有一条写死的通道（Ombre 的 `/breath-hook`）：换服务、加服务、改路径都要改代码。同时，通用 MCP 接不了需要鉴权的远端 server（HTTP/SSE 裸连），两个 server 提供同名工具时会静默互相覆盖。

## Solution

配置里新增一个注入条目列表（`hookServers`，JSON 字符串，锅巴 GSubForm 编辑，与 `mcpServers` 同模式）。每条目指向任意 HTTP 端点，插件在每轮（或会话首轮）把响应内容注入当轮 system——服务端返回纯文本或 Claude 风格 JSON 都能识别。Ombre 浮现注入降级为其中一条配置实例。MCP 侧补 headers 鉴权与工具名冲突防护。

## User Stories

1. 作为 Bot 主人，我想在锅巴里添加任意数量的注入条目（url + 鉴权头），每轮对话自动把该服务的内容注入上下文，不用改代码
2. 作为 Bot 主人，我想让某条目引用已配置的 MCP server 的地址，避免同一地址填两遍
3. 作为 Bot 主人，我想单独开关每条注入条目而不删除其配置
4. 作为 Bot 主人，我想让静态设定类内容只在会话首轮注入一次，省 token
5. 作为 Bot 主人，我想给每条条目单独配超时，服务挂了对话照常
6. 作为 Bot 主人，我想让过大的响应被自动截断，避免撑爆模型上下文
7. 作为 Bot 主人，我想用环境变量引用密钥，密钥不进 config.json
8. 作为 Bot 主人，我想让服务端返回 Claude 风格 JSON（additionalContext）时也能正确注入
9. 作为 Bot 主人，我想给 MCP 的 http/sse 条目配 headers，接需要鉴权的远端 MCP server
10. 作为 Bot 主人，我想让两个 server 的同名工具不会互相覆盖，且冲突被明确告知而不是静默吞掉
11. 作为 Bot 主人，我想按 include/exclude 过滤某个 MCP server 的工具列表
12. 作为 Bot 主人，我想人设与文档里引用的工具名保持稳定，不因以后接入新 server 而漂移
13. 作为 Bot 主人，我想把旧的浮现注入三键配置改写成一条注入条目后，行为与之前完全一致
14. 作为 Bot 主人，我想注入的内容不进入会话历史，不逐轮累积
15. 作为 Bot 主人，我想任何一条注入条目失败时只损失该条目，其他条目与对话本身不受影响

## Implementation Decisions

以下决策已与用户逐条确认（grill 两轮十二问），实现时不再重新讨论。

**范围**：一个迭代三张票——①hook 泛化 ②MCP headers 鉴权 ③MCP 工具名冲突防护。三票可独立验收。

**票 ①：hook 泛化**
- 配置：`enableHooks`（默认 false）总开关 + `hookServers` JSON 字符串（mcpServers 同款模式：兼容裸对象与包装形态，解析失败整段放弃并 error 降级为空）。锅巴 GSubForm multiple schema 同步。
- 条目字段（六个，不加更多）：`enabled` / `url`（或 `server`）/ `headers`（键值对，值支持 `${ENV_VAR}` 插值——可选能力，明文直填同样有效，config.json 不进 git；/ `timeout`（毫秒，默认 3000）/ `maxChars`（默认 10000）/ `when`（`turn` | `session`，默认 `turn`）。路径不单设，并进 url。
- `server` 引用：填 mcpServers 条目名，只取其配置值（url）；引用不依赖该 server 的连接状态，url 与 server 同时存在时 url 优先。
- 触发：`turn` = 每轮发模型前；`session` = 会话首轮（复用既有「Redis 中无该会话」判定先例）。
- 注入位置：锁死 system 末尾，ADR 0015 持续有效；不做位置参数。
- 输出双协议：响应先尝试 JSON 解析，取 `hookSpecificOutput.additionalContext`；解析失败按纯文本全文注入。
- 截断：`maxChars` 硬截断，尾部加 `[output truncated - exceeded N characters]` 后缀（Claude Code 同款做法）。
- 失败语义沿用现状：超时/网络错误/非 2xx warn 一行静默跳过，空结果零告警，任何情况不阻塞对话；同一轮内结果记忆复用（主备/重建路径不再拉取）。
- 多条目：按配置顺序拼接（双换行分隔）；单条目失败只跳过自己。
- 旧键 `breathHookEnable` / `breathHookUrl` / `breathHookToken` 删除；不写自动迁移，Ombre 改写成一条条目（url 含 `/breath-hook` 路径 + headers 带 Bearer），迁移说明写入提交信息与 spec。

**票 ②：MCP headers 鉴权**
- mcpServers 的 http/sse 条目新增 `headers` 键值对，构造传输时透传 requestInit；值支持同样的 `${ENV_VAR}` 插值。
- 不做 OAuth、不做 bearer 专用键（headers 里自己放 Authorization）。

**票 ③：MCP 工具名冲突防护**
- 工具名默认保持远端原名（不整体加前缀——人设与文档硬编码裸工具名，见 ADR 0016 后果节）。
- 连接时检测同名冲突：冲突时**后连接的 server 的重名工具拒绝加载**并 logger.warn 明确列出冲突对；先连接者保持原名不变。
- mcpServers 条目新增可选 `include` / `exclude`（工具名数组），用于绕冲突或裁剪工具面。

**术语**：通用机制定名「上下文注入」，配置键 `enableHooks` / `hookServers`，日志前缀 `[ContextInjection]`；「浮现注入」保留为历史名（GLOSSARY 已更新）。

## Testing Decisions

- **唯一新增缝：helper 模块级纯逻辑单测**（stub 全局 fetch/logger，先例 `test/surfaceInjection.test.mjs`），不为测试新开其他缝。
  - 票 ①：条目列表解析（JSON 失败降级、server 引用解析与优先级、`${ENV}` 插值、enabled/when 过滤）；单条目拉取（双协议、截断后缀、超时、401/空/网络错误、多 header）；多条目按序拼接与单条失败隔离；session 触发判定。
  - 票 ②：headers 透传与 `${ENV}` 插值的纯函数测试。
  - 票 ③：冲突检测纯函数测试（同名拒绝后到者、include/exclude 生效、无冲突时原名保留）。
- 全部改动过 `node --check`；新测试挂独立 `test:*` 脚本并入 `check` 链。
- 真实链路手工验证：Ombre 一条条目（turn）+ 一个带 headers 的远端端点（session）。

## Out of Scope

- MCP 的 sampling / resources / prompts / elicitation（四家里多数也没做，明确不做）
- 多 scope 配置层级、配置热重载（重启生效维持现状）
- user 消息侧注入与 prompt cache 优化（ADR 0015 维持，需要时另立项）
- 旧配置自动迁移代码
- hermes 式超限写盘 + 头尾预览
- OAuth（headers 覆盖绝大多数自托管场景）

## Further Notes

- 需求方补充过的关键背景：曾考虑把 hook 塞进 mcpServers JSON 以省锅巴改动，被否——语义与生命周期不同，且 GSubForm 按 schema 序列化省不掉改动；「复用地址」的诉求由 `server` 引用字段承接。
- 旧「浮现注入」实现（拉取核心：超时/失败静默/prepared 记忆/追加拼装）是票 ① 的直接底座，参数化而非重写。
- 行号级事实锚点见 `.scratch/ombre-hook/chatgpt-plugin-注入点调查.md` 与两份对比调研稿；动手时按符号名重新定位。
- 每张票验收清单随实现前在对应 issue 里细化（本 spec 的 User Stories 即验收基准）。
