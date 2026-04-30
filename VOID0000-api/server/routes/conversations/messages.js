import { Router } from 'express';
import {
  dmSpamGuard,
  messagesFetchLimiter,
  messagesSendLimiter,
} from '../../middleware/rate_limit.js';
import createRouter from './messages/create.js';
import historyRouter from './messages/history.js';
import typingRouter from './messages/typing.js';
import readRouter from './messages/read.js';
import byIdRouter from './messages/byId.js';

const router = Router({ mergeParams: true });

router.use(messagesSendLimiter, dmSpamGuard, createRouter);
router.use(messagesFetchLimiter, historyRouter);
router.use(typingRouter);
router.use(readRouter);
router.use(byIdRouter);

export default router;
