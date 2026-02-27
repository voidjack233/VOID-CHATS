import { Router } from 'express';
import { pool } from '../../../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT method, is_enabled, enabled_at FROM user_2fa WHERE user_id = $1`,
      [req.user.id]
    );

    const methods = {};
    for (const row of result.rows) {
      methods[row.method] = {
        enabled: row.is_enabled,
        enabledAt: row.enabled_at,
      };
    }

    const backupResult = await pool.query(
      `SELECT COUNT(*) as remaining FROM user_2fa_backup_codes 
       WHERE user_id = $1 AND is_used = false`,
      [req.user.id]
    );

    res.json({
      success: true,
      twoFactor: {
        totp: methods.totp || { enabled: false },
        email: methods.email || { enabled: false },
        backupCodesRemaining: parseInt(backupResult.rows[0].remaining),
      },
    });
  } catch (err) {
    console.error('2FA status error:', err);
    res.status(500).json({ success: false, message: 'Failed to get 2FA status' });
  }
});

export default router;