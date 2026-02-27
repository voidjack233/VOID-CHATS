import { useState, useEffect } from 'react';
import { authService } from '../../Auth/authServiceApi';

export function useForgotPassword() {
  const [email, setEmail] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [cooldown, setCooldown] = useState<number | null>(null);
  const [success, setSuccess] = useState(false);
  const [showCaptcha, setShowCaptcha] = useState(false);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
    setErrorMessage('');
  };

  // Step 1: Validate email, then show captcha
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email.trim()) {
      setErrorMessage('Please enter your email address');
      return;
    }

    setErrorMessage('');
    setShowCaptcha(true);
  };

  // Step 2: Captcha solved, now actually send reset link
  const handleCaptchaVerified = async (captchaId: string, captchaAnswer: string) => {
    setShowCaptcha(false);
    setIsLoading(true);
    setErrorMessage('');

    try {
      const result = await authService.forgotPassword(email, {
        captchaId,
        captchaAnswer,
      });

      if (!result.success) {
        throw new Error(result.message || 'Password reset failed');
      }

      setSuccess(true);

    } catch (err: any) {
      let errorMsg = 'Password reset failed';

      if (err?.code === 'FORGOT_RATE_LIMIT_EXCEEDED' && err?.resetTime) {
        const now = Date.now();
        const remainingSeconds = Math.floor((err.resetTime - now) / 1000);

        if (remainingSeconds > 0) {
          setCooldown(remainingSeconds);
          localStorage.setItem('forgotPasswordCooldown', err.resetTime.toString());
        }
        errorMsg = err.message || 'Too many attempts. Please wait.';
      } else if (err?.code === 'CAPTCHA_WRONG' || err?.code === 'CAPTCHA_EXPIRED' || err?.code === 'CAPTCHA_INVALID' || err?.code === 'CAPTCHA_MAX_ATTEMPTS') {
        errorMsg = err.message || 'Captcha verification failed.';
      } else if (err instanceof Error) {
        errorMsg = err.message;
      } else if (err?.message) {
        errorMsg = err.message;
      }

      setErrorMessage(errorMsg);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const stored = localStorage.getItem('forgotPasswordCooldown');
    if (stored) {
      const remaining = Math.floor((+stored - Date.now()) / 1000);
      if (remaining > 0) setCooldown(remaining);
      else localStorage.removeItem('forgotPasswordCooldown');
    }
  }, []);

  useEffect(() => {
    if (cooldown === null) return;

    const timer = setInterval(() => {
      setCooldown(prev => {
        if (prev === null) return null;
        if (prev > 1) return prev - 1;
        localStorage.removeItem('forgotPasswordCooldown');
        return null;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [cooldown]);

  return {
    email,
    errorMessage,
    isLoading,
    cooldown,
    success,
    showCaptcha,
    setShowCaptcha,
    handleInputChange,
    handleSubmit,
    handleCaptchaVerified,
  };
}