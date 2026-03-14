// server/routes/conversations/keys.js
import { Router } from 'express';
import { pool } from '../../db.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { emitConversationUpdate, normalizeKeyVersion } from '../../utils/groupMembership.js';

const router = Router();

async function resolveKeyConversationId(requestedConversationId) {
  const conversation = await findConversationByIdentifier(requestedConversationId);
  if (!conversation) {
    return null;
  }

  return conversation.parent_conversation_id || conversation.id;
}

function hasEncryptedKeyPayload(payload) {
  return Boolean(
    payload &&
    typeof payload.encrypted_private_key === 'string' &&
    typeof payload.iv === 'string' &&
    typeof payload.salt === 'string' &&
    typeof payload.key_id === 'string'
  );
}

// ==================== KEY BACKUP (must be before /:userId) ====================

// POST /api/conversations/keys/backup — store encrypted private key backup
router.post('/backup', async (req, res) => {
  const userId = req.user.id;
  const { encrypted_private_key, iv, salt, key_id } = req.body;

  if (!encrypted_private_key || !iv || !salt || !key_id) {
    return res.status(400).json({ error: 'encrypted_private_key, iv, salt, and key_id required' });
  }

  try {
    await pool.query(
      `INSERT INTO user_key_backups (user_id, encrypted_private_key, iv, salt, key_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id)
       DO UPDATE SET encrypted_private_key = $2, iv = $3, salt = $4, key_id = $5, updated_at = NOW()`,
      [userId, encrypted_private_key, iv, salt, key_id]
    );

    res.json({ success: true, message: 'Key backup stored' });
  } catch (err) {
    console.error('Key backup error:', err);
    res.status(500).json({ error: 'Failed to store key backup' });
  }
});

// GET /api/conversations/keys/backup — retrieve encrypted private key backup
router.get('/backup', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT encrypted_private_key, iv, salt, key_id, created_at
             , recovery_encrypted_private_key, recovery_iv, recovery_salt, recovery_key_id, recovery_configured_at
       FROM user_key_backups
       WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No key backup found' });
    }

    res.json({ success: true, backup: result.rows[0] });
  } catch (err) {
    console.error('Key backup GET error:', err);
    res.status(500).json({ error: 'Failed to fetch key backup' });
  }
});

// POST /api/conversations/keys/backup/recovery — store recovery-wrapped private key backup
router.post('/backup/recovery', async (req, res) => {
  const userId = req.user.id;
  const payload = req.body;

  if (!hasEncryptedKeyPayload(payload)) {
    return res.status(400).json({ error: 'encrypted_private_key, iv, salt, and key_id required' });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const activeKeyResult = await client.query(
      `SELECT key_id
       FROM user_keys
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    );

    const activeKeyId = activeKeyResult.rows[0]?.key_id || null;
    if (activeKeyId && activeKeyId !== payload.key_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Recovery backup key does not match the active identity key',
        code: 'KEY_ID_MISMATCH',
      });
    }

    const existingBackupResult = await client.query(
      `SELECT user_id
       FROM user_key_backups
       WHERE user_id = $1
       FOR UPDATE`,
      [userId]
    );

    if (existingBackupResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Create the standard password backup before configuring recovery',
        code: 'PASSWORD_BACKUP_REQUIRED',
      });
    }

    await client.query(
      `UPDATE user_key_backups
       SET recovery_encrypted_private_key = $2,
           recovery_iv = $3,
           recovery_salt = $4,
           recovery_key_id = $5,
           recovery_configured_at = COALESCE(recovery_configured_at, NOW()),
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, payload.encrypted_private_key, payload.iv, payload.salt, payload.key_id]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Recovery backup stored' });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Recovery backup error:', err);
    res.status(500).json({ error: 'Failed to store recovery backup' });
  } finally {
    client?.release();
  }
});

// ==================== PUBLIC KEYS ====================

// GET /api/conversations/keys/:userId — get user's active public key
router.get('/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      `SELECT public_key, key_id, created_at
       FROM user_keys
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No public key found for user' });
    }

    res.json({ success: true, key: result.rows[0] });
  } catch (err) {
    console.error('Key GET error:', err);
    res.status(500).json({ error: 'Failed to fetch key' });
  }
});

// POST /api/conversations/keys — upload or rotate public key
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { public_key, key_id } = req.body;

  if (!public_key || !key_id) {
    return res.status(400).json({ error: 'public_key and key_id required' });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    await client.query(
      `UPDATE user_keys SET is_active = FALSE WHERE user_id = $1`,
      [userId]
    );

    const result = await client.query(
      `INSERT INTO user_keys (user_id, public_key, key_id, is_active)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id, public_key, key_id, created_at`,
      [userId, public_key, key_id]
    );

    await client.query('COMMIT');

    res.status(201).json({ success: true, key: result.rows[0] });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Key POST error:', err);
    res.status(500).json({ error: 'Failed to upload key' });
  } finally {
    if (client) client.release();
  }
});

// ==================== GROUP KEYS ====================

// GET /api/conversations/keys/group/:conversationId — get group keys for current user
router.get('/group/:conversationId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const resolvedConversation = await findConversationByIdentifier(conversationId);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const memberCheck = await pool.query(
      `SELECT user_id FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [resolvedConversation.id, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member' });
    }

    const keyConversationId = await resolveKeyConversationId(conversationId);
    if (!keyConversationId) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const result = await pool.query(
      `SELECT encrypted_group_key, key_version, wrapped_by_user_id, wrapper_public_key, created_at
       FROM group_key_distribution
       WHERE conversation_id = $1 AND user_id = $2
       ORDER BY key_version DESC`,
      [keyConversationId, userId]
    );

    res.json({ success: true, keys: result.rows });
  } catch (err) {
    console.error('Group key GET error:', err);
    res.status(500).json({ error: 'Failed to fetch group keys' });
  }
});

// POST /api/conversations/keys/group/:conversationId — distribute group key
router.post('/group/:conversationId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { distributions, key_version } = req.body;
  const normalizedKeyVersion = normalizeKeyVersion(key_version, 0);

  if (!Array.isArray(distributions) || distributions.length === 0 || normalizedKeyVersion <= 0) {
    return res.status(400).json({ error: 'distributions array and key_version required' });
  }

  try {
    const resolvedConversation = await findConversationByIdentifier(conversationId);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const keyConversationId = await resolveKeyConversationId(conversationId);
    if (!keyConversationId) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const memberCheck = await pool.query(
      `SELECT role FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [keyConversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member' });
    }

    if (memberCheck.rows[0].role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can distribute group keys' });
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      let versionUpdatedConversation = null;
      let conversationMemberIds = [];

      for (const dist of distributions) {
        await client.query(
          `INSERT INTO group_key_distribution (
             conversation_id,
             user_id,
             encrypted_group_key,
             key_version,
             wrapped_by_user_id,
             wrapper_public_key
           )
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (conversation_id, user_id, key_version)
           DO UPDATE SET
             encrypted_group_key = EXCLUDED.encrypted_group_key,
             wrapped_by_user_id = EXCLUDED.wrapped_by_user_id,
             wrapper_public_key = EXCLUDED.wrapper_public_key`,
          [keyConversationId, dist.user_id, dist.encrypted_group_key, normalizedKeyVersion, userId, dist.wrapper_public_key ?? null]
        );
      }

      const versionUpdateResult = await client.query(
        `UPDATE conversations
         SET current_key_version = $2,
             updated_at = NOW()
         WHERE id = $1
           AND COALESCE(current_key_version, 1) < $2
         RETURNING id, public_id, type, owner_id, current_key_version`,
        [keyConversationId, normalizedKeyVersion]
      );

      versionUpdatedConversation = versionUpdateResult.rows[0] || null;

      if (versionUpdatedConversation) {
        const membersResult = await client.query(
          `SELECT user_id
           FROM conversation_members
           WHERE conversation_id = $1`,
          [keyConversationId]
        );
        conversationMemberIds = membersResult.rows.map((row) => row.user_id);
      }

      await client.query('COMMIT');

      if (versionUpdatedConversation) {
        await emitConversationUpdate(
          versionUpdatedConversation,
          conversationMemberIds,
          normalizeKeyVersion(versionUpdatedConversation.current_key_version, normalizedKeyVersion),
          conversationMemberIds.length
        );
      }

      res.json({
        success: true,
        message: 'Group keys distributed',
        key_version: normalizedKeyVersion,
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK');
      throw err;
    } finally {
      if (client) client.release();
    }
  } catch (err) {
    console.error('Group key distribute error:', err);
    res.status(500).json({ error: 'Failed to distribute group keys' });
  }
});

export default router;
