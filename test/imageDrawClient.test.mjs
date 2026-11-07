import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGenerationPayload,
  buildMultipart,
  classifyResponse,
  clearDrawRouteCache,
  extractImagesFromText,
  generateImage,
  ImageDrawError,
  normalizeQuality,
  normalizeSize
} from '../utils/imageDraw/client.js'

beforeEach(() => clearDrawRouteCache())

const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex')

function jsonResponse (status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: { get: () => 'application/json' }
  }
}

function binaryResponse (buffer, contentType = 'image/png') {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    headers: { get: () => contentType }
  }
}

test('尺寸与质量只放行上游认的取值，其余回落默认', () => {
  assert.equal(normalizeSize('1024x1536'), '1024x1536')
  assert.equal(normalizeSize('512x512'), '1024x1024')
  assert.equal(normalizeSize('', '1536x1024'), '1536x1024')
  assert.equal(normalizeQuality('HIGH'), 'high')
  assert.equal(normalizeQuality('standard'), 'medium')
})

test('gpt-image 系不传 response_format / style，且固定 n=1', () => {
  const payload = buildGenerationPayload({ model: 'gpt-image-2', prompt: '一只猫', size: '1024x1024', quality: 'high' })
  assert.deepEqual(payload, { model: 'gpt-image-2', prompt: '一只猫', size: '1024x1024', quality: 'high', n: 1 })
  assert.equal('response_format' in payload, false)
  assert.equal('style' in payload, false)
})

test('返回体解析：b64_json 优先，空串视为没有', () => {
  assert.deepEqual(classifyResponse({ data: [{ b64_json: 'AAAA', url: '' }] }), { kind: 'b64', value: 'AAAA' })
  // 中转常把不用的字段填成空串，不能只看 key 是否存在
  assert.deepEqual(classifyResponse({ data: [{ b64_json: '', url: 'https://x/1.png' }] }), { kind: 'url', value: 'https://x/1.png' })
  // 空白串同样是「没有」：不 trim 就会拿 ' ' 顶掉后面那张真图，最后只能报空图
  assert.deepEqual(classifyResponse({ data: [{ b64_json: ' ', url: 'https://x/2.png' }] }), { kind: 'url', value: 'https://x/2.png' })
  assert.throws(() => classifyResponse({ data: [{ b64_json: ' ' }] }), err => err.code === 'empty')
})

test('返回体解析：对话式接口从 markdown 正文里取图', () => {
  const body = { choices: [{ message: { content: '画好了！\n![image](https://cdn.example.com/a.png)' } }] }
  assert.deepEqual(classifyResponse(body), { kind: 'url', value: 'https://cdn.example.com/a.png' })

  const dataUrl = 'data:image/webp;base64,AAAA'
  assert.deepEqual(classifyResponse({ choices: [{ message: { content: `看图 ${dataUrl}` } }] }), { kind: 'b64', value: dataUrl, dataUrl: true })
})

test('返回体解析：只回文字时当作审核拒绝，不当作成功', () => {
  // 归到 moderation 而不是 empty：它不计入熔断，一个人连发五条被拦的提示词不该停掉全群
  assert.throws(
    () => classifyResponse({ choices: [{ message: { content: '抱歉，我无法生成这张图片。' } }] }),
    err => err instanceof ImageDrawError && err.code === 'moderation'
  )
  assert.throws(() => classifyResponse({ data: [] }), err => err.code === 'empty')
  assert.throws(() => classifyResponse({ error: { message: 'quota exceeded' } }), err => err.code === 'upstream')
})

test('正文取图覆盖 markdown / html / 裸链接三种写法', () => {
  assert.deepEqual(extractImagesFromText('![](https://a/1.png)'), ['https://a/1.png'])
  assert.deepEqual(extractImagesFromText('<img src="https://a/2.webp">'), ['https://a/2.webp'])
  assert.deepEqual(extractImagesFromText('见 https://a/3.jpg 这张'), ['https://a/3.jpg'])
})

test('multipart 手工拼装：边界、字段与文件字节都在', () => {
  const { body, contentType } = buildMultipart(
    { model: 'gpt-image-2', prompt: '一只猫', n: '1' },
    [{ name: 'image', buffer: PNG_BYTES, mimeType: 'image/png', filename: 'ref.png' }]
  )
  const text = body.toString('binary')
  assert.match(contentType, /^multipart\/form-data; boundary=----chatgptdraw/)
  assert.match(text, /name="model"\r\n\r\ngpt-image-2/)
  assert.match(text, /name="image"; filename="ref.png"\r\nContent-Type: image\/png\r\n\r\n/)
  assert.ok(text.endsWith('--\r\n'))
})

test('文生图：走 images/generations，b64 直接返回字节', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: options.body })
    return jsonResponse(200, { data: [{ b64_json: PNG_BYTES.toString('base64') }] })
  }
  const image = await generateImage({
    provider: { baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-1', model: 'gpt-image-2' },
    prompt: '一只猫',
    size: '1024x1024',
    quality: 'medium',
    fetchImpl
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.example.com/v1/images/generations')
  assert.deepEqual(image.buffer, PNG_BYTES)
  assert.equal(image.via, 'b64')
  assert.equal(image.route, 'images', '走的是标准 Images 接口，日志要能说清')
})

test('图生图：走 images/edits 的 multipart，带上参考图字节', async () => {
  let captured
  const fetchImpl = async (url, options) => {
    captured = { url, contentType: options.headers['content-type'], body: options.body }
    return jsonResponse(200, { data: [{ b64_json: PNG_BYTES.toString('base64') }] })
  }
  await generateImage({
    provider: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-1', model: 'gpt-image-2' },
    prompt: '画成赛博朋克',
    refs: [{ buffer: PNG_BYTES, mimeType: 'image/png' }],
    fetchImpl
  })
  assert.equal(captured.url, 'https://api.example.com/v1/images/edits')
  assert.match(captured.contentType, /multipart\/form-data/)
  assert.ok(captured.body.includes(PNG_BYTES))
})

test('Images 接口 404 时自动降级到对话接口，并记住这条路由', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    // 下载生成图的请求不算「接口调用」，单独忽略
    if (!url.startsWith('https://cdn.example.com/')) urls.push(url)
    if (url.startsWith('https://cdn.example.com/')) return binaryResponse(PNG_BYTES)
    if (url.endsWith('/images/generations')) return jsonResponse(404, { error: { message: 'not found' } })
    return jsonResponse(200, { choices: [{ message: { content: '![x](https://cdn.example.com/out.png)' } }] })
  }
  const options = {
    provider: { baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-1', model: 'gpt-image-2' },
    prompt: '一只猫',
    fetchImpl
  }

  const first = await generateImage(options)
  assert.deepEqual(first.buffer, PNG_BYTES)
  assert.equal(first.route, 'chat', '降级后要记成对话通道')
  assert.deepEqual(urls, ['https://relay.example.com/v1/images/generations', 'https://relay.example.com/v1/chat/completions'])

  // 第二次直接走对话接口，不再浪费一次 404
  urls.length = 0
  await generateImage(options)
  assert.deepEqual(urls, ['https://relay.example.com/v1/chat/completions'])
})

test('对话接口的图生图把参考图放进 image_url', async () => {
  clearDrawRouteCache()
  let body
  const fetchImpl = async (url, options) => {
    body = JSON.parse(options.body)
    return jsonResponse(200, { data: [{ b64_json: PNG_BYTES.toString('base64') }] })
  }
  const provider = { baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-1', model: 'gpt-image-2' }
  // 路由键按端点分开：要让图生图走 chat，得先让 edits 这条单独失败
  await generateImage({
    provider,
    prompt: 'x',
    refs: [{ buffer: PNG_BYTES, mimeType: 'image/png' }],
    fetchImpl: async () => jsonResponse(404, {})
  }).catch(() => {})
  await generateImage({ provider, prompt: '画成水彩', refs: [{ buffer: PNG_BYTES, mimeType: 'image/png' }], fetchImpl })

  assert.equal(body.messages[0].content[0].type, 'text')
  assert.equal(body.messages[0].content[1].type, 'image_url')
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/)
})

test('edits 失败不影响文生图继续试 Images 端点', async () => {
  clearDrawRouteCache()
  const provider = { baseUrl: 'https://relay2.example.com/v1', apiKey: 'sk-1', model: 'gpt-image-2' }
  const refs = [{ buffer: PNG_BYTES, mimeType: 'image/png' }]
  await generateImage({ provider, prompt: 'x', refs, fetchImpl: async () => jsonResponse(404, {}) }).catch(() => {})

  const urls = []
  const fetchImpl = async url => {
    urls.push(url)
    return jsonResponse(200, { data: [{ b64_json: PNG_BYTES.toString('base64') }] })
  }
  await generateImage({ provider, prompt: '一只猫', fetchImpl })
  assert.deepEqual(urls, ['https://relay2.example.com/v1/images/generations'])
})

test('错误分类：401 归为鉴权失败，超时归为 timeout', async () => {
  await assert.rejects(
    generateImage({
      provider: { baseUrl: 'https://a.example.com', apiKey: 'sk-1', model: 'gpt-image-2' },
      prompt: 'x',
      fetchImpl: async () => jsonResponse(401, { error: { message: 'invalid key' } })
    }),
    err => err.code === 'auth' && err.status === 401
  )

  await assert.rejects(
    generateImage({
      provider: { baseUrl: 'https://b.example.com', apiKey: 'sk-1', model: 'gpt-image-2' },
      prompt: 'x',
      fetchImpl: async () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      }
    }),
    err => err.code === 'timeout'
  )
})

test('配置缺失时不发请求，直接报 config 错误', async () => {
  let called = false
  await assert.rejects(
    generateImage({
      provider: { baseUrl: '', apiKey: 'sk-1', model: 'gpt-image-2' },
      prompt: 'x',
      fetchImpl: async () => { called = true }
    }),
    err => err.code === 'config'
  )
  assert.equal(called, false)
})
