/**
 * 更新流程的**探测**层：跑命令、读文件，只回报事实，不做判断。
 *
 * 与 `utils/updateGuard.js` 的分工：这里回答「文件在不在 / 能不能加载 / HEAD 是哪个」，
 * 判断「算不算修复版、要不要回滚」全在纯模块里。这样集成测试不用起 Yunzai 就能跑真实目录。
 *
 * 所有命令都用 args 数组调起（不经 shell）：路径里带空格、目录名带引号都不会被拆词。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

import { CONFIG_BACKUP_KEEP, CONFIG_BACKUP_PREFIX, isGateUnsupported } from './updateGuard.js'

/**
 * 跑一条命令，永远 resolve，把结果折成事实。
 *
 * @param {string} cwd 工作目录
 * @param {string} command 可执行文件
 * @param {string[]} args
 * @param {{timeout?: number}} [options]
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, missingCommand: boolean}>}
 */
export function runCommand(cwd, command, args = [], { timeout = 10 * 60 * 1000 } = {}) {
  return new Promise(resolve => {
    execFile(command, args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : (error ? null : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || '') || (error ? String(error.message || '') : ''),
        // ENOENT = 命令根本不存在：这是「可回落」，与「命令存在但跑失败」处置完全不同
        missingCommand: Boolean(error && error.code === 'ENOENT')
      })
    })
  })
}

/**
 * 目标目录是不是 git 工作树。
 *
 * 只认 `rev-parse` 的结论，不看 git 二进制在不在——装目录不是仓库时后续所有写操作都该拒绝。
 *
 * @param {string} pluginDir
 * @returns {Promise<{ok: boolean, isWorkTree: boolean, missingCommand: boolean, detail: string}>}
 */
export async function probeWorkTree(pluginDir) {
  const ret = await runCommand(pluginDir, 'git', ['rev-parse', '--is-inside-work-tree'])
  if (ret.missingCommand) return { ok: false, isWorkTree: false, missingCommand: true, detail: '未找到 git 命令' }
  const isWorkTree = ret.ok && ret.stdout.trim() === 'true'
  return { ok: ret.ok, isWorkTree, missingCommand: false, detail: (ret.stderr || ret.stdout).trim() }
}

/** HEAD 短 hash；取不到返回空串（调用方据此判失败，不猜） */
export async function shortHead(pluginDir) {
  const ret = await runCommand(pluginDir, 'git', ['rev-parse', '--short', 'HEAD'])
  return ret.ok ? ret.stdout.trim() : ''
}

/**
 * 门1 + 门2：模块存在 + 能被独立加载。
 *
 * 门2 用 `node --input-type=module -e "await import(file://…)"`，能一次验证「语法正确 +
 * 内部 import 全可解析 + 没有把 Yunzai 运行时绑在顶层」。环境不支持这种校验时
 * （`bad option` 之类）降级为 `node --check`，并置 `degraded = true` 让上层如实告知。
 *
 * @param {string} pluginDir
 * @param {string[]} files 相对 pluginDir 的路径
 * @returns {Promise<{filesPresent: boolean, filesImportable: boolean, missing: string[], degraded: boolean, failures: Array<{file: string, detail: string}>}>}
 */
export async function probeModuleGates(pluginDir, files) {
  const missing = []
  const present = []
  for (const file of files) {
    const abs = path.join(pluginDir, file)
    if (fs.existsSync(abs)) present.push({ file, abs })
    else missing.push(file)
  }

  const failures = []
  let degraded = false
  for (const { file, abs } of present) {
    const url = new URL(`file://${abs.replace(/\\/g, '/')}`).href
    const ret = await runCommand(pluginDir, 'node', ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`])
    if (ret.ok) continue
    if (isGateUnsupported(ret.stderr)) {
      // 环境不支持这种校验：降级成语法检查，但绝不静默通过
      degraded = true
      const syntax = await runCommand(pluginDir, 'node', ['--check', abs])
      if (!syntax.ok) failures.push({ file, detail: (syntax.stderr || syntax.stdout).trim() })
      continue
    }
    failures.push({ file, detail: (ret.stderr || ret.stdout).trim() })
  }

  return {
    filesPresent: missing.length === 0,
    filesImportable: failures.length === 0,
    missing,
    degraded,
    failures
  }
}

/** 安装器探测：pnpm 可执行 + 是否存在 npm 的锁文件 */
export async function probeInstallers(pluginDir) {
  const pnpm = await runCommand(pluginDir, 'pnpm', ['--version'])
  return {
    hasPnpm: pnpm.ok,
    hasLock: fs.existsSync(path.join(pluginDir, 'package-lock.json'))
  }
}

/** 配置路径 */
export function configPathOf(pluginDir) {
  return path.join(pluginDir, 'config', 'config.json')
}

/** 读配置文本；文件不存在返回 null（首次安装是正常场景，不是错误） */
export async function readConfigText(pluginDir) {
  try {
    return await fs.promises.readFile(configPathOf(pluginDir), 'utf8')
  } catch {
    return null
  }
}

/** 北京时间戳 `YYYYMMDD-HHmmss`（与备份名一起构成可排序的时间序） */
export function backupStamp(now = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** 列出已有备份，新的在前 */
async function listConfigBackups(pluginDir) {
  const dir = path.dirname(configPathOf(pluginDir))
  let names = []
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return []
  }
  return names
    .filter(name => name.startsWith(CONFIG_BACKUP_PREFIX))
    .sort()
    .reverse()
    .map(name => path.join(dir, name))
}

/**
 * 更新前备份配置，并只保留最近 N 份。
 *
 * 配置不存在（首次安装）直接返回 null，不报错。
 *
 * @param {string} pluginDir
 * @param {{now?: Date, keep?: number}} [options]
 * @returns {Promise<string|null>} 备份文件绝对路径
 */
export async function backupConfig(pluginDir, { now = new Date(), keep = CONFIG_BACKUP_KEEP } = {}) {
  const source = configPathOf(pluginDir)
  if (!fs.existsSync(source)) return null
  const target = `${source}.bak-更新前-${backupStamp(now)}`
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.copyFile(source, target)
  const backups = await listConfigBackups(pluginDir)
  for (const stale of backups.slice(keep)) {
    try { await fs.promises.rm(stale, { force: true }) } catch { /* 清理失败不影响本次更新 */ }
  }
  return target
}

/** 把备份复制回 config.json（只在回滚时调用） */
export async function restoreConfig(pluginDir, backupPath) {
  if (!backupPath || !fs.existsSync(backupPath)) return false
  await fs.promises.copyFile(backupPath, configPathOf(pluginDir))
  return true
}
