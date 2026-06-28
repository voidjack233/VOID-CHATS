import { pool } from '../../../db.js';
import {
  emitConversationUpdate,
  getChildChannelIds,
  normalizeKeyVersion,
  resolveMembershipConversation,
} from '../../../utils/groupMembership.js';

export function registerMemberOwnershipRoutes(router) {
  router.post('/transfer-ownership', async (req, res) => {
    const actorUserId = req.user.id;
    const { conversationId } = req.params;
    const targetUserId =
      typeof req.body?.target_user_id === 'string' ? req.body.target_user_id.trim() : '';

    if (!targetUserId) {
      return res.status(400).json({ error: 'target_user_id required' });
    }

    if (targetUserId === actorUserId) {
      return res.status(400).json({ error: 'Choose a different member to transfer ownership to' });
    }

    let client;
    let committed = false;

    try {
      client = await pool.connect();
      await client.query('BEGIN');

      const membershipConversation = await resolveMembershipConversation(client, conversationId);
      if (!membershipConversation) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Conversation not found' });
      }

      if (membershipConversation.type !== 'group') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Ownership transfer is only supported for groups' });
      }

      const actorMemberResult = await client.query(
        `SELECT role
         FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2
         LIMIT 1`,
        [membershipConversation.id, actorUserId],
      );

      if (actorMemberResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Not a member' });
      }

      if (actorMemberResult.rows[0].role !== 'owner') {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only the owner can transfer ownership' });
      }

      if (String(membershipConversation.owner_id || '') !== actorUserId) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Conversation owner state is out of sync. Refresh and try again.',
          code: 'OWNER_STATE_MISMATCH',
        });
      }

      const targetMemberResult = await client.query(
        `SELECT role
         FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2
         LIMIT 1`,
        [membershipConversation.id, targetUserId],
      );

      if (targetMemberResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Target member not found' });
      }

      const childChannelIds = await getChildChannelIds(client, membershipConversation.id);
      const affectedConversationIds = [membershipConversation.id, ...childChannelIds];

      await client.query(
        `UPDATE conversations
         SET owner_id = $1, updated_at = NOW()
         WHERE id = ANY($2::uuid[])`,
        [targetUserId, affectedConversationIds],
      );

      await client.query(
        `UPDATE conversation_members
         SET role = CASE
           WHEN user_id = $1 THEN 'owner'
           WHEN user_id = $2 THEN 'admin'
           ELSE role
         END
         WHERE conversation_id = ANY($3::uuid[])
           AND user_id IN ($1, $2)`,
        [targetUserId, actorUserId, affectedConversationIds],
      );

      const memberRowsResult = await client.query(
        `SELECT user_id, role
         FROM conversation_members
         WHERE conversation_id = $1`,
        [membershipConversation.id],
      );
      const memberIds = memberRowsResult.rows.map((row) => row.user_id);
      const memberRolesById = Object.fromEntries(
        memberRowsResult.rows.map((row) => [row.user_id, row.role]),
      );

      await client.query('COMMIT');
      committed = true;

      const currentKeyVersion = normalizeKeyVersion(
        membershipConversation.current_key_version,
        1,
      );
      const updatedConversation = {
        ...membershipConversation,
        owner_id: targetUserId,
      };

      try {
        await emitConversationUpdate(
          updatedConversation,
          memberIds,
          currentKeyVersion,
          memberIds.length,
          memberRolesById,
        );
      } catch (emitError) {
        console.warn('Ownership transfer succeeded but live update emit failed:', emitError);
      }

      res.json({
        success: true,
        conversation: {
          id: membershipConversation.id,
          public_id: membershipConversation.public_id
            ? String(membershipConversation.public_id)
            : null,
          type: membershipConversation.type,
          owner_id: targetUserId,
          current_key_version: currentKeyVersion,
          member_count: memberIds.length,
          role: 'admin',
        },
      });
    } catch (err) {
      if (client && !committed) await client.query('ROLLBACK');
      console.error('Transfer ownership error:', err);
      res.status(500).json({ error: 'Failed to transfer ownership' });
    } finally {
      if (client) client.release();
    }
  });
}
