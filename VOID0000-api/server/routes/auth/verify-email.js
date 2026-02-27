import { Router } from 'express';
import { pool } from '../../db.js';

const router = Router();

router.post('/', async (req, res) => {
  const { code, token } = req.body;

  // Validate input
  if (!code || !token) {
    return res.status(400).json({ 
      success: false, 
      message: 'Code and token are required' 
    });
  }

  if (code.length !== 6) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid code format' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Find verification by BOTH token AND code
    const result = await client.query(
      `SELECT user_id, expires_at 
       FROM email_verifications 
       WHERE token = $1 AND code = $2`,
      [token, code]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid token or verification code' 
      });
    }

    const { user_id, expires_at } = result.rows[0];

    // Check if expired
    if (new Date() > new Date(expires_at)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: 'Verification has expired' 
      });
    }

    // Mark user as verified
    await client.query(
      'UPDATE users SET is_verified = true WHERE id = $1',
      [user_id]
    );

    // Delete verification record (removes both code and token)
    await client.query(
      'DELETE FROM email_verifications WHERE user_id = $1',
      [user_id]
    );

    await client.query('COMMIT');

    res.json({ 
      success: true, 
      message: 'Email verified successfully' 
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Verification error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during verification' 
    });
  } finally {
    client.release();
  }
});

export default router;