// server/routes/conversations/keys.js
import { Router } from 'express';
import { pool } from '../../db.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';

const router = Router();

async function resolveKeyConversationId(requestedConversationId) {
  const conversation = await findConversationByIdentifier(requestedConversationId);
  if (!conversation) {
    return null;
  }

  return conversation.parent_conversation_id || conversation.id;
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
      `SELECT encrypted_group_key, key_version, created_at
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

  if (!Array.isArray(distributions) || distributions.length === 0 || !key_version) {
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

    if (!['owner', 'admin'].includes(memberCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Only owner or admin can distribute keys' });
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');

      for (const dist of distributions) {
        await client.query(
          `INSERT INTO group_key_distribution (conversation_id, user_id, encrypted_group_key, key_version)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (conversation_id, user_id, key_version)
           DO UPDATE SET encrypted_group_key = EXCLUDED.encrypted_group_key`,
          [keyConversationId, dist.user_id, dist.encrypted_group_key, key_version]
        );
      }

      await client.query('COMMIT');

      res.json({ success: true, message: 'Group keys distributed', key_version });
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
