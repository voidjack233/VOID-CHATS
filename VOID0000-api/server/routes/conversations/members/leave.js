import { pool } from '../../../db.js';
import { sendLiveEventToUser } from '../../../gateway/client.js';
import { EVENTS } from '../../../gateway/protocol.js';
import {
  emitConversationUpdate,
  ensureGroupOwner,
  getChildChannelIds,
  getGroupMembership,
  normalizeKeyVersion,
  resolveMembershipConversation,
} from '../../../utils/groupMembership.js';
import { reserveMembershipRotation } from './membershipRotations.js';

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
    let selfLeaveRotation = null;
    let targetLabel = 'A member';

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
      const targetIdentityResult = await client.query(
        `SELECT u.username, up.display_name
         FROM users u
         LEFT JOIN user_profiles up ON up.id = u.profile_id
         WHERE u.id = $1
         LIMIT 1`,
        [userId],
      );
      const targetIdentity = targetIdentityResult.rows[0] || null;
      targetLabel = targetIdentity?.display_name || targetIdentity?.username || targetLabel;
      leavePayload = {
        conversation_id: conversation.id,
        conversation_public_id: conversation.public_id ? String(conversation.public_id) : null,
        user_id: userId,
      };

      if (membership.role === 'owner' && memberCount <= 1) {
        await client.query('DELETE FROM conversations WHERE id = $1', [conversation.id]);
        deletedGroup = true;
      } else {
        const rotationResult = await reserveMembershipRotation(client, {
          conversationId: conversation.id,
          actorUserId: userId,
          kind: 'self_leave',
          targetUserIds: [userId],
          requestedKeyVersion: currentKeyVersion + 1,
          expiresInMs: null,
        });
        selfLeaveRotation = rotationResult.operation;

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

        const ownerState = await ensureGroupOwner(client, conversation.id);
        conversation.owner_id = ownerState.ownerUserId;

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

      if (!deletedGroup && selfLeaveRotation && survivorMemberIds.length > 0) {
        const rotationPayload = {
          conversation_id: conversation.id,
          conversation_public_id: conversation.public_id ? String(conversation.public_id) : null,
          target_user_id: userId,
          target_label: targetLabel,
          operation_id: selfLeaveRotation.operationId,
          pending_key_version: selfLeaveRotation.reservedKeyVersion,
          current_key_version: currentKeyVersion,
        };

        survivorMemberIds.forEach((survivorUserId) => {
          sendLiveEventToUser(
            survivorUserId,
            EVENTS.SELF_LEAVE_ROTATION_REQUIRED,
            {
              ...rotationPayload,
              survivor_role: survivorRolesById[survivorUserId] || null,
            },
          );
        });

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
        self_leave_rotation_required: Boolean(selfLeaveRotation),
        ...(selfLeaveRotation
          ? {
              operation_id: selfLeaveRotation.operationId,
              pending_key_version: selfLeaveRotation.reservedKeyVersion,
            }
          : {}),
      });
    } catch (err) {
      if (client && !committed) await client.query('ROLLBACK').catch(() => {});
      console.error('Member self-leave error:', err);
      const status = Number(err?.status) || 500;
      res.status(status).json({
        error: status === 500 ? 'Failed to leave group' : err.message,
        ...(err?.code ? { code: err.code } : {}),
        ...(err?.data || {}),
      });
    } finally {
      client?.release();
    }
  });
}
