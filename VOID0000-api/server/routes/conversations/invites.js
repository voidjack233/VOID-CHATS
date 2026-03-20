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
import { generateInviteCode } from './inviteLinks.js';

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
      return { error: { status: 403, body: { error: 'Only the owner can manage invite links' } } };
    }

    await db.query(
      `UPDATE conversation_members SET role = 'owner' WHERE conversation_id = $1 AND user_id = $2`,
      [conversation.id, userId]
    );
  }

  return { conversation };
}

router.get('/', async (req, res) => {
  const userId = req.user.id;

  try {
    const { conversation, error } = await ensureOwnerConversation(pool, req.params.conversationId, userId);
    if (error) {
      return res.status(error.status).json(error.body);
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

    const { conversation, error } = await ensureOwnerConversation(client, req.params.conversationId, userId);
    if (error) {
      await client.query('ROLLBACK');
      return res.status(error.status).json(error.body);
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

    const { conversation, error } = await ensureOwnerConversation(client, req.params.conversationId, actorUserId);
    if (error) {
      await client.query('ROLLBACK');
      return res.status(error.status).json(error.body);
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

    // Lock the conversation row to serialize concurrent membership changes
    // across all devices/tabs/admins for this conversation.
    const lockedVersionResult = await client.query(
      'SELECT current_key_version FROM conversations WHERE id = $1 FOR UPDATE',
      [conversation.id]
    );
    const currentKeyVersion = normalizeKeyVersion(lockedVersionResult.rows[0].current_key_version, 1);
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
    if (currentMemberIds.includes(joinRequest.requester_user_id)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'User is already a member',
        code: 'ALREADY_MEMBER',
      });
    }

    const finalMemberIds = [...currentMemberIds, joinRequest.requester_user_id];
    const childChannelIds = await getChildChannelIds(client, conversation.id);

    await client.query(
      `INSERT INTO conversation_members (
         conversation_id,
         user_id,
         role,
         joined_key_version,
         history_start_version
       )
       VALUES ($1, $2, 'member', $3, $3)`,
      [conversation.id, joinRequest.requester_user_id, newKeyVersion]
    );

    for (const channelId of childChannelIds) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [channelId, joinRequest.requester_user_id]
      );
    }

    await client.query(
      `UPDATE conversations
       SET current_key_version = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [conversation.id, newKeyVersion]
    );

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

    await client.query(
      `INSERT INTO conversation_key_rotations (
         conversation_id,
         previous_key_version,
         new_key_version,
         rotated_by_user_id,
         reason,
         affected_user_id
       )
       VALUES ($1, $2, $3, $4, 'invite_accept', $5)`,
      [conversation.id, currentKeyVersion, newKeyVersion, actorUserId, joinRequest.requester_user_id]
    );

    await client.query('COMMIT');

    // NOTE: emitConversationUpdate is deliberately NOT called here.
    // The client triggers the broadcast AFTER uploading durable MLS
    // recovery artifacts (group state, welcomes, commits) via
    // POST /members/emit-update, so other devices only learn about
    // the new version once they can actually recover it.

    res.json({
      success: true,
      approved_user_id: joinRequest.requester_user_id,
      key_version: newKeyVersion,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Approve join request error:', err);
    res.status(500).json({ error: 'Failed to approve join request' });
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
    const { conversation, error } = await ensureOwnerConversation(pool, req.params.conversationId, actorUserId);
    if (error) {
      return res.status(error.status).json(error.body);
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
    const { conversation, error } = await ensureOwnerConversation(pool, req.params.conversationId, actorUserId);
    if (error) {
      return res.status(error.status).json(error.body);
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
