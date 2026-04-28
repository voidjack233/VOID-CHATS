import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { securityMiddleware } from '../middleware/xss/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { encryptedCSRFProtection } = await import('../middleware/encryptedCSRF.js');
const { authenticateUser } = await import('../middleware/jwt.js');
const { profileUpdateLimiter, avatarUploadLimiter } = await import('../middleware/rate_limit.js');
const { default: profileReadRouter } = await import('../routes/user/profileRead.js');
const { default: profileFieldsRouter } = await import('../routes/user/profileFields.js');
const { default: profileAvatarRouter } = await import('../routes/user/profileAvatar.js');
const { default: friendRouter } = await import('../routes/friends/index.js');
const { default: userSearchRouter } = await import('../routes/user/userSearch.js');
const { initPublisher } = await import('../valkey-pubsub.js');

const app = express();
const PORT = process.env.SOCIAL_SERVICE_PORT || process.env.PORT || 3004;
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:5173';

const allowedOrigins = [
  FRONT_URL,
  'https://void0000.online',
  'http://localhost:5173',
  'http://localhost',
];

app.set('trust proxy', true);
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
securityMiddleware(allowedOrigins).forEach((mw) => app.use(mw));
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());

initPublisher();

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'voidapp-social-profile-service',
    pid: process.pid,
  });
});

app.use(encryptedCSRFProtection);

app.use('/api/users/profile', profileUpdateLimiter);
app.use('/api/users/profile/avatar', avatarUploadLimiter);
app.use('/api/users/search', userSearchRouter);
app.use('/api/users', authenticateUser, profileFieldsRouter, profileAvatarRouter);
app.use('/api/users', profileReadRouter);
app.use('/api/friends', friendRouter);

const httpServer = createServer(app);

httpServer.listen(PORT, () => {
  console.log(`✅ Social/profile service running on port ${PORT} (PID ${process.pid})`);
});
