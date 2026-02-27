import { Router } from 'express';
import generateRouter from './generate.js';
import checkRouter from './check.js';

const router = Router();

router.use('/generate', generateRouter);
router.use('/check', checkRouter);

export default router;