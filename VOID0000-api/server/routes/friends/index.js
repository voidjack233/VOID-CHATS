import express from 'express';
import { authenticateUser } from '../../middleware/jwt.js';
import actionsRouter from './actions.js';
import removeRouter from './remove.js';
import listRouter from './list.js';
import pendingRouter from './pending.js';

const router = express.Router();

// All friend routes require authentication
router.use(authenticateUser);

// Mount sub-routers
router.use('/', actionsRouter);         // POST /request/:profileId, /accept/:id, /reject/:id, /cancel/:id
router.use('/', removeRouter);          // DELETE /:friendshipId
router.use('/', listRouter);            // GET /
router.use('/requests', pendingRouter); // GET /requests/incoming, /requests/outgoing

export default router;