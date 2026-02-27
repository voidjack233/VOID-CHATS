import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authService } from '../../Auth/authServiceApi';
import { useUser } from '../../Auth/UserContext';

interface LoginForm {
  identifier: string;
  password: string;
}

export function useLogin() {
  const navigate = useNavigate();
  const { refreshUser } = useUser();
  const [formData, setFormData] = useState<LoginForm>({ identifier: '', password: '' });
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
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
    setFormData(prev => ({ ...prev, [name]: value }));
    setErrorMessage('');
    setUnverifiedEmail(null);
  };

  // Step 1: Validate form
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

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

      await refreshUser();
      navigate('/home');

    } catch (err: any) {
      console.log('Login error:', err);
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

      if (err?.code === 'LOGIN_RATE_LIMIT_EXCEEDED' && err?.resetTime) {
        const now = Date.now();
        const remainingSeconds = Math.floor((err.resetTime - now) / 1000);
        if (remainingSeconds > 0) {
          setCooldown(remainingSeconds);
          localStorage.setItem('loginCooldown', err.resetTime.toString());
        }
        errorMsg = err.message || 'Too many login attempts. Please wait.';
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

      // Success! Clear 2FA state and finish login
      setTwoFactorData(null);
      await refreshUser();
      navigate('/home');

    } catch (err: any) {
      console.error('2FA verification error:', err);
      setErrorMessage(err.message || 'Invalid 2FA code. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const stored = localStorage.getItem('loginCooldown');
    if (stored) {
      const remaining = Math.floor((+stored - Date.now()) / 1000);
      if (remaining > 0) setCooldown(remaining);
      else localStorage.removeItem('loginCooldown');
    }
  }, []);

  useEffect(() => {
    if (cooldown === null) return;

    const timer = setInterval(() => {
      setCooldown(prev => {
        if (prev === null) return null;
        if (prev > 1) return prev - 1;
        localStorage.removeItem('loginCooldown');
        return null;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [cooldown]);

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