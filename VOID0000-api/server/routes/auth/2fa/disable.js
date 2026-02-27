import { Router } from 'express';
import { pool } from '../../../db.js';
import argon2 from 'argon2';

const router = Router();

// POST /api/auth/2fa/disable — Disable a 2FA method
router.post('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { method, password } = req.body;

    if (!method || !password) {
      return res.status(400).json({
        success: false,
        message: 'Method and password are required.',
      });
    }

    // Verify password first
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

    // Disable the method
    const result = await pool.query(
      `UPDATE user_2fa SET is_enabled = false, enabled_at = NULL 
       WHERE user_id = $1 AND method = $2 AND is_enabled = true
       RETURNING *`,
      [userId, method]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'This 2FA method is not currently enabled.',
      });
    }

    // Check if any 2FA methods remain enabled
    const remaining = await pool.query(
      `SELECT COUNT(*) as count FROM user_2fa WHERE user_id = $1 AND is_enabled = true`,
      [userId]
    );

    // If no 2FA methods left, delete backup codes
    if (parseInt(remaining.rows[0].count) === 0) {
      await pool.query('DELETE FROM user_2fa_backup_codes WHERE user_id = $1', [userId]);
    }

    res.json({
      success: true,
      message: `${method === 'totp' ? 'Authenticator app' : 'Email 2FA'} has been disabled.`,
    });
  } catch (err) {
    console.error('2FA disable error:', err);
    res.status(500).json({ success: false, message: 'Failed to disable 2FA' });
  }
});

export default router;