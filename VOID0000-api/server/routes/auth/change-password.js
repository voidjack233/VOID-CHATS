import { Router } from 'express';
import { pool } from '../../db.js';
import argon2 from 'argon2';
import { IPSecurity } from '../../utils/securityUtils.js';
import { authenticateUser } from '../../middleware/jwt.js';
import { encryptedCSRFProtection } from '../../middleware/encryptedCSRF.js';

const router = Router();

router.post('/', authenticateUser, encryptedCSRFProtection, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
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

  try {
    const userResult = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = userResult.rows[0];

    const isValid = await argon2.verify(user.password_hash, currentPassword);

    if (!isValid) {
      await IPSecurity.logIPActivity(req, 'PASSWORD_CHANGE_FAILED_WRONG_PASSWORD', userId);
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    const newHash = await argon2.hash(newPassword, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1
    });

    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, userId]
    );

    await IPSecurity.logIPActivity(req, 'PASSWORD_CHANGE_SUCCESS', userId);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (err) {
    console.error('Change password error:', err);
    await IPSecurity.logIPActivity(req, 'PASSWORD_CHANGE_ERROR', userId);
    res.status(500).json({
      success: false,
      message: 'Failed to change password'
    });
  }
});

export default router;