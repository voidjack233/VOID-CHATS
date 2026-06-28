import valkey from '../valkey.js';

const CAPTCHA_KEY_PREFIX = 'captcha:challenge:';
const CAPTCHA_TTL_SECONDS = 5 * 60;

function getCaptchaKey(captchaId) {
  return `${CAPTCHA_KEY_PREFIX}${captchaId}`;
}

export async function saveCaptchaChallenge(captchaId, solution) {
  await valkey.set(
    getCaptchaKey(captchaId),
    JSON.stringify({
      solution,
      attempts: 0,
    }),
    'EX',
    CAPTCHA_TTL_SECONDS,
  );
}

export async function getCaptchaChallenge(captchaId) {
  const raw = await valkey.get(getCaptchaKey(captchaId));
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    await deleteCaptchaChallenge(captchaId);
    return null;
  }
}

export async function updateCaptchaChallenge(captchaId, challenge) {
  const key = getCaptchaKey(captchaId);
  const ttl = await valkey.ttl(key);
  if (ttl <= 0) return false;

  await valkey.set(key, JSON.stringify(challenge), 'EX', ttl);
  return true;
}

export async function deleteCaptchaChallenge(captchaId) {
  await valkey.del(getCaptchaKey(captchaId));
}
