import { Router } from 'express';
import { pool } from '../../db.js';
import argon2 from 'argon2';
import { IPSecurity } from '../../utils/securityUtils.js';

const router = Router();

router.post('/', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ success: false, message: 'Token and new password required' });
  }

  try {
    const resetResult = await pool.query(
      `SELECT user_id FROM password_resets WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );

    if (resetResult.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Token is invalid or expired' });
    }

    const user_id = resetResult.rows[0].user_id;

    const hashed = await argon2.hash(newPassword, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1
    });

    await pool.query('BEGIN'); 

    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hashed, user_id]
    );

    await pool.query('DELETE FROM password_resets WHERE user_id = $1', [user_id]);

    await pool.query('COMMIT'); 

    await IPSecurity.logIPActivity(req, 'PASSWORD_CHANGED', user_id);

    res.json({ success: true, message: 'Password has been reset' });
  } catch (err) {
    await pool.query('ROLLBACK'); 
    console.error('Reset password error:', err);
    res.status(500).json({ success: false, message: 'Failed to reset password' });
  }
});

export default router;
