// server/routes/conversations/keys.js
import { Router } from 'express';
import { pool } from '../../db.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { emitConversationUpdate, normalizeKeyVersion } from '../../utils/groupMembership.js';
import { debugLog } from '../../utils/debugLog.js';
import {
  activateBackedUpMlsKeyPackages,
  normalizeBackedUpMlsKeyPackageRefs,
} from '../../utils/mlsKeyPackageBackupActivation.js';

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

// POST /api/conversations/keys/backup — store encrypted private key backup (+ optional MLS state)
router.post('/backup', async (req, res) => {
  const userId = req.user.id;
  const {
    encrypted_private_key,
    iv,
    salt,
    key_id,
    mls_state_encrypted,
    mls_state_iv,
    mls_state_salt,
    mls_key_package_refs,
  } = req.body;

  if (!encrypted_private_key || !iv || !salt || !key_id) {
    return res.status(400).json({ error: 'encrypted_private_key, iv, salt, and key_id required' });
  }

  const hasMlsState = Boolean(mls_state_encrypted && mls_state_iv && mls_state_salt);
  const hasPartialMlsState = Boolean(mls_state_encrypted || mls_state_iv || mls_state_salt);
  const backedUpMlsKeyPackageRefs = normalizeBackedUpMlsKeyPackageRefs(mls_key_package_refs);

  if (hasPartialMlsState && !hasMlsState) {
    return res.status(400).json({
      error: 'mls_state_encrypted, mls_state_iv, and mls_state_salt must all be provided together',
      code: 'INVALID_MLS_BACKUP',
    });
  }

  if (!backedUpMlsKeyPackageRefs) {
    return res.status(400).json({
      error: 'mls_key_package_refs must be an array of valid package refs',
      code: 'INVALID_MLS_KEY_PACKAGE_REFS',
    });
  }

  if (backedUpMlsKeyPackageRefs.length > 0 && !hasMlsState) {
    return res.status(400).json({
      error: 'An encrypted MLS state backup is required before key packages can be activated',
      code: 'MLS_BACKUP_REQUIRED',
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO user_key_backups (user_id, encrypted_private_key, iv, salt, key_id, mls_state_encrypted, mls_state_iv, mls_state_salt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id)
       DO UPDATE SET
         encrypted_private_key = $2,
         iv = $3,
         salt = $4,
         key_id = $5,
         mls_state_encrypted = COALESCE($6, user_key_backups.mls_state_encrypted),
         mls_state_iv         = COALESCE($7, user_key_backups.mls_state_iv),
         mls_state_salt       = COALESCE($8, user_key_backups.mls_state_salt),
         updated_at = NOW()`,
      [
        userId, encrypted_private_key, iv, salt, key_id,
        hasMlsState ? mls_state_encrypted : null,
        hasMlsState ? mls_state_iv : null,
        hasMlsState ? mls_state_salt : null,
      ]
    );

    const activatedKeyPackageRefs = hasMlsState
      ? await activateBackedUpMlsKeyPackages(client, userId, backedUpMlsKeyPackageRefs)
      : [];

    await client.query('COMMIT');
    debugLog('[MLS_ACCOUNT_KEYS] password backup activation complete', {
      user_id: userId,
      backed_up_key_package_refs_count: backedUpMlsKeyPackageRefs.length,
      activated_key_package_refs_count: activatedKeyPackageRefs.length,
    });
    res.json({
      success: true,
      message: 'Key backup stored',
      data: { activated_key_package_refs: activatedKeyPackageRefs },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Key backup error:', err);
    res.status(500).json({ error: 'Failed to store key backup' });
  } finally {
    client?.release();
  }
});

// POST /api/conversations/keys/backup/account-mls — store MLS state wrapped by the unlocked account identity
router.post('/backup/account-mls', async (req, res) => {
  const userId = req.user.id;
  const {
    account_mls_state_encrypted,
    account_mls_state_iv,
    account_mls_state_key_id,
    mls_key_package_refs,
  } = req.body;

  if (
    typeof account_mls_state_encrypted !== 'string' ||
    typeof account_mls_state_iv !== 'string' ||
    typeof account_mls_state_key_id !== 'string'
  ) {
    return res.status(400).json({
      error: 'account_mls_state_encrypted, account_mls_state_iv, and account_mls_state_key_id required',
      code: 'INVALID_ACCOUNT_MLS_BACKUP',
    });
  }

  const backedUpMlsKeyPackageRefs = normalizeBackedUpMlsKeyPackageRefs(mls_key_package_refs);
  if (!backedUpMlsKeyPackageRefs) {
    return res.status(400).json({
      error: 'mls_key_package_refs must be an array of valid package refs',
      code: 'INVALID_MLS_KEY_PACKAGE_REFS',
    });
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
    if (!activeKeyId || activeKeyId !== account_mls_state_key_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Account MLS backup key does not match the active identity key',
        code: 'KEY_ID_MISMATCH',
      });
    }

    const updatedBackupResult = await client.query(
      `UPDATE user_key_backups
       SET account_mls_state_encrypted = $2,
           account_mls_state_iv = $3,
           account_mls_state_key_id = $4,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id`,
      [
        userId,
        account_mls_state_encrypted,
        account_mls_state_iv,
        account_mls_state_key_id,
      ]
    );

    if (updatedBackupResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Create the account identity backup before storing MLS state',
        code: 'ACCOUNT_BACKUP_REQUIRED',
      });
    }

    const activatedKeyPackageRefs = await activateBackedUpMlsKeyPackages(
      client,
      userId,
      backedUpMlsKeyPackageRefs
    );

    await client.query('COMMIT');
    debugLog('[MLS_ACCOUNT_KEYS] account MLS backup activation complete', {
      user_id: userId,
      backed_up_key_package_refs_count: backedUpMlsKeyPackageRefs.length,
      activated_key_package_refs_count: activatedKeyPackageRefs.length,
    });
    return res.json({
      success: true,
      message: 'Account MLS backup stored',
      data: { activated_key_package_refs: activatedKeyPackageRefs },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Account MLS backup error:', err);
    return res.status(500).json({ error: 'Failed to store account MLS backup' });
  } finally {
    client?.release();
  }
});

// GET /api/conversations/keys/backup — retrieve encrypted private key backup
router.get('/backup', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT encrypted_private_key, iv, salt, key_id, created_at
             , recovery_encrypted_private_key, recovery_iv, recovery_salt, recovery_key_id, recovery_configured_at
             , mls_state_encrypted, mls_state_iv, mls_state_salt
             , recovery_mls_state_encrypted, recovery_mls_state_iv, recovery_mls_state_salt
             , account_mls_state_encrypted, account_mls_state_iv, account_mls_state_key_id
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

  const hasRecoveryMlsState = Boolean(
    payload.recovery_mls_state_encrypted &&
    payload.recovery_mls_state_iv &&
    payload.recovery_mls_state_salt
  );

  const hasPartialRecoveryMlsState = Boolean(
    payload.recovery_mls_state_encrypted ||
    payload.recovery_mls_state_iv ||
    payload.recovery_mls_state_salt
  );

  if (hasPartialRecoveryMlsState && !hasRecoveryMlsState) {
    return res.status(400).json({
      error: 'recovery_mls_state_encrypted, recovery_mls_state_iv, and recovery_mls_state_salt must all be provided together',
      code: 'INVALID_RECOVERY_MLS_BACKUP',
    });
  }

  const backedUpMlsKeyPackageRefs = normalizeBackedUpMlsKeyPackageRefs(payload.mls_key_package_refs);
  if (!backedUpMlsKeyPackageRefs) {
    return res.status(400).json({
      error: 'mls_key_package_refs must be an array of valid package refs',
      code: 'INVALID_MLS_KEY_PACKAGE_REFS',
    });
  }

  if (backedUpMlsKeyPackageRefs.length > 0 && !hasRecoveryMlsState) {
    return res.status(400).json({
      error: 'An encrypted MLS state backup is required before key packages can be activated',
      code: 'MLS_BACKUP_REQUIRED',
    });
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
           recovery_mls_state_encrypted = COALESCE($6, recovery_mls_state_encrypted),
           recovery_mls_state_iv = COALESCE($7, recovery_mls_state_iv),
           recovery_mls_state_salt = COALESCE($8, recovery_mls_state_salt),
           recovery_configured_at = COALESCE(recovery_configured_at, NOW()),
           updated_at = NOW()
       WHERE user_id = $1`,
      [
        userId,
        payload.encrypted_private_key,
        payload.iv,
        payload.salt,
        payload.key_id,
        hasRecoveryMlsState ? payload.recovery_mls_state_encrypted : null,
        hasRecoveryMlsState ? payload.recovery_mls_state_iv : null,
        hasRecoveryMlsState ? payload.recovery_mls_state_salt : null,
      ]
    );

    const activatedKeyPackageRefs = hasRecoveryMlsState
      ? await activateBackedUpMlsKeyPackages(client, userId, backedUpMlsKeyPackageRefs)
      : [];

    await client.query('COMMIT');
    debugLog('[MLS_ACCOUNT_KEYS] recovery backup activation complete', {
      user_id: userId,
      backed_up_key_package_refs_count: backedUpMlsKeyPackageRefs.length,
      activated_key_package_refs_count: activatedKeyPackageRefs.length,
    });
    res.json({
      success: true,
      message: 'Recovery backup stored',
      data: { activated_key_package_refs: activatedKeyPackageRefs },
    });
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

// GET /api/conversations/keys/group/:conversationId — deprecated
router.get('/group/:conversationId', async (req, res) => {
  return res.status(410).json({
    success: false,
    error: 'Legacy group key API removed. Use MLS distribution endpoints.',
    code: 'LEGACY_GROUP_KEY_API_REMOVED',
  });
});

// POST /api/conversations/keys/group/:conversationId — deprecated
router.post('/group/:conversationId', async (req, res) => {
  return res.status(410).json({
    success: false,
    error: 'Legacy group key API removed. Use MLS distribution endpoints.',
    code: 'LEGACY_GROUP_KEY_API_REMOVED',
  });
});

export default router;
