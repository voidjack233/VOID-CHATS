import { pool } from '../../../db.js';
import { sendLiveEventToUser } from '../../../gateway/client.js';
import {
  emitConversationUpdate,
  getChildChannelIds,
  getGroupMembership,
  normalizeKeyVersion,
  resolveMembershipConversation,
} from '../../../utils/groupMembership.js';

export function registerMemberLeaveRoutes(router) {
  router.post('/leave', async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;
    let client;
    let committed = false;
    let leavePayload = null;
    let survivorMemberIds = [];
    let survivorRolesById = {};
    let currentKeyVersion = 1;
    let deletedGroup = false;

    try {
      client = await pool.connect();
      await client.query('BEGIN');

      const conversation = await resolveMembershipConversation(client, conversationId);
      if (!conversation) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Conversation not found' });
      }

      if (conversation.type !== 'group') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Leaving is only supported for groups' });
      }

      const membership = await getGroupMembership(client, conversation.id, userId);
      if (!membership) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Not a member' });
      }

      const memberCountResult = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM conversation_members
         WHERE conversation_id = $1`,
        [conversation.id],
      );
      const memberCount = memberCountResult.rows[0]?.count || 0;

      if (membership.role === 'owner' && memberCount > 1) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'Transfer ownership before leaving this group',
          code: 'OWNER_TRANSFER_REQUIRED',
        });
      }

      currentKeyVersion = normalizeKeyVersion(conversation.current_key_version, 1);
      leavePayload = {
        conversation_id: conversation.id,
        conversation_public_id: conversation.public_id ? String(conversation.public_id) : null,
        user_id: userId,
      };

      if (membership.role === 'owner' && memberCount <= 1) {
        await client.query('DELETE FROM conversations WHERE id = $1', [conversation.id]);
        deletedGroup = true;
      } else {
        const childChannelIds = await getChildChannelIds(client, conversation.id);
        const affectedConversationIds = [conversation.id, ...childChannelIds];

        await client.query(
          `DELETE FROM conversation_members
           WHERE conversation_id = ANY($1::uuid[])
             AND user_id = $2`,
          [affectedConversationIds, userId],
        );

        await client.query(
          `UPDATE conversations
           SET updated_at = NOW()
           WHERE id = ANY($1::uuid[])`,
          [affectedConversationIds],
        );

        const survivorRowsResult = await client.query(
          `SELECT user_id, role
           FROM conversation_members
           WHERE conversation_id = $1`,
          [conversation.id],
        );
        survivorMemberIds = survivorRowsResult.rows.map((row) => row.user_id);
        survivorRolesById = Object.fromEntries(
          survivorRowsResult.rows.map((row) => [row.user_id, row.role]),
        );
      }

      await client.query('COMMIT');
      committed = true;

      try {
        sendLiveEventToUser(userId, 'MEMBER_LEAVE', leavePayload);
      } catch (emitError) {
        console.warn('Self-leave succeeded but member leave emit failed:', emitError);
      }

      if (!deletedGroup && survivorMemberIds.length > 0) {
        try {
          await emitConversationUpdate(
            conversation,
            survivorMemberIds,
            currentKeyVersion,
            survivorMemberIds.length,
            survivorRolesById,
          );
        } catch (emitError) {
          console.warn('Self-leave succeeded but survivor update emit failed:', emitError);
        }
      }

      res.json({
        success: true,
        deleted: deletedGroup,
        message: deletedGroup ? 'Group deleted' : 'Left group',
      });
    } catch (err) {
      if (client && !committed) await client.query('ROLLBACK').catch(() => {});
      console.error('Member self-leave error:', err);
      res.status(500).json({ error: 'Failed to leave group' });
    } finally {
      client?.release();
    }
  });
}
