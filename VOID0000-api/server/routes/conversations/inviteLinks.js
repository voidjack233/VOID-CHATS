import crypto from 'crypto';
import { Router } from 'express';
import { pool } from '../../db.js';
import { authenticateUser } from '../../middleware/jwt.js';
import { BUCKET, GROUP_AVATAR_BUCKET } from '../../minio.js';
import { resolveUserAvatarUrl } from '../../utils/avatarFallback.js';

const router = Router();

function isInviteLinkActive(inviteLink) {
  if (!inviteLink || inviteLink.is_revoked) return false;

  if (inviteLink.expires_at && new Date(inviteLink.expires_at).getTime() <= Date.now()) {
    return false;
  }

  if (
    inviteLink.max_uses != null &&
    Number.isInteger(inviteLink.max_uses) &&
    Number(inviteLink.use_count || 0) >= Number(inviteLink.max_uses)
  ) {
    return false;
  }

  return true;
}

const baseUrl = process.env.CDN_URL || 'https://cdn.void0000.online';

const buildObjectUrl = (bucket, filename) => (
  filename ? `${baseUrl}/${bucket}/${filename}` : null
);
const resolveGroupIconBucket = (filename) => (
  filename?.startsWith('groups/')
    ? BUCKET
    : GROUP_AVATAR_BUCKET
);
const buildAvatarUrl = (filename) => (
  buildObjectUrl(BUCKET, filename)
);
const buildGroupIconUrl = (filename) => (
  filename ? buildObjectUrl(resolveGroupIconBucket(filename), filename) : null
);

async function getInviteLinkPreview(code, db = pool) {
  const result = await db.query(
    `SELECT
       cil.id,
       cil.code,
       cil.max_uses,
       cil.use_count,
       cil.expires_at,
       cil.is_revoked,
       cil.created_at,
       c.id AS conversation_id,
       c.public_id AS conversation_public_id,
       c.name AS conversation_name,
       c.icon_filename AS conversation_icon_filename,
       c.owner_id,
       up.display_name AS owner_display_name,
       u.username AS owner_username,
       up.avatar_filename AS owner_avatar_filename,
       (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count
     FROM conversation_invite_links cil
     JOIN conversations c ON c.id = cil.conversation_id
     LEFT JOIN users u ON u.id = c.owner_id
     LEFT JOIN user_profiles up ON up.id = u.profile_id
     WHERE cil.code = $1
       AND c.type = 'group'
     LIMIT 1`,
    [code]
  );

  return result.rows[0] || null;
}

router.get('/:code', async (req, res) => {
  try {
    const invite = await getInviteLinkPreview(req.params.code);
    if (!invite || !isInviteLinkActive(invite)) {
      return res.status(404).json({
        error: 'Invite link not found or no longer active',
        code: 'INVITE_LINK_INVALID',
      });
    }

    res.json({
      success: true,
      invite: {
        id: invite.id,
        code: invite.code,
        max_uses: invite.max_uses != null ? Number(invite.max_uses) : null,
        use_count: Number(invite.use_count || 0),
        expires_at: invite.expires_at,
        created_at: invite.created_at,
        conversation_id: invite.conversation_id,
        conversation_public_id: invite.conversation_public_id ? String(invite.conversation_public_id) : null,
        conversation_name: invite.conversation_name,
        conversation_icon_url: buildGroupIconUrl(invite.conversation_icon_filename),
        owner_id: invite.owner_id,
        owner_display_name: invite.owner_display_name,
        owner_username: invite.owner_username,
        owner_avatar_url: resolveUserAvatarUrl(invite.owner_avatar_filename, {
          displayName: invite.owner_display_name,
          username: invite.owner_username,
        }),
        member_count: Number(invite.member_count || 0),
      },
    });
  } catch (err) {
    console.error('Invite preview error:', err);
    res.status(500).json({ error: 'Failed to load invite preview' });
  }
});

router.get('/:code/status', authenticateUser, async (req, res) => {
  const userId = req.user.id;

  try {
    const invite = await getInviteLinkPreview(req.params.code);
    if (!invite) {
      return res.status(404).json({ error: 'Invite link not found', code: 'INVITE_LINK_INVALID' });
    }

    const membershipResult = await pool.query(
      `SELECT 1
       FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2
       LIMIT 1`,
      [invite.conversation_id, userId]
    );

    if (membershipResult.rows.length > 0) {
      return res.json({
        success: true,
        status: 'member',
        conversation_public_id: invite.conversation_public_id ? String(invite.conversation_public_id) : null,
      });
    }

    const requestResult = await pool.query(
      `SELECT status, created_at, resolved_at
       FROM conversation_join_requests
       WHERE conversation_id = $1 AND requester_user_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [invite.conversation_id, userId]
    );

    if (requestResult.rows.length === 0) {
      return res.json({ success: true, status: 'none' });
    }

    return res.json({
      success: true,
      status: requestResult.rows[0].status,
      created_at: requestResult.rows[0].created_at,
      resolved_at: requestResult.rows[0].resolved_at,
    });
  } catch (err) {
    console.error('Invite status error:', err);
    res.status(500).json({ error: 'Failed to load invite status' });
  }
});

router.post('/:code/request', authenticateUser, async (req, res) => {
  const userId = req.user.id;

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const invite = await getInviteLinkPreview(req.params.code, client);
    if (!invite || !isInviteLinkActive(invite)) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'Invite link not found or no longer active',
        code: 'INVITE_LINK_INVALID',
      });
    }

    const membershipResult = await client.query(
      `SELECT 1
       FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2
       LIMIT 1`,
      [invite.conversation_id, userId]
    );

    if (membershipResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'You are already a member of this group',
        code: 'ALREADY_MEMBER',
        conversation_public_id: invite.conversation_public_id ? String(invite.conversation_public_id) : null,
      });
    }

    if (invite.owner_id === userId) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'You already own this group',
        code: 'ALREADY_OWNER',
        conversation_public_id: invite.conversation_public_id ? String(invite.conversation_public_id) : null,
      });
    }

    const pendingRequestResult = await client.query(
      `SELECT id, created_at
       FROM conversation_join_requests
       WHERE conversation_id = $1 AND requester_user_id = $2 AND status = 'pending'
       LIMIT 1`,
      [invite.conversation_id, userId]
    );

    if (pendingRequestResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.json({
        success: true,
        status: 'pending',
        request_id: pendingRequestResult.rows[0].id,
        created_at: pendingRequestResult.rows[0].created_at,
      });
    }

    const insertResult = await client.query(
      `INSERT INTO conversation_join_requests (
         conversation_id,
         invite_link_id,
         requester_user_id,
         status
       )
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, created_at`,
      [invite.conversation_id, invite.id, userId]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      status: 'pending',
      request_id: insertResult.rows[0].id,
      created_at: insertResult.rows[0].created_at,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Invite request error:', err);
    res.status(500).json({ error: 'Failed to request to join this group' });
  } finally {
    client?.release();
  }
});

export function generateInviteCode() {
  return crypto.randomBytes(8).toString('base64url');
}

export { isInviteLinkActive, getInviteLinkPreview };

export default router;
