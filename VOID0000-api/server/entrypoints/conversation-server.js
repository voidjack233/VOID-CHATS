import express, { Router } from 'express';
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
const { noCache } = await import('../middleware/noCache.js');
const { pool } = await import('../db.js');
const { default: valkey } = await import('../valkey.js');
const { default: bootstrapRouter } = await import('../routes/bootstrap.js');
const { default: dmRouter } = await import('../routes/conversations/dm.js');
const { default: dmSettingsRouter } = await import('../routes/conversations/dm-settings.js');
const { default: inviteLinksRouter } = await import('../routes/conversations/inviteLinks.js');
const { default: invitesRouter } = await import('../routes/conversations/invites.js');
const { default: keysRouter } = await import('../routes/conversations/keys.js');
const { default: membersRouter } = await import('../routes/conversations/members.js');
const { default: mlsRouter } = await import('../routes/conversations/mls.js');
const { default: pendingSelfLeavesRouter } = await import('../routes/conversations/pendingSelfLeaves.js');
const { default: permissionsRouter } = await import('../routes/conversations/permissions.js');
const { default: rootRouter } = await import('../routes/conversations/root/index.js');
const { createReadinessHandler } = await import('../health/readiness.js');
const { initPublisher } = await import('../valkey-pubsub.js');

const app = express();
const PORT = process.env.CONVERSATION_SERVICE_PORT || process.env.PORT || 3005;
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
    service: 'voidapp-conversation-service',
    pid: process.pid,
  });
});

app.get('/ready', createReadinessHandler({
  service: 'voidapp-conversation-service',
  checks: {
    postgres: () => pool.query('SELECT 1'),
    valkey: () => valkey.ping(),
  },
}));

const conversationRouter = Router();

conversationRouter.use('/membership-rotations', authenticateUser, pendingSelfLeavesRouter);
conversationRouter.use('/dm', authenticateUser, dmRouter);
conversationRouter.use('/:conversationId/dm-settings', authenticateUser, dmSettingsRouter);
conversationRouter.use('/mls', authenticateUser, mlsRouter);
conversationRouter.use('/invite-links', inviteLinksRouter);
conversationRouter.use('/:conversationId/invites', authenticateUser, invitesRouter);
conversationRouter.use('/:conversationId/members', authenticateUser, membersRouter);
conversationRouter.use('/:conversationId/permissions', authenticateUser, permissionsRouter);
conversationRouter.use('/keys', authenticateUser, keysRouter);
conversationRouter.use('/', authenticateUser, rootRouter);

app.use(encryptedCSRFProtection);
app.use('/api/bootstrap', noCache, authenticateUser, bootstrapRouter);
app.use('/api/conversations', noCache, conversationRouter);

const httpServer = createServer(app);

httpServer.listen(PORT, HOST, () => {
  console.log(`✅ Conversation service running on ${HOST}:${PORT} (PID ${process.pid})`);
});
