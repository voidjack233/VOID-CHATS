import express from 'express';
import { pool as db } from '../../db.js';
import { authenticateUser } from '../../middleware/jwt.js';

const router = express.Router();

// GET /api/users/account - Get current user's account info
router.get('/', authenticateUser, async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await db.query(
      `SELECT id, email, username, profile_id, created_at
       FROM users
       WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      account: result.rows[0]
    });
  } catch (err) {
    console.error('AccountRead GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;