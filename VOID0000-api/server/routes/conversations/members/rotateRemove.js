import { pool } from '../../../db.js';
import { sendLiveEventToUser } from '../../../gateway/client.js';
import {
  emitConversationUpdate,
  ensureGroupOwner,
  getChildChannelIds,
  getGroupMembership,
  normalizeKeyVersion,
  resolveMembershipConversation,
} from '../../../utils/groupMembership.js';
import { meetsAdminToggle, resolvePermissions } from '../../../utils/groupPermissions.js';
import {
  insertMembershipFinalizeArtifacts,
  parseMembershipFinalizeArtifacts,
} from '../mls/finalizeArtifacts.js';
import {
  getMembershipOperationId,
  lockMembershipRotation,
  markMembershipRotationFinalized,
  markMembershipRotationRolledBack,
  reserveMembershipRotation,
} from './membershipRotations.js';

const ADMIN_REMOVABLE_TARGET_ROLES = new Set(['member', 'viewer']);

function authorizeMemberRemoval({ actorRole, targetRole, actorUserId, targetUserId }) {
  if (actorUserId === targetUserId) {
    return {
      allowed: false,
      status: 403,
      code: 'SELF_LEAVE_ROTATION_UNAVAILABLE',
      error: 'Secure self-leave is not available yet. Ask another admin or the owner to remove you.',
    };
  }

  if (targetRole === 'owner') {
    return {
      allowed: false,
      status: 403,
      code: 'OWNER_TRANSFER_REQUIRED',
      error: 'Transfer ownership before removing the owner',
    };
  }

  if (actorRole === 'owner') {
    return { allowed: true };
  }

  if (actorRole === 'admin' && ADMIN_REMOVABLE_TARGET_ROLES.has(targetRole)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    status: 403,
    code: 'TARGET_ROLE_PROTECTED',
    error: 'Admins can only remove regular members',
  };
}

export function registerMemberRotateRemoveRoutes(router) {
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

      const perms = resolvePermissions(conversation.permissions);
      if (!meetsAdminToggle(membership.role, perms.admin_can_remove_members)) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'You do not have permission to remove members',
          code: actorUserId === targetUserId ? 'SELF_LEAVE_ROTATION_UNAVAILABLE' : 'PERMISSION_DENIED',
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

      const targetRole = targetMemberResult.rows[0].role;
      const removalAuth = authorizeMemberRemoval({
        actorRole: membership.role,
        targetRole,
        actorUserId,
        targetUserId,
      });

      if (!removalAuth.allowed) {
        await client.query('ROLLBACK');
        return res.status(removalAuth.status).json({
          error: removalAuth.error,
          code: removalAuth.code,
        });
      }

      const { operation, currentKeyVersion } = await reserveMembershipRotation(client, {
        conversationId: conversation.id,
        actorUserId,
        kind: 'remove',
        targetUserIds: [targetUserId],
        requestedKeyVersion: newKeyVersion,
      });

      const lockedTargetResult = await client.query(
        `SELECT role
         FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2`,
        [conversation.id, targetUserId],
      );
      if (lockedTargetResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User is not a member' });
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

      await client.query('COMMIT');

      res.json({
        success: true,
        phase: 'prepared',
        operation_id: operation.operationId,
        pending_key_version: operation.reservedKeyVersion,
        current_key_version: currentKeyVersion,
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('Rotate-remove prepare error:', err);
      const status = Number(err?.status) || 500;
      res.status(status).json({
        error: status === 500 ? 'Failed to prepare member removal' : err.message,
        ...(err?.code ? { code: err.code } : {}),
        ...(err?.data || {}),
      });
    } finally {
      client?.release();
    }
  });

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
      if (!membership) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Not a member' });
      }

      const perms = resolvePermissions(conversation.permissions);
      if (!meetsAdminToggle(membership.role, perms.admin_can_remove_members)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'You do not have permission to remove members' });
      }

      const operationId = getMembershipOperationId(req.body);
      const { operation, currentKeyVersion } = await lockMembershipRotation(client, {
        conversationId: conversation.id,
        operationId,
        actorUserId,
        kind: 'remove',
      });

      if (operation.targetUserIds.length !== 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Member removal operation does not contain one target',
          code: 'MEMBERSHIP_OPERATION_MISMATCH',
        });
      }

      if (operation.status === 'finalized') {
        await client.query('ROLLBACK');
        return res.json({
          success: true,
          key_version: operation.reservedKeyVersion,
          message: 'Member removed',
        });
      }

      if (operation.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Member removal operation is no longer pending',
          code: 'MEMBERSHIP_OPERATION_ROLLED_BACK',
        });
      }

      const pendingTarget = operation.targetUserIds[0];
      const pendingKeyVersion = operation.reservedKeyVersion;

      if (pendingKeyVersion !== currentKeyVersion + 1) {
        await markMembershipRotationRolledBack(client, operation.operationId);
        await client.query('COMMIT');
        return res.status(409).json({
          error: 'Pending removal is stale — version has moved',
          code: 'PENDING_REMOVE_STALE',
          current_key_version: currentKeyVersion,
        });
      }

      const targetUserId = pendingTarget;
      const newKeyVersion = pendingKeyVersion;

      const targetMemberResult = await client.query(
        `SELECT role
         FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2
         LIMIT 1`,
        [conversation.id, targetUserId]
      );

      if (targetMemberResult.rows.length === 0) {
        await markMembershipRotationRolledBack(client, operation.operationId);
        await client.query('COMMIT');
        return res.status(409).json({
          error: 'Pending removal target is no longer a member',
          code: 'PENDING_REMOVE_TARGET_MISSING',
        });
      }

      const targetRole = targetMemberResult.rows[0].role;
      const removalAuth = authorizeMemberRemoval({
        actorRole: membership.role,
        targetRole,
        actorUserId,
        targetUserId,
      });

      if (!removalAuth.allowed) {
        if (removalAuth.code === 'TARGET_ROLE_PROTECTED' || removalAuth.code === 'SELF_LEAVE_ROTATION_UNAVAILABLE') {
          await markMembershipRotationRolledBack(client, operation.operationId);
          await client.query('COMMIT');
        } else {
          await client.query('ROLLBACK');
        }

        return res.status(removalAuth.status).json({
          error: removalAuth.error,
          code: removalAuth.code,
        });
      }

      const currentMembersResult = await client.query(
        `SELECT user_id::text AS user_id
         FROM conversation_members
         WHERE conversation_id = $1`,
        [conversation.id]
      );
      const survivorMemberIds = currentMembersResult.rows
        .map((row) => row.user_id)
        .filter((memberId) => String(memberId) !== String(targetUserId));
      const survivorPeerIds = survivorMemberIds.filter((memberId) => String(memberId) !== String(actorUserId));
      const parsedArtifacts = parseMembershipFinalizeArtifacts(
        req.body?.mls_artifacts ?? req.body?.mlsArtifacts,
        {
          expectedWelcomeUserIds: [],
          pendingKeyVersion,
          requireCommit: survivorPeerIds.length > 0,
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

      await insertMembershipFinalizeArtifacts(client, {
        conversationId: conversation.id,
        actorUserId,
        pendingKeyVersion,
        artifacts: parsedArtifacts.artifacts,
      });

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

      const ownerState = await ensureGroupOwner(client, conversation.id);
      conversation.owner_id = ownerState.ownerUserId;

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

      await markMembershipRotationFinalized(client, operation.operationId);

      await client.query('COMMIT');

      sendLiveEventToUser(targetUserId, 'MEMBER_LEAVE', {
        conversation_id: conversation.id,
        conversation_public_id: conversation.public_id ? String(conversation.public_id) : null,
        removed_by: actorUserId,
      });

      if (survivorMemberIds.length > 0) {
        try {
          await emitConversationUpdate(
            conversation,
            survivorMemberIds,
            newKeyVersion,
            survivorMemberIds.length,
          );
        } catch (emitErr) {
          console.warn('Rotate-remove finalize survivor update emit failed:', emitErr);
        }
      }

      res.json({
        success: true,
        key_version: newKeyVersion,
        message: 'Member removed',
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('Rotate-remove finalize error:', err);
      const status = Number(err?.status) || 500;
      res.status(status).json({
        error: status === 500 ? 'Failed to finalize member removal' : err.message,
        ...(err?.code ? { code: err.code } : {}),
      });
    } finally {
      client?.release();
    }
  });

  router.post('/rotate-remove/rollback', async (req, res) => {
    const actorUserId = req.user.id;
    const { conversationId } = req.params;
    const targetUserId = typeof req.body?.target_user_id === 'string' ? req.body.target_user_id.trim() : '';
    const failedKeyVersion = normalizeKeyVersion(req.body?.failed_key_version, 0);

    if (!targetUserId || failedKeyVersion <= 0) {
      return res.status(400).json({ error: 'target_user_id and failed_key_version required' });
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

      const membership = await getGroupMembership(client, conversation.id, actorUserId);
      if (!membership) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Not a member' });
      }

      const operationId = getMembershipOperationId(req.body);
      const { operation, currentKeyVersion } = await lockMembershipRotation(client, {
        conversationId: conversation.id,
        operationId,
        actorUserId,
        kind: 'remove',
      });

      if (
        operation.reservedKeyVersion !== failedKeyVersion ||
        operation.targetUserIds.length !== 1 ||
        operation.targetUserIds[0] !== targetUserId
      ) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Removal target does not match the pending membership operation',
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
      return res.json({
        success: true,
        rolled_back: targetUserId,
        key_version: currentKeyVersion,
        phase: 'pending_cleared',
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('Rotate-remove rollback error:', err);
      const status = Number(err?.status) || 500;
      return res.status(status).json({
        error: status === 500 ? 'Failed to roll back member removal' : err.message,
        ...(err?.code ? { code: err.code } : {}),
      });
    } finally {
      client?.release();
    }
  });
}
