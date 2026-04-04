import express from 'express';
import { authenticateUser } from '../../middleware/jwt.js';
import { friendsListLimiter, friendActionLimiter } from '../../middleware/rate_limit.js';
import actionsRouter from './actions.js';
import removeRouter from './remove.js';
import listRouter from './list.js';
import pendingRouter from './pending.js';

const router = express.Router();

// All friend routes require authentication
router.use(authenticateUser);

// Mount sub-routers with rate limiting
router.use('/', friendActionLimiter, actionsRouter);         // POST /request/:profileId, /accept/:id, /reject/:id, /cancel/:id
router.use('/', friendActionLimiter, removeRouter);          // DELETE /:friendshipId
router.use('/', friendsListLimiter, listRouter);             // GET /, GET /presence
router.use('/requests', friendsListLimiter, pendingRouter);  // GET /requests/incoming, /requests/outgoing

export default router;
