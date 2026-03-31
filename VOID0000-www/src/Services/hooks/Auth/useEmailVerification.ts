import { useState, useRef, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authService } from '../../Auth/authServiceApi';

export function useEmailVerification() {
  const [code, setCode] = useState<string[]>(Array(6).fill(''));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isVerified, setIsVerified] = useState(false);
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState<number | null>(null);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const inputs = useRef<(HTMLInputElement | null)[]>(Array(6).fill(null));
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const vtoken = searchParams.get('vtoken');

  // Validate token on page load
  useEffect(() => {
    if (isVerified) return;

    const validateToken = async () => {
      if (!vtoken) {
        setTokenValid(false);
        setError('Invalid access. Please register first.');
        return;
      }

      try {
        const response = await authService.validateToken(vtoken);
        if (response.success) {
          setTokenValid(true);
          if (response.email) setUserEmail(response.email);
          if (response.codeSent) setCodeSent(true);
        } else {
          setTokenValid(false);
          setError(response.message || 'Invalid or expired token');
        }
      } catch (err) {
        setTokenValid(false);
        setError('Failed to validate access');
      }
    };

    validateToken();
  }, [vtoken, isVerified]);

  // Cooldown timer
  useEffect(() => {
    if (cooldown === null) return;

    const timer = setInterval(() => {
      setCooldown(prev => {
        if (prev === null) return null;
        if (prev > 1) return prev - 1;
        return null;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [cooldown]);

  // Step 1: User clicks send → show captcha
  const handleSendCode = () => {
    if (!vtoken || sendingCode || cooldown !== null) return;
    setError('');
    setShowCaptcha(true);
  };

  // Step 2: Captcha solved → actually send the code
  const handleCaptchaVerified = async (captchaId: string, captchaAnswer: string) => {
    if (!vtoken) return;

    setShowCaptcha(false);
    setSendingCode(true);
    setError('');

    try {
      const result = await authService.sendVerificationCode(vtoken, {
        captchaId,
        captchaAnswer,
      });

      if (result.success) {
        setCodeSent(true);
        setCooldown(60);
        setTimeout(() => inputs.current[0]?.focus(), 100);
      } else {
        if (result.cooldown) {
          setCooldown(result.cooldown);
        }
        setError(result.message || 'Failed to send code');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send verification code');
    } finally {
      setSendingCode(false);
    }
  };

  // Resend code → show captcha again
  const handleResendCode = () => {
    if (cooldown !== null || sendingCode) return;
    setCode(Array(6).fill(''));
    setError('');
    setShowCaptcha(true);
  };

  const handleChange = (value: string, index: number) => {
    const digits = value.replace(/\D/g, '');
    if (!digits) {
      const newCode = [...code];
      newCode[index] = '';
      setCode(newCode);
      setError('');
      return;
    }

    if (digits.length > 1) {
      handlePaste(digits, index);
      return;
    }

    const newCode = [...code];
    newCode[index] = digits;
    setCode(newCode);
    setError('');

    if (digits && index < 5) {
      inputs.current[index + 1]?.focus();
    }
  };

  const handlePaste = (value: string, startIndex = 0) => {
    const digits = value.replace(/\D/g, '').slice(0, 6 - startIndex);
    if (!digits) return;

    const newCode = [...code];
    digits.split('').forEach((digit, offset) => {
      newCode[startIndex + offset] = digit;
    });
    setCode(newCode);
    setError('');

    const nextIndex = Math.min(startIndex + digits.length, 5);
    inputs.current[nextIndex]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
  };

  const handleSubmit = async () => {
    if (!vtoken) {
      setError('Invalid access');
      return;
    }

    const verificationCode = code.join('');
    if (verificationCode.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }

    setLoading(true);
    try {
      const response = await authService.verifyEmail(verificationCode, vtoken);
      if (!response.success) throw new Error(response.message);
      setIsVerified(true);
      setTimeout(() => navigate('/auth?view=login'), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const goToRegister = () => navigate('/auth?view=register');
  const goToLogin = () => navigate('/auth?view=login');

  return {
    code,
    error,
    loading,
    isVerified,
    tokenValid,
    codeSent,
    sendingCode,
    userEmail,
    cooldown,
    showCaptcha,
    setShowCaptcha,
    inputs,
    handleChange,
    handlePaste,
    handleKeyDown,
    handleSubmit,
    handleSendCode,
    handleResendCode,
    handleCaptchaVerified,
    goToRegister,
    goToLogin,
  };
}
