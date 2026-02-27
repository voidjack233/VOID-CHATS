import { Router } from 'express';
import { getTrustScore, TRUST_THRESHOLD, shouldRequireCaptchaForRegistration } from '../../middleware/captcha/trustScore.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const action = req.query.action || 'login';
    let captchaRequired = true;

    if (action === 'register') {
      captchaRequired = await shouldRequireCaptchaForRegistration(req);
    } else {
      const trust = await getTrustScore(req);
      captchaRequired = trust.isNew || trust.score < TRUST_THRESHOLD;
    }

    res.json({ success: true, captchaRequired });
  } catch (err) {
    console.error('Captcha check error:', err);
    res.json({ success: true, captchaRequired: true });
  }
});

export default router;