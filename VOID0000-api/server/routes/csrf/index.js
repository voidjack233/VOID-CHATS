import { Router } from 'express';
import { generateEncryptedCSRFToken } from '../../middleware/encryptedCSRF.js';
import { getCookieOptions } from '../../utils/cookieConfig.js'; 

const router = Router();

router.get('/csrf-token', (req, res) => {
  const { plainToken, encryptedToken } = generateEncryptedCSRFToken();

  // Use same cookie options as auth tokens
  res.cookie('_csrf', encryptedToken, getCookieOptions(30 * 24 * 60 * 60 * 1000, req));  // 30 days

  res.json({
    success: true,
    csrfToken: plainToken
  });
});

export default router;
