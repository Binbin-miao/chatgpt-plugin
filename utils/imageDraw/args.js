import { DRAW_SIZES, DRAW_QUALITIES, normalizeSize, normalizeQuality } from './client.js'

/**
 * 解析 `#绘图` 后面的参数。
 *
 * 支持两种写法：
 *   #绘图 深海里的鲸鱼
 *   #绘图 -s 1024x1536 -q high -a 画成赛博朋克
 *
 * `-a/--avatar` 表示拿发指令的人的头像当参考图（图生图）。
 *
 * 容错原则：只有「看起来确实是在写参数、但取值不合法」才报错；
 * 其余拼不上的片段一律回到提示词里。用户写「一只写着 -s 的猫」时，
 * 那句 -s 是画面的一部分，不能把整张图判死。
 */

// 只认 #绘图：`#绘画` 归 nai-plugin，抢过来会让装了那个插件的人画不出图
const COMMAND_PATTERN = /^#绘图/
const SIZE_LIKE = /^\d+\s*[x×*]\s*\d+$/i
const QUALITY_LIKE = /^[a-z]+$/i

/** @returns {{prompt: string, size: string, quality: string, useAvatar: boolean, error?: string}} */
export function parseDrawCommand (text, { defaultSize = '1024x1024', defaultQuality = 'medium' } = {}) {
  const body = String(text ?? '').replace(COMMAND_PATTERN, '').trim()
  const tokens = body.split(/\s+/).filter(Boolean)
  const promptParts = []
  let size = normalizeSize(defaultSize, '1024x1024')
  let quality = normalizeQuality(defaultQuality, 'medium')
  let useAvatar = false

  // --size=1024x1536 这类等号写法先拆成两个 token，后面统一处理
  const expanded = []
  for (const token of tokens) {
    const eq = /^(--size|-s|--quality|-q)=(.+)$/i.exec(token)
    if (eq) expanded.push(eq[1], eq[2])
    else expanded.push(token)
  }

  for (let index = 0; index < expanded.length; index += 1) {
    const token = expanded[index]
    const lower = token.toLowerCase()

    if (lower === '-a' || lower === '--avatar' || lower === '头像') {
      // 单独一个「头像」当提示词的情况比当开关少得多，按开关处理更符合直觉
      useAvatar = true
      continue
    }

    if (lower === '-s' || lower === '--size') {
      const value = expanded[index + 1]
      // 后面什么都没有，是参数写了一半，不是提示词
      if (value === undefined) {
        return { prompt: promptParts.join(' '), size, quality, useAvatar, error: '参数 -s 后面要跟尺寸，例如：-s 1024x1536' }
      }
      // 后面跟的不是尺寸写法，说明这只是提示词里的一个短横线，原样保留
      if (!DRAW_SIZES.includes(value) && !SIZE_LIKE.test(value)) {
        promptParts.push(token)
        continue
      }
      if (!DRAW_SIZES.includes(value)) return { prompt: promptParts.join(' '), size, quality, useAvatar, error: `尺寸只支持 ${DRAW_SIZES.join(' / ')}` }
      size = value
      index += 1
      continue
    }

    if (lower === '-q' || lower === '--quality') {
      const raw = expanded[index + 1]
      if (raw === undefined) {
        return { prompt: promptParts.join(' '), size, quality, useAvatar, error: '参数 -q 后面要跟质量，例如：-q high' }
      }
      const value = String(raw)
      if (!value || (!DRAW_QUALITIES.includes(value.toLowerCase()) && !QUALITY_LIKE.test(value))) {
        promptParts.push(token)
        continue
      }
      if (!DRAW_QUALITIES.includes(value.toLowerCase())) return { prompt: promptParts.join(' '), size, quality, useAvatar, error: `质量只支持 ${DRAW_QUALITIES.join(' / ')}` }
      quality = value.toLowerCase()
      index += 1
      continue
    }

    promptParts.push(token)
  }

  const prompt = promptParts.join(' ').trim()
  if (!prompt) return { prompt: '', size, quality, useAvatar, error: '要画什么？在指令后面写一句描述，例如：#绘图 深海里的鲸鱼' }
  return { prompt, size, quality, useAvatar }
}
