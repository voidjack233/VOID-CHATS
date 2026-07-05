import {
  ensureGroupOwner,
  normalizeKeyVersion,
  uniqueUserIds,
} from '../../../utils/groupMembership.js';
import { insertMembershipFinalizeArtifacts } from '../mls/finalizeArtifacts.js';

const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROTATION_TTL_MS = 15 * 60 * 1000;

function rotationError(message, code, status = 409, data = {}) {
  return Object.assign(new Error(message), { code, status, data });
}

function normalizeTargetUserIds(values) {
  return uniqueUserIds(values).sort();
}

function targetListsMatch(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeRotation(row) {
  return {
    operationId: String(row.operation_id),
    kind: row.kind,
    actorUserId: String(row.actor_user_id),
    targetUserIds: normalizeTargetUserIds(row.target_user_ids),
    reservedKeyVersion: Number(row.reserved_key_version),
    joinRequestId: row.join_request_id == null ? null : Number(row.join_request_id),
    status: row.status,
  };
}

export function getMembershipOperationId(body) {
  const value = body?.operation_id ?? body?.operationId;
  if (typeof value !== 'string' || !OPERATION_ID_RE.test(value.trim())) {
    throw rotationError('A valid membership operation_id is required', 'MEMBERSHIP_OPERATION_ID_REQUIRED', 400);
  }

  return value.trim();
}

export async function reserveMembershipRotation(
  client,
  {
    conversationId,
    actorUserId,
    kind,
    targetUserIds,
    requestedKeyVersion,
    joinRequestId = null,
    expiresInMs = ROTATION_TTL_MS,
  },
) {
  const normalizedTargets = normalizeTargetUserIds(targetUserIds);
  const lockedResult = await client.query(
    `SELECT current_key_version,
            pending_add_key_version,
            pending_remove_key_version,
            pending_approve_key_version
     FROM conversations
     WHERE id = $1
     FOR UPDATE`,
    [conversationId],
  );

  if (lockedResult.rows.length === 0) {
    throw rotationError('Conversation not found', 'CONVERSATION_NOT_FOUND', 404);
  }

  const lockedConversation = lockedResult.rows[0];
  const currentKeyVersion = normalizeKeyVersion(lockedConversation.current_key_version, 1);
  const reservedKeyVersion = currentKeyVersion + 1;

  if (
    lockedConversation.pending_add_key_version != null ||
    lockedConversation.pending_remove_key_version != null ||
    lockedConversation.pending_approve_key_version != null
  ) {
    throw rotationError(
      'A membership rotation prepared by an older server version is still pending',
      'MEMBERSHIP_ROTATION_PENDING',
      409,
      { legacy: true },
    );
  }

  await client.query(
    `UPDATE conversation_membership_rotations
     SET status = 'rolled_back',
         rolled_back_at = NOW()
     WHERE conversation_id = $1
       AND status = 'pending'
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()`,
    [conversationId],
  );

  const pendingResult = await client.query(
    `SELECT operation_id,
            kind,
            actor_user_id,
            target_user_ids,
            reserved_key_version,
            join_request_id,
            status
     FROM conversation_membership_rotations
     WHERE conversation_id = $1
       AND status = 'pending'
     LIMIT 1
     FOR UPDATE`,
    [conversationId],
  );

  if (pendingResult.rows.length > 0) {
    const pending = normalizeRotation(pendingResult.rows[0]);
    const isRetry =
      pending.kind === kind &&
      pending.actorUserId === String(actorUserId) &&
      pending.joinRequestId === (joinRequestId == null ? null : Number(joinRequestId)) &&
      targetListsMatch(pending.targetUserIds, normalizedTargets) &&
      pending.reservedKeyVersion === requestedKeyVersion;

    if (isRetry) {
      return { operation: pending, currentKeyVersion, reused: true };
    }

    throw rotationError(
      'Another secure membership change is already pending for this conversation',
      'MEMBERSHIP_ROTATION_PENDING',
      409,
      {
        operation_id: pending.operationId,
        kind: pending.kind,
        reserved_key_version: pending.reservedKeyVersion,
      },
    );
  }

  if (requestedKeyVersion !== reservedKeyVersion) {
    throw rotationError(
      `Expected new_key_version ${reservedKeyVersion}`,
      'INVALID_KEY_VERSION',
      409,
      { current_key_version: currentKeyVersion },
    );
  }

  const insertResult = await client.query(
    `INSERT INTO conversation_membership_rotations (
       conversation_id,
       kind,
       actor_user_id,
       target_user_ids,
       reserved_key_version,
       join_request_id,
       expires_at
     )
     VALUES (
       $1,
       $2,
       $3::UUID,
       $4::UUID[],
       $5,
       $6,
       CASE
         WHEN $7::BIGINT IS NULL THEN NULL
         ELSE NOW() + ($7::BIGINT * INTERVAL '1 millisecond')
       END
     )
     RETURNING operation_id,
               kind,
               actor_user_id,
               target_user_ids,
               reserved_key_version,
               join_request_id,
               status`,
    [
      conversationId,
      kind,
      actorUserId,
      normalizedTargets,
      reservedKeyVersion,
      joinRequestId,
      expiresInMs,
    ],
  );

  return {
    operation: normalizeRotation(insertResult.rows[0]),
    currentKeyVersion,
    reused: false,
  };
}

export async function lockMembershipRotation(
  client,
  {
    conversationId,
    operationId,
    actorUserId,
    kind,
    joinRequestId = null,
    allowDifferentActor = false,
  },
) {
  const lockedConversation = await client.query(
    `SELECT current_key_version
     FROM conversations
     WHERE id = $1
     FOR UPDATE`,
    [conversationId],
  );
  if (lockedConversation.rows.length === 0) {
    throw rotationError('Conversation not found', 'CONVERSATION_NOT_FOUND', 404);
  }

  const result = await client.query(
    `SELECT operation_id,
            kind,
            actor_user_id,
            target_user_ids,
            reserved_key_version,
            join_request_id,
            status
     FROM conversation_membership_rotations
     WHERE conversation_id = $1
       AND operation_id = $2::UUID
     LIMIT 1
     FOR UPDATE`,
    [conversationId, operationId],
  );

  if (result.rows.length === 0) {
    throw rotationError('Membership rotation was not found', 'MEMBERSHIP_OPERATION_NOT_FOUND', 409);
  }

  const operation = normalizeRotation(result.rows[0]);
  if (
    operation.kind !== kind ||
    (!allowDifferentActor && operation.actorUserId !== String(actorUserId)) ||
    operation.joinRequestId !== (joinRequestId == null ? null : Number(joinRequestId))
  ) {
    throw rotationError('Membership rotation does not match this request', 'MEMBERSHIP_OPERATION_MISMATCH', 409);
  }

  return {
    operation,
    currentKeyVersion: normalizeKeyVersion(lockedConversation.rows[0].current_key_version, 1),
  };
}

export async function markMembershipRotationRolledBack(client, operationId) {
  await client.query(
    `UPDATE conversation_membership_rotations
     SET status = 'rolled_back',
         rolled_back_at = NOW()
     WHERE operation_id = $1::UUID
       AND status = 'pending'`,
    [operationId],
  );
}

export async function markMembershipRotationFinalized(client, operationId) {
  await client.query(
    `UPDATE conversation_membership_rotations
     SET status = 'finalized',
         finalized_at = NOW()
     WHERE operation_id = $1::UUID
       AND status = 'pending'`,
    [operationId],
  );
}

export async function finalizeMlsAddedMembers(
  client,
  {
    conversationId,
    actorUserId,
    currentKeyVersion,
    operation,
    artifacts,
    childChannelIds,
    reason,
  },
) {
  await insertMembershipFinalizeArtifacts(client, {
    conversationId,
    actorUserId,
    pendingKeyVersion: operation.reservedKeyVersion,
    artifacts,
  });

  for (const memberId of operation.targetUserIds) {
    await client.query(
      `INSERT INTO conversation_members (
         conversation_id,
         user_id,
         role,
         joined_key_version,
         history_start_version
       )
       VALUES ($1, $2, 'member', $3, $3)`,
      [conversationId, memberId, operation.reservedKeyVersion],
    );

    for (const channelId of childChannelIds) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [channelId, memberId],
      );
    }

    await client.query(
      `INSERT INTO conversation_key_rotations (
         conversation_id,
         previous_key_version,
         new_key_version,
         rotated_by_user_id,
         reason,
         affected_user_id
       )
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [conversationId, currentKeyVersion, operation.reservedKeyVersion, actorUserId, reason, memberId],
    );
  }

  await ensureGroupOwner(client, conversationId);

  await client.query(
    `UPDATE conversations
     SET current_key_version = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [conversationId, operation.reservedKeyVersion],
  );

  await markMembershipRotationFinalized(client, operation.operationId);
}
