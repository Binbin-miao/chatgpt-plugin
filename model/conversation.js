import { providerConversationKey } from '../utils/providers.js'
import { providerLabel } from '../utils/providerProfiles.js'
import { getUin } from '../utils/common.js'
import { Config } from '../utils/config.js'

export const originalValues = ['克劳德', 'api', 'API', 'responses', 'Responses', 'glm', '双子星', '双子座']

export class ConversationManager {
  async endConversation(e, row = this.sessionProfileFor(e)) {
    const ats = (e.message || []).filter(m => m.type === 'at' && String(m.qq) !== String(getUin(e)))
    if (ats.length && !e.isMaster) { await this.reply('只有主人可以结束他人的对话'); return }
    const scope = e.isGroup && Config.groupMerge ? String(e.group_id) : ats[0]?.qq || e.sender.user_id
    await redis.del(providerConversationKey(row, scope))
    await this.reply(`${providerLabel(row)} 对话已结束`, true)
  }

  async endAllConversations(e) {
    if (!e.isMaster) { await this.reply('只有主人可以结束全部会话'); return }
    const all = /全部|所有|全模式/.test(e.msg)
    // 只结束当前会话所属条目的会话（与 abstractChat 同一套分流判定）：分流群里这条指令
    // 若按全局默认算，扫到的是别的条目的 key，自己的会话反而留着
    const pattern = all ? 'CHATGPT:CONVERSATIONS_V2:*' : `CHATGPT:CONVERSATIONS_V2:${this.sessionProfileFor(e).id}:*`
    let count = 0
    for await (const key of redis.scanIterator({ MATCH: pattern })) count += await redis.del(key)
    await this.reply(`已结束 ${count} 个会话`, false)
  }
}
