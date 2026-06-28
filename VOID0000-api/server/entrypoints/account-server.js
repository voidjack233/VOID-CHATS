import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { securityMiddleware } from '../middleware/xss/index.js';
import captchaRouter from '../routes/captcha/index.js';
import { pool } from '../db.js';
import valkey from '../valkey.js';
import { createReadinessHandler } from '../health/readiness.js';
import { validateAuthSecrets } from '../utils/authSecrets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
validateAuthSecrets();

// ================== APP SETUP ==================

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || process.env.BIND_HOST || '0.0.0.0';
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:5173';

const allowedOrigins = [
  FRONT_URL,
  'https://void0000.online',
  'http://localhost:5173',
  'http://localhost'
];

// ================== MIDDLEWARE ==================

app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    exposedHeaders: ['Retry-After'],
  })
);

securityMiddleware(allowedOrigins).forEach(mw => app.use(mw));

// Encrypted attachment uploads are AES-GCM ciphertext encoded as base64 JSON.
// A 10 MB source image expands past 10 MB once encrypted + base64 encoded.
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());

// ================== STATIC (CDN) ==================

app.use(
  '/avatars',
  express.static(path.join(__dirname, '..', 'routes/user/avatars'), {
    maxAge: '30d',
    immutable: true,
  })
);

// ================== ROUTES ==================

import authRouter from '../routes/auth/index.js';
import twoFARouter from '../routes/auth/2fa/index.js';
import meRouter, { authenticateUser } from '../middleware/jwt.js';
import { encryptedCSRFProtection } from '../middleware/encryptedCSRF.js';
import csrfRouter from '../routes/csrf/index.js';
import accountReadRouter from '../routes/user/accountRead.js';
import sessionsRouter from '../routes/user/sessions.js';
import preferencesRouter from '../routes/user/preferences.js';
import notificationsRouter from '../routes/notifications/index.js';
import linkPreviewRouter from '../routes/linkPreview/index.js';
import { noCache } from '../middleware/noCache.js';

import {
  authDeviceLimiter,
  forgotPasswordLimiter,
  resetDeviceLimiter,
  checkResetTokenLimiter,
  registerDeviceLimiter,
  authCheckLimiter,
  refreshTokenLimiter,
  captchaGenerateLimiter,
  captchaCheckLimiter,
  linkPreviewLimiter
} from '../middleware/rate_limit.js';

// ================== API ROUTES ==================

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'voidapp-account-control-service',
    pid: process.pid,
  });
});

app.get('/ready', createReadinessHandler({
  service: 'voidapp-account-control-service',
  checks: {
    postgres: () => pool.query('SELECT 1'),
    valkey: () => valkey.ping(),
  },
}));

// Clear any stale cookies on login attempts
app.use('/api/auth/login', (req, res, next) => {
  if (req.method === 'POST') {
    res.clearCookie('accessToken', { path: '/' });
    res.clearCookie('refreshToken', { path: '/' });
    res.clearCookie('_csrf', { path: '/' });
    res.clearCookie('accessToken', { path: '/', domain: '.void0000.online' });
    res.clearCookie('refreshToken', { path: '/', domain: '.void0000.online' });
    res.clearCookie('_csrf', { path: '/', domain: '.void0000.online' });
  }
  next();
});

// Rate limiting
app.use('/api/auth/login', authDeviceLimiter);
app.use('/api/auth/forgot-password', forgotPasswordLimiter);
app.use('/api/auth/reset-password', resetDeviceLimiter);
app.use('/api/auth/check-reset-token', checkResetTokenLimiter);
app.use('/api/auth/register', registerDeviceLimiter);
app.use('/api/auth/me', authCheckLimiter);
app.use('/api/auth/refresh', refreshTokenLimiter);

app.post('/api/security/csp-report', 
  express.json({ type: 'application/csp-report' }), 
  (req, res) => {
    if (process.env.NODE_ENV === 'development') {
      console.warn('🔍 CSP Violation Report:', req.body);
    }
    res.status(204).end();
  }
);

// CSRF token
app.use('/api/csrf', csrfRouter);
app.use('/api/captcha/generate', captchaGenerateLimiter);
app.use('/api/captcha/check', captchaCheckLimiter);
app.use('/api/captcha', captchaRouter);

// CSRF protection
app.use(encryptedCSRFProtection);

// Auth routes
app.use('/api/auth', authRouter);
app.use('/api/auth/2fa', twoFARouter);

// Me
app.use('/api/me', noCache, meRouter);

// User routes
app.use('/api/users/account', accountReadRouter);
app.use('/api/users/sessions', sessionsRouter);
app.use('/api/users', authenticateUser, preferencesRouter);
app.use('/api/notifications', noCache, authenticateUser, notificationsRouter);
app.use('/api/link-preview', noCache, authenticateUser, linkPreviewLimiter, linkPreviewRouter);

// ================== HTTP SERVER ==================

const httpServer = createServer(app);

// ================== START ==================

httpServer.listen(PORT, HOST, () => {
  console.log(`✅ Account/control service running on ${HOST}:${PORT} (PID ${process.pid})`);
});
