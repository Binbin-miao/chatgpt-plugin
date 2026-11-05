# 浮现注入（Ombre-Brain breath hook）

`Status:` superseded-by `.scratch/generic-hooks/spec.md`（浮现注入已并入通用上下文注入钩子；本文保留决策过程与实现记录，机制细节以新 spec 与 ADR 0016 为准）

把消息发给模型之前，自动从 Ombre-Brain 拉取当前浮现结果并注入当轮 system。术语与决策依据见 `GLOSSARY.md`「浮现注入」词条与 `docs/adr/0015-surface-injection-into-system.md`；链路事实见 `.scratch/ombre-hook/chatgpt-plugin-注入点调查.md`（本文行号均出自该调查）。

## 背景与已定决策

插件现以纯 MCP 直连形态接入 Ombre-Brain（16 个记忆工具），记忆浮现全靠模型主动调 `breath()`。本功能补上「自动浮现」缺口。以下决策已与用户逐条确认，实现时不再重新讨论：

1. **每轮注入**：每条消息发给模型前都拉取一次（不是会话级一次）。
2. **位置**：`model/core.js` 四个 provider 分支的 system 终点、`resolveTurnSystem`（`utils/quotedImage.js:47`）缓存之前追加；抽公共 helper，禁止在分支里内联重复逻辑。
3. **鉴权**：请求带 `Authorization: Bearer <breathHookToken>`；token 与 Ombre 服务端 `config.yaml` 的 `hooks.token` 同值（服务端侧由用户手工配置，不进本仓库）。
4. **范围**：走 `abstractChat` → `Core.sendMessage` 的全部入口（普通对话、第一人称、自主回复等），不做入口裁剪。
5. **失败行为**：超时 3 秒；超时 / 网络错误 / 401 / 429 一律静默跳过（`logger.warn` 一行诊断）；返回空（浮现池为空）是正常状态，静默跳过且不告警；任何情况下不阻塞、不影响消息发出。
6. **配置**：`utils/config.js` 的 `defaultConfig`（`config.js:27`）加三键并在 `guoba.support.js` 同步面板 schema：
   - `breathHookEnable`（默认 `false`）
   - `breathHookUrl`（默认 `http://127.0.0.1:18011`，端点路径固定 `/breath-hook`）
   - `breathHookToken`（默认空）
7. **共存**：记忆 V2 召回（`apps/chat.js:1022-1038`）不动，两管线叠加，不做去重。
8. **体积**：插件侧不截断；体积由 Ombre 服务端 `hooks.max_tokens` 控制（提示用户调，见「仓库外联动改动」）。
9. **测试**：helper 级单测 + `node --check` + `npm run check`；真实链路由用户手工验证一次。
10. **术语**：机制统一叫「浮现注入」，日志前缀建议 `[SurfaceInjection]` 或沿用现风格另定，不混用 `breathHook` 以外的旧称。

## 要做出什么

1. **拉取模块**（建议 `utils/breathHook.js`）：`fetchSurfaceInjection(config)` → 成功返回注入文本、失败/空返回 `null`。3 秒超时、Bearer 头、失败静默 `logger.warn`、不抛出。
2. **四分支接入**（`model/core.js`）：helper 在每分支 system 终点追加注入文本：
   - claude：`core.js:389`（`resolveTurnSystem` 调用）之前
   - gemini：`core.js:470` 前
   - responses：`buildResponsesInstructions` 内（`core.js:566-567` 的重建路径要能保留注入，必须放重建函数里）
   - OpenAI `api`：`buildOpenAISystem`（`core.js:661-664`）内
   - 拉取每轮最多一次，借助既有 `prepared.system` 缓存语义实现主备/重试复用同一份文本。
3. **配置面**：`utils/config.js` 三键 + `guoba.support.js` schema（先例 `enableMcp` 在 `guoba.support.js:1942`）；读取走四个分支收到的 `Config` 形参——即 `sendWithProvider(prompt, conversation, use, e, opt, Config)` 的第六参，由 `sendMessage` 传入 `providerConfig(row, source)` 产出对象（`model/core.js:255`），非全局单例。
4. **单测**（`test/`，纯逻辑、stub 全局依赖）：覆盖成功 / 超时 / 401 / 空结果四路径与「成功时追加到 system、失败时 system 原样返回」。
5. **开关默认关**：未启用时零行为变化——不发起任何 HTTP 请求，四分支 system 与现状完全一致。

## 仓库外联动改动（不属于本仓验收，实现完提醒用户）

- **Ombre 服务端**（`C:\Ombre-Brain\config.yaml`）：`hooks.token` 填随机串；建议同步把 `hooks.max_tokens` 从默认 10000 调小（如 2000–4000），闲聊轮不必背一万 token 浮现正文。改完重启 Ombre 服务。
- **人设文本**（工作区根的人设文件，未随本仓入库）：
  - `:368-370` 唤醒节奏：删掉「无参 `breath()`」步骤，保留 `read_memory('system://boot')`；改为「浮现结果每轮自动注入上下文，无需主动调 `breath()`」。
  - `:382-385` 浮现与检索三入口：`breath()` 描述改为按需兜底检索的说明或直接移除该入口行。
  - `:405` `=== 久未浮现 ===` 的处理说明改挂到「每轮自动注入的内容」上。
- **Dashboard token 占位**：config.yaml 里 `hooks:` 段缩进已在先前部署时校正过，只填值不动结构。

## 验收清单

- [ ] `breathHookEnable` 为 `false`（默认）时：不发起任何 HTTP 请求，四个分支发出的 system 与改动前完全一致
- [ ] 开关开启、Ombre 在线：发一条消息，日志可见一次 `/breath-hook` 拉取，模型收到的 system 末尾含浮现分节文本
- [ ] 同一轮主备切换 / 上下文超限重试时只拉取一次，注入文本一致（responses 重建路径含注入）
- [ ] 工具调用轮的请求中 system 仍含注入文本
- [ ] Ombre 关闭 / 3 秒超时 / 401 / 429：消息照常发出，无异常刷屏，`logger.warn` 恰好一行；返回空：消息照常发出且零告警
- [ ] 注入文本不进入 Redis 会话历史：关闭开关后下一轮的历史与从未开启时一致
- [ ] 对话历史中不出现逐轮累积的注入文本
- [ ] 新增单测覆盖成功 / 超时 / 401 / 空结果四路径，`npm run check` 全绿
- [ ] 锅巴面板可见三个新字段，保存后生效（含改 URL 重连成功）
- [ ] 改动过的 `.js` 全部过 `node --check`
- [ ] 不提交任何含 token 的配置；`config/config.json` 仍在 `.gitignore` 内

## 边界（明确不做）

- 不动记忆 V2 的召回逻辑与配置
- 不做插件侧内容截断、不做两管线去重
- 不改 MCP 挂载（`enableMcp`、16 个工具）与 `breath()` 工具本身
- 不设置 `allow_public` / `OMBRE_HOOK_ALLOW_PUBLIC`（走 token 路线）
- 不裁剪生效入口、不区分群聊私聊

## 已知约束

- `/breath-hook` 每来源限流 10 次/窗口、全局 60（Ombre `src/web/hooks.py:41-42`）；正常对话频率足够，429 按失败静默跳过。
- 四分支接入必须逐处核对后分别验证，不能只验一处就宣称全部生效（AGENTS.md 翻车史警告）。
- 行号基于 2026-11-05 的工作区文件，动手时先按符号名重新定位。

## 评审修正记录（2026-11-05 双轴评审后并入）

- 决策 5 与验收第 5 条：把「返回空」从告警清单里分出来——浮现池为空是正常状态，静默跳过零告警（原始 Q5 推荐口径即如此，spec 文字此前写岔）。
- 「要做出什么」第 3 条：读取方式改为如实描述（分支 `Config` 形参 = `providerConfig` 产出对象）。
- 注入点调查报告移入本仓 `.scratch/ombre-hook/`，交叉引用恢复可解析。
- `model/core.js` claude（:391）与 api（:672）附近「缓存只存基础 system」注释更新为「缓存存基础 system（含浮现注入文本）」。
- 测试按 testing.md 惯例挂独立 `test:surface` 入口，check 链改经 `npm run test:surface`；补 TimeoutError 专项用例。
