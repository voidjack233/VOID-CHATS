import { Router } from 'express';
import createRouter from './create.js';
import detailsRouter from './details.js';
import iconRouter from './icon.js';
import listRouter from './list.js';
import removeRouter from './remove.js';
import updateRouter from './update.js';

const router = Router();

router.use(listRouter);
router.use(createRouter);
router.use(detailsRouter);
router.use(updateRouter);
router.use(iconRouter);
router.use(removeRouter);

export default router;
