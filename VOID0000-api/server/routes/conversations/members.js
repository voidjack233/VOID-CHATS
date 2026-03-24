import { Router } from 'express';
import { pool } from '../../db.js';
import { sendLiveEventToUser } from '../../gateway/client.js';
import {
  emitConversationUpdate,
  getChildChannelIds,
  getGroupMembership,
  normalizeKeyVersion,
  resolveMembershipConversation,
  uniqueUserIds,
  validateFriendships,
} from '../../utils/groupMembership.js';

const router = Router({ mergeParams: true });

// Requires conversation pending-membership columns to be created by a DB migration:
// pending_add_user_ids, pending_add_key_version, pending_remove_target,
// pending_remove_key_version.

// POST /api/conversations/:conversationId/members/rotate-add — prepare member add
//
// Phase 1 of two-phase add. Validates the requested members and records
// intent by setting pending_add_user_ids / pending_add_key_version on the
// conversation row. Does NOT add members or advance current_key_version.
// The client must upload the owner's durable MLS snapshot for
// pending_key_version, then call POST /rotate-add/finalize to atomically
// commit the member add.
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

    // Lock the conversation row to serialize concurrent membership changes
    // across all devices/tabs/admins for this conversation.
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

// POST /api/conversations/:conversationId/members/rotate-add/finalize
//
// Phase 2 of two-phase add. Verifies the owner's durable MLS snapshot for
// pending_key_version exists in mls_group_states, then atomically commits
// the member add, version advance, and rotation records.
// If the snapshot is missing, returns 428 SNAPSHOT_REQUIRED — no state change.
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

    const snapshotCheck = await client.query(
      `SELECT 1
       FROM mls_group_states
       WHERE conversation_id = $1
         AND user_id = $2
         AND key_version IS NOT NULL
         AND key_version >= $3
       LIMIT 1`,
      [conversation.id, actorUserId, pendingKeyVersion]
    ).catch((snapshotErr) => {
      console.warn('Rotate-add finalize snapshot check failed:', snapshotErr.message);
      return { rows: [] };
    });

    if (snapshotCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(428).json({
        success: false,
        error: 'Owner group state snapshot for the new key version must be uploaded before finalizing member add',
        code: 'SNAPSHOT_REQUIRED',
        required_key_version: pendingKeyVersion,
        current_key_version: currentKeyVersion,
      });
    }

    const welcomeCheck = await client.query(
      `SELECT user_id::text AS user_id
       FROM mls_welcome_messages
       WHERE conversation_id = $1
         AND user_id = ANY($2::UUID[])
         AND consumed_at IS NULL`,
      [conversation.id, pendingUserIds]
    );

    const welcomedUserIds = new Set(welcomeCheck.rows.map((r) => r.user_id));
    const missingWelcome = pendingUserIds.find((id) => !welcomedUserIds.has(id));

    if (missingWelcome) {
      await client.query('ROLLBACK');
      return res.status(428).json({
        success: false,
        error: 'Welcome message for each new member must be uploaded before finalizing member add',
        code: 'WELCOME_REQUIRED',
        required_user_id: missingWelcome,
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

    const childChannelIds = await getChildChannelIds(client, conversation.id);

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

    res.json({
      success: true,
      phase: 'finalized',
      added: pendingUserIds,
      key_version: pendingKeyVersion,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Rotate-add finalize error:', err);
    res.status(500).json({ error: 'Failed to finalize member add' });
  } finally {
    client?.release();
  }
});

// POST /api/conversations/:conversationId/members/rotate-add/rollback — revert
// a failed add/re-add when MLS distribution never completed.
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

// POST /api/conversations/:conversationId/members/rotate-remove — prepare member removal
//
// Phase 1 of two-phase remove. Validates the removal and records intent by
// setting pending_remove_target / pending_remove_key_version on the
// conversation row. Does NOT delete the member or advance current_key_version.
// The client must upload the survivor's durable group state snapshot for
// pending_key_version, then call POST /rotate-remove/finalize to atomically
// commit the removal.
router.post('/rotate-remove', async (req, res) => {
  const actorUserId = req.user.id;
  const { conversationId } = req.params;
  const targetUserId = typeof req.body?.target_user_id === 'string' ? req.body.target_user_id.trim() : '';
  const newKeyVersion = normalizeKeyVersion(req.body?.new_key_version, 0);

  if (!targetUserId) {
    return res.status(400).json({ error: 'target_user_id required' });
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
      return res.status(403).json({
        error: 'Only the owner can remove members during key rotation',
        code: actorUserId === targetUserId ? 'SELF_LEAVE_ROTATION_UNAVAILABLE' : 'OWNER_REQUIRED',
      });
    }

    const targetMemberResult = await client.query(
      `SELECT role
       FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversation.id, targetUserId]
    );

    if (targetMemberResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User is not a member' });
    }

    if (targetMemberResult.rows[0].role === 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'Transfer ownership before leaving this group',
        code: 'OWNER_TRANSFER_REQUIRED',
      });
    }

    // Lock the conversation row to serialize concurrent membership changes.
    const lockedResult = await client.query(
      `SELECT current_key_version,
              pending_add_user_ids,
              pending_add_key_version,
              pending_remove_target,
              pending_remove_key_version
       FROM conversations WHERE id = $1 FOR UPDATE`,
      [conversation.id]
    );
    const currentKeyVersion = normalizeKeyVersion(lockedResult.rows[0].current_key_version, 1);
    const existingPendingAddUserIds = Array.isArray(lockedResult.rows[0].pending_add_user_ids)
      ? lockedResult.rows[0].pending_add_user_ids.map((value) => String(value))
      : [];
    const existingPendingAddVersion = lockedResult.rows[0].pending_add_key_version != null
      ? Number(lockedResult.rows[0].pending_add_key_version)
      : null;

    // Idempotent: if the same prepare was already issued, return the pending state.
    const existingPendingTarget = lockedResult.rows[0].pending_remove_target
      ? String(lockedResult.rows[0].pending_remove_target)
      : null;
    const existingPendingVersion = lockedResult.rows[0].pending_remove_key_version
      ? Number(lockedResult.rows[0].pending_remove_key_version)
      : null;

    if (existingPendingAddUserIds.length > 0 && existingPendingAddVersion) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'A member add is already pending for this conversation',
        code: 'PENDING_ADD_CONFLICT',
        pending_members: existingPendingAddUserIds,
        pending_key_version: existingPendingAddVersion,
      });
    }

    if (existingPendingTarget && existingPendingVersion) {
      if (existingPendingTarget === targetUserId && existingPendingVersion === newKeyVersion) {
        // Same prepare already in progress — idempotent success.
        await client.query('ROLLBACK');
        return res.json({
          success: true,
          phase: 'prepared',
          pending_key_version: existingPendingVersion,
          current_key_version: currentKeyVersion,
        });
      }
      // Different pending remove exists — conflict.
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Another member removal is already pending for this conversation',
        code: 'PENDING_REMOVE_CONFLICT',
        pending_remove_target: existingPendingTarget,
        pending_remove_key_version: existingPendingVersion,
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
    const remainingMemberIds = currentMemberIds.filter((memberId) => memberId !== targetUserId);

    if (remainingMemberIds.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot remove the final group member' });
    }

    // Record intent — do NOT delete member or advance version yet.
    await client.query(
      `UPDATE conversations
       SET pending_remove_target = $2::UUID,
           pending_remove_key_version = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [conversation.id, targetUserId, newKeyVersion]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      phase: 'prepared',
      pending_key_version: newKeyVersion,
      current_key_version: currentKeyVersion,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Rotate-remove prepare error:', err);
    res.status(500).json({ error: 'Failed to prepare member removal' });
  } finally {
    client?.release();
  }
});

// POST /api/conversations/:conversationId/members/rotate-remove/finalize
//
// Phase 2 of two-phase remove. Verifies the survivor's durable group state
// snapshot for pending_key_version exists in mls_group_states, then atomically
// commits the membership deletion, version advance, and rotation record.
// If the snapshot is missing, returns 428 SNAPSHOT_REQUIRED — no state change.
router.post('/rotate-remove/finalize', async (req, res) => {
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

    const membership = await getGroupMembership(client, conversation.id, actorUserId);
    if (!membership || membership.role !== 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the owner can finalize member removal' });
    }

    // Lock and read the pending remove state.
    const lockedResult = await client.query(
      `SELECT current_key_version, pending_remove_target, pending_remove_key_version
       FROM conversations WHERE id = $1 FOR UPDATE`,
      [conversation.id]
    );

    const pendingTarget = lockedResult.rows[0].pending_remove_target
      ? String(lockedResult.rows[0].pending_remove_target)
      : null;
    const pendingKeyVersion = lockedResult.rows[0].pending_remove_key_version
      ? Number(lockedResult.rows[0].pending_remove_key_version)
      : null;
    const currentKeyVersion = normalizeKeyVersion(lockedResult.rows[0].current_key_version, 1);

    if (!pendingTarget || !pendingKeyVersion) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'No pending member removal to finalize',
        code: 'NO_PENDING_REMOVE',
      });
    }

    if (pendingKeyVersion !== currentKeyVersion + 1) {
      // Version moved underneath us — the pending is stale. Clear it.
      await client.query(
        `UPDATE conversations
         SET pending_remove_target = NULL,
             pending_remove_key_version = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [conversation.id]
      );
      await client.query('COMMIT');
      return res.status(409).json({
        error: 'Pending removal is stale — version has moved',
        code: 'PENDING_REMOVE_STALE',
        current_key_version: currentKeyVersion,
      });
    }

    // ──────────────────────────────────────────────────────────────
    // DURABILITY GATE: verify the survivor's group state snapshot
    // for pendingKeyVersion exists in mls_group_states.
    // This is the single point that prevents stranded N+1 states.
    // ──────────────────────────────────────────────────────────────
    let snapshotExists = false;
    try {
      const snapshotCheck = await client.query(
        `SELECT 1 FROM mls_group_states
         WHERE conversation_id = $1
           AND user_id = $2
           AND key_version IS NOT NULL
           AND key_version >= $3
         LIMIT 1`,
        [conversation.id, actorUserId, pendingKeyVersion]
      );
      snapshotExists = snapshotCheck.rows.length > 0;
    } catch (snapshotErr) {
      // mls_group_states table may not exist yet (schema created lazily).
      console.warn('Rotate-remove finalize snapshot check failed:', snapshotErr.message);
    }

    if (!snapshotExists) {
      await client.query('ROLLBACK');
      return res.status(428).json({
        success: false,
        error: 'Survivor group state snapshot for the new key version must be uploaded before finalizing remove',
        code: 'SNAPSHOT_REQUIRED',
        required_key_version: pendingKeyVersion,
        current_key_version: currentKeyVersion,
      });
    }

    // Snapshot proven durable — now atomically commit the remove.
    const targetUserId = pendingTarget;
    const newKeyVersion = pendingKeyVersion;

    await client.query(
      `DELETE FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversation.id, targetUserId]
    );

    const childChannelIds = await getChildChannelIds(client, conversation.id);
    for (const channelId of childChannelIds) {
      await client.query(
        `DELETE FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2`,
        [channelId, targetUserId]
      );
    }

    await client.query(
      `UPDATE conversations
       SET current_key_version = $2,
           pending_remove_target = NULL,
           pending_remove_key_version = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [conversation.id, newKeyVersion]
    );

    await client.query(
      `INSERT INTO conversation_key_rotations (
         conversation_id,
         previous_key_version,
         new_key_version,
         rotated_by_user_id,
         reason,
         affected_user_id
       )
       VALUES ($1, $2, $3, $4, 'member_remove', $5)`,
      [conversation.id, currentKeyVersion, newKeyVersion, actorUserId, targetUserId]
    );

    await client.query('COMMIT');

    sendLiveEventToUser(targetUserId, 'MEMBER_LEAVE', {
      conversation_id: conversation.id,
      conversation_public_id: conversation.public_id ? String(conversation.public_id) : null,
      removed_by: actorUserId,
    });

    res.json({
      success: true,
      key_version: newKeyVersion,
      message: 'Member removed',
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Rotate-remove finalize error:', err);
    res.status(500).json({ error: 'Failed to finalize member removal' });
  } finally {
    client?.release();
  }
});

// POST /api/conversations/:conversationId/members — legacy non-rotating add
router.post('/', async (req, res) => {
  try {
    const conversation = await resolveMembershipConversation(pool, req.params.conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (conversation.type === 'dm') {
      return res.status(400).json({ error: 'Cannot add members to a DM' });
    }

    return res.status(409).json({
      error: 'Adding group members now requires key rotation',
      code: 'KEY_ROTATION_REQUIRED',
      endpoint: 'POST /api/conversations/:conversationId/members/rotate-add',
    });
  } catch (err) {
    console.error('Members POST error:', err);
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// DELETE /api/conversations/:conversationId/members/:targetUserId — legacy non-rotating remove
router.delete('/:targetUserId', async (req, res) => {
  try {
    const conversation = await resolveMembershipConversation(pool, req.params.conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (conversation.type === 'dm') {
      return res.status(400).json({ error: 'Cannot remove members from a DM' });
    }

    return res.status(409).json({
      error: 'Removing group members now requires key rotation by the owner',
      code: req.user.id === req.params.targetUserId ? 'SELF_LEAVE_ROTATION_UNAVAILABLE' : 'KEY_ROTATION_REQUIRED',
      endpoint: 'POST /api/conversations/:conversationId/members/rotate-remove',
    });
  } catch (err) {
    console.error('Members DELETE error:', err);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// PUT /api/conversations/:conversationId/members/:userId — update role
router.put('/:targetUserId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId, targetUserId } = req.params;
  const { role } = req.body;

  if (!role || !['admin', 'member', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Valid role required: admin, member, viewer' });
  }

  try {
    const resolvedConversation = await findConversationByIdentifier(conversationId);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const membershipConversation = await resolveMembershipConversation(pool, conversationId);
    if (!membershipConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const ownerCheck = await pool.query(
      `SELECT c.type, cm.role FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE c.id = $1 AND cm.user_id = $2`,
      [membershipConversation.id, userId]
    );

    if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can change roles' });
    }

    await pool.query(
      `UPDATE conversation_members SET role = $1
       WHERE conversation_id = $2 AND user_id = $3`,
      [role, membershipConversation.id, targetUserId]
    );

    if (ownerCheck.rows[0].type === 'group') {
      const childChannelIds = await getChildChannelIds(pool, membershipConversation.id);
      for (const channelId of childChannelIds) {
        await pool.query(
          `UPDATE conversation_members SET role = $1
           WHERE conversation_id = $2 AND user_id = $3`,
          [role, channelId, targetUserId]
        );
      }
    }

    res.json({ success: true, message: 'Role updated' });
  } catch (err) {
    console.error('Members PUT error:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// POST /api/conversations/:conversationId/members/emit-update
// Client calls this AFTER uploading durable MLS recovery artifacts so that
// other devices only learn about the new key version once they can recover it.
router.post('/emit-update', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const conversation = await resolveMembershipConversation(pool, conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const membership = await getGroupMembership(pool, conversation.id, userId);
    if (!membership) {
      return res.status(403).json({ error: 'Not a member' });
    }

    const membersResult = await pool.query(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
      [conversation.id]
    );
    const memberIds = membersResult.rows.map((row) => row.user_id);
    const currentKeyVersion = normalizeKeyVersion(conversation.current_key_version, 1);

    await emitConversationUpdate(conversation, memberIds, currentKeyVersion, memberIds.length);

    res.json({ success: true });
  } catch (err) {
    console.error('Emit-update error:', err);
    res.status(500).json({ error: 'Failed to emit update' });
  }
});

export default router;
