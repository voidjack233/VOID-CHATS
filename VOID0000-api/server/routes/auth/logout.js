import { Router } from 'express';
import { pool } from '../../db.js';
import jwt from 'jsonwebtoken';
import { IPSecurity } from '../../utils/securityUtils.js';
import { clearCookieOptions } from '../../utils/cookieConfig.js';
import { hashToken } from '../../utils/hashToken.js';

const router = Router();
const REFRESH_SECRET = process.env.REFRESH_SECRET;

// Clear cookies on both domains to kill stale duplicates
function clearAllCookies(res) {
  const cookieNames = ['accessToken', 'refreshToken', '_csrf'];

  // Clear with domain (.void0000.online)
  cookieNames.forEach(name => {
    res.clearCookie(name, clearCookieOptions());
  });

  // Clear without domain (kills stale api.void0000.online cookies)
  cookieNames.forEach(name => {
    res.clearCookie(name, { path: '/', httpOnly: true });
  });
}

router.post('/', async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  let userId = null;

  try {
    if (refreshToken) {
      try {
        const decoded = jwt.verify(refreshToken, REFRESH_SECRET);
        userId = decoded.id;
        
        await pool.query(
          'UPDATE refresh_tokens SET is_revoked = TRUE, revoked_at = NOW() WHERE jti = $1',
          [decoded.jti]
        );
      } catch (err) {
        const tokenHash = hashToken(refreshToken);
        await pool.query(
          'UPDATE refresh_tokens SET is_revoked = TRUE, revoked_at = NOW() WHERE token_hash = $1',
          [tokenHash]
        );
      }
    }

    clearAllCookies(res);

    await IPSecurity.logIPActivity(req, 'LOGOUT_SUCCESS', userId);

    res.json({ 
      success: true, 
      message: 'Logged out successfully' 
    });
    
  } catch (err) {
    console.error('Logout error:', err);

    clearAllCookies(res);

    await IPSecurity.logIPActivity(req, 'LOGOUT_FAILED', userId);

    res.json({ success: true });
  }
});

export default router;