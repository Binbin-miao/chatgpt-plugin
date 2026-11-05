# 原对话结论摘录（通用上下文注入钩子，2026-11-05）

本文件是上一个对话窗口的关键结论导出，供新窗口在怀疑某条概括失准时回查。完整决策以 spec 与 ADR 为准。

## 已拍板的决策（grill 两轮十二问 + 一次需求变更）

1. 浮现注入泛化为「上下文注入钩子」，独立配置段（`enableHooks` + `hookServers` JSON 字符串），不塞 mcpServers；条目可 `server` 引用 mcpServers 条目复用地址（只取配置值，不依赖连接状态），url 与 server 并存时 url 优先。
2. 条目六字段：enabled / url(或 server) / headers（`${ENV_VAR}` 插值为可选能力，明文直填同样有效）/ timeout(默认 3000ms) / maxChars(默认 10000) / when(turn|session，默认 turn)。
3. 注入位置锁死 system 末尾（ADR 0015 持续有效）。理由：本插件 system 本就拼群历史不稳定，prompt cache 收益存疑；user 侧注入会随历史落库逐轮累积。
4. 输出双兼容协议：先试 JSON 取 `hookSpecificOutput.additionalContext`，失败按纯文本全文。
5. maxChars 硬截断 + `[output truncated - exceeded N characters]` 后缀（Claude Code 同款）；不用 hermes 式写盘预览。
6. 失败语义：超时/网络错误/非 2xx warn 一行静默跳过，空结果零告警，不阻塞；同一轮 prepared 记忆复用，一轮只拉一次。
7. 旧三键（breathHookEnable/Url/Token）删除，不写自动迁移，Ombre 手工改写成一条条目。
8. MCP 票：http/sse 条目加 headers 透传 requestInit；工具名默认保持远端原名、冲突时后连接者拒载 + warn + include/exclude（刻意不学四家的全前缀，因为人设硬编码裸工具名）。
9. 术语：机制名「上下文注入」，配置键 enableHooks/hookServers，日志前缀 `[ContextInjection]`；「浮现注入」为历史名。

## 试过不通 / 被否的（别再走）

- 把 hook 塞进 mcpServers JSON 省锅巴改动——被否（语义/生命周期不同，GSubForm 按 schema 序列化省不掉）。
- prompt 前置注入——被否（随历史落库逐轮累积，见 ADR 0015）。
- 照 Claude Code 官方文档抄 hook 字段——文档四处不实：`onFailure` 字段不存在、`mcp_tool` handler 不存在、事件 27 个非 30 余、10000 字符是硬截断非写盘。以 `.scratch/hook-compare/claude-code.md` 的源码核实为准。
- 本机 `npm run check` 从 test:config 起卡 `Cannot find package 'lodash'`——独立副本缺 Yunzai 宿主 node_modules 的既有环境问题，不是代码缺陷，不要试图修复；checkSyntax/pathLeak/lint 与新增单测可本地跑。
- 在本环境用 `run_in_background` 派子代理会丢结果——一律前台并发派出（AGENTS.md 已记录）。
- `git checkout --` 还原会连未提交改动一起冲掉（AGENTS.md 已记录）。

## 现场状态

- 工作区有**未提交**的上一 feature（浮现注入）实现：utils/breathHook.js（withSurfaceInjection，拉取核心）、model/core.js 四分支接线、config.js 三键、test/surfaceInjection.test.mjs、GLOSSARY/ADR/锅巴。它是票 02 的**底座**（参数化而非重写），不要还原、不要顺手提交，commit 由用户明示。
- 四张票全部未开工，01 是 frontier。
