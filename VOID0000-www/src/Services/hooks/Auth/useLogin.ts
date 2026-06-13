import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authService } from '../../Auth/authServiceApi';
import { useUser } from '../../Auth/UserContext';

interface LoginForm {
  identifier: string;
  password: string;
}

const PENDING_INVITE_PATH_KEY = 'void_pending_invite_path';
const LOGIN_COOLDOWN_STORAGE_KEY = 'void_login_cooldown_until';
const LEGACY_LOGIN_COOLDOWN_STORAGE_KEY = 'loginCooldown';
const LOGIN_RATE_LIMIT_MESSAGE = 'Too many attempts. Try again later.';

const getCooldownUntil = (error: unknown): number | null => {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const payload = error as {
    code?: string;
    cooldownUntil?: number;
    retryAfterMs?: number;
    resetTime?: number;
  };
  if (
    payload.code !== 'LOGIN_RATE_LIMITED' &&
    payload.code !== 'LOGIN_RATE_LIMIT_EXCEEDED'
  ) {
    return null;
  }

  const cooldownUntil = Number(payload.cooldownUntil ?? payload.resetTime);
  if (Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) {
    return cooldownUntil;
  }

  const retryAfterMs = Number(payload.retryAfterMs);
  return Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Date.now() + retryAfterMs
    : null;
};

function getPostLoginDestination() {
  const pendingInvitePath = sessionStorage.getItem(PENDING_INVITE_PATH_KEY);
  if (pendingInvitePath) {
    sessionStorage.removeItem(PENDING_INVITE_PATH_KEY);
    return pendingInvitePath;
  }

  return '/chats';
}

export function useLogin() {
  const navigate = useNavigate();
  const { refreshUser, setLoginPassword } = useUser();
  const [formData, setFormData] = useState<LoginForm>({ identifier: '', password: '' });
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [cooldown, setCooldown] = useState<number | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [captchaRequired, setCaptchaRequired] = useState<boolean | null>(null);
  
  // New state to hold 2FA requirements
  const [twoFactorData, setTwoFactorData] = useState<any>(null);

  // Check if captcha is required on mount
  useEffect(() => {
    const checkCaptcha = async () => {
      const result = await authService.checkCaptchaRequired();
      setCaptchaRequired(result.captchaRequired);
    };
    checkCaptcha();
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    const sanitized = value.replace(/ /g, '');
    setFormData(prev => ({ ...prev, [name]: sanitized }));
    if (cooldown === null) {
      setErrorMessage('');
    }
    setUnverifiedEmail(null);
  };

  // Step 1: Validate form
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (cooldownUntil && cooldownUntil > Date.now()) {
      setErrorMessage(LOGIN_RATE_LIMIT_MESSAGE);
      return;
    }

    if (!formData.identifier.trim() || !formData.password.trim()) {
      setErrorMessage('Please enter both email/username and password');
      return;
    }

    setErrorMessage('');

    // If trusted device, skip captcha and login directly
    if (captchaRequired === false) {
      await doLogin();
    } else {
      setShowCaptcha(true);
    }
  };

  // Step 2: Captcha solved (or skipped)
  const handleCaptchaVerified = async (captchaId: string, captchaAnswer: string) => {
    setShowCaptcha(false);
    await doLogin(captchaId, captchaAnswer);
  };

  // Actual login logic
  const doLogin = async (captchaId?: string, captchaAnswer?: string) => {
    if (cooldownUntil && cooldownUntil > Date.now()) {
      setErrorMessage(LOGIN_RATE_LIMIT_MESSAGE);
      return;
    }

    setIsLoading(true);
    setErrorMessage('');
    setUnverifiedEmail(null);
    setTwoFactorData(null); // Reset 2FA state on new attempt

    try {
      const payload: any = { ...formData };
      if (captchaId && captchaAnswer) {
        payload.captchaId = captchaId;
        payload.captchaAnswer = captchaAnswer;
      }

      const result = await authService.login(payload);

      // Handle 2FA Requirement
      if (result.code === 'REQUIRES_2FA' || result.twoFactorToken) {
          setTwoFactorData(result);
          setIsLoading(false);
          return; // Stop here, wait for 2FA input
      }

      if (!result.success) {
        throw new Error(result.message || 'Login failed');
      }

      // Pass password for E2E key recovery before refreshing user
      setLoginPassword(formData.password);

      await refreshUser();
      setFormData(prev => ({ ...prev, password: '' }));
      navigate(getPostLoginDestination());

    } catch (err: any) {
      console.error('Login error:', err);
      let errorMsg = 'Login failed';

      // If backend says captcha required but we skipped it, show captcha
      if (err?.code === 'CAPTCHA_REQUIRED') {
        setCaptchaRequired(true);
        setShowCaptcha(true);
        setIsLoading(false);
        return;
      }

      if (err?.code === 'EMAIL_NOT_VERIFIED') {
        setUnverifiedEmail(err?.email || formData.identifier);
        errorMsg = err.message || 'Please verify your email before logging in.';
        setErrorMessage(errorMsg);
        setIsLoading(false);
        return;
      }

      const nextCooldownUntil = getCooldownUntil(err);
      if (nextCooldownUntil) {
        setCooldownUntil(nextCooldownUntil);
        setCooldown(Math.max(1, Math.ceil((nextCooldownUntil - Date.now()) / 1000)));
        localStorage.setItem(LOGIN_COOLDOWN_STORAGE_KEY, String(nextCooldownUntil));
        localStorage.removeItem(LEGACY_LOGIN_COOLDOWN_STORAGE_KEY);
        errorMsg = LOGIN_RATE_LIMIT_MESSAGE;
      } else if (err?.code === 'CAPTCHA_WRONG' || err?.code === 'CAPTCHA_EXPIRED' || err?.code === 'CAPTCHA_INVALID' || err?.code === 'CAPTCHA_MAX_ATTEMPTS') {
        errorMsg = err.message || 'Captcha verification failed.';
      } else if (err instanceof Error) {
        errorMsg = err.message;
      } else if (err?.message) {
        errorMsg = err.message;
      }

      if (err?.name === 'TypeError' || err?.name === 'NetworkError') {
        errorMsg = 'Network error. Please check your connection.';
      }

      setErrorMessage(errorMsg);
    } finally {
      setIsLoading(false);
    }
  };

  // Step 3: Handle 2FA Verification Submission
  const handle2FAVerified = async (code: string, method: string) => {
    if (!twoFactorData?.twoFactorToken) return;

    setIsLoading(true);
    setErrorMessage('');

    try {
      const result = await authService.verify2FALogin(
        twoFactorData.twoFactorToken, 
        code, 
        method
      );

      if (!result.success) {
        throw new Error(result.message || '2FA verification failed');
      }

      // Pass password for E2E key recovery
      setLoginPassword(formData.password);

      // Success! Clear 2FA state and finish login
      setTwoFactorData(null);
      await refreshUser();
      setFormData(prev => ({ ...prev, password: '' }));
      navigate(getPostLoginDestination());

    } catch (err: any) {
      console.error('2FA verification error:', err);
      setErrorMessage(err.message || 'Invalid 2FA code. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const stored =
      localStorage.getItem(LOGIN_COOLDOWN_STORAGE_KEY) ||
      localStorage.getItem(LEGACY_LOGIN_COOLDOWN_STORAGE_KEY);
    if (stored) {
      const storedUntil = Number(stored);
      const remaining = Math.ceil((storedUntil - Date.now()) / 1000);
      if (remaining > 0) {
        setCooldownUntil(storedUntil);
        setCooldown(remaining);
        setErrorMessage(LOGIN_RATE_LIMIT_MESSAGE);
        localStorage.setItem(LOGIN_COOLDOWN_STORAGE_KEY, String(storedUntil));
      } else {
        localStorage.removeItem(LOGIN_COOLDOWN_STORAGE_KEY);
      }
      localStorage.removeItem(LEGACY_LOGIN_COOLDOWN_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (cooldownUntil === null) {
      setCooldown(null);
      return;
    }

    const updateCooldown = () => {
      const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
      if (remaining <= 0) {
        localStorage.removeItem(LOGIN_COOLDOWN_STORAGE_KEY);
        setCooldownUntil(null);
        return null;
      }
      setCooldown(remaining);
      return remaining;
    };

    updateCooldown();
    const timer = window.setInterval(updateCooldown, 250);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  return {
    formData,
    errorMessage,
    isLoading,
    cooldown,
    unverifiedEmail,
    showCaptcha,
    setShowCaptcha,
    twoFactorData,
    setTwoFactorData,
    handleInputChange,
    handleSubmit,
    handleCaptchaVerified,
    handle2FAVerified,
  };
}
