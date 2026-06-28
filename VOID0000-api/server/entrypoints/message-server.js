import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { securityMiddleware } from '../middleware/xss/index.js';
import { validateAuthSecrets } from '../utils/authSecrets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
validateAuthSecrets();

const { encryptedCSRFProtection } = await import('../middleware/encryptedCSRF.js');
const { authenticateUser } = await import('../middleware/jwt.js');
const { messageReactionToggleLimiter } = await import('../middleware/rate_limit.js');
const { noCache } = await import('../middleware/noCache.js');
const { pool } = await import('../db.js');
const { default: valkey } = await import('../valkey.js');
const { default: scyllaClient } = await import('../scylla.js');
const { minioClient, ATTACH_BUCKET } = await import('../minio.js');
const { default: attachmentsRouter } = await import('../routes/conversations/attachments.js');
const { default: batchReactionsRouter } = await import('../routes/conversations/batchReactions.js');
const { default: messagesRouter } = await import('../routes/conversations/messages.js');
const { default: reactionsRouter } = await import('../routes/conversations/reactions.js');
const { createReadinessHandler } = await import('../health/readiness.js');
const { initPublisher } = await import('../valkey-pubsub.js');

const app = express();
const PORT = process.env.MESSAGE_SERVICE_PORT || process.env.PORT || 3002;
const HOST = process.env.HOST || process.env.BIND_HOST || '0.0.0.0';
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:5173';

const allowedOrigins = [
  FRONT_URL,
  'https://void0000.online',
  'http://localhost:5173',
  'http://localhost',
];

app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
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
    service: 'voidapp-message-service',
    pid: process.pid,
  });
});

app.get('/ready', createReadinessHandler({
  service: 'voidapp-message-service',
  checks: {
    postgres: () => pool.query('SELECT 1'),
    valkey: () => valkey.ping(),
    scylla: () => scyllaClient.execute('SELECT key FROM system.local'),
    minio: () => minioClient.bucketExists(ATTACH_BUCKET),
  },
}));

app.use(encryptedCSRFProtection);
app.use(
  '/api/conversations/:conversationId/messages/:messageId/reactions',
  noCache,
  authenticateUser,
  messageReactionToggleLimiter,
  reactionsRouter
);
app.use(
  '/api/conversations/:conversationId/messages',
  noCache,
  authenticateUser,
  messagesRouter
);
app.use(
  '/api/conversations/:conversationId/reactions',
  noCache,
  authenticateUser,
  batchReactionsRouter
);
app.use(
  '/api/conversations/:conversationId/attachments',
  noCache,
  authenticateUser,
  attachmentsRouter
);

const httpServer = createServer(app);

httpServer.listen(PORT, HOST, () => {
  console.log(`✅ Message service running on ${HOST}:${PORT} (PID ${process.pid})`);
});
