import { Router } from 'express';
import { pool } from '../../db.js';
import argon2 from 'argon2';
import { IPSecurity } from '../../utils/securityUtils.js';
import { authenticateUser } from '../../middleware/jwt.js';
import { encryptedCSRFProtection } from '../../middleware/encryptedCSRF.js';

const router = Router();

router.post('/', authenticateUser, encryptedCSRFProtection, async (req, res) => {
  const { currentPassword, newPassword, keyBackup } = req.body;
  const userId = req.user.id;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: 'Current password and new password are required'
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      success: false,
      message: 'New password must be at least 8 characters'
    });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({
      success: false,
      message: 'New password must be different from current password'
    });
  }

  if (keyBackup) {
    const hasAllBackupFields =
      typeof keyBackup.encrypted_private_key === 'string' &&
      typeof keyBackup.iv === 'string' &&
      typeof keyBackup.salt === 'string' &&
      typeof keyBackup.key_id === 'string';

    if (!hasAllBackupFields) {
      return res.status(400).json({
        success: false,
        message: 'keyBackup must include encrypted_private_key, iv, salt, and key_id'
      });
    }
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const userResult = await client.query(
      'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );

    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = userResult.rows[0];

    const isValid = await argon2.verify(user.password_hash, currentPassword);

    if (!isValid) {
      await client.query('ROLLBACK');
      await IPSecurity.logIPActivity(req, 'PASSWORD_CHANGE_FAILED_WRONG_PASSWORD', userId);
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    const existingBackupResult = await client.query(
      'SELECT key_id FROM user_key_backups WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    if (existingBackupResult.rows.length > 0 && !keyBackup) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        code: 'KEY_BACKUP_REQUIRED',
        message: 'This device must re-encrypt your chat key backup before changing password.'
      });
    }

    if (keyBackup) {
      const activeKeyResult = await client.query(
        `SELECT key_id
         FROM user_keys
         WHERE user_id = $1 AND is_active = TRUE
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId]
      );

      const activeKeyId = activeKeyResult.rows[0]?.key_id || null;
      if (activeKeyId && activeKeyId !== keyBackup.key_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          code: 'KEY_ID_MISMATCH',
          message: 'Your local chat key does not match the active server key. Refresh and try again from the device that can still read your chats.'
        });
      }
    }

    const newHash = await argon2.hash(newPassword, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1
    });

    await client.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, userId]
    );

    if (keyBackup) {
      await client.query(
        `INSERT INTO user_key_backups (user_id, encrypted_private_key, iv, salt, key_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id)
         DO UPDATE SET encrypted_private_key = $2, iv = $3, salt = $4, key_id = $5, updated_at = NOW()`,
        [
          userId,
          keyBackup.encrypted_private_key,
          keyBackup.iv,
          keyBackup.salt,
          keyBackup.key_id,
        ]
      );
    }

    await client.query('COMMIT');
    await IPSecurity.logIPActivity(req, 'PASSWORD_CHANGE_SUCCESS', userId);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('Change password error:', err);
    await IPSecurity.logIPActivity(req, 'PASSWORD_CHANGE_ERROR', userId);
    res.status(500).json({
      success: false,
      message: 'Failed to change password'
    });
  } finally {
    client?.release();
  }
});

export default router;
