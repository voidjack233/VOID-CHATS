import { Router } from 'express';
import { authenticateUser } from '../../middleware/jwt.js';
import {
  messageReactionToggleLimiter,
  messagesFetchLimiter,
} from '../../middleware/rate_limit.js';
import attachmentsRouter from './attachments.js';
import batchReactionsRouter from './batchReactions.js';
import dmRouter from './dm.js';
import dmSettingsRouter from './dm-settings.js';
import inviteLinksRouter from './inviteLinks.js';
import invitesRouter from './invites.js';
import keysRouter from './keys.js';
import membersRouter from './members.js';
import messagesRouter from './messages.js';
import mlsRouter from './mls.js';
import permissionsRouter from './permissions.js';
import reactionsRouter from './reactions.js';
import rootRouter from './root/index.js';

const router = Router();

router.use('/dm', authenticateUser, dmRouter);
router.use('/:conversationId/dm-settings', authenticateUser, dmSettingsRouter);
router.use('/mls', authenticateUser, mlsRouter);
router.use('/invite-links', inviteLinksRouter);
router.use('/:conversationId/invites', authenticateUser, invitesRouter);
router.use('/:conversationId/members', authenticateUser, membersRouter);
router.use('/:conversationId/messages', authenticateUser, messagesFetchLimiter, messagesRouter);
router.use(
  '/:conversationId/messages/:messageId/reactions',
  authenticateUser,
  messageReactionToggleLimiter,
  reactionsRouter,
);
router.use('/:conversationId/reactions', authenticateUser, batchReactionsRouter);
router.use('/:conversationId/attachments', authenticateUser, attachmentsRouter);
router.use('/:conversationId/permissions', authenticateUser, permissionsRouter);
router.use('/keys', authenticateUser, keysRouter);
router.use('/', authenticateUser, rootRouter);

export default router;
