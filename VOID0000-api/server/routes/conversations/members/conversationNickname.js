import { pool } from '../../../db.js';
import { EVENTS } from '../../../gateway/protocol.js';
import { sendLiveEventToUser } from '../../../gateway/client.js';
import { resolveMembershipConversation } from '../../../utils/groupMembership.js';
import { meetsWhoThreshold, resolvePermissions } from '../../../utils/groupPermissions.js';

const MAX_NICKNAME_LENGTH = 32;

export function registerConversationNicknameRoutes(router) {
  router.patch('/:targetUserId/conversation-nickname', async (req, res) => {
    const userId = req.user.id;
    const { conversationId, targetUserId } = req.params;
    const { nickname } = req.body;

    if (nickname !== null && nickname !== undefined && typeof nickname !== 'string') {
      return res.status(400).json({ error: 'Nickname must be a string or null' });
    }

    const trimmed = typeof nickname === 'string' ? nickname.trim() : null;
    const finalNickname = trimmed === '' ? null : trimmed;

    if (finalNickname && finalNickname.length > MAX_NICKNAME_LENGTH) {
      return res.status(400).json({ error: `Nickname must be ${MAX_NICKNAME_LENGTH} characters or fewer` });
    }

    try {
      const membershipConversation = await resolveMembershipConversation(pool, conversationId);
      if (!membershipConversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const actorCheck = await pool.query(
        `SELECT role FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2`,
        [membershipConversation.id, userId]
      );

      if (actorCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Not a member' });
      }

      const actorRole = actorCheck.rows[0].role;
      const isSelf = userId === targetUserId;

      if (membershipConversation.type === 'group') {
        const perms = resolvePermissions(membershipConversation.permissions);
        if (isSelf) {
          if (!meetsWhoThreshold(actorRole, perms.who_can_edit_own_nickname)) {
            return res.status(403).json({ error: 'You do not have permission to edit your own nickname' });
          }
        } else {
          if (!meetsWhoThreshold(actorRole, perms.who_can_edit_other_nicknames)) {
            return res.status(403).json({ error: 'You do not have permission to edit other members\' nicknames' });
          }
        }
      }

      const targetCheck = await pool.query(
        `SELECT role FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2`,
        [membershipConversation.id, targetUserId]
      );

      if (targetCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Target member not found' });
      }

      await pool.query(
        `UPDATE conversation_members SET nickname = $1
         WHERE conversation_id = $2 AND user_id = $3`,
        [finalNickname, membershipConversation.id, targetUserId]
      );

      const membersResult = await pool.query(
        `SELECT user_id
         FROM conversation_members
         WHERE conversation_id = $1`,
        [membershipConversation.id]
      );

      const payload = {
        conversation_id: membershipConversation.id,
        conversation_public_id: membershipConversation.public_id
          ? String(membershipConversation.public_id)
          : null,
        user_id: targetUserId,
        nickname: finalNickname,
      };

      membersResult.rows.forEach(({ user_id }) => {
        sendLiveEventToUser(user_id, EVENTS.MEMBER_NICKNAME_UPDATE, payload);
      });

      res.json({ success: true, nickname: finalNickname });
    } catch (err) {
      console.error('ConversationNickname PATCH error:', err);
      res.status(500).json({ error: 'Failed to update conversation nickname' });
    }
  });
}
