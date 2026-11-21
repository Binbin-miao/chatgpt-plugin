import plugin from '../../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import {
  REQUIRED_MODULES,
  UPDATE_LOCK_KEY,
  UPDATE_LOCK_TTL_SECONDS,
  evaluateUpdate,
  pickInstaller,
  validateConfig
} from '../utils/updateGuard.js'
import {
  backupConfig,
  probeInstallers,
  probeModuleGates,
  probeWorkTree,
  readConfigText,
  restoreConfig,
  runCommand,
  shortHead
} from '../utils/updateProbe.js'

/** 默认插件目录（Yunzai 约定）；测试可覆盖成临时目录 */
const DEFAULT_PLUGIN_DIR = './plugins/chatgpt-plugin/'

// 进程内快速防重入（跨进程/跨重启靠 Redis 锁）
let uping = false

/**
 * 处理插件更新
 */
export class Update extends plugin {
  constructor() {
    super({
      name: 'chatgpt更新插件',
      event: 'message',
      priority: 1000,
      rule: [
        {
          reg: '^#(chatgpt|柴特寄批踢|GPT|ChatGPT|柴特鸡批踢|Chat|CHAT|CHATGPT|柴特|ChatGPT-Plugin|ChatGPT-plugin|chatgpt-plugin)((插件)?(强制)?更新| update)(\\s*(v2|dev|DEV|main|MAIN))?$',
          fnc: 'update'
        }
      ]
    })
  }

  /** 插件目录；测试可覆盖成临时目录 */
  get pluginDir() {
    return this._pluginDir || DEFAULT_PLUGIN_DIR
  }

  set pluginDir(value) {
    this._pluginDir = value
  }

  /**
   * rule - 更新chatgpt插件
   */
  async update() {
    if (!this.e.isMaster) return false
    if (uping) {
      await this.reply('已有命令更新中..请勿重复操作')
      return false
    }

    const dir = this.pluginDir

    /** 不是 git 工作树就一条写操作都不做：在后面 reset/clean 会毁掉一个手工安装的目录 */
    const workTree = await probeWorkTree(dir)
    if (!workTree.isWorkTree) {
      await this.reply(workTree.missingCommand
        ? '更新失败：本机没有找到 git 命令，无法更新。请按 README 重新安装插件。'
        : `更新失败：${dir} 不是 git 仓库，无法用更新指令升级。请按 README 重新安装插件（重装前先备份 config/ 与 data/）。`)
      return false
    }

    /**
     * 跨进程/跨重启的更新锁。检查点放在权限之后、任何写操作之前：
     * 装依赖那几分钟里别人再发一次指令，会并发跑第二份 npm install 把 node_modules 写坏。
     */
    const locked = await this.tryLock()
    if (!locked) {
      await this.reply('正在更新中，请等当前更新结束后再试')
      return false
    }

    uping = true
    this.isUp = false
    /** 流程是否正常走完（B 象限也算走完，但它不需要重启，所以与 isUp 分开） */
    let flowOk = false
    try {
      const isForce = this.e.msg.includes('强制')
      const isDevUpdate = this.e.msg.includes('dev') || this.e.msg.includes('DEV')
      const isMainUpdate = this.e.msg.includes('main') || this.e.msg.includes('MAIN') || this.e.msg.includes('v2')
      flowOk = await this.runUpdate(isForce, isDevUpdate, isMainUpdate)
    } finally {
      uping = false
      await this.releaseLock()
      /**
       * `isUp` 只在全流程成功后才为真（git → 装依赖 → 自检 → 配置校验），
       * 原来「依赖装失败也置 true」正是带着坏依赖重启、插件起不来的直接原因。
       */
      if (this.isUp) {
        await this.reply('更新完成，即将重启（约 2 秒）。重启期间消息可能丢失，请稍后重发。')
        setTimeout(() => this.restart(), 2000)
      }
    }
    return flowOk === true
  }

  /**
   * 重启宿主。
   *
   * 用动态 import：`other/restart.js` 属于**宿主机**（Yunzai）而不是本插件，
   * 顶层静态 import 会让「只想复用更新判定」的调用方（以及单测）连模块都加载不了；
   * 而且真出问题时应该记日志，不是让一个未捕获的 rejection 静默丢掉。
   */
  async restart() {
    try {
      const { Restart } = await import('../../other/restart.js')
      new Restart(this.e).restart()
    } catch (err) {
      logger.error(`[chatgpt-plugin] 重启失败，请手动重启宿主：${err?.message || err}`)
    }
  }

  /** 抢更新锁：SET NX EX，一条命令完成「不存在才写 + 过期释放」 */
  async tryLock() {
    try {
      return Boolean(await redis.set(UPDATE_LOCK_KEY, String(Date.now()), { NX: true, EX: UPDATE_LOCK_TTL_SECONDS }))
    } catch (err) {
      logger.warn(`[chatgpt-plugin] 获取更新锁失败，按未占用处理：${err?.message || err}`)
      return true
    }
  }

  async releaseLock() {
    try {
      await redis.del(UPDATE_LOCK_KEY)
    } catch (err) {
      logger.warn(`[chatgpt-plugin] 释放更新锁失败（TTL 到期会自动释放）：${err?.message || err}`)
    }
  }

  /**
   * 更新主流程：备份配置 → git → 门1/门2 → 四象限 → 装依赖 → 自检 → 配置校验。
   *
   * @param {boolean} isForce 强制更新（reset --hard @{u}）
   * @param {boolean} isDevUpdate 更新 dev
   * @param {boolean} isMainUpdate 更新 v2/main
   */
  async runUpdate(isForce, isDevUpdate, isMainUpdate) {
    const dir = this.pluginDir
    const version = await this.pluginVersion()
    /** 回显与 getLog 截断都靠它；本次不 bump 版本号，hash 是唯一能区分「拉没拉到修复」的东西 */
    const oldHash = await shortHead(dir)
    this.oldCommitId = oldHash
    const beforeConfig = await readConfigText(dir)
    const configBackup = await backupConfig(dir)
    await this.reply(this.startMessage(isForce, isForce && isDevUpdate ? 'dev' : isForce && isMainUpdate ? 'v2' : ''))

    const git = await this.gitUpdate({ isForce, isDevUpdate, isMainUpdate })
    if (!git.ok) {
      // 什么都没拉到：不需要回滚，回滚到当前 commit 是空动作
      logger.mark(`${this.e.logFnc} 更新失败：chatgpt-plugin`)
      await this.gitErr(new Error(git.stderr || 'git 更新失败'), git.stdout)
      return false
    }

    const newHash = await shortHead(dir)
    const gates = await probeModuleGates(dir, REQUIRED_MODULES)
    const outcome = evaluateUpdate({
      filesPresent: gates.filesPresent,
      filesImportable: gates.filesImportable,
      missing: gates.missing,
      degraded: gates.degraded,
      oldHash,
      newHash,
      version
    })

    /** B：已在修复版上——不装依赖、不重启，只回一句 */
    if (outcome.action === 'noop') {
      await this.reply(outcome.message)
      return true
    }

    /** D：与远端一致但不含修复——不回滚（reset 到同一 commit 是空动作），只报告 */
    if (outcome.action === 'report') {
      await this.reply(outcome.message)
      return false
    }

    /** C：拉到了别的东西——回滚到旧 commit，并把缺哪些文件列清楚 */
    if (outcome.action === 'rollback') {
      await this.rollbackTo(oldHash, configBackup, outcome.message)
      return false
    }

    /** A：真拉到修复版 → 装依赖（失败即回滚，绝不置 isUp） */
    const installer = pickInstaller(await probeInstallers(dir))
    logger.mark(`[chatgpt-plugin] 安装依赖：${installer.manager} ${installer.args.join(' ')}（${installer.reason}）`)
    const install = await runCommand(dir, installer.manager, installer.args)
    if (!install.ok) {
      const reason = `依赖安装失败（${installer.manager} ${installer.args.join(' ')}）：${(install.stderr || '').slice(0, 300)}`
      logger.error(`[chatgpt-plugin] ${reason}`)
      await this.rollbackTo(oldHash, configBackup, reason)
      return false
    }
    logger.mark('[chatgpt-plugin] 依赖安装成功')

    /** 装完依赖再自检一遍：否则「缺依赖」和「没拉到修复」分不清 */
    const recheck = await probeModuleGates(dir, REQUIRED_MODULES)
    if (!recheck.filesPresent || !recheck.filesImportable) {
      const gap = recheck.missing.length ? recheck.missing.join('、') : recheck.failures.map(item => item.file).join('、')
      await this.rollbackTo(oldHash, configBackup, `装完依赖后自检失败（${gap}）`)
      return false
    }

    /** 配置只做「读 + 备份 + 比对」，不一致只告警并指向备份，绝不改写 */
    const configCheck = validateConfig(beforeConfig, await readConfigText(dir))
    if (!configCheck.ok) {
      const detail = configCheck.problems.map(item => item.message).join('；')
      await this.reply(`⚠️ ${detail}\n备份在：${configBackup || '（本次未备份：更新前没有 config/config.json）'}\n（不会自动改回配置，请主人确认后再决定）`)
    }

    this.isUp = true
    await this.reply(outcome.message)
    const log = await this.getLog('chatgpt-plugin')
    if (log) await this.reply(log)
    return true
  }

  /** 开场提示：告诉用户正在对哪个分支做什么 */
  startMessage(isForce, branch) {
    if (!isForce) return '正在执行更新操作，请稍等（会自动备份配置）'
    if (branch) return `正在执行 ${branch} 分支强制更新操作，请稍等（会自动备份配置）`
    return '正在执行强制更新操作，请稍等（会自动备份配置）'
  }

  /**
   * 拼 git 更新命令。
   *
   * `clean -fd` 一律带 `-e config/`：即使 `config/*` 现在被 ignore、`clean` 不带 `-x` 本就不会删它，
   * 这也是防御性写法——哪天有人为了打包把 config 从 ignore 挪出来，这条不会顺手删掉 78 个顶层键。
   */
  async gitUpdate({ isForce, isDevUpdate, isMainUpdate }) {
    const dir = this.pluginDir
    if (!isForce) return await runCommand(dir, 'git', ['pull', '--no-rebase'])

    const steps = [
      ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ['fetch', 'origin'],
      ['reset', '--hard', 'HEAD'],
      ['clean', '-fd', '-e', 'config/']
    ]
    const branch = isDevUpdate ? 'dev' : isMainUpdate ? 'v2' : ''
    if (branch) steps.push(['checkout', branch])
    steps.push(['fetch', '--all'], ['reset', '--hard', branch ? `origin/${branch}` : '@{u}'])

    let stdout = ''
    let stderr = ''
    for (const args of steps) {
      const ret = await runCommand(dir, 'git', args)
      stdout += ret.stdout
      stderr += ret.stderr
      if (!ret.ok) return { ok: false, stdout, stderr: stderr || ret.stderr }
    }
    return { ok: true, stdout, stderr }
  }

  /**
   * 回滚：git reset --hard 旧 commit → 恢复配置备份 → 报错。
   *
   * 不重装依赖（运行中的进程用的是已加载的旧模块），也不再 clean（会二次破坏）。
   * 回滚本身失败时把实际 HEAD 与手工命令一起发出去，并保持不重启。
   */
  async rollbackTo(oldHash, configBackup, reason) {
    const dir = this.pluginDir
    const ret = await runCommand(dir, 'git', ['reset', '--hard', oldHash])
    if (!ret.ok) {
      const actual = await shortHead(dir)
      await this.reply([
        '回滚失败，请手动处理（本次不会重启）。',
        `当前 HEAD = ${actual || '（取不到）'}，期望为 ${oldHash}`,
        `请在该目录执行：git reset --hard ${oldHash}`,
        `配置备份：${configBackup || '（本次未备份）'}`,
        ret.stderr
      ].join('\n'))
      return false
    }
    await restoreConfig(dir, configBackup)
    await this.reply(`${reason}\n已回滚到 ${oldHash}${configBackup ? `\n配置备份：${configBackup}` : ''}`)
    return true
  }

  /** 插件版本号（只读，不改写 package.json） */
  async pluginVersion() {
    try {
      const raw = await fs.promises.readFile(path.join(this.pluginDir, 'package.json'), 'utf8')
      return JSON.parse(raw).version || ''
    } catch {
      return ''
    }
  }

  /**
   * 获取chatgpt-plugin的更新日志
   * @param {string} plugin 插件名称
   */
  async getLog(pluginName = '') {
    const dir = pluginName ? path.join(path.dirname(this.pluginDir.replace(/[\\/]+$/, '')), pluginName) : this.pluginDir
    const ret = await runCommand(dir, 'git', ['log', '-20', '--oneline', '--pretty=format:%h||[%cd] %s', '--date=format:%m-%d %H:%M'])
    if (!ret.ok || !ret.stdout) return false

    const lines = []
    for (const row of ret.stdout.split('\n')) {
      const [hash, text] = row.split('||')
      if (hash === this.oldCommitId) break
      if (!text || text.includes('Merge branch')) continue
      lines.push(text)
    }
    if (!lines.length) return ''

    const end = '更多详细信息，请前往github查看\nhttps://github.com/misaka20002/chatgpt-plugin/commits/v2'
    return await this.makeForwardMsg(`chatgpt-plugin更新日志，共${lines.length}条`, lines.join('\n\n'), end)
  }

  /**
   * 制作转发消息
   * @param {string} title 标题 - 首条消息
   * @param {string} msg 日志信息
   * @param {string} end 最后一条信息
   */
  async makeForwardMsg(title, msg, end) {
    let nickname = (this.e.bot ?? Bot).nickname
    if (this.e.isGroup) {
      let info = await (this.e.bot ?? Bot).getGroupMemberInfo?.(this.e.group_id, (this.e.bot ?? Bot).uin) || await (this.e.bot ?? Bot).pickMember?.(this.e.group_id, (this.e.bot ?? Bot).uin)
      nickname = info.card || info.nickname
    }
    let userInfo = {
      user_id: (this.e.bot ?? Bot).uin,
      nickname
    }

    let forwardMsg = [
      { ...userInfo, message: title },
      { ...userInfo, message: msg }
    ]

    if (end) forwardMsg.push({ ...userInfo, message: end })

    /** 制作转发内容 */
    if (this.e.group?.makeForwardMsg) {
      forwardMsg = await this.e.group.makeForwardMsg(forwardMsg)
    } else if (this.e?.friend?.makeForwardMsg) {
      forwardMsg = await this.e.friend.makeForwardMsg(forwardMsg)
    } else {
      return msg
    }

    let dec = 'chatgpt-plugin 更新日志'
    /** 处理描述 */
    if (typeof (forwardMsg.data) === 'object') {
      let detail = forwardMsg.data?.meta?.detail
      if (detail) detail.news = [{ text: dec }]
    } else {
      forwardMsg.data = forwardMsg.data
        .replace(/\n/g, '')
        .replace(/<title color="#777777" size="26">(.+?)<\/title>/g, '___')
        .replace(/___+/, `<title color="#777777" size="26">${dec}</title>`)
    }

    return forwardMsg
  }

  /**
   * 处理更新失败的相关函数
   * @param {Error} err
   * @param {string} stdout
   */
  async gitErr(err, stdout = '') {
    let msg = '更新失败！'
    let errMsg = String(err?.message ?? err ?? '')
    stdout = String(stdout || '')

    if (errMsg.includes('Timed out')) {
      const remote = errMsg.match(/'(.+?)'/)?.[0]?.replace(/'/g, '') || '远端'
      await this.reply(msg + `\n连接超时：${remote}`)
      return
    }

    if (/Failed to connect|unable to access/g.test(errMsg)) {
      const remote = errMsg.match(/'(.+?)'/)?.[0]?.replace(/'/g, '') || '远端'
      await this.reply(msg + `\n连接失败：${remote}`)
      return
    }

    await this.reply([errMsg, stdout, '\n若存在git冲突，可尝试执行#chatgpt强制更新'].filter(Boolean).join('\n'))
  }
}
