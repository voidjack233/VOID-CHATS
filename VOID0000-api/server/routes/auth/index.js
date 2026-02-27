import { Router } from 'express';
import { verifyCaptcha, verifyCaptchaForRegistration } from '../../middleware/captcha/captchaVerify.js';
import register from './register.js';
import login from './login.js';
import logout from './logout.js';
import refresh from './refresh.js';
import forgotPassword from './forgot-password.js';
import changePassword from './change-password.js';
import resetPassword from './reset-password.js';
import verifyEmail from './verify-email.js';
import sendCode from './send-code.js';
import resendVerification from './resend-email-code.js';
import checkResetToken from './check-reset-token.js';
import validateToken from './validate-token.js';

const router = Router();

// Protected by captcha
router.use('/register', verifyCaptchaForRegistration, register);
router.use('/login', verifyCaptcha, login);
router.use('/send-code', verifyCaptcha, sendCode);
router.use('/forgot-password', verifyCaptcha, forgotPassword);
router.use('/resend-email-code', verifyCaptcha, resendVerification);

// No captcha needed
router.use('/logout', logout);
router.use('/refresh', refresh);
router.use('/change-password', changePassword);
router.use('/reset-password', resetPassword);
router.use('/verify-email', verifyEmail);
router.use('/check-reset-token', checkResetToken);
router.use('/validate-token', validateToken);

export default router;