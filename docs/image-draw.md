# 内置绘图

插件自带出图能力，不依赖 paimonnai-plugin 之类的外部插件。两种调用方式共用同一条链路：
AI 工具 `generate_image`，以及群里的 `#绘图` 指令。

## 配置（锅巴 → 绘图）

| 键 | 说明 |
| --- | --- |
| `imageDrawEnable` | 总开关。关掉时指令不接管消息、工具不注册，模型根本看不到绘图能力 |
| `imageDrawOnlyMaster` | 只允许主人用。与 `#识图` 的 `gemini_vqa_needMaster` 同一套口径 |
| `imageDrawProviderId` | 用哪一行 provider 的地址与密钥；留空则整个功能报配置错 |
| `imageDrawModel` | 模型名，如 `gpt-image-2`。注意 provider 行里填的对话模型不会被沿用 |
| `imageDrawDailyLimit` | 每人每日张数，`0` 表示不限 |
| `imageDrawCooldownMinutes` | 画完一张后的个人冷却分钟数 |
| `imageDrawSize` / `imageDrawQuality` | 默认尺寸与质量；AI 会按用户描述自行覆盖 |
| `imageDrawTimeoutSeconds` | 单次生成超时，gpt-image 系通常要 40–100 秒 |
| `imageDrawFailStreakLimit` | 连续失败多少次触发全员熔断 |
| `imageDrawGlobalCooldownHours` | 熔断持续小时数 |

主人不受张数与冷却限制，也不会产生计数。

## 两种调用方式

```
#绘图 深海里的鲸鱼
#绘图 -s 1024x1536 -q high 雨夜的东京街头
#绘图头像 把这个人画成赛博朋克        （拿自己的 QQ 头像当参考图）
引用一张图 + #绘图 改成水彩风格        （以图生图）
```

`-s/--size`、`-q/--quality`、`-a/--avatar` 都可省略；参数拼错会回到提示词里，不会把整条指令判死。

AI 侧由模型自己判断尺寸，调用 `generate_image` 后只拿回一句「已提交」，插件不发回执——开口回应这个人的机会留给模型。
指令链路会先回一句带等待区间的回执（例如「30秒~3分钟」），图生成完再补发到群里。
返图会引用触发它的那条消息，方便对上号；引用发送失败时自动降级成普通消息重发一次，不会出现「额度扣了、图却没到」。
回执与返图都会报一句当日剩余次数：回执在扣额度前发出，说的是「今天还能画 N 张」（含正在画的这一张）；返图报的是扣完之后剩下的张数。主人与不限额度时不报。
不论走指令还是走 AI 调用，开始绘图时都会告知每日张数与出图冷却；主人与不限额的情况不显示。
AI 主动调用被拦截时，插件把结构化理由（原因、冷却秒数、今日上限、今日已用）交给模型，由模型转达；指令链路则由插件直接回群告知。
工具返回给模型的 `daily_limit` 为 `unlimited` 表示不限张数（`0` 会被读成「今天 0 张」，所以不用 0 表示不限）；被冷却或熔断拒绝时同样会带上真实的每日上限与今日已用。
`#绘图解禁` 清熔断（仅主人），`#绘图状态` 看自己的额度与冷却（谁都能查）。

## 为什么要兼容两套接口

中转站暴露绘图能力有两种形态，一套代码都吃：

1. 标准 Images 接口：`POST {baseUrl}/images/generations`、`{baseUrl}/images/edits`（multipart）
2. 包成对话接口：`POST {baseUrl}/chat/completions`，图在 `choices[].message.content` 的 markdown / data URL 里

先试 Images，遇到 404/405 或「无可用渠道」这类 400 就自动降级到对话接口，并把结论缓存 5 分钟。
图生图与文生图的端点能力可能不同，缓存键分开，一次 edits 失败不会把文生图也带偏。

> `baseUrl` 按仓库约定已经带 `/v1`（默认值 `https://api.openai.com/v1`），客户端不再补，补了会变成 `/v1/v1/...`。

## 熔断只认接口故障

`upstream / network / timeout / auth / quota / rate-limit / bad-response` 计入失败连击；
`moderation`（提示词被拦）、`empty`（上游没给图）、`download`（图取不回来）不计入。
一个人连发五条被拦的提示词，不该让全群冷却五小时。

## 排障

| 现象 | 先看这里 |
| --- | --- |
| 指令没反应 | `imageDrawEnable` 是否为 true；`imageDrawOnlyMaster` 是否把非主人挡了 |
| 回「绘图还没启用」 | 同上，锅巴里打开开关 |
| 回「选中的提供商没有填地址」 | `imageDrawProviderId` 指向的 provider 行缺 `openAiBaseUrl` |
| 一直「生成失败了」 | 看日志 `[ChatGPT][绘图]`。若是 404 末端点判定，检查 baseUrl 是否重复带 `/v1` |
| 一直「提示词被上游拦截」 | 上游把纯文字回复当成拒绝。换模型或换渠道再试 |
| 全员冷却中 | 连错达到阈值；主人发 `#绘图解禁` 立刻恢复 |

日志前缀统一为 `[ChatGPT][绘图]`，出图成功会记通道（`images`/`chat`）、字节数与耗时。
