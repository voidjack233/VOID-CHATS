import { Router } from 'express';
import { pool } from '../../db.js';
import { sendLiveEventToUser } from '../../gateway/client.js';
import {
  emitConversationUpdate,
  getChildChannelIds,
  getGroupMembership,
  hasExactDistributionSet,
  insertGroupKeyDistributions,
  normalizeDistributions,
  normalizeKeyVersion,
  resolveMembershipConversation,
  uniqueUserIds,
  validateFriendships,
} from '../../utils/groupMembership.js';

const router = Router({ mergeParams: true });

// POST /api/conversations/:conversationId/members/rotate-add — add members with key rotation
router.post('/rotate-add', async (req, res) => {
  const actorUserId = req.user.id;
  const { conversationId } = req.params;
  const requestedMembers = uniqueUserIds(req.body?.members);
  const distributions = normalizeDistributions(req.body?.distributions);
  const newKeyVersion = normalizeKeyVersion(req.body?.new_key_version, 0);

  if (requestedMembers.length === 0) {
    return res.status(400).json({ error: 'Members array required' });
  }

  if (newKeyVersion <= 0) {
    return res.status(400).json({ error: 'new_key_version required' });
  }

  if (distributions.length === 0) {
    return res.status(400).json({ error: 'distributions array required' });
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

    const currentKeyVersion = normalizeKeyVersion(conversation.current_key_version, 1);
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

    const finalMemberIds = [...currentMemberIds, ...requestedMembers];
    if (!hasExactDistributionSet(finalMemberIds, distributions)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'distributions must exactly match the final member set for the new key version',
        code: 'INVALID_DISTRIBUTIONS',
      });
    }

    const childChannelIds = await getChildChannelIds(client, conversation.id);

    for (const memberId of requestedMembers) {
      await client.query(
        `INSERT INTO conversation_members (
           conversation_id,
           user_id,
           role,
           joined_key_version,
           history_start_version
         )
         VALUES ($1, $2, 'member', $3, $3)`,
        [conversation.id, memberId, newKeyVersion]
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

    await insertGroupKeyDistributions(client, conversation.id, distributions, newKeyVersion, actorUserId);

    await client.query(
      `UPDATE conversations
       SET current_key_version = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [conversation.id, newKeyVersion]
    );

    for (const memberId of requestedMembers) {
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
        [conversation.id, currentKeyVersion, newKeyVersion, actorUserId, memberId]
      );
    }

    await client.query('COMMIT');

    await emitConversationUpdate(conversation, finalMemberIds, newKeyVersion, finalMemberIds.length);

    res.json({
      success: true,
      added: requestedMembers,
      key_version: newKeyVersion,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Rotate-add members error:', err);
    res.status(500).json({ error: 'Failed to add members with key rotation' });
  } finally {
    client?.release();
  }
});

// POST /api/conversations/:conversationId/members/rotate-remove — remove member with key rotation
router.post('/rotate-remove', async (req, res) => {
  const actorUserId = req.user.id;
  const { conversationId } = req.params;
  const targetUserId = typeof req.body?.target_user_id === 'string' ? req.body.target_user_id.trim() : '';
  const distributions = normalizeDistributions(req.body?.distributions);
  const newKeyVersion = normalizeKeyVersion(req.body?.new_key_version, 0);

  if (!targetUserId) {
    return res.status(400).json({ error: 'target_user_id required' });
  }

  if (newKeyVersion <= 0) {
    return res.status(400).json({ error: 'new_key_version required' });
  }

  if (distributions.length === 0) {
    return res.status(400).json({ error: 'distributions array required' });
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

    const currentKeyVersion = normalizeKeyVersion(conversation.current_key_version, 1);
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

    if (!hasExactDistributionSet(remainingMemberIds, distributions)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'distributions must exactly match the remaining member set for the new key version',
        code: 'INVALID_DISTRIBUTIONS',
      });
    }

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

    await insertGroupKeyDistributions(client, conversation.id, distributions, newKeyVersion, actorUserId);

    await client.query(
      `UPDATE conversations
       SET current_key_version = $2,
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

    await emitConversationUpdate(conversation, remainingMemberIds, newKeyVersion, remainingMemberIds.length);

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
    console.error('Rotate-remove member error:', err);
    res.status(500).json({ error: 'Failed to remove member with key rotation' });
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

export default router;
