import { Router } from 'express';
import { pool } from '../../db.js';
import { hashToken } from '../../utils/hashToken.js';

const router = Router();

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (local.length <= 1) return `${local}***@${domain}`;
  return `${local[0]}***@${domain}`;
}

router.post('/', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ 
      success: false, 
      message: 'Token is required' 
    });
  }

  try {
    const tokenHash = hashToken(token);
    const result = await pool.query(
      `SELECT ev.expires_at, ev.code, u.email, u.is_verified
       FROM email_verifications ev
       JOIN users u ON u.id = ev.user_id
       WHERE ev.token = $1`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.json({ success: false, message: 'Invalid token' });
    }

    const record = result.rows[0];

    if (record.is_verified) {
      return res.json({ success: false, message: 'Email is already verified' });
    }

    if (new Date() > new Date(record.expires_at)) {
      return res.json({ success: false, message: 'Token has expired. Please register again.' });
    }

    res.json({ 
      success: true,
      email: maskEmail(record.email),
      codeSent: record.code !== null
    });
  } catch (err) {
    console.error('Token validation error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
