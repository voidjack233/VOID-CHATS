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
const { noCache } = await import('../middleware/noCache.js');
const { pool } = await import('../db.js');
const { default: valkey } = await import('../valkey.js');
const { default: callsRouter } = await import('../routes/calls/index.js');
const { createReadinessHandler } = await import('../health/readiness.js');
const { initPublisher } = await import('../valkey-pubsub.js');

const app = express();
const PORT = process.env.MEDIA_CALL_SERVICE_PORT || 3006;
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
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

initPublisher();

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'voidapp-media-call-service',
    pid: process.pid,
  });
});

app.get('/ready', createReadinessHandler({
  service: 'voidapp-media-call-service',
  checks: {
    postgres: () => pool.query('SELECT 1'),
    valkey: () => valkey.ping(),
  },
}));

app.use(encryptedCSRFProtection);
app.use('/api/calls', noCache, authenticateUser, callsRouter);

const httpServer = createServer(app);

httpServer.listen(PORT, HOST, () => {
  console.log(`✅ Media call service running on ${HOST}:${PORT} (PID ${process.pid})`);
});
