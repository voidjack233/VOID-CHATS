import { pool } from '../../../db.js';
import {
  emitConversationUpdate,
  getChildChannelIds,
  getGroupMembership,
  normalizeKeyVersion,
  resolveMembershipConversation,
  uniqueUserIds,
  validateFriendships,
} from '../../../utils/groupMembership.js';
import {
  insertMembershipFinalizeArtifacts,
  parseMembershipFinalizeArtifacts,
} from '../mls/finalizeArtifacts.js';

export function registerMemberRotateAddRoutes(router) {
  router.post('/rotate-add', async (req, res) => {
    const actorUserId = req.user.id;
    const { conversationId } = req.params;
    const requestedMembers = uniqueUserIds(req.body?.members);
    const newKeyVersion = normalizeKeyVersion(req.body?.new_key_version, 0);

    if (requestedMembers.length === 0) {
      return res.status(400).json({ error: 'Members array required' });
    }

    if (newKeyVersion <= 0) {
      return res.status(400).json({ error: 'new_key_version required' });
    }

    let client;

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
        return res.status(400).json({ error: 'Rotated membership changes are only supported for groups' });
      }

      const membership = await getGroupMembership(client, conversation.id, actorUserId);
      if (!membership) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Not a member' });
      }

      if (membership.role !== 'owner') {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only the owner can add members during key rotation' });
      }

      const lockedVersionResult = await client.query(
        `SELECT current_key_version,
                pending_remove_target,
                pending_remove_key_version,
                pending_add_user_ids,
                pending_add_key_version
         FROM conversations
         WHERE id = $1 FOR UPDATE`,
        [conversation.id]
      );
      const currentKeyVersion = normalizeKeyVersion(lockedVersionResult.rows[0].current_key_version, 1);
      const existingPendingRemoveTarget = lockedVersionResult.rows[0].pending_remove_target
        ? String(lockedVersionResult.rows[0].pending_remove_target)
        : null;
      const existingPendingRemoveVersion = lockedVersionResult.rows[0].pending_remove_key_version != null
        ? Number(lockedVersionResult.rows[0].pending_remove_key_version)
        : null;
      const existingPendingUserIds = Array.isArray(lockedVersionResult.rows[0].pending_add_user_ids)
        ? lockedVersionResult.rows[0].pending_add_user_ids.map((value) => String(value))
        : [];
      const existingPendingVersion = lockedVersionResult.rows[0].pending_add_key_version != null
        ? Number(lockedVersionResult.rows[0].pending_add_key_version)
        : null;

      if (existingPendingUserIds.length > 0 && existingPendingVersion) {
        const samePendingMembers =
          existingPendingUserIds.length === requestedMembers.length &&
          existingPendingUserIds.every((memberId, index) => memberId === requestedMembers[index]);

        if (samePendingMembers && existingPendingVersion === newKeyVersion) {
          await client.query('ROLLBACK');
          return res.json({
            success: true,
            phase: 'prepared',
            added: requestedMembers,
            pending_key_version: existingPendingVersion,
            current_key_version: currentKeyVersion,
          });
        }

        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Another member add is already pending for this conversation',
          code: 'PENDING_ADD_CONFLICT',
          pending_members: existingPendingUserIds,
          pending_key_version: existingPendingVersion,
        });
      }

      if (existingPendingRemoveTarget && existingPendingRemoveVersion) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'A member removal is already pending for this conversation',
          code: 'PENDING_REMOVE_CONFLICT',
          pending_remove_target: existingPendingRemoveTarget,
          pending_remove_key_version: existingPendingRemoveVersion,
        });
      }

      if (newKeyVersion !== currentKeyVersion + 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Expected new_key_version ${currentKeyVersion + 1}`,
          code: 'INVALID_KEY_VERSION',
          current_key_version: currentKeyVersion,
        });
      }

      const currentMembersResult = await client.query(
        `SELECT user_id
         FROM conversation_members
         WHERE conversation_id = $1`,
        [conversation.id]
      );
      const currentMemberIds = currentMembersResult.rows.map((row) => row.user_id);
      const currentMemberSet = new Set(currentMemberIds);

      const duplicateTarget = requestedMembers.find((memberId) => currentMemberSet.has(memberId));
      if (duplicateTarget) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'One or more requested users are already members',
          code: 'ALREADY_MEMBER',
          user_id: duplicateTarget,
        });
      }

      const nonFriendId = await validateFriendships(client, actorUserId, requestedMembers);
      if (nonFriendId) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'You can only add accepted friends to this group',
          code: 'FRIENDSHIP_REQUIRED',
          user_id: nonFriendId,
        });
      }

      await client.query(
        `UPDATE conversations
         SET pending_add_user_ids = $2::UUID[],
             pending_add_key_version = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [conversation.id, requestedMembers, newKeyVersion]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        phase: 'prepared',
        added: requestedMembers,
        pending_key_version: newKeyVersion,
        current_key_version: currentKeyVersion,
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('Rotate-add prepare error:', err);
      res.status(500).json({ error: 'Failed to prepare member add with key rotation' });
    } finally {
      client?.release();
    }
  });

  router.post('/rotate-add/finalize', async (req, res) => {
    const actorUserId = req.user.id;
    const { conversationId } = req.params;

    let client;

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
        return res.status(400).json({ error: 'Rotated membership changes are only supported for groups' });
      }

      const membership = await getGroupMembership(client, conversation.id, actorUserId);
      if (!membership || membership.role !== 'owner') {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only the owner can finalize member add' });
      }

      const lockedResult = await client.query(
        `SELECT current_key_version,
                pending_add_user_ids,
                pending_add_key_version
         FROM conversations
         WHERE id = $1 FOR UPDATE`,
        [conversation.id]
      );

      const currentKeyVersion = normalizeKeyVersion(lockedResult.rows[0].current_key_version, 1);
      const pendingUserIds = Array.isArray(lockedResult.rows[0].pending_add_user_ids)
        ? lockedResult.rows[0].pending_add_user_ids.map((value) => String(value))
        : [];
      const pendingKeyVersion = lockedResult.rows[0].pending_add_key_version != null
        ? Number(lockedResult.rows[0].pending_add_key_version)
        : null;

      if (pendingUserIds.length === 0 || !pendingKeyVersion) {
        const finalizedAdditions = await client.query(
          `SELECT affected_user_id::text AS user_id
           FROM conversation_key_rotations
           WHERE conversation_id = $1
             AND reason = 'member_add'
             AND new_key_version = $2`,
          [conversation.id, currentKeyVersion]
        );

        if (finalizedAdditions.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.json({
            success: true,
            phase: 'finalized',
            added: finalizedAdditions.rows.map((row) => row.user_id),
            key_version: currentKeyVersion,
          });
        }

        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'No pending member add to finalize',
          code: 'NO_PENDING_ADD',
        });
      }

      if (pendingKeyVersion !== currentKeyVersion + 1) {
        await client.query(
          `UPDATE conversations
           SET pending_add_user_ids = NULL,
               pending_add_key_version = NULL,
               updated_at = NOW()
           WHERE id = $1`,
          [conversation.id]
        );
        await client.query('COMMIT');
        return res.status(409).json({
          error: 'Pending member add is stale — version has moved',
          code: 'PENDING_ADD_STALE',
          current_key_version: currentKeyVersion,
        });
      }

      const duplicateMembers = await client.query(
        `SELECT user_id::text AS user_id
         FROM conversation_members
         WHERE conversation_id = $1
           AND user_id = ANY($2::UUID[])`,
        [conversation.id, pendingUserIds]
      );

      if (duplicateMembers.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'One or more pending users are already members',
          code: 'ALREADY_MEMBER',
          user_id: duplicateMembers.rows[0].user_id,
        });
      }

      const currentMembersResult = await client.query(
        `SELECT user_id::text AS user_id
         FROM conversation_members
         WHERE conversation_id = $1`,
        [conversation.id]
      );
      const currentMemberIds = currentMembersResult.rows.map((row) => row.user_id);
      const existingPeerIds = currentMemberIds.filter((memberId) => String(memberId) !== String(actorUserId));

      const parsedArtifacts = parseMembershipFinalizeArtifacts(
        req.body?.mls_artifacts ?? req.body?.mlsArtifacts,
        {
          expectedWelcomeUserIds: pendingUserIds,
          pendingKeyVersion,
          requireCommit: existingPeerIds.length > 0,
        },
      );

      if (parsedArtifacts.error) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          success: false,
          error: parsedArtifacts.error,
          code: parsedArtifacts.code,
        });
      }

      const childChannelIds = await getChildChannelIds(client, conversation.id);

      await insertMembershipFinalizeArtifacts(client, {
        conversationId: conversation.id,
        actorUserId,
        pendingKeyVersion,
        artifacts: parsedArtifacts.artifacts,
      });

      for (const memberId of pendingUserIds) {
        await client.query(
          `INSERT INTO conversation_members (
             conversation_id,
             user_id,
             role,
             joined_key_version,
             history_start_version
           )
           VALUES ($1, $2, 'member', $3, $3)`,
          [conversation.id, memberId, pendingKeyVersion]
        );

        for (const channelId of childChannelIds) {
          await client.query(
            `INSERT INTO conversation_members (conversation_id, user_id, role)
             VALUES ($1, $2, 'member')
             ON CONFLICT DO NOTHING`,
            [channelId, memberId]
          );
        }
      }

      await client.query(
        `UPDATE conversations
         SET current_key_version = $2,
             pending_add_user_ids = NULL,
             pending_add_key_version = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [conversation.id, pendingKeyVersion]
      );

      for (const memberId of pendingUserIds) {
        await client.query(
          `INSERT INTO conversation_key_rotations (
             conversation_id,
             previous_key_version,
             new_key_version,
             rotated_by_user_id,
             reason,
             affected_user_id
           )
           VALUES ($1, $2, $3, $4, 'member_add', $5)`,
          [conversation.id, currentKeyVersion, pendingKeyVersion, actorUserId, memberId]
        );
      }

      await client.query('COMMIT');

      const updatedMemberIds = [...new Set([...currentMemberIds, ...pendingUserIds])];
      if (updatedMemberIds.length > 0) {
        try {
          await emitConversationUpdate(
            conversation,
            updatedMemberIds,
            pendingKeyVersion,
            updatedMemberIds.length,
          );
        } catch (emitErr) {
          console.warn('Rotate-add finalize member update emit failed:', emitErr);
        }
      }

      res.json({
        success: true,
        phase: 'finalized',
        added: pendingUserIds,
        key_version: pendingKeyVersion,
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('Rotate-add finalize error:', err);
      const status = Number(err?.status) || 500;
      res.status(status).json({
        error: status === 500 ? 'Failed to finalize member add' : err.message,
        ...(err?.code ? { code: err.code } : {}),
      });
    } finally {
      client?.release();
    }
  });

  router.post('/rotate-add/rollback', async (req, res) => {
    const actorUserId = req.user.id;
    const { conversationId } = req.params;
    const requestedMembers = uniqueUserIds(req.body?.members);
    const failedKeyVersion = normalizeKeyVersion(req.body?.failed_key_version, 0);

    if (requestedMembers.length === 0) {
      return res.status(400).json({ error: 'Members array required' });
    }

    if (failedKeyVersion <= 0) {
      return res.status(400).json({ error: 'failed_key_version required' });
    }

    let client;

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
        return res.status(400).json({ error: 'Rotated membership changes are only supported for groups' });
      }

      const membership = await getGroupMembership(client, conversation.id, actorUserId);
      if (!membership) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Not a member' });
      }

      if (membership.role !== 'owner') {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only the owner can roll back failed member adds' });
      }

      const lockedVersionResult = await client.query(
        `SELECT current_key_version,
                pending_add_user_ids,
                pending_add_key_version
         FROM conversations
         WHERE id = $1 FOR UPDATE`,
        [conversation.id]
      );
      const currentKeyVersion = normalizeKeyVersion(lockedVersionResult.rows[0].current_key_version, 1);
      const pendingUserIds = Array.isArray(lockedVersionResult.rows[0].pending_add_user_ids)
        ? lockedVersionResult.rows[0].pending_add_user_ids.map((value) => String(value))
        : [];
      const pendingKeyVersion = lockedVersionResult.rows[0].pending_add_key_version != null
        ? Number(lockedVersionResult.rows[0].pending_add_key_version)
        : null;

      const pendingMatches =
        pendingKeyVersion === failedKeyVersion &&
        pendingUserIds.length === requestedMembers.length &&
        pendingUserIds.every((memberId, index) => memberId === requestedMembers[index]);

      if (pendingMatches) {
        await client.query(
          `UPDATE conversations
           SET pending_add_user_ids = NULL,
               pending_add_key_version = NULL,
               updated_at = NOW()
           WHERE id = $1`,
          [conversation.id]
        );

        await client.query('COMMIT');

        return res.json({
          success: true,
          rolled_back: requestedMembers,
          key_version: currentKeyVersion,
          phase: 'pending_cleared',
        });
      }

      if (currentKeyVersion !== failedKeyVersion) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Cannot roll back key version ${failedKeyVersion}; conversation is now at ${currentKeyVersion}`,
          code: 'ROLLBACK_NOT_POSSIBLE',
          current_key_version: currentKeyVersion,
        });
      }

      const addedMembersResult = await client.query(
        `SELECT user_id::text AS user_id
         FROM conversation_members
         WHERE conversation_id = $1
           AND user_id = ANY($2::UUID[])
           AND joined_key_version = $3`,
        [conversation.id, requestedMembers, failedKeyVersion]
      );

      if (addedMembersResult.rows.length !== requestedMembers.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Requested members no longer match the failed add operation',
          code: 'ROLLBACK_NOT_POSSIBLE',
        });
      }

      const childChannelIds = await getChildChannelIds(client, conversation.id);

      await client.query(
        `DELETE FROM conversation_members
         WHERE conversation_id = $1
           AND user_id = ANY($2::UUID[])
           AND joined_key_version = $3`,
        [conversation.id, requestedMembers, failedKeyVersion]
      );

      for (const channelId of childChannelIds) {
        await client.query(
          `DELETE FROM conversation_members
           WHERE conversation_id = $1
             AND user_id = ANY($2::UUID[])`,
          [channelId, requestedMembers]
        );
      }

      await client.query(
        `DELETE FROM conversation_key_rotations
         WHERE conversation_id = $1
           AND new_key_version = $2
           AND reason = 'member_add'
           AND affected_user_id = ANY($3::UUID[])`,
        [conversation.id, failedKeyVersion, requestedMembers]
      );

      await client.query(
        `UPDATE conversations
         SET current_key_version = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [conversation.id, failedKeyVersion - 1]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        rolled_back: requestedMembers,
        key_version: failedKeyVersion - 1,
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('Rotate-add rollback error:', err);
      res.status(500).json({ error: 'Failed to roll back member add' });
    } finally {
      client?.release();
    }
  });
}
