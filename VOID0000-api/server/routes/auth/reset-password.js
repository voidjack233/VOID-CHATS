import { Router } from 'express';
import { pool } from '../../db.js';
import argon2 from 'argon2';
import { IPSecurity } from '../../utils/securityUtils.js';
import { hashToken } from '../../utils/hashToken.js';
import { sessionStore } from '../../middleware/sessionStore.js';
import { disconnectLiveSession } from '../../gateway/control.js';
import { validateAccountPassword } from '../../utils/passwordPolicy.js';

const router = Router();

router.post('/', async (req, res) => {
  const { token, newPassword } = req.body;
  let client;

  if (!token || !newPassword) {
    return res.status(400).json({ success: false, message: 'Token and new password required' });
  }

  const passwordError = validateAccountPassword(newPassword);
  if (passwordError) {
    return res.status(400).json({ success: false, message: passwordError });
  }

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const hashedToken = hashToken(token);
    const resetResult = await client.query(
      `SELECT user_id
       FROM password_resets
       WHERE token = $1
         AND expires_at > NOW()
       FOR UPDATE`,
      [hashedToken]
    );

    if (resetResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Token is invalid or expired' });
    }

    const user_id = resetResult.rows[0].user_id;

    const sessionsResult = await client.query(
      `SELECT DISTINCT device_id
       FROM refresh_tokens
       WHERE user_id = $1
         AND device_id IS NOT NULL
         AND is_revoked = FALSE`,
      [user_id]
    );

    const hashed = await argon2.hash(newPassword, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1
    });

    await client.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hashed, user_id]
    );

    await client.query(
      `UPDATE refresh_tokens
       SET is_revoked = TRUE,
           revoked_at = NOW(),
           revoked_by = $1
       WHERE user_id = $1
         AND is_revoked = FALSE`,
      [user_id]
    );

    await client.query('DELETE FROM password_resets WHERE user_id = $1', [user_id]);

    await client.query('COMMIT');

    await sessionStore.revokeAll(user_id);
    await Promise.all(
      sessionsResult.rows.map((row) =>
        disconnectLiveSession(user_id, row.device_id, 4001, 'Password reset')
      )
    );

    await IPSecurity.logIPActivity(req, 'PASSWORD_CHANGED', user_id);

    res.json({ success: true, message: 'Password has been reset' });
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('Reset password error:', err);
    res.status(500).json({ success: false, message: 'Failed to reset password' });
  } finally {
    client?.release();
  }
});

export default router;
