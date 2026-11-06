# 01: sanitizeArgs 已知接受的边角——远端显式声明 sender/isAdmin 等同名业务字段时宿主值透传

**What was found:** 2026-11-06 两轴评审 `4285d8b`（fix: 隔离 MCP 工具调用的宿主鉴权字段并按 inputSchema 清洗入参）时，规范轴与规格轴独立命中同一条边角：`McpTool.sanitizeArgs` 的非严格路径（`additionalProperties: true` 的开放 schema）对 `HOST_INJECTED_KEYS`（sender/isAdmin/groupId）有一个豁免——键被远端 `properties` 显式声明时不剥离（否则会误伤同名业务字段）。于是「远端恰好把 sender/isAdmin/groupId 声明成业务入参 + 开放 schema」时，宿主注入值会顶着业务字段的名字透传给远端；严格白名单路径（`additionalProperties !== true`）同理，声明了同名键即视为业务字段，宿主值原样保留。

**Status:** wontfix（接受，理由如下）

## 为什么接受

- 触发条件要求远端 server 给鉴权字段起 `sender`/`isAdmin`/`groupId` 这三个名字**并**把它们声明成业务入参——JSON Schema/MCP 语义下这三个名字不是通用约定字段，真实 server 撞上的概率趋近于零；已接入的 Ombre-Brain（`extra="forbid"`）与 nocturne_memory（`extra="ignore"`）都没有这些字段。
- 反向修法（无条件剥离这三个键）会误伤真业务字段：远端若真声明了 `sender` 参数，模型的合法入参会被静默清掉——比透传更糟且更难排查。
- 该豁免是 `4285d8b` 引入清洗时即有的行为，评审未发现实际可达的危害路径。

## 何时重开

出现真实 server 把这三个名字之一声明为业务入参且行为异常时，再考虑区分「宿主注入值」与「模型产出值」（例如执行器传参数副本时打标）。

## 相关记录

- 无 inputSchema 工具的静默清空（同次评审发现的另一条，未声明 schema 的工具命中默认空 properties 严格白名单会把全部参数清空）已修复：constructor 记录 `hasRemoteSchema`，未声明 schema 的工具清洗回退为仅剥离注入键（`test/mcpToolFilter.test.mjs`「远端未声明 inputSchema」用例，先红后绿）。
- 本条边角**故意不加测试钉住**：把透传行为 pin 进测试会让人误读为完整设计意图，这里的记录即是裁定。
- 规范轴同场评审的另两条未处理项：四路分流形状重复（core.js 两处近乎逐行相同，可提取共享 helper，属既有重复延续）与 `HOST_INJECTED_MODES` 含无生产来源的 `'openai'`——均为 judgement call，留此存档。
