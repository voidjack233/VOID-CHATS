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
  parseMembershipFinalizeArtifacts,
} from '../mls/finalizeArtifacts.js';
import {
  finalizeMlsAddedMembers,
  getMembershipOperationId,
  lockMembershipRotation,
  markMembershipRotationRolledBack,
  reserveMembershipRotation,
} from './membershipRotations.js';

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

      const { operation, currentKeyVersion } = await reserveMembershipRotation(client, {
        conversationId: conversation.id,
        actorUserId,
        kind: 'direct_add',
        targetUserIds: requestedMembers,
        requestedKeyVersion: newKeyVersion,
      });

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

      await client.query('COMMIT');

      res.json({
        success: true,
        phase: 'prepared',
        added: requestedMembers,
        operation_id: operation.operationId,
        pending_key_version: operation.reservedKeyVersion,
        current_key_version: currentKeyVersion,
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('Rotate-add prepare error:', err);
      const status = Number(err?.status) || 500;
      res.status(status).json({
        error: status === 500 ? 'Failed to prepare member add with key rotation' : err.message,
        ...(err?.code ? { code: err.code } : {}),
        ...(err?.data || {}),
      });
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

      const operationId = getMembershipOperationId(req.body);
      const { operation, currentKeyVersion } = await lockMembershipRotation(client, {
        conversationId: conversation.id,
        operationId,
        actorUserId,
        kind: 'direct_add',
      });
      const pendingUserIds = operation.targetUserIds;
      const pendingKeyVersion = operation.reservedKeyVersion;

      if (operation.status === 'finalized') {
        await client.query('ROLLBACK');
        return res.json({
          success: true,
          phase: 'finalized',
          added: pendingUserIds,
          key_version: pendingKeyVersion,
        });
      }

      if (operation.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Member add operation is no longer pending',
          code: 'MEMBERSHIP_OPERATION_ROLLED_BACK',
        });
      }

      if (pendingKeyVersion !== currentKeyVersion + 1) {
        await markMembershipRotationRolledBack(client, operation.operationId);
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

      await finalizeMlsAddedMembers(client, {
        conversationId: conversation.id,
        actorUserId,
        currentKeyVersion,
        operation,
        artifacts: parsedArtifacts.artifacts,
        childChannelIds,
        reason: 'member_add',
      });

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

      const operationId = getMembershipOperationId(req.body);
      const { operation, currentKeyVersion } = await lockMembershipRotation(client, {
        conversationId: conversation.id,
        operationId,
        actorUserId,
        kind: 'direct_add',
      });
      const expectedMembers = [...new Set(requestedMembers.map((memberId) => String(memberId)))].sort();
      const matchesRequest =
        operation.reservedKeyVersion === failedKeyVersion &&
        operation.targetUserIds.length === expectedMembers.length &&
        operation.targetUserIds.every((memberId, index) => memberId === expectedMembers[index]);

      if (!matchesRequest) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Requested members do not match the pending add operation',
          code: 'MEMBERSHIP_OPERATION_MISMATCH',
        });
      }

      if (operation.status === 'finalized') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'A finalized membership rotation cannot be rolled back automatically',
          code: 'ROLLBACK_NOT_POSSIBLE',
          current_key_version: currentKeyVersion,
        });
      }

      await markMembershipRotationRolledBack(client, operation.operationId);

      await client.query('COMMIT');

      res.json({
        success: true,
        rolled_back: operation.targetUserIds,
        key_version: currentKeyVersion,
        phase: 'pending_cleared',
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('Rotate-add rollback error:', err);
      const status = Number(err?.status) || 500;
      res.status(status).json({
        error: status === 500 ? 'Failed to roll back member add' : err.message,
        ...(err?.code ? { code: err.code } : {}),
      });
    } finally {
      client?.release();
    }
  });
}
