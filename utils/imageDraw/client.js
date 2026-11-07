import { logWarn } from './log.js'
import { newFetch } from '../proxy.js'

/**
 * 绘图接口客户端。
 *
 * 中转站暴露绘图能力有两种形态，必须一套代码兼容：
 *   1. 标准 Images 接口：POST /v1/images/generations（文生图）、/v1/images/edits（图生图，multipart）
 *   2. 包成对话接口：POST /v1/chat/completions，图在 choices[].message.content 的 markdown / data URL 里
 *
 * 上过一次的站要记住走哪条，否则每次失败都要多打一次无用的请求。
 */

/** 上游只认这几个尺寸；用户填别的值一律回落到默认，避免 400 */
export const DRAW_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536']
/** gpt-image 系只认这四档；standard/hd 是 dall-e 遗产，传了直接 400 */
export const DRAW_QUALITIES = ['auto', 'low', 'medium', 'high']

/** 生成图下载上限：gpt-image 的 1536 长边输出也就几 MB，20MB 足够挡住恶意大文件 */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

/** baseUrl + model + 通道形态 → 'images' | 'chat'（图生图与文生图的端点能力可能不同，不能共用一个结论） */
const routeCache = new Map()
const ROUTE_TTL = 5 * 60 * 1000

/** 仅测试用：清空通道缓存 */
export function clearDrawRouteCache () {
  routeCache.clear()
}

export class ImageDrawError extends Error {
  constructor (message, code = 'failed', status = 0) {
    super(message)
    this.name = 'ImageDrawError'
    this.code = code
    this.status = status
  }
}

export function normalizeSize (value, fallback = '1024x1024') {
  const size = String(value ?? '').trim()
  return DRAW_SIZES.includes(size) ? size : fallback
}

export function normalizeQuality (value, fallback = 'medium') {
  const quality = String(value ?? '').trim().toLowerCase()
  return DRAW_QUALITIES.includes(quality) ? quality : fallback
}

/**
 * 拼文生图请求体。
 *
 * gpt-image 系永远返回 b64_json，传 response_format 会 400；style 只属于 dall-e-3，
 * 同样会 400。按模型名判断而不是让用户配，少一个能配错的地方。
 */
export function buildGenerationPayload ({ model, prompt, size, quality } = {}) {
  return { model, prompt, size: normalizeSize(size), quality: normalizeQuality(quality), n: 1 }
}

function trimBase (baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '')
}

/** 从 data URL 或裸 base64 里取出字节 */
function decodeBase64 (value) {
  const raw = String(value || '')
  const body = (raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw).replace(/\s+/g, '')
  if (!body) throw new ImageDrawError('上游返回了空图片', 'empty')
  const buffer = Buffer.from(body, 'base64')
  // Buffer.from 对残缺 base64 不报错，只会解出很短的一截；这里挡一下，免得把坏图发进群
  if (buffer.length < 8) throw new ImageDrawError('上游返回的图片数据不完整', 'empty')
  return buffer
}

function mimeOfDataUrl (value) {
  const match = /^data:([^;,]+)[;,]/.exec(String(value || ''))
  return match ? match[1] : 'image/png'
}

/**
 * 拦掉指向内网/本机的主机名。
 *
 * 只能挡字面量地址：真正的防护要解析 DNS 之后再看 IP，而这里拿不到解析结果。
 * 对「上游返回的图片地址」这个场景，字面量拦截已经够用——它挡的是把 127.0.0.1
 * 或 192.168.x.x 塞进返回体、借机器人把内网内容带出去这种最省事的打法。
 */
function assertPublicHost (hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) throw new ImageDrawError('生成图地址缺少主机名', 'download')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new ImageDrawError(`生成图地址指向本机：${host}`, 'download')
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    const private4 = a === 0 || a === 127 || a === 10
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
    if (private4) throw new ImageDrawError(`生成图地址指向内网：${host}`, 'download')
  }
  if (host.includes(':') && (host === '::1' || /^f[cd]/.test(host) || /^fe80/.test(host))) {
    throw new ImageDrawError(`生成图地址指向内网：${host}`, 'download')
  }
}

/**
 * 下载上游给的临时地址：这类链接通常几分钟就过期，必须当场取回字节。
 *
 * 地址来自上游返回体（对话通道里甚至是模型正文），属于不可信输入，
 * 所以禁本机/内网、限体积、带超时；不能直接 await fetch。
 */
async function downloadImage (url, { timeoutMs, fetchImpl = newFetch } = {}) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) throw new ImageDrawError(`生成图地址不是 http(s)：${target.slice(0, 60)}`, 'download')
  let parsed
  try {
    parsed = new URL(target)
  } catch {
    throw new ImageDrawError(`生成图地址无法解析：${target.slice(0, 60)}`, 'download')
  }
  assertPublicHost(parsed.hostname)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60000)
  try {
    const response = await fetchImpl(target, { signal: controller.signal })
    if (!response?.ok) throw new ImageDrawError(`下载生成图失败：HTTP ${response?.status ?? '无响应'}`, 'download')
    // content-length 只是提前止损，真正的上限还得看落到手里的字节数
    const declared = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new ImageDrawError(`生成图超过 ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB`, 'download')
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) throw new ImageDrawError('下载到的图片是空的', 'download')
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      throw new ImageDrawError(`生成图超过 ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB`, 'download')
    }
    const ext = /\.(png|jpe?g|webp)(?:[?#]|$)/i.exec(target)?.[1]?.toLowerCase()
    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext ? `image/${ext}` : 'image/png'
    return { buffer, mimeType }
  } catch (err) {
    if (err instanceof ImageDrawError) throw err
    if (err?.name === 'AbortError') throw new ImageDrawError('下载生成图超时', 'timeout')
    throw new ImageDrawError(`下载生成图失败：${err?.message || err}`, 'download')
  } finally {
    clearTimeout(timer)
  }
}

/** 从对话式返回的正文里抠出图片地址（markdown / html / data URL / 裸链接） */
export function extractImagesFromText (text) {
  const content = String(text || '')
  const found = []
  // 允许尖括号包裹、允许 ` "title"` / ` 'title'` 这类标题、允许 URL 里有一层括号：
  // 中转的短链经常没有扩展名，标题和括号都很常见，写窄了就直接丢图。
  for (const match of content.matchAll(/!\[[^\]]*\]\(\s*<?((?:[^()\s<>]|\([^()]*\))+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g)) found.push(match[1])
  for (const match of content.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) found.push(match[1])
  for (const match of content.matchAll(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=\s]+/g)) found.push(match[0].replace(/\s+/g, ''))
  if (!found.length) {
    // 裸链接兜底：带上查询串，签名参数丢了照样 403
    for (const match of content.matchAll(/https?:\/\/[^\s"'<>)\]]+\.(?:png|jpe?g|webp)(?:[?#][^\s"'<>)\]]*)?/gi)) found.push(match[0])
  }
  return found
}

/**
 * 把上游返回体归一到「拿得到图片」的形态。
 *
 * 顺序是硬规则：b64_json 优先（空串不算）→ url → 对话正文 → 报错。
 * 中转经常把不用的字段填成空串而不是省略，只看 key 是否存在会把空图当成功。
 */
export function classifyResponse (json) {
  if (!json || typeof json !== 'object') throw new ImageDrawError('上游返回体无法解析', 'bad-response')

  const error = json.error
  if (error) {
    const message = typeof error === 'string' ? error : (error.message || JSON.stringify(error))
    throw new ImageDrawError(message, 'upstream')
  }

  const data = Array.isArray(json.data) ? json.data : []
  // 只判真值不够：中转会回 " " / "\n" 这种空白串，解出来是 0 字节，当成功就会发空图还扣额度
  const b64 = data.map(item => item?.b64_json).find(value => typeof value === 'string' && value.trim())
  if (b64) return { kind: 'b64', value: b64.trim() }
  const url = data.map(item => item?.url).find(value => typeof value === 'string' && value.trim())
  if (url) return { kind: 'url', value: url.trim() }

  const choices = Array.isArray(json.choices) ? json.choices : []
  if (choices.length) {
    const message = choices[0]?.message || {}
    // 有的中转把图直接放在 content 数组里（type: image_url），只取 text 会判成「没画出来」
    const parts = Array.isArray(message.content) ? message.content : []
    const direct = parts.find(part => part?.image_url?.url || part?.url)
    if (direct) {
      const value = String(direct.image_url?.url || direct.url).trim()
      return value.startsWith('data:') ? { kind: 'b64', value, dataUrl: true } : { kind: 'url', value }
    }
    const content = Array.isArray(message.content)
      ? message.content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('')
      : (message.content || '')
    const images = extractImagesFromText(content)
    if (images.length) {
      return images[0].startsWith('data:') ? { kind: 'b64', value: images[0], dataUrl: true } : { kind: 'url', value: images[0] }
    }
    // 只回了文字：多半被审核拦了，或者这个站根本不支持对话式出图。
    // 归到 moderation 而不是 empty——它不该计入接口熔断，一个人连发五条被拦的提示词不该停掉全群。
    throw new ImageDrawError(content.trim().slice(0, 120) || '上游没有返回图片', 'moderation')
  }

  const extra = Array.isArray(json.images) ? json.images : []
  if (extra.length) {
    const first = extra[0] || {}
    if (first.b64_json) return { kind: 'b64', value: first.b64_json }
    if (first.url) return { kind: 'url', value: first.url }
  }

  throw new ImageDrawError('上游没有返回图片', 'empty')
}

/** 手工拼 multipart：node-fetch 对 spec FormData 支持不稳，自己拼最省事 */
export function buildMultipart (fields, files) {
  const boundary = `----chatgptdraw${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`
  const chunks = []
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  for (const file of files) {
    const fileName = file.filename || 'image.png'
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${fileName}"\r\nContent-Type: ${file.mimeType || 'image/png'}\r\n\r\n`))
    chunks.push(file.buffer)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** 把上游报错翻译成能给用户看的短句，原始报文只进日志 */
export function toUserMessage (err) {
  const status = err?.status || 0
  const code = err?.code || ''
  if (code === 'timeout') return '生成超时了，稍后再试'
  if (code === 'auth' || status === 401 || status === 403) return '绘图服务鉴权失败，请主人检查密钥'
  if (code === 'quota' || status === 402) return '绘图服务额度不足，请主人充值'
  if (code === 'rate-limit' || status === 429) return '绘图服务被限流了，稍后再试'
  if (code === 'moderation') return '提示词被上游拦截了，换个说法试试'
  return '生成失败了，稍后再试'
}

function classifyStatus (status, text) {
  if (status === 401 || status === 403) return new ImageDrawError(`鉴权失败：${text}`, 'auth', status)
  if (status === 402) return new ImageDrawError(`额度不足：${text}`, 'quota', status)
  if (status === 429) return new ImageDrawError(`被限流：${text}`, 'rate-limit', status)
  if (status === 404 || status === 405) return new ImageDrawError(`端点不存在：${text}`, 'unsupported-endpoint', status)
  // 对话式中转对不认识的 /v1/images/* 常回 400「无可用渠道 / not supported」：
  // 只认 404 的话，这类站会一直报「生成失败」，而它其实只是要走另一条通道。
  if (status === 400 && /not\s*support|unsupported|no\s*such|invalid.*(endpoint|route|path|url)|无可用渠道|不支持/i.test(text)) {
    return new ImageDrawError(`端点不可用：${text}`, 'unsupported-endpoint', status)
  }
  return new ImageDrawError(`上游返回 HTTP ${status}：${text}`, 'upstream', status)
}

async function readBody (res) {
  const text = await res.text()
  try {
    return { json: JSON.parse(text), text }
  } catch {
    return { json: null, text }
  }
}

/** 标准 Images 接口（文生图走 generations，带参考图走 edits） */
async function requestImages (ctx) {
  const { baseUrl, headers, prompt, model, size, quality, refs, timeoutMs, fetchImpl } = ctx
  // baseUrl 按仓库约定已经带 /v1（默认值就是 https://api.openai.com/v1），这里不能再补一次
  const endpoint = refs.length ? '/images/edits' : '/images/generations'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let res
    if (refs.length) {
      const multipart = buildMultipart(
        { model, prompt, size: normalizeSize(size), quality: normalizeQuality(quality), n: '1' },
        // 目前一次只带一张参考图；文件名后缀跟 mimeType 走，避免 webp 内容顶着 .png 的扩展名
        refs.slice(0, 1).map(ref => ({
          name: 'image',
          buffer: ref.buffer,
          mimeType: ref.mimeType,
          filename: `ref.${ref.mimeType === 'image/jpeg' ? 'jpg' : (ref.mimeType.split('/')[1] || 'png')}`
        }))
      )
      res = await fetchImpl(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': multipart.contentType },
        body: multipart.body,
        signal: controller.signal
      })
    } else {
      res = await fetchImpl(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(buildGenerationPayload({ model, prompt, size, quality })),
        signal: controller.signal
      })
    }
    const { json, text } = await readBody(res)
    if (!res.ok) {
      // 部分中转用 200 之外的码 + error 字段表达「模型不支持该参数」，一并落到 unsupported
      const detail = json?.error?.message || json?.message || text.slice(0, 200)
      throw classifyStatus(res.status, detail)
    }
    if (!json) throw new ImageDrawError(`上游返回的不是 JSON：${text.slice(0, 120)}`, 'bad-response')
    return classifyResponse(json)
  } catch (err) {
    if (err instanceof ImageDrawError) throw err
    if (err?.name === 'AbortError') throw new ImageDrawError('生成超时', 'timeout')
    throw new ImageDrawError(`请求失败：${err?.message || err}`, 'network')
  } finally {
    clearTimeout(timer)
  }
}

/** 对话式接口（中转常见：opacity 参数被忽略，图在正文里） */
async function requestChat (ctx) {
  const { baseUrl, headers, prompt, model, size, quality, refs, timeoutMs, fetchImpl } = ctx
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const content = refs.length
      ? [
          { type: 'text', text: prompt },
          ...refs.map(ref => ({ type: 'image_url', image_url: { url: `data:${ref.mimeType};base64,${ref.buffer.toString('base64')}` } }))
        ]
      : prompt
    const body = {
      model,
      messages: [{ role: 'user', content }],
      size: normalizeSize(size),
      quality: normalizeQuality(quality),
      n: 1,
      stream: false
    }
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const { json, text } = await readBody(res)
    if (!res.ok) {
      const detail = json?.error?.message || json?.message || text.slice(0, 200)
      throw classifyStatus(res.status, detail)
    }
    if (!json) throw new ImageDrawError(`上游返回的不是 JSON：${text.slice(0, 120)}`, 'bad-response')
    return classifyResponse(json)
  } catch (err) {
    if (err instanceof ImageDrawError) throw err
    if (err?.name === 'AbortError') throw new ImageDrawError('生成超时', 'timeout')
    throw new ImageDrawError(`请求失败：${err?.message || err}`, 'network')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 生成一张图。
 *
 * @param {object} options
 * @param {{baseUrl: string, apiKey: string, model: string}} options.provider 已解析好的连接参数
 * @param {string} options.prompt
 * @param {string} [options.size]
 * @param {string} [options.quality]
 * @param {Array<{buffer: Buffer, mimeType: string}>} [options.refs] 参考图（图生图）
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.fetchImpl] 测试注入
 * @returns {Promise<{buffer: Buffer, mimeType: string, via: string}>}
 */
export async function generateImage ({
  provider,
  prompt,
  size,
  quality,
  refs = [],
  timeoutMs = 180_000,
  fetchImpl = newFetch
}) {
  const baseUrl = trimBase(provider?.baseUrl)
  const apiKey = String(provider?.apiKey || '').trim()
  const model = String(provider?.model || '').trim()
  if (!baseUrl) throw new ImageDrawError('绘图地址未配置', 'config')
  if (!apiKey) throw new ImageDrawError('绘图密钥未配置', 'config')
  if (!model) throw new ImageDrawError('绘图模型名未配置', 'config')
  if (!String(prompt || '').trim()) throw new ImageDrawError('提示词为空', 'config')

  const headers = { authorization: `Bearer ${apiKey}`, accept: 'application/json' }
  const ctx = { baseUrl, headers, prompt: String(prompt).trim(), model, size, quality, refs, timeoutMs, fetchImpl }
  // 图生图（edits）与文生图（generations）是不同端点：某个站可能只缺其中一个，
  // 用同一个键会让「一次 edits 404」把之后所有文生图都永久推到对话接口。
  const routeKey = `${baseUrl}|${model}|${refs.length ? 'edits' : 'gen'}`
  const cached = routeCache.get(routeKey)
  const route = cached && Date.now() - cached.at < ROUTE_TTL ? cached.via : null

  let result
  let usedRoute
  if (route === 'chat') {
    usedRoute = 'chat'
    result = await requestChat(ctx)
  } else {
    try {
      result = await requestImages(ctx)
      usedRoute = 'images'
      routeCache.set(routeKey, { via: 'images', at: Date.now() })
    } catch (err) {
      if (err?.code !== 'unsupported-endpoint') throw err
      logWarn(`${baseUrl} 不支持 Images 接口，改用对话接口`)
      usedRoute = 'chat'
      routeCache.set(routeKey, { via: 'chat', at: Date.now() })
      result = await requestChat(ctx)
    }
  }

  if (result.kind === 'b64') {
    const buffer = decodeBase64(result.value)
    return { buffer, mimeType: result.dataUrl ? mimeOfDataUrl(result.value) : 'image/png', via: 'b64', route: usedRoute }
  }
  const downloaded = await downloadImage(result.value, { timeoutMs, fetchImpl })
  return { ...downloaded, via: 'url', route: usedRoute }
}
