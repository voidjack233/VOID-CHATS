import { Router } from 'express';
import { pool } from '../../db.js';
import argon2 from 'argon2';
import { IPSecurity } from '../../utils/securityUtils.js';
import { authenticateUser } from '../../middleware/jwt.js';
import { encryptedCSRFProtection } from '../../middleware/encryptedCSRF.js';
import { totp } from '../../middleware/2fa/totp.js';
import { decrypt } from './2fa/setup-totp.js';
import valkey from '../../valkey.js';
import crypto from 'crypto';
import { debugLog } from '../../utils/debugLog.js';
import {
  activateBackedUpMlsKeyPackages,
  normalizeBackedUpMlsKeyPackageRefs,
} from '../../utils/mlsKeyPackageBackupActivation.js';
import { getTwoFactorCodeSecret } from '../../utils/authSecrets.js';
import { validateAccountPassword } from '../../utils/passwordPolicy.js';

const router = Router();
const CHANGE_PASSWORD_EMAIL_ACTION = 'change_password';

function getActionEmailKey(userId, action) {
  return `auth:2fa:action-email:${userId}:${action}`;
}

function hashActionEmailCode(userId, action, code) {
  return crypto
    .createHmac('sha256', getTwoFactorCodeSecret())
    .update(`${userId}:${action}:${String(code).trim()}`)
    .digest('hex');
}

function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

router.post('/', authenticateUser, encryptedCSRFProtection, async (req, res) => {
  const { currentPassword, newPassword, keyBackup, twoFactorMethod, twoFactorCode } = req.body;
  const userId = req.user.id;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: 'Current password and new password are required'
    });
  }

  const passwordError = validateAccountPassword(newPassword);
  if (passwordError) {
    return res.status(400).json({
      success: false,
      message: passwordError
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

    const hasAnyMlsField =
      keyBackup.mls_state_encrypted != null ||
      keyBackup.mls_state_iv != null ||
      keyBackup.mls_state_salt != null;
    const hasCompleteMlsFields =
      typeof keyBackup.mls_state_encrypted === 'string' &&
      typeof keyBackup.mls_state_iv === 'string' &&
      typeof keyBackup.mls_state_salt === 'string';
    const backedUpMlsKeyPackageRefs = normalizeBackedUpMlsKeyPackageRefs(keyBackup.mls_key_package_refs);

    if (!hasAllBackupFields) {
      return res.status(400).json({
        success: false,
        message: 'keyBackup must include encrypted_private_key, iv, salt, and key_id'
      });
    }

    if (hasAnyMlsField && !hasCompleteMlsFields) {
      return res.status(400).json({
        success: false,
        message: 'mls_state_encrypted, mls_state_iv, and mls_state_salt must all be provided together'
      });
    }

    if (!backedUpMlsKeyPackageRefs) {
      return res.status(400).json({
        success: false,
        message: 'mls_key_package_refs must be an array of valid package refs'
      });
    }

    if (backedUpMlsKeyPackageRefs.length > 0 && !hasCompleteMlsFields) {
      return res.status(400).json({
        success: false,
        message: 'An encrypted MLS state backup is required before key packages can be activated'
      });
    }
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const enabledMethodsResult = await client.query(
      `SELECT method FROM user_2fa WHERE user_id = $1 AND is_enabled = true`,
      [userId]
    );
    const enabledMethods = enabledMethodsResult.rows.map((row) => row.method);
    const requiresTwoFactor = enabledMethods.length > 0;

    if (requiresTwoFactor) {
      if (!twoFactorMethod || !twoFactorCode) {
        await client.query('ROLLBACK');
        return res.status(401).json({
          success: false,
          code: 'TWO_FACTOR_REQUIRED',
          message: 'This account requires a 2FA code before changing password.',
        });
      }

      if (twoFactorMethod === 'backup') {
        const backupCodes = await client.query(
          `SELECT id, code_hash FROM user_2fa_backup_codes WHERE user_id = $1 AND is_used = false`,
          [userId]
        );

        let usedCodeId = null;
        for (const row of backupCodes.rows) {
          const match = await argon2.verify(row.code_hash, String(twoFactorCode).trim().toUpperCase());
          if (match) {
            usedCodeId = row.id;
            break;
          }
        }

        if (!usedCodeId) {
          await client.query('ROLLBACK');
          return res.status(401).json({
            success: false,
            code: 'TWO_FACTOR_INVALID',
            message: 'Invalid backup code.',
          });
        }

        await client.query(
          `UPDATE user_2fa_backup_codes SET is_used = true, used_at = NOW() WHERE id = $1`,
          [usedCodeId]
        );
      } else if (twoFactorMethod === 'totp') {
        if (!enabledMethods.includes('totp')) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            message: 'Authenticator app 2FA is not enabled on this account.',
          });
        }

        const secretResult = await client.query(
          `SELECT totp_secret FROM user_2fa WHERE user_id = $1 AND method = 'totp' AND is_enabled = true LIMIT 1`,
          [userId]
        );

        if (secretResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            message: 'Authenticator app 2FA is not enabled on this account.',
          });
        }

        const secret = decrypt(secretResult.rows[0].totp_secret);
        const isValid = totp.verifyToken(String(twoFactorCode).trim(), secret);
        if (!isValid) {
          await client.query('ROLLBACK');
          return res.status(401).json({
            success: false,
            code: 'TWO_FACTOR_INVALID',
            message: 'Invalid authenticator code.',
          });
        }
      } else if (twoFactorMethod === 'email') {
        if (!enabledMethods.includes('email')) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            message: 'Email 2FA is not enabled on this account.',
          });
        }

        const raw = await valkey.get(getActionEmailKey(userId, CHANGE_PASSWORD_EMAIL_ACTION));
        const stored = raw ? JSON.parse(raw) : null;

        const submittedCodeHash = hashActionEmailCode(
          userId,
          CHANGE_PASSWORD_EMAIL_ACTION,
          twoFactorCode,
        );
        if (!stored?.codeHash || !safeEqualHex(stored.codeHash, submittedCodeHash)) {
          await client.query('ROLLBACK');
          return res.status(401).json({
            success: false,
            code: 'TWO_FACTOR_INVALID',
            message: 'Invalid email verification code.',
          });
        }

        await valkey.del(getActionEmailKey(userId, CHANGE_PASSWORD_EMAIL_ACTION));
      } else {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Unsupported 2FA verification method.',
        });
      }
    }

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
        message: 'Your account must re-encrypt its secure chat backup before changing password.'
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
          message: 'Your local chat key does not match the active account key. Restore your account secure state and try again.'
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
      const hasMlsState =
        typeof keyBackup.mls_state_encrypted === 'string' &&
        typeof keyBackup.mls_state_iv === 'string' &&
        typeof keyBackup.mls_state_salt === 'string';

      await client.query(
        `INSERT INTO user_key_backups (
           user_id,
           encrypted_private_key,
           iv,
           salt,
           key_id,
           mls_state_encrypted,
           mls_state_iv,
           mls_state_salt
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id)
         DO UPDATE SET
           encrypted_private_key = $2,
           iv = $3,
           salt = $4,
           key_id = $5,
           mls_state_encrypted = COALESCE($6, user_key_backups.mls_state_encrypted),
           mls_state_iv = COALESCE($7, user_key_backups.mls_state_iv),
           mls_state_salt = COALESCE($8, user_key_backups.mls_state_salt),
           updated_at = NOW()`,
        [
          userId,
          keyBackup.encrypted_private_key,
          keyBackup.iv,
          keyBackup.salt,
          keyBackup.key_id,
          hasMlsState ? keyBackup.mls_state_encrypted : null,
          hasMlsState ? keyBackup.mls_state_iv : null,
          hasMlsState ? keyBackup.mls_state_salt : null,
        ]
      );

      if (hasMlsState) {
        const backedUpMlsKeyPackageRefs = normalizeBackedUpMlsKeyPackageRefs(keyBackup.mls_key_package_refs) || [];
        const activatedKeyPackageRefs = await activateBackedUpMlsKeyPackages(client, userId, backedUpMlsKeyPackageRefs);
        debugLog('[MLS_ACCOUNT_KEYS] password change activation complete', {
          user_id: userId,
          backed_up_key_package_refs_count: backedUpMlsKeyPackageRefs.length,
          activated_key_package_refs_count: activatedKeyPackageRefs.length,
        });
      }
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
