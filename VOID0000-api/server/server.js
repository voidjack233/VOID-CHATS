import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { createRequire } from 'module';
import { securityMiddleware } from './middleware/xss/index.js';
import captchaRouter from './routes/captcha/index.js';
import { startImageWorker } from './queues/imageQueue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ================== CLUSTER / GATEWAY CONFIG ==================

const require2 = createRequire(import.meta.url);
const config = require2('./config.json');
const isCluster = config.cluster.enabled;
const gatewayMode = config.gateway?.mode || 'phoenix';

if (gatewayMode !== 'phoenix') {
  throw new Error(`Unsupported gateway.mode "${gatewayMode}". The Node gateway has been retired; use "phoenix".`);
}

// ================== APP SETUP ==================

const app = express();
const PORT = process.env.PORT || 3001;
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:5173';

const allowedOrigins = [
  FRONT_URL,
  'https://void0000.online',
  'http://localhost:5173',
  'http://localhost'
];

// ================== MIDDLEWARE ==================

app.set('trust proxy', true);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

securityMiddleware(allowedOrigins).forEach(mw => app.use(mw));

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
import preferencesRouter from './routes/user/preferences.js';
import { noCache } from './middleware/noCache.js';
import conversationRouter from './routes/conversations/index.js';

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

// ================== GATEWAY / PUBSUB SETUP ==================

let getConnectionStats;
const { initPublisher } = await import('./valkey-pubsub.js');
initPublisher();
const { initPresenceFanout } = await import('./gateway/presence-fanout.js');
initPresenceFanout();
console.log(`📡 Phoenix gateway mode: API worker started (pub/sub publisher ready)`);
getConnectionStats = () => ({
  mode: gatewayMode,
  pid: process.pid,
  note: 'Stats available on external gateway',
});

// ================== API ROUTES ==================

app.get('/api/debug/ws-stats', (req, res) => {
  res.json(getConnectionStats());
});

app.get('/api/clear-stale', (req, res) => {
  const names = ['accessToken', 'refreshToken', '_csrf'];
  names.forEach(n => res.clearCookie(n, { path: '/' }));
  names.forEach(n => res.clearCookie(n, { path: '/', domain: '.void0000.online' }));
  res.json({ success: true, message: 'All cookies cleared. Please log in again.' });
});

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
app.use('/api/auth/register', registerDeviceLimiter);
app.use('/api/auth/me', authCheckLimiter);
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

// CSRF token
app.use('/api/csrf', csrfRouter);
app.use('/api/captcha', captchaGenerateLimiter, captchaRouter);

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
app.use('/api/users/search', userSearchRouter);
app.use('/api/users', authenticateUser, preferencesRouter, profileUpdateRouter, profileAvatarRouter);
app.use('/api/users', profileReadRouter);
app.use('/api/friends', friendRouter);
app.use('/api/conversations', noCache, conversationRouter);

// ================== CLEANUP ==================

import { cleanupAllExpired } from './utils/cleanUpExpired.js';

cleanupAllExpired().then(() => {
  console.log('✅ Initial cleanup done');
});

setInterval(cleanupAllExpired, 6 * 60 * 60 * 1000);

// ================== HTTP SERVER ==================

const httpServer = createServer(app);

// ================== IMAGE WORKER ==================

startImageWorker();

// ================== START ==================

httpServer.listen(PORT, () => {
  const apiModeLabel = isCluster ? 'cluster API worker' : 'single API worker';
  const gatewayLabel = `${gatewayMode} gateway`;

  console.log(`✅ Server running on port ${PORT} (${apiModeLabel}, ${gatewayLabel}, PID ${process.pid})`);
});
