import express from 'express';
import { pool as db } from '../../db.js';
import { authenticateUser } from '../../middleware/jwt.js';
import { sessionStore } from '../../middleware/sessionStore.js';
import { disconnectLiveSession } from '../../gateway/control.js';
import { hashToken } from '../../utils/hashToken.js';

const router = express.Router();

// GET /api/users/sessions - List all active sessions
router.get('/', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const currentToken = req.cookies.refreshToken;
  const currentTokenHash = currentToken ? hashToken(currentToken) : null;

  try {
    const result = await db.query(
      `SELECT id, ip_address, user_agent, created_at, expires_at, token_hash
       FROM refresh_tokens
       WHERE user_id = $1 AND expires_at > NOW() AND is_revoked = FALSE
       ORDER BY created_at DESC`,
      [userId]
    );

    const sessions = result.rows.map(session => ({
      id: session.id,
      ip_address: session.ip_address,
      user_agent: session.user_agent,
      created_at: session.created_at,
      expires_at: session.expires_at,
      is_current: session.token_hash === currentTokenHash
    }));

    res.json({
      success: true,
      sessions
    });
  } catch (err) {
    console.error('Sessions GET error:', err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// DELETE /api/users/sessions/:id - Revoke specific session
router.delete('/:id', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const sessionId = req.params.id;
  const currentToken = req.cookies.refreshToken;
  const currentTokenHash = currentToken ? hashToken(currentToken) : null;

  try {
    const checkResult = await db.query(
      `SELECT token_hash, device_id FROM refresh_tokens WHERE id = $1 AND user_id = $2`,
      [sessionId, userId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (checkResult.rows[0].token_hash === currentTokenHash) {
      return res.status(400).json({ error: 'Cannot revoke current session. Use logout instead.' });
    }

    const revoked = await db.query(
      `DELETE FROM refresh_tokens WHERE id = $1 AND user_id = $2 RETURNING device_id`,
      [sessionId, userId]
    );

    const revokedDeviceId = revoked.rows[0]?.device_id;
    if (revokedDeviceId) {
      await sessionStore.revoke(userId, revokedDeviceId);
      await disconnectLiveSession(userId, revokedDeviceId);
    }

    res.json({
      success: true,
      message: 'Session revoked'
    });
  } catch (err) {
    console.error('Session DELETE error:', err);
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

// DELETE /api/users/sessions - Revoke all sessions except current
router.delete('/', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const currentToken = req.cookies.refreshToken;
  const currentTokenHash = currentToken ? hashToken(currentToken) : null;

  try {
    const result = await db.query(
      `DELETE FROM refresh_tokens 
       WHERE user_id = $1 AND token_hash != $2
       RETURNING id, device_id`,
      [userId, currentTokenHash]
    );

    for (const row of result.rows) {
      if (!row.device_id) continue;
      await sessionStore.revoke(userId, row.device_id);
      await disconnectLiveSession(userId, row.device_id);
    }

    res.json({
      success: true,
      message: `${result.rowCount} session(s) revoked`
    });
  } catch (err) {
    console.error('Sessions DELETE ALL error:', err);
    res.status(500).json({ error: 'Failed to revoke sessions' });
  }
});

export default router;
