import { pool } from '../../../db.js';
import valkey from '../../../valkey.js';
import { debugLog } from '../../../utils/debugLog.js';
import {
  emitConversationUpdate,
  getGroupMembership,
  resolveMembershipConversation,
} from '../../../utils/groupMembership.js';
import {
  insertMembershipFinalizeArtifacts,
  parseMembershipFinalizeArtifacts,
  resolveMembershipRepairWelcomeUserIds,
} from '../mls/finalizeArtifacts.js';
import {
  getMembershipOperationId,
  lockMembershipRotation,
  markMembershipRotationFinalized,
} from './membershipRotations.js';

const SELF_LEAVE_CLAIM_TTL_SECONDS = 60;

function selfLeaveClaimKey(conversationId, operationId) {
  return `mls:self_leave:claim:${conversationId}:${operationId}`;
}

async function postSelfLeaveSystemMessage({
  conversationId,
  finalizerUserId,
  keyVersion,
  operationId,
  targetUserId,
}) {
  const identityResult = await pool.query(
    `SELECT COALESCE(NULLIF(profiles.display_name, ''), users.username, 'A member') AS target_label
     FROM users
     LEFT JOIN user_profiles profiles ON profiles.id = users.profile_id
     WHERE users.id = $1
     LIMIT 1`,
    [targetUserId],
  );
  const targetLabel = identityResult.rows[0]?.target_label || 'A member';
  const { sendConversationMessage } = await import('../messages/sendMessage.js');

  await sendConversationMessage({
    userId: finalizerUserId,
    conversationIdentifier: conversationId,
    body: {
      content: `${targetLabel} left the group.`,
      key_version: keyVersion,
      message_type: 'system',
      client_message_id: `self-leave:${operationId}`,
    },
  });
}

export function registerMemberSelfLeaveRoutes(router, {
  cache = valkey,
  database = pool,
  emitUpdate = emitConversationUpdate,
  getMembership = getGroupMembership,
  insertFinalizeArtifacts = insertMembershipFinalizeArtifacts,
  lockRotation = lockMembershipRotation,
  markRotationFinalized = markMembershipRotationFinalized,
  postSystemMessage = postSelfLeaveSystemMessage,
  resolveConversation = resolveMembershipConversation,
} = {}) {
  router.post('/self-leave/claim', async (req, res) => {
    const claimantUserId = req.user.id;
    const { conversationId } = req.params;

    try {
      const conversation = await resolveConversation(database, conversationId);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const membership = await getMembership(database, conversation.id, claimantUserId);
      if (!membership) {
        return res.status(403).json({
          error: 'Only a remaining group member can claim this rotation',
          code: 'SELF_LEAVE_FINALIZER_NOT_MEMBER',
        });
      }
      if (membership.role === 'member') {
        debugLog('[SELF_LEAVE] member-role survivor requested claim', {
          conversation_id: conversation.id,
          user_id: claimantUserId,
        });
      }

      const operationId = getMembershipOperationId(req.body);
      const operationResult = await database.query(
        `SELECT operation_id::text AS operation_id,
                target_user_ids,
                reserved_key_version,
                status
         FROM conversation_membership_rotations
         WHERE conversation_id = $1
           AND operation_id = $2::UUID
           AND kind = 'self_leave'
         LIMIT 1`,
        [conversation.id, operationId],
      );
      if (operationResult.rows.length === 0) {
        return res.status(409).json({
          error: 'Self-leave rotation was not found',
          code: 'MEMBERSHIP_OPERATION_NOT_FOUND',
        });
      }

      const operation = operationResult.rows[0];
      const targetUserIds = Array.isArray(operation.target_user_ids)
        ? operation.target_user_ids.map(String)
        : [];
      if (targetUserIds.length !== 1) {
        return res.status(409).json({
          error: 'Self-leave rotation must contain exactly one target',
          code: 'MEMBERSHIP_OPERATION_MISMATCH',
        });
      }

      if (operation.status === 'finalized') {
        return res.json({
          success: true,
          claimed: false,
          already_finalized: true,
          removed_user_id: targetUserIds[0],
          key_version: Number(operation.reserved_key_version),
        });
      }
      if (operation.status !== 'pending') {
        return res.status(409).json({
          error: 'Self-leave rotation is no longer pending',
          code: 'SELF_LEAVE_ROTATION_NOT_PENDING',
        });
      }

      if (Number(operation.reserved_key_version) !== Number(conversation.current_key_version) + 1) {
        return res.status(409).json({
          error: 'Self-leave rotation is stale and requires repair',
          code: 'SELF_LEAVE_ROTATION_STALE',
          current_key_version: Number(conversation.current_key_version),
        });
      }

      const targetMembershipResult = await database.query(
        `SELECT 1
         FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2
         LIMIT 1`,
        [conversation.id, targetUserIds[0]],
      );
      if (targetMembershipResult.rows.length > 0) {
        return res.status(409).json({
          error: 'Self-leave target is still an active member',
          code: 'SELF_LEAVE_TARGET_STILL_ACTIVE',
        });
      }

      const claimKey = selfLeaveClaimKey(conversation.id, operationId);
      const claimed = await cache.set(
        claimKey,
        String(claimantUserId),
        'EX',
        SELF_LEAVE_CLAIM_TTL_SECONDS,
        'NX',
      );

      if (claimed === 'OK') {
        return res.json({
          success: true,
          claimed: true,
          claim_ttl_seconds: SELF_LEAVE_CLAIM_TTL_SECONDS,
        });
      }

      const [claimOwner, claimTtl] = await Promise.all([
        cache.get(claimKey),
        cache.ttl(claimKey),
      ]);
      if (claimOwner === String(claimantUserId)) {
        await cache.expire(claimKey, SELF_LEAVE_CLAIM_TTL_SECONDS);
        return res.json({
          success: true,
          claimed: true,
          claim_ttl_seconds: SELF_LEAVE_CLAIM_TTL_SECONDS,
        });
      }

      return res.json({
        success: true,
        claimed: false,
        retry_after_seconds: Math.max(1, claimTtl),
      });
    } catch (err) {
      console.error('Self-leave claim error:', err);
      const status = Number(err?.status) || 500;
      return res.status(status).json({
        error: status === 500 ? 'Failed to claim secure self-leave' : err.message,
        ...(err?.code ? { code: err.code } : {}),
      });
    }
  });

  router.post('/self-leave/finalize', async (req, res) => {
    const finalizerUserId = req.user.id;
    const { conversationId } = req.params;
    let client;

    try {
      client = await database.connect();
      await client.query('BEGIN');

      const conversation = await resolveConversation(client, conversationId);
      if (!conversation) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const membership = await getMembership(client, conversation.id, finalizerUserId);
      if (!membership) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'Only a remaining group member can secure this leave',
          code: 'SELF_LEAVE_FINALIZER_NOT_MEMBER',
        });
      }

      const operationId = getMembershipOperationId(req.body);
      const { operation, currentKeyVersion } = await lockRotation(client, {
        conversationId: conversation.id,
        operationId,
        actorUserId: finalizerUserId,
        kind: 'self_leave',
        allowDifferentActor: true,
      });

      if (operation.targetUserIds.length !== 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Self-leave rotation must contain exactly one target',
          code: 'MEMBERSHIP_OPERATION_MISMATCH',
        });
      }

      const targetUserId = operation.targetUserIds[0];
      if (operation.status === 'finalized') {
        await client.query('ROLLBACK');
        await cache.del(selfLeaveClaimKey(conversation.id, operation.operationId)).catch(() => {});
        return res.json({
          success: true,
          phase: 'finalized',
          already_finalized: true,
          removed_user_id: targetUserId,
          key_version: operation.reservedKeyVersion,
        });
      }

      if (operation.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Self-leave rotation is no longer pending',
          code: 'SELF_LEAVE_ROTATION_NOT_PENDING',
        });
      }

      if (operation.reservedKeyVersion !== currentKeyVersion + 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Self-leave rotation is stale and requires repair',
          code: 'SELF_LEAVE_ROTATION_STALE',
          current_key_version: currentKeyVersion,
        });
      }

      const claimOwner = await cache
        .get(selfLeaveClaimKey(conversation.id, operation.operationId))
        .catch(() => null);
      if (claimOwner && claimOwner !== String(finalizerUserId)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Another member is securing this leave',
          code: 'SELF_LEAVE_CLAIM_HELD',
        });
      }

      const targetMembershipResult = await client.query(
        `SELECT 1
         FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2
         LIMIT 1`,
        [conversation.id, targetUserId],
      );
      if (targetMembershipResult.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Self-leave target is still an active member',
          code: 'SELF_LEAVE_TARGET_STILL_ACTIVE',
        });
      }

      const survivorResult = await client.query(
        `SELECT user_id::text AS user_id, role
         FROM conversation_members
         WHERE conversation_id = $1`,
        [conversation.id],
      );
      const survivorMemberIds = survivorResult.rows.map((row) => row.user_id);
      const survivorRolesById = Object.fromEntries(
        survivorResult.rows.map((row) => [row.user_id, row.role]),
      );
      const rawArtifacts = req.body?.mls_artifacts ?? req.body?.mlsArtifacts;
      const welcomeResolution = resolveMembershipRepairWelcomeUserIds(
        rawArtifacts,
        survivorMemberIds,
      );
      if (welcomeResolution.error) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          success: false,
          error: welcomeResolution.error,
          code: welcomeResolution.code,
        });
      }

      const parsedArtifacts = parseMembershipFinalizeArtifacts(
        rawArtifacts,
        {
          expectedWelcomeUserIds: welcomeResolution.welcomeUserIds,
          pendingKeyVersion: operation.reservedKeyVersion,
          requireCommit: survivorMemberIds.length > 1,
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

      await insertFinalizeArtifacts(client, {
        conversationId: conversation.id,
        actorUserId: finalizerUserId,
        pendingKeyVersion: operation.reservedKeyVersion,
        artifacts: parsedArtifacts.artifacts,
      });

      await client.query(
        `UPDATE conversations
         SET current_key_version = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [conversation.id, operation.reservedKeyVersion],
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
         VALUES ($1, $2, $3, $4, 'member_self_leave', $5)`,
        [
          conversation.id,
          currentKeyVersion,
          operation.reservedKeyVersion,
          finalizerUserId,
          targetUserId,
        ],
      );

      await markRotationFinalized(client, operation.operationId);
      await client.query('COMMIT');
      await cache.del(selfLeaveClaimKey(conversation.id, operation.operationId)).catch(() => {});

      try {
        await postSystemMessage({
          conversationId: conversation.id,
          finalizerUserId,
          keyVersion: operation.reservedKeyVersion,
          operationId: operation.operationId,
          targetUserId,
        });
      } catch (messageError) {
        console.warn('Self-leave finalized but system message failed:', messageError);
      }

      if (membership.role === 'member') {
        debugLog('[SELF_LEAVE] member-role survivor finalized successfully', {
          conversation_id: conversation.id,
          user_id: finalizerUserId,
          key_version: operation.reservedKeyVersion,
        });
      }

      try {
        await emitUpdate(
          conversation,
          survivorMemberIds,
          operation.reservedKeyVersion,
          survivorMemberIds.length,
          survivorRolesById,
        );
      } catch (emitError) {
        console.warn('Self-leave finalized but survivor update emit failed:', emitError);
      }

      return res.json({
        success: true,
        phase: 'finalized',
        already_finalized: false,
        removed_user_id: targetUserId,
        key_version: operation.reservedKeyVersion,
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('Self-leave finalize error:', err);
      const status = Number(err?.status) || 500;
      return res.status(status).json({
        error: status === 500 ? 'Failed to finalize secure self-leave' : err.message,
        ...(err?.code ? { code: err.code } : {}),
        ...(err?.data || {}),
      });
    } finally {
      client?.release();
    }
  });
}
