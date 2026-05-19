import { Router } from 'express';
import { authenticateUser } from '../../../middleware/jwt.js';
import setupTOTP from './setup-totp.js';
import setupEmail from './setup-email.js';
import verifySetup from './verify-setup.js';
import verifyLogin from './verify-login.js';
import sendActionEmail from './send-action-email.js';
import disable from './disable.js';
import backupCodes from './backup-codes.js';
import status from './status.js';

const router = Router();

// Public (used during login flow)
router.use('/verify-login', verifyLogin);

// Protected (requires authentication)
router.use('/send-action-email', authenticateUser, sendActionEmail);
router.use('/setup-totp', authenticateUser, setupTOTP);
router.use('/setup-email', authenticateUser, setupEmail);
router.use('/verify-setup', authenticateUser, verifySetup);
router.use('/disable', authenticateUser, disable);
router.use('/backup-codes', authenticateUser, backupCodes);
router.use('/status', authenticateUser, status);

export default router;
