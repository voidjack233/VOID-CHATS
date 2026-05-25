import { Router } from 'express';
import { pool } from '../../db.js';
import { resolveUserAvatarUrl } from '../../utils/avatarFallback.js';
import {
  emitConversationUpdate,
  getChildChannelIds,
  getGroupMembership,
  normalizeKeyVersion,
  resolveMembershipConversation,
} from '../../utils/groupMembership.js';
import { meetsAdminToggle, meetsWhoThreshold, resolvePermissions } from '../../utils/groupPermissions.js';
import { generateInviteCode } from './inviteLinks.js';
import {
  parseMembershipFinalizeArtifacts,
} from './mls/finalizeArtifacts.js';
import {
  finalizeMlsAddedMembers,
  getMembershipOperationId,
  lockMembershipRotation,
  markMembershipRotationRolledBack,
  reserveMembershipRotation,
} from './members/membershipRotations.js';

const router = Router({ mergeParams: true });

function buildInviteUrl(code) {
  const frontUrl = process.env.FRONT_URL || 'https://void0000.online';
  return `${frontUrl.replace(/\/$/, '')}/invite/${code}`;
}

async function ensureOwnerConversation(db, conversationId, userId) {
  const conversation = await resolveMembershipConversation(db, conversationId);
  if (!conversation) {
    return { error: { status: 404, body: { error: 'Conversation not found' } } };
  }

  if (conversation.type !== 'group') {
    return { error: { status: 400, body: { error: 'Invites are only supported for groups' } } };
  }

  const isConversationOwner =
    conversation.owner_id != null &&
    String(conversation.owner_id) === String(userId);

  let membership = await getGroupMembership(db, conversation.id, userId);

  if (!membership) {
    if (!isConversationOwner) {
      return { error: { status: 403, body: { error: 'Not a member' } } };
    }

    const currentKeyVersion = normalizeKeyVersion(conversation.current_key_version, 1);
    await db.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, joined_key_version, history_start_version) VALUES ($1, $2, 'owner', $3, 1) ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = 'owner'`,
      [conversation.id, userId, currentKeyVersion]
    );

    membership = { role: 'owner' };
  }

  if (membership.role !== 'owner') {
    if (!isConversationOwner) {
      return { conversation, membership };
    }

    await db.query(
      `UPDATE conversation_members SET role = 'owner' WHERE conversation_id = $1 AND user_id = $2`,
      [conversation.id, userId]
    );
    membership = { role: 'owner' };
  }

  return { conversation, membership };
}

async function ensureConversationMember(db, conversationId, userId) {
  const conversation = await resolveMembershipConversation(db, conversationId);
  if (!conversation) {
    return { error: { status: 404, body: { error: 'Conversation not found' } } };
  }

  if (conversation.type !== 'group') {
    return { error: { status: 400, body: { error: 'Invites are only supported for groups' } } };
  }

  const isConversationOwner =
    conversation.owner_id != null &&
    String(conversation.owner_id) === String(userId);

  let membership = await getGroupMembership(db, conversation.id, userId);

  if (!membership) {
    if (!isConversationOwner) {
      return { error: { status: 403, body: { error: 'Not a member' } } };
    }

    const currentKeyVersion = normalizeKeyVersion(conversation.current_key_version, 1);
    await db.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, joined_key_version, history_start_version) VALUES ($1, $2, 'owner', $3, 1) ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = 'owner'`,
      [conversation.id, userId, currentKeyVersion]
    );
    membership = { role: 'owner' };
  }

  if (isConversationOwner && membership.role !== 'owner') {
    await db.query(
      `UPDATE conversation_members SET role = 'owner' WHERE conversation_id = $1 AND user_id = $2`,
      [conversation.id, userId]
    );
    membership = { role: 'owner' };
  }

  return { conversation, membership };
}

router.get('/', async (req, res) => {
  const userId = req.user.id;

  try {
    const { conversation, membership, error } = await ensureConversationMember(pool, req.params.conversationId, userId);
    if (error) {
      return res.status(error.status).json(error.body);
    }

    const perms = resolvePermissions(conversation.permissions);
    if (!meetsAdminToggle(membership.role, perms.admin_can_manage_invite_links)) {
      return res.status(403).json({ error: 'You do not have permission to manage invite links' });
    }

    const [linksResult, requestsResult] = await Promise.all([
      pool.query(
        `SELECT id, code, max_uses, use_count, expires_at, is_revoked, created_at
         FROM conversation_invite_links
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [conversation.id]
      ),
      pool.query(
        `SELECT
           cjr.id,
           cjr.status,
           cjr.created_at,
           cjr.invite_link_id,
           u.id AS requester_user_id,
           u.username,
           up.display_name,
           up.avatar_filename,
           up.id AS profile_id
         FROM conversation_join_requests cjr
         JOIN users u ON u.id = cjr.requester_user_id
         JOIN user_profiles up ON up.id = u.profile_id
         WHERE cjr.conversation_id = $1
           AND cjr.status = 'pending'
         ORDER BY cjr.created_at ASC`,
        [conversation.id]
      ),
    ]);

    res.json({
      success: true,
      invites: linksResult.rows.map((row) => ({
        id: row.id,
        code: row.code,
        url: buildInviteUrl(row.code),
        max_uses: row.max_uses != null ? Number(row.max_uses) : null,
        use_count: Number(row.use_count || 0),
        expires_at: row.expires_at,
        is_revoked: row.is_revoked,
        created_at: row.created_at,
      })),
      pending_requests: requestsResult.rows.map((row) => ({
        id: row.id,
        status: row.status,
        created_at: row.created_at,
        invite_link_id: row.invite_link_id,
        requester_user_id: row.requester_user_id,
        username: row.username,
        display_name: row.display_name,
        avatar_url: resolveUserAvatarUrl(row.avatar_filename, {
          displayName: row.display_name,
          username: row.username,
        }),
        profile_id: row.profile_id,
      })),
    });
  } catch (err) {
    console.error('Conversation invites GET error:', err);
    res.status(500).json({ error: 'Failed to fetch invites' });
  }
});

router.post('/', async (req, res) => {
  const userId = req.user.id;
  const maxUses = Number.isInteger(req.body?.max_uses) ? req.body.max_uses : null;
  const expiresInDays = Number.isInteger(req.body?.expires_in_days) ? req.body.expires_in_days : 7;

  if (maxUses != null && maxUses <= 0) {
    return res.status(400).json({ error: 'max_uses must be greater than zero' });
  }

  if (expiresInDays <= 0 || expiresInDays > 365) {
    return res.status(400).json({ error: 'expires_in_days must be between 1 and 365' });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const { conversation, membership, error } = await ensureConversationMember(client, req.params.conversationId, userId);
    if (error) {
      await client.query('ROLLBACK');
      return res.status(error.status).json(error.body);
    }

    const perms = resolvePermissions(conversation.permissions);
    if (!meetsAdminToggle(membership.role, perms.admin_can_manage_invite_links)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You do not have permission to create invite links' });
    }

    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    let createdInvite = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateInviteCode();

      try {
        const result = await client.query(
          `INSERT INTO conversation_invite_links (
             conversation_id,
             created_by_user_id,
             code,
             max_uses,
             expires_at
           )
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, code, max_uses, use_count, expires_at, is_revoked, created_at`,
          [conversation.id, userId, code, maxUses, expiresAt]
        );
        createdInvite = result.rows[0];
        break;
      } catch (err) {
        if (err?.code !== '23505') {
          throw err;
        }
      }
    }

    if (!createdInvite) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Failed to generate a unique invite code' });
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      invite: {
        id: createdInvite.id,
        code: createdInvite.code,
        url: buildInviteUrl(createdInvite.code),
        max_uses: createdInvite.max_uses != null ? Number(createdInvite.max_uses) : null,
        use_count: Number(createdInvite.use_count || 0),
        expires_at: createdInvite.expires_at,
        is_revoked: createdInvite.is_revoked,
        created_at: createdInvite.created_at,
      },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Conversation invites POST error:', err);
    res.status(500).json({ error: 'Failed to create invite link' });
  } finally {
    client?.release();
  }
});

router.post('/requests/:requestId/approve', async (req, res) => {
  const actorUserId = req.user.id;
  const requestId = parseInt(req.params.requestId, 10);
  const newKeyVersion = normalizeKeyVersion(req.body?.new_key_version, 0);

  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Valid requestId required' });
  }

  if (newKeyVersion <= 0) {
    return res.status(400).json({ error: 'new_key_version required' });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const { conversation, membership, error } = await ensureConversationMember(client, req.params.conversationId, actorUserId);
    if (error) {
      await client.query('ROLLBACK');
      return res.status(error.status).json(error.body);
    }

    const perms = resolvePermissions(conversation.permissions);
    if (!meetsAdminToggle(membership.role, perms.admin_can_approve_join_requests)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You do not have permission to approve join requests' });
    }

    const requestResult = await client.query(
      `SELECT id, requester_user_id, invite_link_id, status
       FROM conversation_join_requests
       WHERE id = $1 AND conversation_id = $2
       LIMIT 1`,
      [requestId, conversation.id]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Join request not found' });
    }

    const joinRequest = requestResult.rows[0];
    if (joinRequest.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Join request is no longer pending' });
    }

    const { operation, currentKeyVersion } = await reserveMembershipRotation(client, {
      conversationId: conversation.id,
      actorUserId,
      kind: 'invite_approval',
      targetUserIds: [joinRequest.requester_user_id],
      requestedKeyVersion: newKeyVersion,
      joinRequestId: joinRequest.id,
    });

    const currentMembersResult = await client.query(
      `SELECT user_id
       FROM conversation_members
       WHERE conversation_id = $1`,
      [conversation.id]
    );

    const currentMemberIds = currentMembersResult.rows.map((row) => row.user_id);
    if (currentMemberIds.includes(joinRequest.requester_user_id)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'User is already a member',
        code: 'ALREADY_MEMBER',
      });
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      phase: 'prepared',
      requester_user_id: joinRequest.requester_user_id,
      operation_id: operation.operationId,
      pending_key_version: operation.reservedKeyVersion,
      current_key_version: currentKeyVersion,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Approve join request prepare error:', err);
    const status = Number(err?.status) || 500;
    res.status(status).json({
      error: status === 500 ? 'Failed to prepare join approval' : err.message,
      ...(err?.code ? { code: err.code } : {}),
      ...(err?.data || {}),
    });
  } finally {
    client?.release();
  }
});

// POST /api/conversations/:conversationId/invites/requests/:requestId/approve/finalize
//
// Phase 2 of invite approval. Publishes the generated MLS artifacts in the
// same transaction that commits membership and advances the key version.
router.post('/requests/:requestId/approve/finalize', async (req, res) => {
  const actorUserId = req.user.id;
  const requestId = parseInt(req.params.requestId, 10);

  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Valid requestId required' });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const { conversation, membership, error } = await ensureConversationMember(client, req.params.conversationId, actorUserId);
    if (error) {
      await client.query('ROLLBACK');
      return res.status(error.status).json(error.body);
    }

    const perms = resolvePermissions(conversation.permissions);
    if (!meetsAdminToggle(membership.role, perms.admin_can_approve_join_requests)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You do not have permission to approve join requests' });
    }

    const requestResult = await client.query(
      `SELECT id, requester_user_id, invite_link_id, status
       FROM conversation_join_requests
       WHERE id = $1 AND conversation_id = $2
       LIMIT 1`,
      [requestId, conversation.id]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Join request not found' });
    }

    const joinRequest = requestResult.rows[0];

    const operationId = getMembershipOperationId(req.body);
    const { operation, currentKeyVersion } = await lockMembershipRotation(client, {
      conversationId: conversation.id,
      operationId,
      actorUserId,
      kind: 'invite_approval',
      joinRequestId: joinRequest.id,
    });
    const pendingKeyVersion = operation.reservedKeyVersion;

    if (operation.targetUserIds.length !== 1 || operation.targetUserIds[0] !== String(joinRequest.requester_user_id)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Membership rotation does not match this join request',
        code: 'MEMBERSHIP_OPERATION_MISMATCH',
      });
    }

    if (operation.status === 'finalized' && joinRequest.status === 'approved') {
      await client.query('ROLLBACK');
      return res.json({
        success: true,
        phase: 'finalized',
        approved_user_id: joinRequest.requester_user_id,
        key_version: pendingKeyVersion,
      });
    }

    if (operation.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Join approval operation is no longer pending',
        code: 'MEMBERSHIP_OPERATION_ROLLED_BACK',
      });
    }

    if (pendingKeyVersion !== currentKeyVersion + 1) {
      await markMembershipRotationRolledBack(client, operation.operationId);
      await client.query('COMMIT');
      return res.status(409).json({
        error: 'Pending approval is stale — version has moved',
        code: 'PENDING_APPROVAL_STALE',
        current_key_version: currentKeyVersion,
      });
    }

    if (joinRequest.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Join request is no longer pending',
        code: 'REQUEST_STATUS_INVALID',
        request_status: joinRequest.status,
      });
    }

    const existingMember = await client.query(
      `SELECT 1
       FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2
       LIMIT 1`,
      [conversation.id, joinRequest.requester_user_id]
    );

    if (existingMember.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'User is already a member',
        code: 'ALREADY_MEMBER',
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
        expectedWelcomeUserIds: [joinRequest.requester_user_id],
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
      reason: 'invite_accept',
    });

    await client.query(
      `UPDATE conversation_join_requests
       SET status = 'approved',
           resolved_at = NOW(),
           resolved_by_user_id = $2
       WHERE id = $1`,
      [joinRequest.id, actorUserId]
    );

    if (joinRequest.invite_link_id) {
      await client.query(
        `UPDATE conversation_invite_links
         SET use_count = use_count + 1
         WHERE id = $1`,
        [joinRequest.invite_link_id]
      );
    }

    await client.query('COMMIT');

    const updatedMemberIds = [...new Set([...currentMemberIds, String(joinRequest.requester_user_id)])];
    if (updatedMemberIds.length > 0) {
      try {
        await emitConversationUpdate(
          conversation,
          updatedMemberIds,
          pendingKeyVersion,
          updatedMemberIds.length,
        );
      } catch (emitErr) {
        console.warn('Finalize join approval member update emit failed:', emitErr);
      }
    }

    res.json({
      success: true,
      phase: 'finalized',
      approved_user_id: joinRequest.requester_user_id,
      key_version: pendingKeyVersion,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Finalize join approval error:', err);
    const status = Number(err?.status) || 500;
    res.status(status).json({
      error: status === 500 ? 'Failed to finalize join approval' : err.message,
      ...(err?.code ? { code: err.code } : {}),
    });
  } finally {
    client?.release();
  }
});

// POST /api/conversations/:conversationId/invites/requests/:requestId/rollback-approval
// Revert an approval when MLS add/welcome failed before secure membership completed.
router.post('/requests/:requestId/rollback-approval', async (req, res) => {
  const actorUserId = req.user.id;
  const requestId = parseInt(req.params.requestId, 10);
  const failedKeyVersion = normalizeKeyVersion(req.body?.failed_key_version, 0);

  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Valid requestId required' });
  }

  if (failedKeyVersion <= 0) {
    return res.status(400).json({ error: 'failed_key_version required' });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const { conversation, membership, error } = await ensureConversationMember(client, req.params.conversationId, actorUserId);
    if (error) {
      await client.query('ROLLBACK');
      return res.status(error.status).json(error.body);
    }

    const perms = resolvePermissions(conversation.permissions);
    if (!meetsAdminToggle(membership.role, perms.admin_can_approve_join_requests)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You do not have permission to manage join requests' });
    }

    const requestResult = await client.query(
      `SELECT id, requester_user_id, invite_link_id, status
       FROM conversation_join_requests
       WHERE id = $1 AND conversation_id = $2
       LIMIT 1`,
      [requestId, conversation.id]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Join request not found' });
    }

    const joinRequest = requestResult.rows[0];
    const operationId = getMembershipOperationId(req.body);
    const { operation, currentKeyVersion } = await lockMembershipRotation(client, {
      conversationId: conversation.id,
      operationId,
      actorUserId,
      kind: 'invite_approval',
      joinRequestId: joinRequest.id,
    });

    if (
      operation.reservedKeyVersion !== failedKeyVersion ||
      operation.targetUserIds.length !== 1 ||
      operation.targetUserIds[0] !== String(joinRequest.requester_user_id)
    ) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Join request does not match the pending membership operation',
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
      requester_user_id: joinRequest.requester_user_id,
      key_version: currentKeyVersion,
      request_status: joinRequest.status,
      phase: 'pending_cleared',
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Rollback approval error:', err);
    const status = Number(err?.status) || 500;
    res.status(status).json({
      error: status === 500 ? 'Failed to roll back join approval' : err.message,
      ...(err?.code ? { code: err.code } : {}),
    });
  } finally {
    client?.release();
  }
});

router.post('/requests/:requestId/decline', async (req, res) => {
  const actorUserId = req.user.id;
  const requestId = parseInt(req.params.requestId, 10);

  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Valid requestId required' });
  }

  try {
    const { conversation, membership, error } = await ensureConversationMember(pool, req.params.conversationId, actorUserId);
    if (error) {
      return res.status(error.status).json(error.body);
    }

    const perms = resolvePermissions(conversation.permissions);
    if (!meetsAdminToggle(membership.role, perms.admin_can_approve_join_requests)) {
      return res.status(403).json({ error: 'You do not have permission to manage join requests' });
    }

    const result = await pool.query(
      `UPDATE conversation_join_requests
       SET status = 'declined',
           resolved_at = NOW(),
           resolved_by_user_id = $2
       WHERE id = $1
         AND conversation_id = $3
         AND status = 'pending'
       RETURNING id`,
      [requestId, actorUserId, conversation.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pending join request not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Decline join request error:', err);
    res.status(500).json({ error: 'Failed to decline join request' });
  }
});

router.post('/:inviteId/revoke', async (req, res) => {
  const actorUserId = req.user.id;
  const inviteId = parseInt(req.params.inviteId, 10);

  if (!Number.isInteger(inviteId) || inviteId <= 0) {
    return res.status(400).json({ error: 'Valid inviteId required' });
  }

  try {
    const { conversation, membership, error } = await ensureConversationMember(pool, req.params.conversationId, actorUserId);
    if (error) {
      return res.status(error.status).json(error.body);
    }

    const perms = resolvePermissions(conversation.permissions);
    if (!meetsAdminToggle(membership.role, perms.admin_can_manage_invite_links)) {
      return res.status(403).json({ error: 'You do not have permission to manage invite links' });
    }

    const result = await pool.query(
      `UPDATE conversation_invite_links
       SET is_revoked = TRUE
       WHERE id = $1
         AND conversation_id = $2
       RETURNING id`,
      [inviteId, conversation.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invite link not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Revoke invite error:', err);
    res.status(500).json({ error: 'Failed to revoke invite link' });
  }
});

export default router;
