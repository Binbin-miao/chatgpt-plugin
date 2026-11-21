/**
 * 旧会话桶（`CHATGPT:CONVERSATIONS_V2:<通道 id>:<连接版本>:<scope>`）→ 新键（`CHATGPT:CONVERSATION_V3:<scope>`）
 * 的懒迁移与全量迁移。
 *
 * 为什么必须有它：换键之后老用户的会话在新键下不存在，若不做归并，他们下一句就是「全新对话」，
 * 等于用改键的方式把所有人的上下文清了一遍。
 *
 * 三条不能违反的约束（写在这里，改代码前先读）：
 * 1. **`ctime` 排序，`utime` 绝不参与排序**。`utime` 全仓只在建桶时被写成 `ctime`，从不更新，
 *    拿它排序等于按创建时间排，看起来「差不多」，但再也识别不出「桶被重新启用」。
 * 2. **只在跨桶边界去重，桶内绝不去重**。用户在同一个群里真的会重复问同一句，桶内重复必须保留。
 * 3. **迁移时旧键不 DEL**：先备份到 `..._BAK:<scope>:<ver>` 再 `EXPIRE 604800`，回滚后旧代码还读得到。
 *    例外是用户主动清空（`clearScopeHistory` / `clearAllHistory`）：那时新键与旧桶必须一起删，
 *    否则下一次读取会把旧桶懒迁移回来，等于清空从未发生。
 *
 * 失败一律「往回退一步」而不是抛：抢不到锁就读旧桶、旧桶坏了就跳过它、合并出错就回落最活跃的那个桶。
 * 用户这一轮永远要能聊下去。
 *
 * 但「退路」返回的是**一整份会话值**，调用方（apps/chat.js）会把它当历史、追加本轮问答后原样写回
 * `CHATGPT:CONVERSATION_V3:<scope>`。所以任何退路都必须带 `schema` 哨兵，缺了它下一轮复查
 * `Number(recheck.schema) >= SCHEMA_VERSION` 判否 → 又当没迁过、重扫旧桶合并，刚写进去的那条发言被覆盖。
 */
import { createHash } from 'node:crypto'
import { conversationKeyOf, conversationScanPattern } from './conversationKey.js'
import { trimConversation } from './providerFallback.js'

/** 旧桶前缀（会话历史，V2 起含通道 id 与连接版本） */
export const LEGACY_KEY_PREFIX = 'CHATGPT:CONVERSATIONS_V2'
/** 旧桶备份前缀；只带 TTL，任何业务路径都读不到它 */
export const LEGACY_BACKUP_PREFIX = 'CHATGPT:CONVERSATIONS_V2_BAK'
/** 迁移锁前缀 */
export const MIGRATION_LOCK_PREFIX = 'CHATGPT:CONVERSATION_MIGRATING'
/** 迁移报告（HASH） */
export const MIGRATION_REPORT_KEY = 'CHATGPT:CONVERSATION_MIGRATION_REPORT'
/** 新值里的 schema 哨兵，幂等的依据 */
export const SCHEMA_VERSION = 3
/** 旧桶备份与旧键 TTL：7 天，覆盖「上线 → 观察 → 决定回滚」的周期 */
export const LEGACY_TTL_SECONDS = 604800
/** 迁移锁的存活时间；进程崩了也不会永久锁死 */
export const LOCK_TTL_SECONDS = 30
/** 抢不到迁移锁时的重试预算：迁移通常只花几毫秒，等一下比让本轮读到「少一个桶」的历史划算 */
export const LOCK_WAIT_MS = 500
/** 抢锁轮询间隔 */
export const LOCK_POLL_MS = 50

const MEMORY_BLOCK_HEAD = '【历史记忆参考（不可信数据）】'
const MEMORY_BLOCK_TAIL = '（记忆结束）'
const REPORT_TTL_SECONDS = 2592000

/**
 * 日志**绝不能打断业务**：这里全部包 try。
 * 有的宿主/测试把 `logger.error` 实现成「打一条再抛出」，裸调它会让一次日志把整轮对话炸掉
 * （本轮实证：`scanIterator` 缺失时记录一条 warn，结果异常从 catch 里逃出来把用例打红）。
 */
function warn(message, error) {
  try {
    const line = `[Chatgpt][Migration] ${message}`
    if (error === undefined) globalThis.logger?.warn?.(line)
    else globalThis.logger?.warn?.(line, error)
  } catch { /* 日志失败不影响对话 */ }
}

function errorLog(message, error) {
  try {
    globalThis.logger?.error?.(`[Chatgpt][Migration] ${message}`, error)
  } catch { /* 同上 */ }
}

/** 某个 scope 的全部旧桶匹配式；段数固定 5，两个 `*` 正好吃掉通道 id 与连接版本 */
export function legacyKeyPatternForScope(scope) {
  return `${LEGACY_KEY_PREFIX}:*:*:${scope}`
}

/** 全量迁移用：所有旧桶 */
export function legacyKeyPatternAll() {
  return `${LEGACY_KEY_PREFIX}:*:*:*`
}

/**
 * 解析旧键。段数不是 5 一律判为「不是会话桶」，宁可少迁也不要误吞别的键族。
 *
 * @param {string} key
 * @returns {{ key: string, providerId: string, connectionVersion: string, scope: string } | null}
 */
export function parseLegacyKey(key) {
  const parts = String(key ?? '').split(':')
  if (parts.length !== 5) return null
  const [head, family, providerId, connectionVersion, scope] = parts
  if (head !== 'CHATGPT' || family !== 'CONVERSATIONS_V2') return null
  if (!providerId || !connectionVersion || !scope) return null
  return { key, providerId, connectionVersion, scope }
}

/**
 * 旧键对应的备份键。
 *
 * @param {{ providerId: string, connectionVersion: string, scope: string }} parsed
 * @returns {string}
 */
export function legacyBackupKeyOf(parsed) {
  return `${LEGACY_BACKUP_PREFIX}:${parsed.scope}:${parsed.connectionVersion}`
}

/**
 * 剥掉历史里已经烘进去的记忆块（B5 的存量清理）。
 *
 * 必须行首锚定；找不到结束标记就整条不剥——宁可留脏数据，也不能误删用户原话。
 *
 * @param {string} content
 * @returns {{ content: string, stripped: boolean }}
 */
export function stripMemoryBlock(content) {
  if (typeof content !== 'string') return { content, stripped: false }
  const head = content.replace(/^\s+/, '')
  if (!head.startsWith(MEMORY_BLOCK_HEAD)) return { content, stripped: false }
  const tailIndex = content.indexOf(MEMORY_BLOCK_TAIL)
  if (tailIndex < 0) return { content, stripped: false }
  let rest = content.slice(tailIndex + MEMORY_BLOCK_TAIL.length)
  if (rest.startsWith('\n\n')) rest = rest.slice(2)
  else if (rest.startsWith('\n')) rest = rest.slice(1)
  return { content: rest, stripped: true }
}

function timeOf(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function newestActivityOf(bucket) {
  const stamps = Array.isArray(bucket.value?.replyTimestamps) ? bucket.value.replyTimestamps : []
  const valid = stamps.map(Number).filter(Number.isFinite)
  if (valid.length) return Math.max(...valid)
  return timeOf(bucket.value?.utime) || timeOf(bucket.value?.ctime)
}

/**
 * 桶排序：`ctime` 升序 → 消息条数升序 → 键名字典序。
 *
 * 第三级不是装饰：保证同样的输入永远得到同样的输出，否则「重跑两次」会得到两份不同的历史。
 *
 * @param {Array<{ key: string, value: object }>} buckets
 * @returns {Array<{ key: string, value: object }>}
 */
export function sortLegacyBuckets(buckets) {
  return [...buckets].sort((a, b) => {
    const byTime = timeOf(a.value?.ctime) - timeOf(b.value?.ctime)
    if (byTime !== 0) return byTime
    const byLength = (a.value?.messages?.length || 0) - (b.value?.messages?.length || 0)
    if (byLength !== 0) return byLength
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
}

function pairHash(userContent, assistantContent) {
  return createHash('sha1').update(`${userContent}\u0000${assistantContent}`).digest('hex')
}

/**
 * 合并同一 scope 的 N 个旧桶。
 *
 * 纯函数：不碰 Redis，便于把「顺序 / 去重 / 裁剪 / 元信息」逐条钉死在用例里。
 *
 * @param {Array<{ key: string, parsed: object, value: object }>} rawBuckets 已解析出 value 的桶
 * @param {{ config: object, providerRow?: object, now?: number }} options
 * @returns {{ value: object, report: object }}
 */
export function mergeLegacyBuckets(rawBuckets, { config, providerRow = null, now = Date.now() } = {}) {
  const sorted = sortLegacyBuckets(rawBuckets)
  const strippedCount = { value: 0 }
  const flat = []
  for (const [bucketIndex, bucket] of sorted.entries()) {
    const messages = Array.isArray(bucket.value?.messages) ? bucket.value.messages : []
    for (const message of messages) {
      if (!message || typeof message.role !== 'string') continue
      let content = message.content
      if (message.role === 'user') {
        const result = stripMemoryBlock(content)
        content = result.content
        if (result.stripped) strippedCount.value += 1
      }
      flat.push({ role: message.role, content, bucket: bucketIndex })
    }
  }

  const kept = []
  const pairOwners = new Map()
  const pushKept = item => {
    const last = kept[kept.length - 1]
    // 相邻重复：只有「跨桶」才丢，桶内连续重复是用户真实行为
    if (last && last.role === item.role && last.content === item.content && last.bucket !== item.bucket) return
    kept.push(item)
  }
  for (let index = 0; index < flat.length;) {
    const head = flat[index]
    const next = flat[index + 1]
    const isPair = head.role === 'user' && next && next.role === 'assistant'
    if (!isPair) { pushKept(head); index += 1; continue }
    const hash = pairHash(head.content, next.content)
    const owner = pairOwners.get(hash)
    if (owner !== undefined && owner !== head.bucket) { index += 2; continue }
    if (owner === undefined) pairOwners.set(hash, head.bucket)
    pushKept(head)
    pushKept(next)
    index += 2
  }

  const messages = kept.map(item => ({ role: item.role, content: item.content }))
  const capped = trimConversation(messages, config || {}, providerRow)
  const cappedTo = Array.isArray(capped) ? capped.length : messages.length

  const stamps = sorted
    .flatMap(bucket => (Array.isArray(bucket.value?.replyTimestamps) ? bucket.value.replyTimestamps : []))
    .map(Number)
    .filter(Number.isFinite)
  const replyTimestamps = [...new Set(stamps)].sort((a, b) => a - b).slice(-10)

  const ctimes = sorted.map(bucket => bucket.value?.ctime).filter(Boolean)
  const ctime = ctimes.sort((a, b) => timeOf(a) - timeOf(b))[0] || new Date(now).toISOString()
  const latestSender = [...sorted].sort((a, b) => timeOf(b.value?.ctime) - timeOf(a.value?.ctime))[0]
  const mostActive = [...sorted].sort((a, b) => newestActivityOf(b) - newestActivityOf(a))[0]
  const utimeMs = replyTimestamps.length ? replyTimestamps[replyTimestamps.length - 1] : timeOf(latestSender?.value?.ctime)
  const utime = new Date(utimeMs || now).toISOString()

  const finalMessages = Array.isArray(capped) ? capped : messages
  const value = {
    schema: SCHEMA_VERSION,
    scope: sorted[0]?.parsed?.scope,
    sender: latestSender?.value?.sender,
    ctime,
    utime,
    num: finalMessages.filter(message => message.role === 'assistant').length,
    messages: finalMessages,
    replyTimestamps,
    channel: {
      providerId: mostActive?.parsed?.providerId,
      connectionVersion: mostActive?.parsed?.connectionVersion,
      type: providerRow?.type,
      model: providerRow?.model,
      updatedAt: utimeMs
    },
    migration: {
      from: sorted.map(bucket => bucket.key),
      buckets: sorted.length,
      mergedMessages: messages.length,
      cappedTo,
      strippedMemoryBlocks: strippedCount.value,
      anomalyResumedBuckets: sorted.filter(bucket => newestActivityOf(bucket) > timeOf(nextCtimeAfter(sorted, bucket)) && nextCtimeAfter(sorted, bucket) > 0).length,
      at: now
    }
  }
  return { value, report: value.migration }
}

/** 排序后「下一个桶的 ctime」——用来数「被重新启用」的异常桶 */
function nextCtimeAfter(sorted, bucket) {
  const index = sorted.indexOf(bucket)
  const next = sorted[index + 1]
  return next?.value?.ctime
}

async function safeGet(client, key) {
  try { return await client.get(key) } catch (err) { errorLog(`读取 ${key} 失败`, err); return null }
}

function parseJson(raw) {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

/**
 * 抢迁移锁。Redis 的 `SET NX EX` 是一步原子操作，比 setnx + expire 两步更安全。
 *
 * @returns {Promise<boolean>}
 */
async function acquireLock(client, key) {
  try {
    const ok = await client.set(key, '1', { EX: LOCK_TTL_SECONDS, NX: true })
    return ok === 'OK' || ok === true
  } catch (err) {
    errorLog(`抢迁移锁 ${key} 失败`, err)
    return false
  }
}

async function releaseLock(client, key) {
  try { await client.del(key) } catch (err) { errorLog(`释放迁移锁 ${key} 失败`, err) }
}

async function listKeys(client, pattern) {
  const keys = []
  try {
    for await (const key of client.scanIterator({ MATCH: pattern })) keys.push(String(key))
  } catch (err) {
    errorLog(`扫描 ${pattern} 失败`, err)
    return null
  }
  return keys
}

async function safeDel(client, key) {
  try {
    return Number(await client.del(key)) || 0
  } catch (err) {
    errorLog(`删除 ${key} 失败`, err)
    return 0
  }
}

/**
 * 读某一 scope 的全部旧桶并解析。
 *
 * 坏 JSON 的桶被跳过并计数（`bad`），不抛——一个坏桶不能让整个 scope 迁不动。
 * 返回扫描计数是为了让全量迁移能如实回报「跳过几个坏桶」，而不是静默吞掉。
 *
 * @returns {Promise<{ buckets: Array<{ key: string, parsed: object, value: object }>, scanned: number, bad: number }>}
 */
export async function collectLegacyBuckets(client, scope) {
  const keys = await listKeys(client, legacyKeyPatternForScope(scope))
  if (!keys) return { buckets: [], scanned: 0, bad: 0 }
  const buckets = []
  let bad = 0
  for (const key of keys) {
    const parsed = parseLegacyKey(key)
    if (!parsed) { bad += 1; continue }
    const value = parseJson(await safeGet(client, key))
    if (!value) {
      bad += 1
      warn(`旧桶内容不是合法 JSON，跳过：${key}`)
      continue
    }
    buckets.push({ key, parsed, value })
  }
  return { buckets, scanned: keys.length, bad }
}

/** 一组旧桶里「最后活跃最大」的那个的 value——内存合并都失败时按单桶兜底 */
function mostActiveOf(buckets) {
  return [...buckets].sort((a, b) => newestActivityOf(b) - newestActivityOf(a))[0]?.value || null
}

/**
 * 抢锁带短等待。锁被持有通常意味着「另一个进程正在迁同一个 scope」，几毫秒就会放掉；
 * 立刻退到旧桶会让本轮读到还没合并完的历史。预算必须短（≤500ms），不能拖住用户的这一轮。
 *
 * @returns {Promise<boolean>}
 */
async function acquireLockWithRetry(client, key) {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    if (await acquireLock(client, key)) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS))
  }
}

/**
 * 退路返回值：在**内存**里把该 scope 的全部旧桶合并一次（纯函数，不写 Redis）。
 *
 * 必须带 `schema`：调用方会把返回值当历史、追加本轮问答后写回新键，
 * 缺 schema 时下一轮复查判为「未迁移」→ 重扫旧桶合并 → 把刚写进去的这条发言覆盖掉。
 * 万不得已才退到「最活跃单桶 + schema 哨兵」——这样至少下一轮认得出已迁移，不会反复重合并。
 *
 * @param {Array<{ key: string, parsed: object, value: object }>} buckets
 * @param {{ config: object, providerRow?: object, now?: number }} options
 * @returns {object | null}
 */
function fallbackValueFrom(buckets, { config, providerRow = null, now = Date.now() } = {}) {
  if (!Array.isArray(buckets) || !buckets.length) return null
  try {
    const { value } = mergeLegacyBuckets(buckets, { config, providerRow, now })
    if (value) return value
  } catch (err) {
    errorLog('退路内存合并失败，回落最活跃单桶', err)
  }
  try {
    const single = mostActiveOf(buckets)
    return single ? { ...single, schema: SCHEMA_VERSION } : null
  } catch (err) {
    errorLog('退路取最活跃单桶失败', err)
    return null
  }
}

async function writeReport(client, scope, report) {
  try {
    await client.hSet(MIGRATION_REPORT_KEY, String(scope), JSON.stringify(report))
    await client.expire(MIGRATION_REPORT_KEY, REPORT_TTL_SECONDS)
  } catch (err) {
    // 报告写不进去不影响对话本身
    warn('迁移报告写入失败', err)
  }
}

/**
 * 把一个 scope 的旧桶合并进新键。
 *
 * 顺序：抢锁（含短重试）→ 扫描 → 合并 → 备份每个旧键 → **单次 SET** 新键 → 旧键置 7 天 TTL → 写报告。
 * 任何异常都不抛：退路是内存合并该 scope 的全部旧桶（带 schema），本轮照样能聊，
 * 写回新键后下一轮仍认得出「已迁移」，不会重合并把本轮发言覆盖掉。
 *
 * @param {{ scope: string, client: object, config: object, providerRow?: object, now?: number }} options
 * @returns {Promise<{ status: 'already' | 'empty' | 'locked' | 'migrated' | 'fallback', value: object | null, report?: object }>}
 */
export async function ensureMigratedScope({ scope, client, config, providerRow = null, now = Date.now() }) {
  const targetKey = conversationKeyOf(scope)
  if (!scope || !targetKey) return { status: 'empty', value: null }

  const existingRaw = await safeGet(client, targetKey)
  const existing = parseJson(existingRaw)
  if (existing && Number(existing.schema) >= SCHEMA_VERSION) return { status: 'already', value: existing }

  // 先做一次**只读**扫描再决定要不要抢锁。理由：绝大多数读取是新用户或已迁移用户，一个旧桶都没有，
  // 若照 migration.md 5.2 的字面「先抢锁再扫」，每一轮对话都会多出 SET NX + DEL 两次写，
  // 读路径就不再是纯读路径了（也白费两次往返）。先扫的代价是一次 SCAN，
  // 而且只在「新键没命中」时才发生——一轮对话成功后新键就在，下一轮直接早退。
  const preview = await collectLegacyBuckets(client, scope)
  if (!preview.buckets.length) {
    // 没有旧桶可搬：新键里要是有能解析的值就直接用，**绝不能返回 null**。
    // schema 缺失只说明它是迁移前写下的值（或手工塞的），丢掉它等于把用户历史吞了。
    if (existing) return { status: 'already', value: existing, badBuckets: preview.bad }
    return { status: 'empty', value: null, badBuckets: preview.bad }
  }

  const lockKey = `${MIGRATION_LOCK_PREFIX}:${scope}`
  if (!await acquireLockWithRetry(client, lockKey)) {
    // 退路同样要「完整」：返回值会被调用方写回新键，必须带 schema，否则下一轮重合并覆盖本轮发言。
    // 用内存合并而不是单桶，是为了别让用户在这一轮看到「历史少了一截」。
    warn(`scope ${scope} 的迁移锁被占用，内存合并旧桶后继续（不写 Redis）`)
    return { status: 'locked', value: fallbackValueFrom(preview.buckets, { config, providerRow, now }), badBuckets: preview.bad }
  }
  // 兜底合并的数据源：try 里重扫到更全的桶就换掉它，catch 分支用它
  let fallbackBuckets = preview.buckets
  try {
    // 抢到锁后重扫：期间别的进程可能已经迁完（新键落地），那就直接用别人的结果
    const recheck = parseJson(await safeGet(client, targetKey))
    if (recheck && Number(recheck.schema) >= SCHEMA_VERSION) return { status: 'already', value: recheck }
    const found = await collectLegacyBuckets(client, scope)
    const buckets = found.buckets
    if (!buckets.length) return { status: 'empty', value: null, badBuckets: found.bad }
    fallbackBuckets = buckets
    const { value, report } = mergeLegacyBuckets(buckets, { config, providerRow, now })
    // 备份先于写入：算法万一有 bug，原件还在，可以重算
    let backups = 0
    for (const bucket of buckets) {
      await client.set(legacyBackupKeyOf(bucket.parsed), JSON.stringify(bucket.value), { EX: LEGACY_TTL_SECONDS })
      backups += 1
    }
    // 合并结果单次 SET：不存在「写了一半」的中间态
    await client.set(targetKey, JSON.stringify(value), config?.conversationPreserveTime > 0 ? { EX: config.conversationPreserveTime } : {})
    // 旧键不删，只置短 TTL：回滚后旧代码立刻又能读到
    for (const bucket of buckets) await client.expire(bucket.key, LEGACY_TTL_SECONDS)
    const receipt = { ...report, badBuckets: found.bad, backups }
    await writeReport(client, scope, receipt)
    return { status: 'migrated', value, report: receipt, badBuckets: found.bad }
  } catch (err) {
    errorLog(`scope ${scope} 迁移失败，内存合并旧桶继续对话`, err)
    // 同样必须带 schema：裸旧桶值被写回后，下一轮会把它当「未迁移」再合并一遍，覆盖本轮发言
    return { status: 'fallback', value: fallbackValueFrom(fallbackBuckets, { config, providerRow, now }), badBuckets: preview.bad }
  } finally {
    await releaseLock(client, lockKey)
  }
}

/**
 * 读会话的唯一入口：新键优先，未命中则懒迁移。
 *
 * `isNewConversation` 的口径：**只有「新键不存在且一个旧桶都没有」才算首轮**。
 * 归并成功一律视为续接，否则 `when:"session"` 的上下文注入会在老用户身上误触发。
 *
 * @param {{ scope: string, client: object, config: object, providerRow?: object }} options
 * @returns {Promise<{ value: object | null, isNewConversation: boolean, status: string }>}
 */
export async function loadConversation({ scope, client, config, providerRow = null }) {
  const result = await ensureMigratedScope({ scope, client, config, providerRow })
  const hasHistory = Boolean(result.value && Array.isArray(result.value.messages) && result.value.messages.length > 0)
  return { value: result.value, isNewConversation: !hasHistory, status: result.status }
}

/**
 * 清空一个 scope 的历史：新键 + 该 scope 的全部旧 V2 桶。
 *
 * **删键必须连旧桶一起删，否则懒迁移会复活**：读取路径（`ensureMigratedScope`）在新键缺失时
 * 会自动把旧桶合并回来。只删新键的话，用户清空后说的下一句话就把整段历史搬回新键，
 * 「清空」这个指令等于从未生效过。
 *
 * 备份键（`..._BAK:*`）、迁移锁、迁移报告一律不动：它们不是读路径的数据源，删掉只会丢回滚抓手。
 *
 * @param {{ client: object, scope: string }} options
 * @returns {Promise<number>} 实际删除的键数
 */
export async function clearScopeHistory({ client, scope } = {}) {
  const targetKey = conversationKeyOf(scope)
  if (!targetKey) return 0
  let deleted = await safeDel(client, targetKey)
  const keys = await listKeys(client, legacyKeyPatternForScope(scope))
  for (const key of keys || []) deleted += await safeDel(client, key)
  return deleted
}

/**
 * 清空全库历史：所有 V3 键 + 所有旧 V2 桶（`#结束全部对话`）。
 *
 * 与 `clearScopeHistory` 同样的理由：只扫 V3 前缀的话，旧桶会在下一个 scope 开口时被懒迁移搬回来。
 * 只认「会话历史」这两个前缀，因此 `_BAK`、迁移锁、报告、BING 键族都不会被误吞。
 *
 * @param {{ client: object }} options
 * @returns {Promise<{ conversations: number, legacy: number }>} 两个数分开报，回执才答得出「清了多少」
 */
export async function clearAllHistory({ client } = {}) {
  const result = { conversations: 0, legacy: 0 }
  const v3Keys = await listKeys(client, conversationScanPattern())
  for (const key of v3Keys || []) result.conversations += await safeDel(client, key)
  const legacyKeys = await listKeys(client, legacyKeyPatternAll())
  for (const key of legacyKeys || []) result.legacy += await safeDel(client, key)
  return result
}

/**
 * 主人指令 `#迁移会话` 的全量迁移。
 *
 * 只扫旧桶前缀，因此备份键、迁移锁、报告键、BING 键族都不会被误吞。
 *
 * @param {{ client: object, config: object, providerRowFor?: (scope: string) => object, onProgress?: (payload: object) => void }} options
 * @returns {Promise<{ scannedKeys: number, scopes: number, migrated: number, skipped: number, failed: number, mergedMessages: number, badBuckets: number, backups: number, cappedTo: number, stripped: number }>}
 */
export async function migrateAllScopes({ client, config, providerRowFor, onProgress } = {}) {
  const summary = {
    scannedKeys: 0, scopes: 0, migrated: 0, skipped: 0, failed: 0,
    mergedMessages: 0, badBuckets: 0, backups: 0, cappedTo: 0, stripped: 0
  }
  const keys = await listKeys(client, legacyKeyPatternAll())
  if (!keys) return summary
  summary.scannedKeys = keys.length
  const scopes = [...new Set(keys.map(key => parseLegacyKey(key)?.scope).filter(Boolean))]
  summary.scopes = scopes.length

  const guardKey = `${MIGRATION_LOCK_PREFIX}:__all__`
  if (!await acquireLock(client, guardKey)) {
    throw new Error('已有一个全量迁移在跑，等它结束或等 30 秒锁过期')
  }
  try {
    for (const [index, scope] of scopes.entries()) {
      const result = await ensureMigratedScope({ scope, client, config, providerRow: providerRowFor?.(scope) || null })
      summary.badBuckets += result.badBuckets || 0
      if (result.status === 'migrated') {
        summary.migrated += 1
        summary.mergedMessages += result.report?.mergedMessages || 0
        summary.backups += result.report?.backups || 0
        summary.cappedTo += result.report?.cappedTo || 0
        summary.stripped += result.report?.strippedMemoryBlocks || 0
      } else if (result.status === 'already' || result.status === 'empty') {
        summary.skipped += 1
      } else {
        summary.failed += 1
      }
      if (onProgress && (index + 1) % 50 === 0) onProgress({ ...summary, done: index + 1 })
    }
  } finally {
    await releaseLock(client, guardKey)
  }
  return summary
}
