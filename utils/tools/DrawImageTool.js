import { AbstractTool } from './AbstractTool.js'
import { Config } from '../config.js'
import { DRAW_SIZES } from '../imageDraw/client.js'
import { launchDraw } from '../imageDraw/index.js'

/**
 * 每日上限的表达：有上限报数字，不限额报 unlimited。
 * 0 会被模型读成「今天 0 张」，比缺字段更糟。
 */
function dailyLimitText (limit) {
  const count = Number(limit)
  return Number.isFinite(count) && count > 0 ? String(count) : 'unlimited'
}

/** 被拒时给模型看的固定字段顺序；缺哪个就报 0，不让模型自己猜 */
function rejectionText (result, isMaster) {
  const rawLimit = result?.limit
  // 预检给出的上限最准（主人与不限额的人那里是 0）；它缺了才按配置兜底
  const limit = rawLimit === undefined || rawLimit === null
    ? (isMaster ? 0 : Number(Config.imageDrawDailyLimit))
    : Number(rawLimit)
  return [
    'Error: 绘图请求未受理',
    `reason: ${result?.code || 'unknown'}`,
    `retry_after_seconds: ${Number(result?.retryAfter) || 0}`,
    `daily_limit: ${dailyLimitText(limit)}`,
    `used_today: ${Number(result?.used) || 0}`,
    `cooldown_minutes: ${Number(Config.imageDrawCooldownMinutes) || 0}`,
    `detail: ${result?.message || ''}`,
    '请把 reason 对应的原因和相关数字转达给用户，不要说已经画好，也不要编造图片地址。'
  ].join('\n')
}

/** 受理后告诉模型规则：每日张数与出图冷却 */
function acceptedText (isMaster) {
  return [
    '已受理，正在生成。图片会由插件直接发出。',
    `daily_limit: ${dailyLimitText(isMaster ? 0 : Number(Config.imageDrawDailyLimit))}`,
    `cooldown_minutes: ${Number(Config.imageDrawCooldownMinutes) || 0}`,
    '请把每日张数与冷却时长一并告诉用户。'
  ].join('\n')
}

/**
 * 让 AI 自己决定画什么、画多大。
 *
 * 只回一句话就返回：绘图实测要 40-100 秒，工具里死等会把整轮对话卡住，
 * 部分框架还会直接判工具超时。图片由插件在后台画完后单独发出。
 *
 * 工具链路只有模型一个说话的人：插件不许自己发消息，被拒与受理都要写成
 * 「原因 + 数字」交给模型去转达，模型才不会被读成「已经画好了」。
 */
export class DrawImageTool extends AbstractTool {
  name = 'generate_image'

  parameters = {
    properties: {
      prompt: {
        type: 'string',
        description: '图像的完整描述。把用户的需求转述成一段可直接作画的画面描述（主体、动作、风格、氛围），保留用户原话里的关键信息，用中文即可，不要翻译成英文 tag，也不要自己堆画质词。'
      },
      size: {
        type: 'string',
        enum: DRAW_SIZES,
        description: '根据用户对构图的要求选择：方图 1024x1024、横图 1536x1024、竖图 1024x1536。用户没提构图就留空，用默认值。'
      },
      useAvatar: {
        type: 'boolean',
        description: '用户要求「用我的头像画」「把我画成…」时设为 true，插件会取提问者的 QQ 头像当参考图。引用图片作画时不用设这个参数，插件会自动取引用图。'
      }
    },
    required: ['prompt']
  }

  description = '根据文字描述生成一张图片。当用户明确要求画图、生成图片、来一张图时调用；只是讨论绘画风格或问问题不要调用。引用消息里的图片会被插件自动当成参考图，用户要求用自己的头像作画时把 useAvatar 设为 true。调用会立刻返回，图片在几十秒后由插件直接发到群里，你可以自己用一句话回应用户——不要编造图片地址，也不要许诺具体秒数。与 draw 工具的区别：draw 是把请求转交给第三方绘图插件（nai/ap 等），本工具直接调用内置绘图接口。如果工具返回以 `Error: 绘图请求未受理` 开头的内容，说明这次请求被拒绝了：必须把 reason 对应的原因和数字转达给用户，不要当成已经画好。成功时也要把 daily_limit 与 cooldown_minutes 对应的每日张数与冷却时长告诉用户。`daily_limit` 为 `unlimited` 表示不限张数；`used_today` 是今天已经画掉的张数。'

  func = async function (opts, e) {
    if (Config.imageDrawOnlyMaster && !e?.isMaster) {
      return 'Error: 当前仅主人可以使用绘图功能，请告知用户联系主人开启。'
    }
    const prompt = String(opts?.prompt || '').trim()
    if (!prompt) return 'Error: 缺少 prompt，无法作画。'

    const result = await launchDraw({
      e,
      prompt,
      size: opts?.size,
      useAvatar: Boolean(opts?.useAvatar)
      // 不传 ack：回执交给模型，插件再插一句只会和模型的回复撞在一起
    })
    if (!result.ok) return rejectionText(result, Boolean(e?.isMaster))
    return acceptedText(Boolean(e?.isMaster))
  }
}
