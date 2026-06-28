import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { sessionStore } from './sessionStore.js';
import { getAccessSecret } from '../utils/authSecrets.js';

const router = Router();

async function verifyRequestSession(req) {
  const token = req.cookies.accessToken;

  if (!token) {
    return { ok: false, status: 401, body: { error: 'Authentication required' } };
  }

  try {
    const decoded = jwt.verify(token, getAccessSecret());
    if (!decoded.id || !decoded.device_id) {
      return { ok: false, status: 401, body: { error: 'Token invalid or expired' } };
    }

    let session = await sessionStore.validate(decoded.id, decoded.device_id);

    if (!session) {
      const result = await pool.query(
        `SELECT ip_address, user_agent, device_name, device_type
         FROM refresh_tokens
         WHERE user_id = $1
           AND device_id = $2
           AND is_revoked = FALSE
           AND expires_at > NOW()
         ORDER BY last_used_at DESC NULLS LAST, created_at DESC
         LIMIT 1`,
        [decoded.id, decoded.device_id]
      );

      if (result.rows.length === 0) {
        return { ok: false, status: 401, body: { error: 'Session invalid or revoked' } };
      }

      const activeSession = result.rows[0];
      session = await sessionStore.create(decoded.id, decoded.device_id, {
        ip: activeSession.ip_address || 'unknown',
        userAgent: activeSession.user_agent || 'unknown',
        deviceName: activeSession.device_name || 'Unknown',
        deviceType: activeSession.device_type || 'unknown',
      });

      if (!session) {
        return { ok: false, status: 500, body: { error: 'Session validation failed' } };
      }
    }

    return { ok: true, user: decoded };
  } catch (err) {
    return { ok: false, status: 401, body: { error: 'Token invalid or expired' } };
  }
}

export const authenticateUser = async (req, res, next) => {
  const result = await verifyRequestSession(req);

  if (!result.ok) {
    return res.status(result.status).json(result.body);
  }

  req.user = result.user;
  next();
};

// API ENDPOINT
router.get('/', async (req, res) => {
  const result = await verifyRequestSession(req);

  if (!result.ok) {
    return res.status(result.status).json({
      success: false,
      message: result.body.error,
    });
  }

  res.json({ success: true, user: result.user });
});

export default router;
