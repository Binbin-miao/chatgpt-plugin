# 01: 抽 `${ENV_VAR}` 插值共享 helper

**What to build:** 一个纯函数：把字符串里的 `${VAR}` 占位替换为对应环境变量的值，未定义的变量替换为空串，不含占位符的输入原样返回。它是后续两张票（注入钩子的 headers、MCP 的 headers）共用的鉴权配套件。注意这是**可选能力**：headers 里明文直填密钥同样有效，插值只服务于「密钥不落 config.json」的需求。依据 `.scratch/generic-hooks/spec.md`（Implementation Decisions 节）。

**Blocked by:** None (can start immediately)

**Status:** done（commit `23f62fb`，2026-11-05，分支 v2）

- [x] `${VAR}` 正确替换为环境变量值；未定义变量替换为空串；不含 `${}` 的字符串原样返回；非字符串输入原样返回
- [x] 单测覆盖上述四条路径，挂独立 `test:*` 脚本并入 `check` 链（先例：surfaceInjection 测试的挂载方式）
- [x] 纯新增，不改动任何现有行为；全仓 `node --check` 与 `check` 相关步骤绿
