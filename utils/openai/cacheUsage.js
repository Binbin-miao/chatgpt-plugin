/**
 * 从各家的 usage 里认出「缓存命中」与「缓存写入」的 token 数。
 *
 * 字段并不统一：OpenAI 系放在 `prompt_tokens_details.cached_tokens`，Anthropic 用
 * `cache_read_input_tokens` / `cache_creation_input_tokens`，DeepSeek 用顶层的
 * `prompt_cache_hit_tokens`，部分中转只给顶层 `cached_tokens`。
 * 少认一个字段，真命中也会被算成 0——这是「缓存 0%」最常见的假象来源。
 *
 * 返回 `undefined` 而不是 0，是为了让调用方能区分「上游没给这个字段」（不打日志、不判命中）
 * 与「上游明确给了 0」（确实一次都没命中）。
 *
 * @param {object} [usage] 上游返回的 usage 对象
 * @returns {{read: number|undefined, write: number|undefined}}
 */
export function pickCacheUsage (usage = {}) {
  const read = usage.cache_read_input_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? usage.cached_tokens
  const write = usage.cache_creation_input_tokens
    ?? usage.prompt_tokens_details?.cache_write_tokens
    ?? usage.input_tokens_details?.cache_write_tokens
  return { read, write }
}
