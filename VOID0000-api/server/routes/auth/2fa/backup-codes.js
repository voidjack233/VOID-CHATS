import { Router } from 'express';
import { pool } from '../../../db.js';
import argon2 from 'argon2';
import { generateBackupCodes } from './verify-setup.js';

const router = Router();

// POST /api/auth/2fa/backup-codes/regenerate — Generate new backup codes
router.post('/regenerate', async (req, res) => {
  try {
    const userId = req.user.id;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required.',
      });
    }

    // Verify password
    const userResult = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId]
    );

    const match = await argon2.verify(userResult.rows[0].password_hash, password);
    if (!match) {
      return res.status(401).json({
        success: false,
        message: 'Incorrect password.',
      });
    }

    // Check that at least one 2FA method is enabled
    const enabled = await pool.query(
      `SELECT COUNT(*) as count FROM user_2fa WHERE user_id = $1 AND is_enabled = true`,
      [userId]
    );

    if (parseInt(enabled.rows[0].count) === 0) {
      return res.status(400).json({
        success: false,
        message: 'Enable at least one 2FA method first.',
      });
    }

    const codes = await generateBackupCodes(userId);

    res.json({
      success: true,
      message: 'New backup codes generated. Previous codes are now invalid.',
      backupCodes: codes,
    });
  } catch (err) {
    console.error('Backup codes regenerate error:', err);
    res.status(500).json({ success: false, message: 'Failed to regenerate backup codes' });
  }
});

export default router;