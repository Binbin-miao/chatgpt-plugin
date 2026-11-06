# hook-compare：四大 agent hook 与 MCP 机制源码核实分稿

2026-11-05 自工作区根的 `.scratch/hook-compare/` 收编进仓。每篇按被核实的产品命名，结论均带源码文件：行号锚点；`docs/adr/0016` 与 `.scratch/generic-hooks/` 的 spec、research/ 对比稿引用本目录。

- `claude-code.md` / `codex.md` / `hermes-agent.md` / `opencode.md`：四家 hook 引擎机制（事件、handler 类型、注入语义、超时、失败语义、体积控制、安全）。
- `mcp-*.md` 同名四篇：四家 MCP 客户端能力清单（传输、鉴权、工具发现与命名冲突、resources/prompts、elicitation/sampling、运维、权限）。

上游源码克隆（工作区根的 hook-repos/，共 838MB）未随本仓入库——各篇首行记有镜像地址与 commit，按 commit 可复现行号；核对结论时重新 clone 对应版本即可。另注意：本组核实起因是 Claude Code 官方文档多处失实（见 claude-code.md 的不一致汇总），**文档当索引、源码当依据**是这批笔记的立场。
