import { getCaptchaStore } from '../../routes/captcha/generate.js';
import { getTrustScore, updateTrustScore, TRUST_THRESHOLD, shouldRequireCaptchaForRegistration } from './trustScore.js';

export async function verifyCaptcha(req, res, next) {
  try {
    const trust = await getTrustScore(req);

    if (!trust.isNew && trust.score >= TRUST_THRESHOLD) {
      req.captchaSkipped = true;
      return next();
    }
  } catch (err) {
    console.error('Trust check error:', err);
  }

  return verifyCaptchaAnswer(req, res, next);
}

export async function verifyCaptchaForRegistration(req, res, next) {
  try {
    const required = await shouldRequireCaptchaForRegistration(req);

    if (!required) {
      req.captchaSkipped = true;
      return next();
    }
  } catch (err) {
    console.error('Registration trust check error:', err);
  }

  return verifyCaptchaAnswer(req, res, next);
}

async function verifyCaptchaAnswer(req, res, next) {
  const { captchaId, captchaAnswer } = req.body;

  if (!captchaId || !captchaAnswer) {
    return res.status(400).json({
      success: false,
      message: 'Captcha is required',
      code: 'CAPTCHA_REQUIRED'
    });
  }

  const store = getCaptchaStore();
  const captchaData = store.get(captchaId);

  if (!captchaData) {
    return res.status(400).json({
      success: false,
      message: 'Captcha expired or invalid. Please refresh.',
      code: 'CAPTCHA_INVALID'
    });
  }

  if (Date.now() > captchaData.expiresAt) {
    store.delete(captchaId);
    return res.status(400).json({
      success: false,
      message: 'Captcha expired. Please refresh.',
      code: 'CAPTCHA_EXPIRED'
    });
  }

  if (captchaData.attempts >= 3) {
    store.delete(captchaId);
    const trust = await getTrustScore(req);
    await updateTrustScore(trust.deviceId, 'CAPTCHA_FAILED', req);
    return res.status(400).json({
      success: false,
      message: 'Too many failed attempts. Please refresh captcha.',
      code: 'CAPTCHA_MAX_ATTEMPTS'
    });
  }

  captchaData.attempts++;

  if (captchaAnswer.toUpperCase().trim() !== captchaData.solution) {
    const trust = await getTrustScore(req);
    await updateTrustScore(trust.deviceId, 'CAPTCHA_FAILED', req);
    return res.status(400).json({
      success: false,
      message: 'Incorrect captcha. Please try again.',
      code: 'CAPTCHA_WRONG',
      attemptsLeft: 3 - captchaData.attempts
    });
  }

  store.delete(captchaId);
  const trust = await getTrustScore(req);
  await updateTrustScore(trust.deviceId, 'CAPTCHA_PASSED', req);
  next();
}