import { pool } from '../../db.js';
import { DeviceFingerprint } from '../../utils/deviceFingerprint.js';

const TRUST_THRESHOLD = 0.75; // Above this = skip captcha

export async function getTrustScore(req) {
  try {
    const deviceId = DeviceFingerprint.generateFingerprint(req);

    const result = await pool.query(
      'SELECT * FROM trust_scores WHERE device_id = $1',
      [deviceId]
    );

    if (result.rows.length === 0) {
      return { score: 0, isNew: true, deviceId };
    }

    const record = result.rows[0];
    return {
      score: parseFloat(record.trust_score),
      isNew: false,
      deviceId,
      record
    };
  } catch (err) {
    console.error('Trust score lookup error:', err);
    return { score: 0, isNew: true, deviceId: null };
  }
}

export async function updateTrustScore(deviceId, event, req) {
  if (!deviceId) return;

  try {
    const ip = req?.ip || null;

    // Upsert device record
    await pool.query(
      `INSERT INTO trust_scores (device_id, ip_address, first_seen_at, last_seen_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (device_id) DO UPDATE SET
         ip_address = COALESCE($2, trust_scores.ip_address),
         last_seen_at = NOW()`,
      [deviceId, ip]
    );

    // Update counters based on event
    let counterUpdate = '';
    switch (event) {
      case 'LOGIN_SUCCESS':
        counterUpdate = 'successful_logins = successful_logins + 1';
        break;
      case 'LOGIN_FAILED':
        counterUpdate = 'failed_logins = failed_logins + 1';
        break;
      case 'CAPTCHA_PASSED':
        counterUpdate = 'captchas_passed = captchas_passed + 1';
        break;
      case 'CAPTCHA_FAILED':
        counterUpdate = 'captchas_failed = captchas_failed + 1';
        break;
      default:
        return;
    }

    await pool.query(
      `UPDATE trust_scores SET ${counterUpdate} WHERE device_id = $1`,
      [deviceId]
    );

    // Recalculate trust score
    const result = await pool.query(
      'SELECT * FROM trust_scores WHERE device_id = $1',
      [deviceId]
    );

    if (result.rows.length === 0) return;

    const r = result.rows[0];
    const totalLogins = r.successful_logins + r.failed_logins;
    const totalCaptchas = r.captchas_passed + r.captchas_failed;

    let score = 0.50; // base

    // Login success ratio (weight: 0.30)
    if (totalLogins > 0) {
      const loginRatio = r.successful_logins / totalLogins;
      score += (loginRatio - 0.5) * 0.30;
    }

    // Captcha success ratio (weight: 0.20)
    if (totalCaptchas > 0) {
      const captchaRatio = r.captchas_passed / totalCaptchas;
      score += (captchaRatio - 0.5) * 0.20;
    }

    // Longevity bonus: days since first seen (weight: 0.15, max at 30 days)
    const daysSinceFirst = (Date.now() - new Date(r.first_seen_at).getTime()) / (1000 * 60 * 60 * 24);
    const longevityBonus = Math.min(daysSinceFirst / 30, 1) * 0.15;
    score += longevityBonus;

    // Activity bonus: total successful logins (weight: 0.10, max at 20 logins)
    const activityBonus = Math.min(r.successful_logins / 20, 1) * 0.10;
    score += activityBonus;

    // Penalty: recent failures drag score down harder
    if (r.failed_logins > 5) {
      score -= 0.15;
    }
    if (r.captchas_failed > 3) {
      score -= 0.10;
    }

    // Clamp between 0 and 1
    score = Math.max(0, Math.min(1, score));

    await pool.query(
      'UPDATE trust_scores SET trust_score = $1 WHERE device_id = $2',
      [score.toFixed(2), deviceId]
    );

  } catch (err) {
    console.error('Trust score update error:', err);
  }
}

export async function recordAccountCreation(deviceId) {
  if (!deviceId) return;

  try {
    await pool.query(
      `UPDATE trust_scores 
       SET accounts_created = accounts_created + 1, 
           last_account_created_at = NOW() 
       WHERE device_id = $1`,
      [deviceId]
    );
  } catch (err) {
    console.error('Record account creation error:', err);
  }
}

export async function shouldRequireCaptchaForRegistration(req) {
  try {
    const trust = await getTrustScore(req);

    // New device → always captcha
    if (trust.isNew) return true;

    // Low trust → always captcha
    if (trust.score < TRUST_THRESHOLD) return true;

    const record = trust.record;

    // 3+ accounts from this device → always captcha
    if (record.accounts_created >= 3) return true;

    // Created an account less than 24 hours ago → captcha
    if (record.last_account_created_at) {
      const hoursSince = (Date.now() - new Date(record.last_account_created_at).getTime()) / (1000 * 60 * 60);
      if (hoursSince < 24) return true;
    }

    return false;
  } catch (err) {
    console.error('Registration captcha check error:', err);
    return true; // Default to requiring captcha
  }
}

export { TRUST_THRESHOLD };