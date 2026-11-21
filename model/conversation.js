import { conversationScope } from '../utils/conversationKey.js'
import { clearAllHistory, clearScopeHistory } from '../utils/conversationMigration.js'
import { providerLabel } from '../utils/providerProfiles.js'
import { getUin } from '../utils/common.js'
import { Config } from '../utils/config.js'

export const originalValues = ['克劳德', 'api', 'API', 'responses', 'Responses', 'glm', '双子星', '双子座']

export class ConversationManager {
  async endConversation(e, row = this.sessionProfileFor(e)) {
    const ats = (e.message || []).filter(m => m.type === 'at' && String(m.qq) !== String(getUin(e)))
    if (ats.length && !e.isMaster) { await this.reply('只有主人可以结束他人的对话'); return }
    const scope = conversationScope(e, Config.groupMerge, ats[0]?.qq)
    if (!scope) { await this.reply('取不到会话身份，无法结束对话', true); return }
    // 新键与旧 V2 桶必须一起删：只删新键的话，下一句话会触发懒迁移把历史整段搬回来
    await clearScopeHistory({ client: redis, scope })
    await this.reply(`${providerLabel(row)} 对话已结束`, true)
  }

  /**
   * `#结束全部对话` / `#结束全部模式对话` / `#结束全部模型对话` —— **一律扫全库**。
   *
   * 「只清当前这一个 scope」由 `#结束对话`（`endConversation`）承担，这里不再重复一遍：
   * 两个指令干同一件事时，名字里那个「全部」就是假话。
   *
   * 经验（别再踩）：**不能拿「消息里有没有『全部』」当判据**。指令名本身就叫「结束全部对话」，
   * 那个判据恒为真，所以历史上写的「只清当前通道条目的会话」分支从未被执行过。
   * 结论不是拆语义，而是承认只有全库这一种含义。
   *
   * 风险提示（既有行为，本次**不改变**）：这条指令一按就清全站，主人很容易以为只清了自己。
   * `isMaster` 护栏是唯一的闸，别删。
   */
  async endAllConversations(e) {
    if (!e.isMaster) { await this.reply('只有主人可以结束全部会话'); return }
    // 全库语义：V3 与旧 V2 两个前缀都要扫，只扫 V3 会让旧桶在下一轮被懒迁移复活
    const { conversations, legacy } = await clearAllHistory({ client: redis })
    await this.reply(`已结束 ${conversations} 个会话（含 ${legacy} 个旧会话桶）`, false)
  }
}
