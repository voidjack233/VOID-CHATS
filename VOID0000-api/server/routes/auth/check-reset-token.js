import { Router } from 'express';
import { pool } from '../../db.js';
import { hashToken } from '../../utils/hashToken.js';

const router = Router();

router.post('/', async (req, res) => {
  const { token } = req.body;

  if (!token) return res.status(400).json({ success: false, message: 'Token required' });

  try {
    const hashedToken = hashToken(token);
    const result = await pool.query(
      `SELECT user_id
       FROM password_resets
       WHERE token = $1
         AND expires_at > NOW()`,
      [hashedToken]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or expired token' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Token check error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
