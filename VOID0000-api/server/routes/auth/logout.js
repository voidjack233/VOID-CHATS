import { Router } from 'express';
import { pool } from '../../db.js';
import jwt from 'jsonwebtoken';
import { IPSecurity } from '../../utils/securityUtils.js';
import { clearCookieOptions } from '../../utils/cookieConfig.js';
import { hashToken } from '../../utils/hashToken.js';
import { sessionStore } from '../../middleware/sessionStore.js';
import { disconnectLiveSession } from '../../gateway/control.js';
import { getRefreshSecret } from '../../utils/authSecrets.js';

const router = Router();

// Clear cookies on both domains to kill stale duplicates
function clearAllCookies(req, res) {
  const cookieNames = ['accessToken', 'refreshToken', '_csrf'];

  // Clear with domain (.void0000.online)
  cookieNames.forEach(name => {
    res.clearCookie(name, clearCookieOptions(req));
  });

  // Clear without domain (kills stale api.void0000.online cookies)
  cookieNames.forEach(name => {
    res.clearCookie(name, { path: '/', httpOnly: true });
  });
}

router.post('/', async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  let userId = null;
  let deviceId = null;

  try {
    if (refreshToken) {
      try {
        const decoded = jwt.verify(refreshToken, getRefreshSecret());
        userId = decoded.id;
        deviceId = decoded.device_id || null;

        await pool.query(
          'UPDATE refresh_tokens SET is_revoked = TRUE, revoked_at = NOW() WHERE jti = $1',
          [decoded.jti]
        );
      } catch (err) {
        const tokenHash = hashToken(refreshToken);
        const revoked = await pool.query(
          `UPDATE refresh_tokens
           SET is_revoked = TRUE, revoked_at = NOW()
           WHERE token_hash = $1
           RETURNING user_id, device_id`,
          [tokenHash]
        );

        if (revoked.rows.length > 0) {
          userId = revoked.rows[0].user_id;
          deviceId = revoked.rows[0].device_id;
        }
      }

      if (userId && deviceId) {
        await sessionStore.revoke(userId, deviceId);
        await disconnectLiveSession(userId, deviceId);
      }
    }

    clearAllCookies(req, res);

    await IPSecurity.logIPActivity(req, 'LOGOUT_SUCCESS', userId);

    res.json({ 
      success: true, 
      message: 'Logged out successfully' 
    });
    
  } catch (err) {
    console.error('Logout error:', err);

    clearAllCookies(req, res);

    await IPSecurity.logIPActivity(req, 'LOGOUT_FAILED', userId);

    res.json({ success: true });
  }
});

export default router;
