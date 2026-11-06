# 02: 上下文注入钩子泛化

**What to build:** 端到端——Bot 主人在锅巴的 `hookServers` 列表里添加一条条目（url / headers / timeout / maxChars / when），开启开关后发消息，模型收到的 system 末尾出现该服务的响应内容；Ombre 浮现注入降级为其中一条配置实例（url 含 `/breath-hook` + headers 带 Bearer），旧的三键配置删除。每轮（turn）或会话首轮（session）注入，服务挂了对话照常。机制决策与取舍见 `.scratch/generic-hooks/spec.md` 与 ADR 0015 / 0016。

**Blocked by:** 01（`${ENV_VAR}` 插值 helper）

**Status:** done（feat 76a0ad8，2026-11-05 验收通过；CI 全绿，turn 与 session 条目均经部署实证）

- [x] `enableHooks` 为 false（默认）时零行为变化：不发起任何请求，四个 provider 分支的 system 与改动前一致
- [x] 条目列表解析：JSON 解析失败整段放弃并 error 降级为空；`server` 引用取 mcpServers 同名条目的 url（只取配置值，不依赖其连接状态），url 与 server 并存时 url 优先；`headers` 值完成 `${ENV}` 插值；`enabled: false` 条目跳过
- [x] `when: "turn"` 条目每轮注入；`when: "session"` 条目仅会话首轮注入（复用既有「Redis 中无该会话」判定先例），对话过期或结束后下一条消息重新触发
- [x] 双协议：响应为 `hookSpecificOutput.additionalContext` JSON 时取其值；解析失败按纯文本全文注入
- [x] `maxChars` 硬截断并尾部加 `[output truncated - exceeded N characters]` 后缀；`timeout` 生效；超时/网络错误/非 2xx 时 warn 恰好一行并跳过该条目；空结果零告警；任何失败不阻塞消息发出
- [x] 多条目按配置顺序以双换行拼接；单条目失败只损失自己，其他条目照常
- [x] 注入文本不进入 Redis 会话历史（关闭开关后下一轮历史与从未开启一致）；同一轮内只拉取一次（主备切换与上下文超限重建路径复用同一份）
- [x] 锅巴面板：`enableHooks` 开关 + `hookServers` GSubForm multiple schema（六字段）可见、可保存、重启生效
- [x] 旧三键（breathHook 三键）从默认配置与面板移除；Ombre 改写为一条条目的说明写入提交信息
- [x] 代码注释与日志使用「上下文注入」术语，日志前缀 `[ContextInjection]`
- [x] 单测覆盖：条目解析（引用/优先级/插值/过滤）、单条目拉取（双协议/截断/超时/401/空）、多条目拼接与失败隔离、session 触发判定；`node --check` 与 `check` 全绿；真实链路由用户手工验证（Ombre turn 条目 + 一个 session 条目）

## 验证记录（2026-11-05）

- `test/contextInjection.test.mjs` 31/31 绿（TDD：先红后绿）；`test:env`、`test:thinking` 绿；`checkSyntax` / `pathLeak` / `lint` 绿；改动文件 `node --check` 全过。
- 本机缺 Yunzai 宿主依赖（无宿主 `lib/`、`node_modules` 为空）：`test:config` 起卡 lodash、`test:providers` / `test:group-reply` 模块加载即挂，均为既有环境问题，与本次 diff 无关，留给 CI 验证。
- 真实链路（Ombre turn 条目 + 一个 session 条目）待用户手工验证——这是 Status 停在 ready-for-human 的原因。
- 评审（规范轴 + 规格轴）通过，无硬违规；两处沿既有语义的说明见下。
- 部署实证（2026-11-05 23:09-23:11，用户实际部署环境）：Ombre turn 条目（`http://127.0.0.1:18011/breath-hook`）密钥未生效时返回 401，warn 恰好一行「返回 HTTP 401，本轮跳过该条目」且对话照常发出——失败语义实证；重启后 200 正常接入。session 条目复测待注入成功日志上线后进行（成功注入此前静默，已补 info 一行）。
- session 实证（2026-11-06 00:05-00:12，用户实际部署环境，服务端视角）：session 条目仅会话首轮拉取一次（00:06:40 GET /breath-hook 200），后续对话无拉取——when:session 语义确认。成功注入 info 日志已随 2b7e52f 上线（`已注入（session，N 字符）`），部署更新后首轮拉取时可见。
- 排查注记（2026-11-06 00:35，「插件端无 info 日志」根因）：首轮判定以 Redis 会话存在性为准（apps/chat.js:1008），conversationPreserveTime 默认 0 不过期，**插件重启不重置首轮**；且当时浮现池为空，服务端 200 空体，插件按原 spec「空结果静默」跳过——拉取语义成立，但注入内容链路未真正走通。静默路径已全部改为可观测（session 非首轮跳过、session 首轮空结果各 info 一行；JSON 缺 additionalContext 字段 warn 一行），待浮现池非空后由新日志确认字符数收口。
- 终验（2026-11-06 00:49，插件端日志，随 0aca9db 部署）：`#结束对话` 后首轮「本轮无内容（session 首轮，服务端返回为空）」、同会话次轮「跳过（session 非会话首轮）」双行符合预期——session 语义插件端确认；浮现池攒起内容后首轮自然带字符数。

## Ombre 旧三键改写说明（原定写入提交信息）

按用户规矩本票未提交 git，说明落此。旧配置（`breathHookEnable` / `breathHookUrl` / `breathHookToken`）等价改写为一条注入条目：

```json
{
  "hookServers": [
    {
      "enabled": true,
      "url": "http://127.0.0.1:18011/breath-hook",
      "headers": { "Authorization": "Bearer <Ombre 服务端 hooks.token>" },
      "timeout": 3000,
      "maxChars": 10000,
      "when": "turn"
    }
  ]
}
```

- 端点路径不再固定拼接，直接写进 `url`（旧实现的「基础地址 + 固定 /breath-hook」与此等价）。
- 令牌从专用键改为通用 headers，可用 `${ENV_VAR}` 引用环境变量避免明文进 config.json。
- 新增插件侧 `maxChars` 硬截断（默认 10000 字符）：浮现池体积偏大时可在服务端调 `hooks.max_tokens` 或调高该值。
- 旧三键无自动迁移：`removeExtraKeys` 会在加载时从运行期配置剔除旧键，磁盘残留下次保存时消失（configuration.md 既有行为）。

## 语义说明（沿用既有行为，非本次改动引入）

- 「合法 JSON 但没有 `hookSpecificOutput.additionalContext`」视为服务端本轮无内容，静默不注入：这是 ADR 0016「纯文本服务避免返回 JSON 形状文本」约定的直接推论，与 Claude Code 行为一致；spec L45 的「解析失败按纯文本全文注入」只覆盖 JSON 解析失败分支。
- 注入点在 `appendGroupAutoReplyPrompt` 之前，与被 ADR 0015 验收的旧实现逐字同位（群自动回复提示按次追加在其后是原有分层）。
