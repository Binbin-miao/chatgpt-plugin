# 四大 agent 的 hook 机制对比（源码核实版）

对 Claude Code、OpenAI Codex、hermes-agent、OpenCode 四家 hook 机制的源码级对比。分线调查稿在 `.scratch/hook-compare/`（每条结论的文件:行号见各分稿），本文只做横向对比与设计映射。背景：为 chatgpt-plugin「通用 hook」泛化选型（现状硬编码 Ombre 浮现注入三键）。

## 一、总览

| | Claude Code | OpenAI Codex | hermes-agent | OpenCode |
|---|---|---|---|---|
| 源码获取 | 闭源；2025 年 npm 包 source map 泄漏，社区反混淆镜像 | 主动开源（Rust） | 主动开源（Python） | 主动开源（TS/Go） |
| 配置/注册 | settings.json：事件 → matcher 组 → hooks 数组，声明式 | config.toml 内联 `[hooks]` 或分层 `hooks.json`（同一 schema），声明式 | 双轨：Python 插件目录发现 + config.yaml 声明 shell hook（须 allowlist 批准） | opencode.json `plugin` 数组 + 插件目录发现，TS 模块内 `ctx.<域>.hook()` |
| 事件数 | 27（文档称 30 余，不准） | 14（Stable 默认启用） | 40+ | 约 20 个分 5 域 |
| handler 类型 | command / prompt / agent / http（仅 4 种；文档虚标 mcp_tool，源码不存在） | command / mcp_tool（prompt、agent 是空占位） | Python 回调 + shell 脚本 | TS 回调 |
| 注入上下文 | `additionalContext` → **isMeta user 消息** + system-reminder 标签（不进 system） | `additionalContext` 注入，超约 2500 token 转存磁盘 | `{"context"}` → **user message 的 wire 副本**（api_content sidecar，live 消息不动） | `session.context` 直接 **mutate system/messages**（可塞任意内容） |
| 阻塞 | 退出码 2 + stderr；JSON deny | 同 Claude 协议（刻意兼容） | `{"action":"block"}` 可否决整回合 | 仅 `tool.execute.before` 可抛错拒绝；其余抛错=defect 卡死链路 |
| 默认超时 | 600s（SessionEnd 收紧 1500ms） | 600s（SessionEnd 1s） | 回调 30s（上限 600）、shell 60s | **无任何超时** |
| 失败语义 | 非阻塞事件提示后继续 | 非 2xx / 非零退出码仅记 Failed | pre_llm_call fail-open，收集层 try/except 返回空串 | 抛错向上冒泡中断请求 |
| 多 hook 顺序 | 按配置序 | 并发执行、按配置序上报 | 插件发现序（目录名字母序），`"\n\n"` 拼接 | 注册序同步 await |
| 体积控制 | 10000 字符硬截断 + 后缀（不写盘） | additionalContext 超约 2500 token 转存磁盘 | 10000 字符写盘 + 头尾 500 预览 | 无 |
| 安全 | SSRF 防护、URL 通配白名单、env 插值白名单（未列入替换为空串）、CRLF 清洗 | 项目信任门控；企业 `allow_managed_hooks_only`；插件 hook 白名单 | allowlist + 脚本 mtime 漂移检测 | 无特殊机制 |

## 二、横向观察

1. **Claude 协议正在成为事实标准**。Codex 的 hook 引擎类名就叫 `ClaudeHooksEngine`（`codex-rs/hooks/src/engine/mod.rs:277`），输出协议完全兼容（hookSpecificOutput、退出码 2 阻塞、CLAUDE_PLUGIN_ROOT 兼容别名）；hermes 的 oversized spill 机制注释里直接写明移植自 codex PR #21069。新做通用 hook 时，把输出协议向 Claude 风格看齐（宽松 JSON，`additionalContext` 优先）等于站在事实标准上。
2. **声明式配置与代码式插件是两条谱系**。Claude/Codex（声明式 JSON/TOML，用户只填配置）适合「接外部服务」；OpenCode/hermes（代码模块，mutate 对象/注册回调）适合「写逻辑」。我们要做的是前者——用户填 URL 让插件拉内容注入，与 Claude http 型 / Codex command+MCP 型同谱系。
3. **注入位置没有一家进 system prompt**。Claude 用 isMeta user 消息包 system-reminder；hermes 更精细——注入只落在 wire 副本（sidecar），live 消息字节不动，明确为保 prompt cache；OpenCode 是唯一能改 system 的（mutate 语义）。我们现状注入 system 末尾，与三家主流做法相反。
4. **「失败不阻塞 + 显式超时」是守则，OpenCode 是反例**。Claude/Codex/hermes 三家都有超时且失败对主链路无害；OpenCode 无超时、抛错冒泡，正好演示了不设防的下场。我们现状（3s、静默跳过、不阻塞）与三家守则一致，方向正确。
5. **体积控制三家都有、做法分两派**：硬截断（Claude 10000 字符 + 后缀）与溢出转盘（Codex 约 2500 token、hermes 10000 字符写盘 + 头尾 500 预览）。没有任何一家信任「服务端自己会截」。
6. **安全强度与「能跑外部代码/请求」的程度成正比**：Claude http 型的 SSRF 防护 + URL 白名单 + env 插值白名单最完整；我们的通用 hook 允许插件进程向任意用户配置 URL 发请求，至少要考虑内网地址拦截（与仓库已有的不可信媒体 URL DNS 固定/私网拦截不变式呼应）。

## 三、对本插件通用 hook 设计的映射（只列依据，决策留给评审）

1. **配置形态**：通用 MCP 范式（总开关 + 条目列表 + 条目 enabled + 逐条隔离）与 Claude/Codex 的事件数组结构同构，此前结论被源码对比进一步支持；条目字段可对齐 Claude http 型**真实存在**的字段：`enabled / url / headers（键值对，含鉴权）/ timeout`。
2. **修正一项此前的错误事实**：早前调研（通用hook-调研.md）引用官方文档称 Claude http 型有 `onFailure` 字段、处理器有 `mcp_tool` 类型、事件 30 余个——源码核实均不成立，设计时不得引用。
3. **注入位置是最大的待重审决策**：现状注入 system 末尾且缓存进 `prepared.system`；Claude/hermes 都走 user 侧消息并保护 system 字节稳定。但本插件场景有差异——群历史本来就拼进 system（system 本身不稳定，prompt cache 收益打折），且四个 provider 分支改注入位置的改动量不同。是否跟随主流改 user 侧，需要结合 prompt cache 实际收益单独评。
4. **通用化后插件侧体积上限从「不做」改为「必须做」**：硬编码 Ombre 时截断由服务端负责是成立的；通用 hook 面对任意端点没有这个保证。三家里 Claude 的硬截断（10000 字符 + 提示后缀）实现最简单，可直接借。
5. **输出协议**：服务端返回纯文本（现状 /breath-hook）与返回 Claude 风格 JSON（`{"hookSpecificOutput": {"additionalContext": ...}}`）可以双兼容——先按纯文本试解析 JSON，失败即原文，成本极低，向前兼容事实标准。
6. **每轮/会话首轮**：Claude/Codex 用事件区分（SessionStart vs UserPromptSubmit），hermes 用入参 `is_first_turn`。本插件若要支持会话级条目，复用 `previousConversation?.num === 0` 判定即可（apps/chat.js:1041 先例）。

## 四、结论

四家里没有现成可照搬的「纯配置多条目 HTTP 注入」实现，但零件齐全：配置形态抄本仓通用 MCP，字段集抄 Claude http 型（源码核实版），失败/超时守则三家一致且我们已符合，体积控制借 Claude 硬截断，注入位置是需要重新拍板的唯一结构性决策。
