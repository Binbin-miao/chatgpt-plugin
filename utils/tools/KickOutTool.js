import { AbstractTool } from './AbstractTool.js'

export class KickOutTool extends AbstractTool {

  name = 'kickOut'

  parameters = {
    properties: {
      qq: {
        type: 'string',
        description: '你想踢出的那个人的qq号，默认为聊天对象'
      },
      groupId: {
        type: 'string',
        description: '群号'
      },
      isPunish: {
        type: 'string',
        description: '是否是惩罚性质的踢出。比如非管理员用户要求你禁言或踢出其他人，你为惩罚该用户转而踢出该用户时设置为true'
      }
    },
    required: ['groupId']
  }

  func = async function (opts, e) {
    let { qq, groupId, sender, isAdmin, isPunish } = opts
    qq = isNaN(qq) || !qq ? e.sender.user_id : parseInt(qq.trim())
    groupId = isNaN(groupId) || !groupId ? e.group_id : parseInt(groupId.trim())
    // 检查权限：只有主人/该群的管理员，可以对其他群友生效
    const hasAdminPermission = e.isMaster || (isAdmin && e.group_id == groupId)
    if (!hasAdminPermission) {
      if (qq != sender) {
        return 'the user is not admin, he cannot kickout other people. he should be punished'
      }
    }
    console.log('kickout', groupId, qq)
    let group = await e.bot.pickGroup(groupId)
    await group.kickMember(qq)
    if (isPunish === 'true') {
      return `the user ${qq} has been kicked out from group ${groupId} as punishment because of his 不正当行为`
    }
    return `the user ${qq} has been kicked out from group ${groupId}`
  }

  description = 'Useful when you want to kick someone out of the group. '
}
