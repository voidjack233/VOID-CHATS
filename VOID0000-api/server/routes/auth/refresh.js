import { Router } from 'express';
import { pool } from '../../db.js';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getClientIP } from '../../utils/securityUtils.js';
import { accessCookieOptions, refreshCookieOptions, clearCookieOptions } from '../../utils/cookieConfig.js';
import { hashToken } from '../../utils/hashToken.js';
import { sessionStore } from '../../middleware/sessionStore.js';
import { syncLiveTokenExpiry } from '../../gateway/control.js';
import { debugLog } from '../../utils/debugLog.js';
import { getAccessSecret, getRefreshSecret } from '../../utils/authSecrets.js';

const router = Router();

const normalizeIP = (ip) => {
  if (!ip) return null;
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
};

router.post('/', async (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({
      success: false,
      code: 'NO_REFRESH_TOKEN',
      message: 'No refresh token'
    });
  }

  let client;

  try {
    // 1. VERIFY JWT STRUCTURE
    const decoded = jwt.verify(refreshToken, getRefreshSecret());

    if (!decoded.id || !decoded.profile_id || !decoded.jti || !decoded.device_id) {
      console.error('Invalid JWT payload:', decoded);
      return res.status(403).json({
        success: false,
        code: 'TOKEN_INVALID',
        message: 'Malformed token'
      });
    }

    if (decoded.type !== 'refresh') {
      return res.status(403).json({
        success: false,
        code: 'TOKEN_INVALID',
        message: 'Wrong token type'
      });
    }

    // 2. DATABASE LOOKUP
    client = await pool.connect();
    await client.query('BEGIN');

    const tokenHash = hashToken(refreshToken);

    const result = await client.query(
      `SELECT rt.*, u.is_verified 
       FROM refresh_tokens rt
       JOIN users u ON rt.user_id = u.id
       WHERE rt.jti = $1 
         AND rt.user_id = $2 
         AND rt.token_hash = $3
         AND rt.expires_at > NOW() 
         AND rt.is_revoked = FALSE`,
      [decoded.jti, decoded.id, tokenHash]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');

      // Check if this is a rotation race condition:
      // Another request already rotated this token, but the device still has a valid session
      const deviceCheck = await pool.query(
        `SELECT id FROM refresh_tokens 
         WHERE user_id = $1 
           AND device_id = $2 
           AND is_revoked = FALSE 
           AND expires_at > NOW()`,
        [decoded.id, decoded.device_id]
      );

      if (deviceCheck.rows.length > 0) {
        // Valid token exists for this device — race condition, not theft
        // Issue new access token only (the other request already rotated the refresh token)
        const newAccessToken = jwt.sign(
          {
            id: decoded.id,
            profile_id: decoded.profile_id,
            device_id: decoded.device_id,
            jti: uuidv4(),
            type: 'access'
          },
          getAccessSecret(),
          { expiresIn: '15m' }
        );

        const newAccessDecoded = jwt.decode(newAccessToken);

        res.cookie('accessToken', newAccessToken, accessCookieOptions(req));

        const touched = await sessionStore.touch(decoded.id, decoded.device_id);
        if (!touched) {
          await sessionStore.create(decoded.id, decoded.device_id, {
            ip: normalizeIP(getClientIP(req)),
            userAgent: req.get('User-Agent') || 'unknown',
            deviceName: 'Unknown',
            deviceType: 'unknown',
          });
        }

        if (Number.isInteger(newAccessDecoded?.exp)) {
          await syncLiveTokenExpiry(decoded.id, decoded.device_id, newAccessDecoded.exp);
        }

        debugLog(`🔄 Refresh race handled for user ${decoded.id.substring(0, 8)}... — issued new access token only`);

        return res.json({
          success: true,
          message: 'Token refreshed (race recovery)'
        });
      }

      // No valid token for this device — genuinely invalid
      res.clearCookie('accessToken', clearCookieOptions(req));
      res.clearCookie('refreshToken', clearCookieOptions(req));

      return res.status(403).json({
        success: false,
        code: 'REFRESH_TOKEN_INVALID',
        message: 'Session expired. Please login again.'
      });
    }

    const tokenRecord = result.rows[0];

    if (tokenRecord.device_id !== decoded.device_id) {
      console.error('Device mismatch:', {
        tokenDevice: tokenRecord.device_id,
        jwtDevice: decoded.device_id
      });
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        code: 'DEVICE_MISMATCH',
        message: 'Device verification failed'
      });
    }

    if (!tokenRecord.is_verified) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        code: 'USER_NOT_VERIFIED',
        message: 'Account verification required'
      });
    }

    // 3. GENERATE NEW TOKENS
    const newJtiAccess = uuidv4();
    const newJtiRefresh = uuidv4();

    const tokenPayload = {
      id: decoded.id,
      profile_id: decoded.profile_id,
      device_id: decoded.device_id
    };

    const newAccessToken = jwt.sign(
      { ...tokenPayload, jti: newJtiAccess, type: 'access' },
      getAccessSecret(),
      { expiresIn: '15m' }
    );
    const newAccessDecoded = jwt.decode(newAccessToken);

    const newRefreshToken = jwt.sign(
      { ...tokenPayload, jti: newJtiRefresh, type: 'refresh' },
      getRefreshSecret(),
      { expiresIn: '30d' }
    );

    // 4. TOKEN ROTATION
    const newTokenHash = hashToken(newRefreshToken);

    await client.query(
      `INSERT INTO refresh_tokens 
        (user_id, token_hash, jti, expires_at, ip_address, user_agent, device_id, device_name, device_type, last_used_at, is_revoked, revoked_at, created_at) 
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', $4, $5, $6, $7, $8, NOW(), FALSE, NULL, NOW())
       ON CONFLICT ON CONSTRAINT unique_user_device 
       DO UPDATE SET 
         token_hash = EXCLUDED.token_hash,
         jti = EXCLUDED.jti,
         expires_at = EXCLUDED.expires_at,
         ip_address = EXCLUDED.ip_address,
         user_agent = EXCLUDED.user_agent,
         last_used_at = NOW(),
         is_revoked = FALSE,
         revoked_at = NULL`,
      [
        decoded.id,
        newTokenHash,
        newJtiRefresh,
        normalizeIP(getClientIP(req)),
        req.get('User-Agent') || 'unknown',
        decoded.device_id,
        tokenRecord.device_name || 'Unknown',
        tokenRecord.device_type || 'unknown'
      ]
    );

    // 5. CLEANUP
    await client.query(
      `DELETE FROM refresh_tokens 
       WHERE expires_at < NOW() - INTERVAL '7 days'
          OR (is_revoked = TRUE AND revoked_at < NOW() - INTERVAL '7 days')`
    );

    await client.query('COMMIT');

    const touched = await sessionStore.touch(decoded.id, decoded.device_id);
    if (!touched) {
      await sessionStore.create(decoded.id, decoded.device_id, {
        ip: normalizeIP(getClientIP(req)),
        userAgent: req.get('User-Agent') || 'unknown',
        deviceName: tokenRecord.device_name || 'Unknown',
        deviceType: tokenRecord.device_type || 'unknown',
      });
    }

    if (Number.isInteger(newAccessDecoded?.exp)) {
      await syncLiveTokenExpiry(decoded.id, decoded.device_id, newAccessDecoded.exp);
    }

    // 6. SET COOKIES
    res.cookie('accessToken', newAccessToken, accessCookieOptions(req));
    res.cookie('refreshToken', newRefreshToken, refreshCookieOptions(req));

    res.json({
      success: true,
      message: 'Token refreshed'
    });

  } catch (err) {
    if (client) await client.query('ROLLBACK');

    console.error('Refresh error:', err);

    // Only clear cookies for definitive token errors
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
      res.clearCookie('accessToken', clearCookieOptions(req));
      res.clearCookie('refreshToken', clearCookieOptions(req));

      return res.status(403).json({
        success: false,
        code: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
        message: 'Session expired. Please login again.'
      });
    }

    // Transient error (DB hiccup, etc.) — don't destroy the session
    return res.status(500).json({
      success: false,
      code: 'REFRESH_FAILED',
      message: 'Refresh failed, please try again'
    });
  } finally {
    if (client) client.release();
  }
});

export default router;
