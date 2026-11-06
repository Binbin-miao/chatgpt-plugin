# 通用 hook 泛化调研

> **勘误（2026-11-05 源码核实后）**：本文第一节引官方文档的四处描述被 Claude Code 反混淆源码证伪——http 型 **没有 `onFailure` 字段**、处理器类型**没有 `mcp_tool`**（仅 command/prompt/agent/http 四种）、事件实数 **27 个**（非 30 余）、10000 字符是**硬截断加后缀**（并非溢出转文件）。核实过程与全部偏差见 `四大agent-hook对比-调研.md` 与 `.scratch/hook-compare/claude-code.md`；设计时以下述勘误后的口径为准。

背景：chatgpt-plugin 现有硬编码「浮现注入」（breathHookEnable/Url/Token 三键，utils/breathHook.js）要泛化为通用 hook：用户可配置任意 HTTP 端点，每轮发模型前拉取内容注入上下文，Ombre 只是其中一条实例。本文只列各生态做法与出处，决策留给后续评审。

## 一、Claude Code hooks 的配置格式（官方文档确认）

来源：https://code.claude.com/docs/en/hooks （官方文档确认）。

1. **结构**：settings.json 里三层嵌套——事件名 → matcher 组数组 → hooks 处理器数组：
```json
{ "hooks": { "UserPromptSubmit": [ { "matcher": "", "hooks": [
  { "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh", "timeout": 30 } ] } ] } }
```
2. **处理器 type 有五种**：command / http / mcp_tool / prompt / agent。http 型即「把 JSON POST 到 url」，字段有 url（必填）、headers、allowedEnvVars、onFailure（"continue" | "block"）。
3. **通用字段**：type、timeout（秒，command/http 默认 600，UserPromptSubmit 场景降为 30）、if（权限规则过滤）、statusMessage。
4. **事件清单**（节选）：SessionStart（会话开始/恢复，matcher 为 startup/resume/clear）、UserPromptSubmit（每条 prompt 提交后、处理前，不支持 matcher）、PreToolUse/PostToolUse、Stop、PreCompact 等 30 余个。
5. **注入语义**：UserPromptSubmit 与 SessionStart 的 stdout 纯文本直接进上下文；也可返回 JSON `{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "..."}}`。只能注入、不能替换 prompt。超过 10000 字符写入文件、传 2000 字符预览。
6. **环境与入参**：`${CLAUDE_PROJECT_DIR}` 等路径占位符；stdin 收 `session_id`、`prompt_id`、`cwd`、`hook_event_name`、`permission_mode` 等 JSON。

对本任务的映射：Claude Code 的 http 型 hook 证明「可配置 url + headers + timeout + 失败策略」是成熟字段集；其 hooks 数组即「多条目按序执行」。

## 二、LiteLLM 的 pre-call hook 形态（官方文档确认）

来源：https://docs.litellm.ai/docs/proxy/call_hooks （官方文档确认）。

1. **注册方式**：config.yaml 的 `litellm_settings.callbacks: custom_callbacks.proxy_handler_instance`——指向「python 文件.实例」的点路径，文件须自行创建实例；只接受 CustomLogger 实例，指向类会加载报错。
2. **签名**：`async_pre_call_hook(self, user_api_key_dict, cache, data, call_type)`，在 LLM 调用前触发；**直接修改并返回 data**（data 含 messages），抛异常则拒绝请求。
3. **形态特征**：LiteLLM 是「代码级 hook」——用户写 Python 类而非填配置；配置里只有注册点。没有内置的「纯配置 HTTP 拉取注入」callback，HTTP 逻辑写在用户 hook 代码内。
4. 多个 callback 按注册顺序串行执行，后者看到前者的输出（async_filter_listed_models 一节明确此语义）。

## 三、SillyTavern World Info 的注入位置参数化（官方文档确认）

来源：https://docs.sillytavern.app/usage/core-concepts/worldinfo/ （官方文档确认）。

1. **Insertion Position** 枚举：Before Char Defs / After Char Defs / Before Example Messages / After Example Messages / Top of AN / Bottom of AN / **@ D（按深度插入聊天历史，可选 system / user / assistant 角色）** / Outlet（不自动注入，由 `{{outlet::Name}}` 宏手动放置）。
2. **Insertion Order**：数值，多条目同时激活时的排序；值大的靠近上下文末尾、影响更强。
3. **Probability（Trigger %）**：0–100，激活后仍有概率不插入。
4. **Context % / Budget**：World Info 总体 token 预算，超预算即停；常驻条目先插，order 大的先插。
5. **Timed Effects**：Sticky（激活后保持 N 轮）/ Cooldown / Delay（前 N 轮不激活）——即「每轮 vs 偶尔注入」的现成参数化。

## 四、其他开源 pre-call HTTP 注入实现（搜索到的项目介绍）

1. **hermes-agent 插件体系**（https://github.com/can1357/hermes-agent ，docs：website/docs/user-guide/features/hooks.md，搜索到的项目文档）：`pre_llm_call` hook 返回 `{"context": "..."}` 即注入。要点：**注入 user message 而非 system**，理由是保持 system prompt 稳定以命中 prompt cache（官方文档原文）；HTTP 插件自带 `timeout = 3`、异常时 `return None` 静默跳过；**单 hook 上下文上限 10000 字符**，超出写入磁盘文件、注入头尾预览；多插件输出按发现顺序以双换行拼接。
2. **hermes 配置驱动壳**（https://gitmemories.com/kenyonxu/hermes-persona ，搜索到的项目介绍）：hermes-persona 在 pre_llm_call 之上做了纯配置层（persona-config.json），模块总控开关、异常静默降级、配置热加载——「引擎通用 + 配置驱动」与本次泛化思路同构。
3. 同类先例（Claude Code 生态的 UserPromptSubmit + curl HTTP 拉取）已在工作区根的 chatgpt-plugin-hook-调研.md 第二节记录（未随本仓入库；contextstream/claude-code、silmari-Context-Engine、AutoMem gist 等），不重复。
4. 未找到「纯配置、无代码、用户只填 URL」的多条目通用 HTTP 注入 hook 的知名独立项目；现成形态都是「宿主提供 hook 点 + 用户写少量脚本/配置」或「插件市场里单个记忆插件」。

## 五、仓库内「通用 MCP」配置范式（本地文件阅读）

1. **配置组织**（utils/config.js:371-384）：总开关 `enableMcp`（boolean）+ `mcpServers`（**整段 JSON 字符串**，形如 `{"mcpServers": {"名称": {...}}}`，与 Claude Desktop / MCP 官方格式一致）。单条目字段：enabled / type / url / command / args / env。
2. **面板编辑**（guoba.support.js:1937-2025）：`enableMcp` 用 Switch；`mcpServers` 用 **GSubForm multiple: true**，schemas 定义单条目表单（name/enabled/type/url/command/args/env，各带 required、defaultValue、bottomHelpMessage），面板负责把多份表单条目序列化回 JSON 字符串。浮现注入面板（:2027 起）是单条目三键的 Switch+Input 形态。
3. **读取与容错**（utils/mcp.js:20-142）：init 时 `JSON.parse(Config.mcpServers)`，解析失败整段放弃并 logger.error；兼容裸对象与 `{mcpServers: ...}` 包装两种形态；**单条目 `enabled: false` 跳过但不删除配置**；字段校验不合规 logger.warn + continue；**单条目连接失败 logger.error 后继续下一条**，不影响其他条目与主链路；type 缺省时按 url/command 存在性推断。修改后需重启生效。
4. 范式要点总结：总开关 + 列表字符串、条目自带 enabled、逐条 try/catch 隔离失败、解析失败降级为空。

## 六、设计问题清单（只列做法，不拍板）

**1. 配置形态：单条三键 vs 条目列表**
- 现状浮现注入：单条三键 breathHookEnable/Url/Token（config.js:386-389）。
- 通用 MCP：enableMcp 总开关 + mcpServers JSON 列表（config.js:372-384）。
- Claude Code：事件名下挂数组，数组内每项一条 hook（官方文档）。

**2. 单条目字段集**
- enable：MCP 单条 enabled（mcp.js:50-54）、WI 条目 toggle（ST 文档）均有先例。
- url：三方一致（Claude http hook 必填 url；MCP http 型必填 url）。
- timeout：Claude 按条目可配、按事件有默认值（UserPromptSubmit 30s）；现状硬编码 3000ms（breathHook.js:18）；hermes 示例 3s。
- 鉴权：Claude http hook 提供 `headers` 任意键值（可放 Authorization）；现状固定 Bearer + 单 token 键；MCP http 未内置鉴权字段。
- 注入位置：现状 system 末尾（breathHook.js:34）；hermes 刻意注入 user message 以保 prompt cache（其文档原文）；ST 提供 8 种位置枚举 + 深度 + 角色；Claude 由事件类型固定位置。
- 触发时机：现状每轮；ST 有 Sticky/Delay 参数化「每轮 vs 前几轮不注入」；Claude 以事件区分（SessionStart vs UserPromptSubmit）；hermes 插件签名带 `is_first_turn` 参数。
- 失败策略：现状静默 warn 后返回 null、失败结果本轮记忆不重试（breathHook.js:30-31）；Claude http hook 有 onFailure: "continue" | "block" 显式字段；hermes 示例 except 后 return None；MCP 条目失败跳过继续。

**3. 多条目拼接顺序与体积预算**
- 拼接顺序：Claude hooks 数组按配置序执行、stdout 依次进上下文；LiteLLM 多 callback 按注册序；hermes 多插件按目录名字母序双换行拼接。
- 体积预算：Claude 单 hook 输出 10000 字符溢出转文件；hermes 同为 10000 字符上限（可配 max_chars）+ 头尾预览；ST 有 Context % / Budget 总预算 + order 优先级截断；现状不做截断，交由服务端（breathHook.js 注释）。

**4. 超时与失败对主链路的影响**
- Claude：command/http 默认超时 600s、UserPromptSubmit 场景 30s；超时视为 hook 失败，对不可阻塞事件仅提示并继续。
- LiteLLM：pre_call 抛异常直接拒绝请求（fail loud，网关语义）。
- hermes：3s 超时 + 静默 None（对话优先）。
- 现状：3s 超时 + 非 2xx + 网络错误一律 warn 后照常发消息。
- MCP 参照：连接失败仅损失该条工具，主链路无关。

**5. 现有「浮现注入」如何迁移为一条配置**
- 现有三键与新条目字段的对应：breathHookEnable→条目 enabled（或总开关沿用）、breathHookUrl→url + 固定路径 /breath-hook（若条目只有 url 无 path 需决定路径并入 url）、breathHookToken→headers 自定义（现状固定 Bearer）。
- 与 hermes-persona 同构：引擎（fetch + 注入）通用，Ombre 是一条配置实例。
- 可直接复用的现有实现（breathHook.js）：fetchSurfaceInjection 的超时/失败静默/空结果静默语义、prepared 记忆避免一轮多次 HTTP、withSurfaceInjection 的追加拼装——泛化时把「读哪个配置键、拉哪个 URL、怎么拼 headers」参数化即可，核心链路无需重写。
