import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { setupGateway } from './gateway/index.js';
import { securityMiddleware } from './middleware/xss/index.js';
import captchaRouter from './routes/captcha/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env') });

// ================== APP SETUP ==================

const app = express();
const PORT = process.env.PORT || 3001;
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:5173';

const allowedOrigins = [
  FRONT_URL,
  'https://void0000.online',
  'https://www.void0000.online',
  'http://localhost:5173'
];

// ================== MIDDLEWARE ==================

app.set('trust proxy', true);

// CORS must be first — handles preflight OPTIONS requests
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// Security headers (spread the array)
securityMiddleware(allowedOrigins).forEach(mw => app.use(mw));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ================== STATIC (CDN) ==================

app.use(
  '/avatars',
  express.static(path.join(__dirname, 'routes/user/avatars'), {
    maxAge: '30d',
    immutable: true,
  })
);

// ================== ROUTES ==================

import authRouter from './routes/auth/index.js';
import twoFARouter from './routes/auth/2fa/index.js';
import meRouter, { authenticateUser } from './middleware/jwt.js';
import { encryptedCSRFProtection } from './middleware/encryptedCSRF.js';
import csrfRouter from './routes/csrf/index.js';
import accountReadRouter from './routes/user/accountRead.js';
import sessionsRouter from './routes/user/sessions.js';
import profileReadRouter from './routes/user/profileRead.js';
import profileUpdateRouter from './routes/user/profileUpdate.js';
import profileAvatarRouter from './routes/user/profileAvatar.js';
import friendRouter from './routes/friends/index.js';
import userSearchRouter from './routes/user/userSearch.js';
import { getConnectionStats } from './gateway/index.js';
import { noCache } from './middleware/noCache.js';

import {
  authDeviceLimiter,
  forgotPasswordLimiter,
  resetDeviceLimiter,
  registerDeviceLimiter,
  authCheckLimiter,
  profileUpdateLimiter,
  avatarUploadLimiter,
  captchaGenerateLimiter
} from './middleware/rate_limit.js';

app.get('/api/debug/ws-stats', (req, res) => {
  res.json(getConnectionStats());
});


// Temporary endpoint to clear cookies for testing logout and stale cookie scenarios
app.get('/api/clear-stale', (req, res) => {
  const names = ['accessToken', 'refreshToken', '_csrf'];
  
  // Clear without domain (stale api.void0000.online cookies)
  names.forEach(n => res.clearCookie(n, { path: '/' }));
  
  // Clear with domain (.void0000.online)
  names.forEach(n => res.clearCookie(n, { path: '/', domain: '.void0000.online' }));
  
  res.json({ success: true, message: 'All cookies cleared. Please log in again.' });
});

// Rate limiting
app.use('/api/auth/login', authDeviceLimiter);
app.use('/api/auth/forgot-password', forgotPasswordLimiter);
app.use('/api/auth/reset-password', resetDeviceLimiter);
app.use('/api/auth/register', registerDeviceLimiter);
app.use('/api/auth/me', authCheckLimiter);
// For profile
app.use('/api/users/profile', profileUpdateLimiter);
app.use('/api/users/avatar', avatarUploadLimiter);

app.post('/api/security/csp-report', 
  express.json({ type: 'application/csp-report' }), 
  (req, res) => {
    if (process.env.NODE_ENV === 'development') {
      console.log('🔍 CSP Violation Report:', req.body);
    }
    res.status(204).end();
  }
);

// ROUTE ORDER MATTERS

// CSRF token
app.use('/api/csrf', csrfRouter);

app.use('/api/captcha', captchaGenerateLimiter, captchaRouter);

// CSRF protection
app.use(encryptedCSRFProtection);

// Auth routes
app.use('/api/auth', authRouter);

// 2FA routes (must be after auth routes to ensure user is authenticated) — includes backup codes, TOTP, email verification, etc.
app.use('/api/auth/2fa', twoFARouter);

// Me
app.use('/api/me', noCache, meRouter);

// User routes
app.use('/api/users/account', accountReadRouter);
app.use('/api/users/sessions', sessionsRouter);
app.use('/api/users/search', userSearchRouter);
app.use('/api/users', authenticateUser, profileUpdateRouter, profileAvatarRouter);
app.use('/api/users', profileReadRouter);
app.use('/api/friends', friendRouter);

// ================== CLEANUP ==================

import { cleanupAllExpired } from './utils/cleanUpExpired.js';

cleanupAllExpired().then(() => {
  console.log('✅ Initial cleanup done');
});

setInterval(cleanupAllExpired, 6 * 60 * 60 * 1000);

// ================== HTTP SERVER ==================
const httpServer = createServer(app);

// ================== GATEWAY ==================
setupGateway(httpServer);

// ================== START ==================
httpServer.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔌 Gateway ready`);
});