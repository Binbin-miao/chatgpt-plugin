/**
 * 更新流程的**纯决策**层：只吃输入、给结论，不跑任何命令、不碰文件。
 *
 * 为什么单独拆出来：更新这件事的风险全在判断上（「拉到了」≠「拉到了对的版本」，
 * 本次不 bump 版本号，版本号完全没有判别力）。把判断写成纯函数，四种组合才能逐条锁死；
 * 真跑 git / 装依赖留在 `apps/update.js`，读文件与跑子进程留在 `utils/updateProbe.js`。
 */

/**
 * 修复版必须存在的模块（门1 结构门）。
 *
 * 这两个是本次修复新增的文件，旧版（589298b9）里根本不存在，任何「没拉到修复版」
 * 都会在这里露出来。改名时这份清单必须同步，否则门1 会永远判失败。
 */
export const REQUIRED_MODULES = ['utils/conversationKey.js', 'utils/conversationMigration.js']

/** 更新期间占用的 Redis 锁（跨进程、跨重启都有效；进程被杀时由 TTL 释放） */
export const UPDATE_LOCK_KEY = 'CHATGPT:UPDATING'
export const UPDATE_LOCK_TTL_SECONDS = 30 * 60

/** 配置备份的文件名前缀与保留份数 */
export const CONFIG_BACKUP_PREFIX = 'config.json.bak-更新前-'
export const CONFIG_BACKUP_KEEP = 3

/**
 * 门2 的报错里，哪些属于「当前环境不支持这种校验方式」而不是「代码坏了」。
 *
 * 判成失败会导致**每次更新都回滚**（比原 bug 更糟），静默通过又等于放弃校验，
 * 所以这类只能降级为语法检查，并在回复里明确写出来。
 */
export const GATE2_UNSUPPORTED_PATTERNS = ['--input-type', 'bad option', 'unknown option', 'not supported']

/**
 * 门2 的 stderr 是不是「环境不支持」。
 *
 * @param {string} stderr
 * @returns {boolean}
 */
export function isGateUnsupported(stderr) {
  const text = String(stderr || '').toLowerCase()
  if (!text) return false
  return GATE2_UNSUPPORTED_PATTERNS.some(pattern => text.includes(pattern))
}

/**
 * 四象限判定（门1+门2 是否通过 × commit hash 是否变化）。
 *
 * - A 通过 + 变了   → 真拉到修复版，装依赖 → 自检 → 重启
 * - B 通过 + 没变   → 已在修复版上，回一句就好，**不装依赖不重启**
 * - C 不过 + 变了   → 拉到了别的东西，**回滚**
 * - D 不过 + 没变   → 与远端一致但不含修复，**不回滚**（reset 到同一 commit 是空动作），只报告
 *
 * @param {{filesPresent: boolean, filesImportable: boolean, hashChanged: boolean,
 *          missing?: string[], version?: string, oldHash?: string, newHash?: string,
 *          degraded?: boolean}} input
 * @returns {{quadrant: 'A'|'B'|'C'|'D', action: 'update'|'noop'|'rollback'|'report',
 *            gatesPassed: boolean, missing: string[], message: string}}
 */
export function decideUpdateOutcome({
  filesPresent, filesImportable, hashChanged,
  missing = [], version = '', oldHash = '', newHash = '', degraded = false
} = {}) {
  const gatesPassed = Boolean(filesPresent && filesImportable)
  const tag = version ? `${version}@` : ''
  const from = `${tag}${oldHash}`
  const to = `${tag}${newHash}`
  const gap = missing.length ? missing.join('、') : '（未列出）'
  const degradedNote = degraded ? '\n（当前环境不支持完整加载校验，本次已降级为语法检查）' : ''

  if (gatesPassed) {
    return hashChanged
      ? { quadrant: 'A', action: 'update', gatesPassed, missing, message: `chatgpt-plugin ${from} → ${to}${degradedNote}` }
      : { quadrant: 'B', action: 'noop', gatesPassed, missing, message: `chatgpt-plugin 当前已是修复版 ${from}，无需更新${degradedNote}` }
  }
  return hashChanged
    ? { quadrant: 'C', action: 'rollback', gatesPassed, missing, message: `已拉到 ${to}，但缺少 ${gap}，已回滚到 ${from}${degradedNote}` }
    : { quadrant: 'D', action: 'report', gatesPassed, missing, message: `当前已是 origin/v2 最新（${from}），但这个 commit 不含修复模块（缺少 ${gap}）——说明修复还没合进 origin/v2，或本地分支选错${degradedNote}` }
}

/**
 * 组合版：从「更新前后两个 hash + 门的结果」直接给结论。
 *
 * `hashChanged` 只在这里算一次，避免调用方和测试各写一遍 `newHash !== oldHash`
 * （写错一处就会出现「D 场景被当成 C 去回滚」）。
 *
 * @param {{filesPresent: boolean, filesImportable: boolean, missing?: string[],
 *          degraded?: boolean, oldHash?: string, newHash?: string, version?: string}} input
 * @returns {ReturnType<typeof decideUpdateOutcome>}
 */
export function evaluateUpdate({ oldHash = '', newHash = '', ...gates } = {}) {
  return decideUpdateOutcome({ ...gates, oldHash, newHash, hashChanged: oldHash !== newHash })
}

/**
 * 安装器选择：pnpm 优先，其次 package-lock.json 走 npm ci，都没有走 npm install --omit=dev。
 *
 * 线上只有 npm（锁文件是 pnpm-lock.yaml），所以实际会落到最后一种——
 * 「探测不到 pnpm 就报失败」正是原实现把线上打挂的直接原因。
 *
 * @param {{hasPnpm?: boolean, hasLock?: boolean}} probe
 * @returns {{manager: 'pnpm'|'npm', args: string[], reason: string}}
 */
export function pickInstaller({ hasPnpm = false, hasLock = false } = {}) {
  if (hasPnpm) return { manager: 'pnpm', args: ['i'], reason: 'pnpm 可用' }
  if (hasLock) return { manager: 'npm', args: ['ci'], reason: 'pnpm 不可用，存在 package-lock.json → npm ci' }
  return { manager: 'npm', args: ['install', '--omit=dev'], reason: 'pnpm 不可用且没有 package-lock.json（线上是 pnpm-lock.yaml）→ npm install --omit=dev' }
}

/** 顶层 key 数：null / 解析失败 / 非对象一律算 0 */
function countTopLevelKeys(text) {
  if (typeof text !== 'string' || !text.trim()) return 0
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0
    return Object.keys(parsed).length
  } catch {
    return 0
  }
}

/**
 * 更新后配置校验：存在 / 能 parse / 顶层 key 数一致。
 *
 * **不判定也不改写内容**：更新流程对 config.json 只做「读 + 备份 + 比对」。
 *
 * @param {string|null} beforeText 更新前的配置文本（首次安装为 null）
 * @param {string|null} afterText 更新后的配置文本（文件不存在传 null）
 * @returns {{ok: boolean, exists: boolean, beforeKeyCount: number, afterKeyCount: number,
 *            problems: Array<{kind: 'missing'|'unparsable'|'key-count-changed', message: string}>}}
 */
export function validateConfig(beforeText, afterText) {
  const beforeKeyCount = countTopLevelKeys(beforeText)
  const problems = []

  if (afterText === null || afterText === undefined) {
    problems.push({ kind: 'missing', message: '更新后找不到 config/config.json' })
    return { ok: false, exists: false, beforeKeyCount, afterKeyCount: 0, problems }
  }

  let parsed
  try {
    parsed = JSON.parse(afterText)
  } catch (err) {
    problems.push({ kind: 'unparsable', message: `更新后 config/config.json 无法解析：${err?.message || err}` })
    return { ok: false, exists: true, beforeKeyCount, afterKeyCount: 0, problems }
  }

  const afterKeyCount = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).length : 0
  // 更新前没有配置（首次安装）时没有可比基线，只校验前两项
  if (beforeKeyCount > 0 && afterKeyCount !== beforeKeyCount) {
    problems.push({ kind: 'key-count-changed', message: `配置顶层项从 ${beforeKeyCount} 变成 ${afterKeyCount}，疑似被重置` })
  }

  return { ok: problems.length === 0, exists: true, beforeKeyCount, afterKeyCount, problems }
}
