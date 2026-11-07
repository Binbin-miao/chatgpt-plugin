import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDrawCommand } from '../utils/imageDraw/args.js'

test('最简单写法：只剩提示词，尺寸质量走默认', () => {
  assert.deepEqual(parseDrawCommand('#绘图 深海里的鲸鱼'), {
    prompt: '深海里的鲸鱼',
    size: '1024x1024',
    quality: 'medium',
    useAvatar: false
  })
})

test('#绘图头像 与多余空白都能吃下', () => {
  const parsed = parseDrawCommand('#绘图头像   一只  橘猫  ')
  assert.equal(parsed.prompt, '一只 橘猫')
  assert.equal(parsed.useAvatar, true)
})

test('参数可以放在提示词前面，也可以穿插', () => {
  const result = parseDrawCommand('#绘图 -s 1024x1536 -q high 雨夜的东京街头')
  assert.equal(result.size, '1024x1536')
  assert.equal(result.quality, 'high')
  assert.equal(result.prompt, '雨夜的东京街头')
})

test('头像开关：-a / --avatar / 头像 三种写法等价', () => {
  assert.equal(parseDrawCommand('#绘图 -a 赛博朋克').useAvatar, true)
  assert.equal(parseDrawCommand('#绘图 --avatar 赛博朋克').useAvatar, true)
  assert.equal(parseDrawCommand('#绘图 头像 赛博朋克').useAvatar, true)
  assert.equal(parseDrawCommand('#绘图 头像 赛博朋克').prompt, '赛博朋克')
})

test('#绘图头像 直接把头像开关点亮', () => {
  const result = parseDrawCommand('#绘图头像 变成水彩画')
  assert.equal(result.useAvatar, true)
  assert.equal(result.prompt, '变成水彩画')
})

test('非法尺寸/质量给出明确提示，而不是静默回落', () => {
  assert.match(parseDrawCommand('#绘图 -s 512x512 一只猫').error, /尺寸只支持/)
  assert.match(parseDrawCommand('#绘图 -q ultra 一只猫').error, /质量只支持/)
  assert.match(parseDrawCommand('#绘图 -s').error, /参数 -s 后面要跟尺寸/)
})

test('没有提示词时提示怎么写', () => {
  assert.match(parseDrawCommand('#绘图').error, /要画什么/)
  assert.match(parseDrawCommand('#绘图 -a').error, /要画什么/)
})

test('提示词里的英文和标点原样保留', () => {
  assert.equal(parseDrawCommand('#绘图 a cat, cyberpunk style, 8k').prompt, 'a cat, cyberpunk style, 8k')
})
