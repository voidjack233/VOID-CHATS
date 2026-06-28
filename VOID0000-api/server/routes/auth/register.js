import { Router } from 'express';
import { pool } from '../../db.js';
import argon2 from 'argon2';
import { IPSecurity, DeviceManager } from '../../utils/securityUtils.js';
import { generateVerificationToken, getCodeExpiration } from '../../middleware/emailService.js';
import { DeviceFingerprint } from '../../utils/deviceFingerprint.js';
import { recordAccountCreation } from '../../middleware/captcha/trustScore.js';
import { profileSnowflake } from '../../utils/snowflake.js';
import { hashToken } from '../../utils/hashToken.js';
import { validateAccountPassword } from '../../utils/passwordPolicy.js';

const router = Router();

router.post('/', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    await IPSecurity.logIPActivity(req, 'REGISTER_FAILURE_MISSING_FIELDS');
    return res.status(400).json({ 
      success: false, 
      message: 'All fields are required' 
    });
  }

  const passwordError = validateAccountPassword(password);
  if (passwordError) {
    await IPSecurity.logIPActivity(req, 'REGISTER_FAILURE_WEAK_PASSWORD');
    return res.status(400).json({
      success: false,
      message: passwordError,
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id, email, username FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );

    if (existing.rows.length > 0) {
      const isDuplicateEmail = existing.rows.some(row => row.email === email);
      const isDuplicateUsername = existing.rows.some(row => row.username === username);

      if (isDuplicateEmail) {
        await IPSecurity.logIPActivity(req, 'REGISTER_FAILURE_EMAIL_EXISTS', null, client);
        await client.query('ROLLBACK');
        return res.status(409).json({ 
          success: false, 
          message: 'Unable to create an account with those details'
        });
      }
      
      if (isDuplicateUsername) {
        await IPSecurity.logIPActivity(req, 'REGISTER_FAILURE_USERNAME_EXISTS', null, client);
        await client.query('ROLLBACK');
        return res.status(409).json({ 
          success: false, 
          message: 'Unable to create an account with those details'
        });
      }
    }

    const hashed = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1
    });

    const profile_id = profileSnowflake.nextId();

    const userResult = await client.query(
      `INSERT INTO users (username, email, password_hash, created_at, updated_at, is_verified)
       VALUES ($1, $2, $3, NOW(), NOW(), false)
       RETURNING id, username, email, created_at`,
      [username, email, hashed]
    );

    const newUser = userResult.rows[0];
    const user_id = newUser.id;

    await client.query(
      `INSERT INTO user_profiles (id, user_id, display_name, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [profile_id, user_id, username]
    );

    await client.query(
      `UPDATE users SET profile_id = $1 WHERE id = $2`,
      [profile_id, user_id]
    );

    await DeviceManager.registerDevice(user_id, req, client);

    const verificationToken = generateVerificationToken();
    const verificationTokenHash = hashToken(verificationToken);
    const expiresAt = getCodeExpiration();

    await client.query(
      `INSERT INTO email_verifications (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [user_id, verificationTokenHash, expiresAt]
    );

    await IPSecurity.logIPActivity(req, 'REGISTER_SUCCESS', user_id, client);

    await client.query('COMMIT');

    // Record account creation for trust scoring (outside transaction)
    const trustDeviceId = DeviceFingerprint.generateFingerprint(req);
    await recordAccountCreation(trustDeviceId);

    res.json({
      success: true,
      message: 'User registered successfully.',
      verificationToken,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        profile_id: profile_id
      }
    });

  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError);
    }
    
    console.error('Register error:', err);
    
    try {
      await IPSecurity.logIPActivity(req, 'REGISTER_ERROR_SERVER');
    } catch (logError) {
      console.error('Failed to log IP activity:', logError);
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Server error during registration',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    client.release();
  }
});

export default router;
