import { pool } from '../../../db.js';
import {
  emitConversationUpdate,
  getChildChannelIds,
  normalizeKeyVersion,
  resolveMembershipConversation,
} from '../../../utils/groupMembership.js';

export function registerMemberRoleRoutes(router) {
  router.put('/:targetUserId', async (req, res) => {
    const userId = req.user.id;
    const { conversationId, targetUserId } = req.params;
    const { role } = req.body;

    if (!role || !['admin', 'member'].includes(role)) {
      return res.status(400).json({ error: 'Valid role required: admin or member' });
    }

    try {
      const membershipConversation = await resolveMembershipConversation(pool, conversationId);
      if (!membershipConversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const actorCheck = await pool.query(
        `SELECT c.type, cm.role FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id
         WHERE c.id = $1 AND cm.user_id = $2`,
        [membershipConversation.id, userId]
      );

      if (actorCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Not a member' });
      }

      const actorRole = actorCheck.rows[0].role;
      if (!['owner', 'admin'].includes(actorRole)) {
        return res.status(403).json({ error: 'Only the owner or an admin can change roles' });
      }

      const targetMemberResult = await pool.query(
        `SELECT role
         FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2
         LIMIT 1`,
        [membershipConversation.id, targetUserId]
      );

      if (targetMemberResult.rows.length === 0) {
        return res.status(404).json({ error: 'Target member not found' });
      }

      const targetRole = targetMemberResult.rows[0].role;

      if (targetRole === 'owner') {
        return res.status(400).json({ error: 'Cannot change the owner role' });
      }

      if (actorRole === 'admin' && targetRole !== 'member' && targetRole !== 'viewer') {
        return res.status(403).json({
          error: 'Admins can only change regular member roles',
          code: 'TARGET_ROLE_PROTECTED',
        });
      }

      await pool.query(
        `UPDATE conversation_members SET role = $1
         WHERE conversation_id = $2 AND user_id = $3`,
        [role, membershipConversation.id, targetUserId]
      );

      if (actorCheck.rows[0].type === 'group') {
        const childChannelIds = await getChildChannelIds(pool, membershipConversation.id);
        for (const channelId of childChannelIds) {
          await pool.query(
            `UPDATE conversation_members SET role = $1
             WHERE conversation_id = $2 AND user_id = $3`,
            [role, channelId, targetUserId]
          );
        }
      }

      const memberRowsResult = await pool.query(
        `SELECT user_id, role
         FROM conversation_members
         WHERE conversation_id = $1`,
        [membershipConversation.id]
      );
      const memberIds = memberRowsResult.rows.map((row) => row.user_id);
      const memberRolesById = Object.fromEntries(
        memberRowsResult.rows.map((row) => [row.user_id, row.role])
      );
      const currentKeyVersion = normalizeKeyVersion(
        membershipConversation.current_key_version,
        1,
      );

      await emitConversationUpdate(
        membershipConversation,
        memberIds,
        currentKeyVersion,
        memberIds.length,
        memberRolesById,
      );

      res.json({ success: true, message: 'Role updated' });
    } catch (err) {
      console.error('Members PUT error:', err);
      res.status(500).json({ error: 'Failed to update role' });
    }
  });
}
