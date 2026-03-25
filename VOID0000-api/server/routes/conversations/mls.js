import { Router } from 'express';
import capabilitiesRouter from './mls/capabilities.js';
import keyPackagesRouter from './mls/keyPackages.js';
import groupStatesRouter from './mls/groupStates.js';
import welcomesRouter from './mls/welcomes.js';
import commitsRouter from './mls/commits.js';
import groupKeyArchiveRouter from './mls/groupKeyArchive.js';
import syncRouter from './mls/sync.js';

const router = Router();

router.use(capabilitiesRouter);
router.use(keyPackagesRouter);
router.use(groupStatesRouter);
router.use(welcomesRouter);
router.use(commitsRouter);
router.use(groupKeyArchiveRouter);
router.use(syncRouter);

export default router;
