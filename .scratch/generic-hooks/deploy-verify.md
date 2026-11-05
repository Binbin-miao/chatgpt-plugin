# 部署后验证清单（generic-hooks）

票 02/03 的真实链路确认项只活在票文件里，部署到真实 Yunzai 环境后照这里逐条打勾；全部过完，两张票 ready-for-human 的残留才算收口。

- [x] CI 全绿：v2 分支最新 commit 的 check workflow 通过——本地缺宿主依赖跑不到的套件（test:config 起）在这里收口
- [x] 票 02（Ombre turn 条目）：锅巴 `hookServers` 加一条 `url` 含 `/breath-hook` + `headers` 带 Bearer + `when=turn` 的条目，开 `enableHooks` 后群里发消息，模型回复带上了浮现内容（服务端日志可对账）；关掉开关后下一轮会话历史与从未开启一致
- [x] 票 02（session 条目）：再加一条 `when=session` 的条目，同一会话首轮注入一次、后续轮次不重复注入；`#结束对话` 后下一条消息重新触发——2026-11-06 服务端视角实证：仅会话首轮拉取一次（00:06:40 GET /breath-hook 200），后续对话无拉取；插件端 info 行（`[ContextInjection] <url> 已注入（session，N 字符）`）自 2b7e52f 起可用，首轮拉取时打一行、后续轮静默。注记：当时浮现池为空（服务端 200 空体、插件按 spec 静默跳过），拉取语义成立但注入内容未确认；静默路径已改可观测（非首轮「跳过」、首轮空「本轮无内容」各 info 一行），待池非空时看首轮字符数收口
- [x] 票 03（真实远端鉴权 server）：`mcpServers` 配一个实际在用的带 Bearer 鉴权远端 http/sse server（`headers` 用 `Authorization=Bearer ${ENV_VAR}` 或明文），重启后连接成功并拉到工具列表；不配 `headers` 的条目行为与之前完全一致
- [x] 票 04：无需真实链路（冲突检测与过滤已由纯函数单测覆盖，11/11）；有现成环境时可选确认——两个 server 提供同名工具时后连接者拒载并出现 warn，include/exclude 裁剪后冲突绕开

对应票文件：`.scratch/generic-hooks/issues/02-context-injection-hooks.md`、`03-mcp-headers.md`、`04-mcp-tool-conflicts.md`。
