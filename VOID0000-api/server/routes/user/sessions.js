import express from 'express';
import { pool as db } from '../../db.js';
import { authenticateUser } from '../../middleware/jwt.js';
import { sessionStore } from '../../middleware/sessionStore.js';
import { disconnectLiveSession } from '../../gateway/control.js';

const router = express.Router();

// GET /api/users/sessions - List all active sessions
router.get('/', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const currentDeviceId = req.user.device_id;

  try {
    const result = await db.query(
      `WITH ranked_sessions AS (
         SELECT
           device_id,
           device_name,
           device_type,
           ip_address,
           user_agent,
           created_at,
           COALESCE(last_used_at, created_at) AS last_seen_at,
           expires_at,
           ROW_NUMBER() OVER (
             PARTITION BY device_id
             ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC
           ) AS row_rank,
           MIN(created_at) OVER (PARTITION BY device_id) AS first_seen_at,
           MAX(COALESCE(last_used_at, created_at)) OVER (PARTITION BY device_id) AS updated_at
         FROM refresh_tokens
         WHERE user_id = $1
           AND expires_at > NOW()
           AND is_revoked = FALSE
           AND device_id IS NOT NULL
       )
       SELECT
         device_id,
         device_name,
         device_type,
         ip_address,
         user_agent,
         first_seen_at AS created_at,
         updated_at,
         expires_at
       FROM ranked_sessions
       WHERE row_rank = 1
       ORDER BY updated_at DESC, created_at DESC`,
      [userId]
    );

    const sessions = result.rows.map(session => ({
      id: session.device_id,
      device_id: session.device_id,
      device_name: session.device_name,
      device_type: session.device_type,
      ip_address: session.ip_address,
      user_agent: session.user_agent,
      created_at: session.created_at,
      updated_at: session.updated_at,
      expires_at: session.expires_at,
      is_current: session.device_id === currentDeviceId
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
  const deviceId = req.params.id;
  const currentDeviceId = req.user.device_id;

  try {
    const checkResult = await db.query(
      `SELECT device_id
       FROM refresh_tokens
       WHERE user_id = $1
         AND device_id = $2
         AND expires_at > NOW()
         AND is_revoked = FALSE
       LIMIT 1`,
      [userId, deviceId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (deviceId === currentDeviceId) {
      return res.status(400).json({ error: 'Cannot revoke current session. Use logout instead.' });
    }

    const revoked = await db.query(
      `DELETE FROM refresh_tokens
       WHERE user_id = $1
         AND device_id = $2
       RETURNING device_id`,
      [userId, deviceId]
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
  const currentDeviceId = req.user.device_id;

  try {
    const result = await db.query(
      `DELETE FROM refresh_tokens 
       WHERE user_id = $1
         AND device_id IS DISTINCT FROM $2
       RETURNING id, device_id`,
      [userId, currentDeviceId]
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
