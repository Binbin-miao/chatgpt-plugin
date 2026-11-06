import assert from 'node:assert/strict'
import test from 'node:test'

const { pickCacheUsage } = await import('../utils/openai/cacheUsage.js')

test('认 OpenAI 的 prompt_tokens_details.cached_tokens', () => {
  assert.deepEqual(
    pickCacheUsage({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 128 } }),
    { read: 128, write: undefined }
  )
})

test('认 DeepSeek 的 prompt_cache_hit_tokens', () => {
  assert.deepEqual(
    pickCacheUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 }),
    { read: 80, write: undefined }
  )
})

test('认第三方中转只给顶层 cached_tokens 的情况', () => {
  assert.deepEqual(pickCacheUsage({ cached_tokens: 42 }), { read: 42, write: undefined })
})

test('Anthropic 两组字段优先，且缓存写入单独给出', () => {
  assert.deepEqual(
    pickCacheUsage({
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 100,
      prompt_tokens_details: { cached_tokens: 1 }
    }),
    { read: 900, write: 100 }
  )
})

test('上游完全没给缓存字段时返回 undefined，而不是 0', () => {
  assert.deepEqual(pickCacheUsage({ prompt_tokens: 10 }), { read: undefined, write: undefined })
  assert.deepEqual(pickCacheUsage(), { read: undefined, write: undefined })
})

test('上游明确给 0 时保留 0，以便区分「没给」与「没命中」', () => {
  assert.deepEqual(
    pickCacheUsage({ prompt_tokens_details: { cached_tokens: 0 } }),
    { read: 0, write: undefined }
  )
})
