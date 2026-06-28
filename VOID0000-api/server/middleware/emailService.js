import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { debugLog } from '../utils/debugLog.js';
import { hashEmailVerificationCode } from '../utils/emailVerificationSecurity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create reusable transporter
const createTransporter = () => {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
};

// Load and process HTML template
const loadTemplate = (templateName, variables) => {
  const templatePath = path.join(__dirname, '../utils/emails', `${templateName}.html`);
  let html = fs.readFileSync(templatePath, 'utf8');
  
  for (const [key, value] of Object.entries(variables)) {
    html = html.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  
  return html;
};

// Send Verification Email
export async function sendVerificationEmail(email, code, verificationUrl = '') {
  const transporter = createTransporter();
  
  const html = loadTemplate('verificationEmail', {
    CODE: code,
    VERIFICATION_LINK: verificationUrl
      ? `<p style="margin: 24px 0 0; text-align: center;"><a href="${verificationUrl}" style="display: inline-block; padding: 12px 18px; background: #2563eb; color: #ffffff; border-radius: 10px; text-decoration: none; font-weight: 600;">Open Verification Page</a></p>`
      : '',
    YEAR: new Date().getFullYear()
  });

  await transporter.sendMail({
    from: `"Void App" <no-reply@void0000.online>`,
    to: email,
    subject: 'Your Verification Code - Void App',
    text: `Your verification code is: ${code}${verificationUrl ? `\n\nOpen the verification page:\n${verificationUrl}` : ''}\n\nIt will expire in 15 minutes.\n\nIf you didn't request this code, please ignore this email.`,
    html
  });
  
  debugLog(`Verification code email sent to ${email}`);
}

// Send Password Reset Email
export async function sendPasswordResetEmail(email, resetUrl) {
  const transporter = createTransporter();
  
  const html = loadTemplate('passwordResetEmail', {
    RESET_URL: resetUrl,
    YEAR: new Date().getFullYear()
  });

  await transporter.sendMail({
    from: `"Void App" <no-reply@void0000.online>`,
    to: email,
    subject: 'Reset Your Password - Void App',
    text: `Click the link to reset your password:\n\n${resetUrl}\n\nThis link is valid for 1 hour.\n\nIf you didn't request this, please ignore this email.`,
    html
  });
  
  debugLog(`Password reset email sent to ${email}`);
}

// Generate Verification Code (6-digit)
export function generateVerificationCode() {
  return crypto.randomInt(100000, 999999).toString();
}

// Generate Verification Token (for URL)
export function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Get Code Expiration Time (15 minutes)
export function getCodeExpiration() {
  return new Date(Date.now() + 15 * 60 * 1000);
}

// Verification Service Class
export class VerificationService {
  static async sendVerificationEmail(email, code, verificationUrl = '') {
    return await sendVerificationEmail(email, code, verificationUrl);
  }

  static async createVerificationCode(client, user_id, email) {
    const code = generateVerificationCode();
    const expires_at = getCodeExpiration();

    await client.query('DELETE FROM email_verifications WHERE user_id = $1', [user_id]);

    await client.query(
      `INSERT INTO email_verifications (user_id, code, expires_at)
       VALUES ($1, $2, $3)`,
      [user_id, hashEmailVerificationCode(user_id, code), expires_at]
    );

    debugLog(`Verification code ${code} inserted for user_id ${user_id}`);

    try {
      await sendVerificationEmail(email, code);
      return { success: true, code };
    } catch (emailError) {
      console.error('Failed to send email:', emailError);
      return { success: false, code, error: emailError.message };
    }
  }

  static async sendVerificationCodeToUser(pool, email) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const result = await client.query('SELECT id FROM users WHERE email = $1', [email]);
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return { success: false, message: 'User not found' };
      }

      const user_id = result.rows[0].id;
      const { success, code, error } = await this.createVerificationCode(client, user_id, email);
      
      await client.query('COMMIT');
      
      return { 
        success: success, 
        message: success ? 'Verification code sent' : 'Code created but email failed',
        code: code
      };
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error in sendVerificationCodeToUser:', err);
      throw err;
    } finally {
      client.release();
    }
  }
}
