# 通用上下文注入钩子采用独立配置段与双兼容协议

状态：已采纳（2026-11-05）。需求与决策过程见 `.scratch/generic-hooks/spec.md`（grill 两轮十二问）。

「浮现注入」（ADR 0015）上线后需求方提出泛化：像通用 MCP 一样，用户可配置任意 HTTP 端点做发模型前的上下文注入，Ombre 只是其中一条实例。泛化引出三个结构性选择，本文记录取舍。

## 决定

- **独立配置段，不塞 mcpServers**。曾考虑把 hook 指令并进 `mcpServers` 条目以省锅巴改动，被否：MCP 条目是「一个 server 连接」、hook 条目是「一个拉取动作」，语义与生命周期都不同；hook 的价值恰恰是接任意 HTTP 端点（对方可以完全没有 MCP），绑进 server 条目会收窄适用面；且锅巴 GSubForm 按 schema 序列化，加字段省不掉面板改动。四家参考（Claude/Codex/hermes/OpenCode）无一把 hook 配置挂在 MCP server 配置下。
- **重复地址用引用解决**：条目可填 `server`（mcpServers 条目名）复用其 url，只取配置值、不依赖该 server 的连接状态；url 与 server 并存时 url 优先。
- **输出双兼容协议**：响应先按 JSON 解析取 `hookSpecificOutput.additionalContext`，失败按纯文本全文注入。Claude 风格协议是事实标准（Codex 的 hook 引擎刻意兼容之，hermes 的溢出机制亦移植自 codex），双兼容让 Ombre 零改动、Claude 风格服务零成本接入。
- **插件侧硬截断**：per-entry `maxChars` 默认 10000，截断加提示后缀（Claude Code 同款）。硬编码 Ombre 时代「截断交服务端」的前提对任意端点不成立；四家全部自带截断，无一信任服务端。
- **条目字段集六件**：`enabled` / `url`(或 `server`) / `headers`（`${ENV_VAR}` 插值，密钥不进 config.json）/ `timeout`（默认 3s）/ `maxChars` / `when`（turn|session）。注入位置锁死 system 末尾（ADR 0015 持续有效：本插件 system 本就拼群历史，prompt cache 收益存疑；user 侧注入会随历史落库逐轮累积）。
- **术语**：机制定名「上下文注入」，配置键 `enableHooks` / `hookServers`，日志前缀 `[ContextInjection]`；「浮现注入」降为历史名。

## 被否的备选

- 塞进 mcpServers JSON（省面板改动）——见上。
- 注入位置做成参数（system/user、深度、顺序，SillyTavern 式）——user 侧有历史累积问题，system 是现状且 ADR 0015 已论证；参数化属投机扩展。
- hermes 式超限写盘 + 头尾预览——QQ bot 场景无人去看那个文件，过度设计。
- 旧三键自动迁移——用户群就是配置者本人，手工改写一条条目即可，迁移代码是给不存在的用户写的。

## 后果

- 锅巴新增一组 GSubForm multiple schema（复制 mcpServers 的编辑模式），面板分组与 `mcpServers` 并列。
- 双协议解析意味着「响应体恰好是合法 JSON 但本意是纯文本」的服务会被误解析——约定：纯文本服务避免返回 JSON 形状的文本（现实风险极低，Ombre 返回分节纯文本）。
- `when: "session"` 复用「Redis 中无该会话」判定，对话过期或 `#结束对话` 后下一条消息重新触发；群场景以群为会话单位。
- 硬截断只保上下文不保信息：被截掉的内容静默丢失（与 Claude Code 行为一致），条目作者应自己控制服务端输出体积。
- MCP 工具名冲突防护（generic-hooks 票 ③）：工具名保持远端原名，不做整体前缀——人设与文档硬编码裸工具名；同名冲突时后连接者的重名工具拒载并 warn，条目级 include/exclude（白/黑名单，先白后黑）可裁剪某 server 的工具面绕开冲突。
