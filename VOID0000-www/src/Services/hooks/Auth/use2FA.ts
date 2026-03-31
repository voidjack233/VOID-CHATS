import { useState, useRef, useCallback } from 'react';
import { authService } from '../../Auth/authServiceApi';

type ModalView = 'status' | 'password-prompt' | 'setup-totp' | 'setup-email' | 'disable' | 'backup-codes';

// Cache 2FA status to avoid redundant API calls on rapid open/close
let statusCache: { data: any; timestamp: number } | null = null;
const CACHE_TTL = 30_000; // 30 seconds

export function use2FA() {
  const [view, setView] = useState<ModalView>('status');
  const [isLoading, setIsLoading] = useState(true);
  const [status, setStatus] = useState<any>(null);

  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [password, setPassword] = useState('');
  const [setupMethod, setSetupMethod] = useState<'totp' | 'email' | null>(null);
  const [disableMethod, setDisableMethod] = useState<'totp' | 'email' | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const [code, setCode] = useState(['', '', '', '', '', '']);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  const hasTotp = status?.totp?.enabled || false;
  const hasEmail = status?.email?.enabled || false;
  const hasAny2FA = hasTotp || hasEmail;

  // Fetch status with caching
  const fetchStatus = useCallback(async (forceRefresh = false) => {
    // Use cache if valid and not forced
    if (!forceRefresh && statusCache && Date.now() - statusCache.timestamp < CACHE_TTL) {
      setStatus(statusCache.data);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError('');
    try {
      const res = await authService.get2FAStatus();
      if (res.success) {
        setStatus(res.twoFactor);
        statusCache = { data: res.twoFactor, timestamp: Date.now() };
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch 2FA status.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Invalidate cache (call after enable/disable)
  const invalidateCache = () => {
    statusCache = null;
  };

  // OTP input handlers
  const handleCodeChange = (value: string, index: number) => {
    const digits = value.replace(/\D/g, '');
    if (!digits) {
      const newCode = [...code];
      newCode[index] = '';
      setCode(newCode);
      return;
    }

    if (digits.length > 1) {
      handleCodePaste(digits, index);
      return;
    }

    const newCode = [...code];
    newCode[index] = digits;
    setCode(newCode);
    if (digits && index < 5) inputs.current[index + 1]?.focus();
  };

  const handleCodePaste = (value: string, startIndex = 0) => {
    const digits = value.replace(/\D/g, '').slice(0, 6 - startIndex);
    if (!digits) return;

    const newCode = [...code];
    digits.split('').forEach((digit, offset) => {
      newCode[startIndex + offset] = digit;
    });
    setCode(newCode);
    inputs.current[Math.min(startIndex + digits.length, 5)]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
  };

  // Setup flow
  const promptSetup = (method: 'totp' | 'email') => {
    setSetupMethod(method);
    setPassword('');
    setError('');
    setView('password-prompt');
  };

  const handlePasswordSubmit = async () => {
    if (!password || !setupMethod) return;

    setIsLoading(true);
    setError('');

    try {
      if (setupMethod === 'totp') {
        const res = await authService.setupTOTP(password);
        if (!res.success) throw new Error(res.message || 'Failed to set up authenticator.');
        setQrCode(res.qrCode);
        setSecret(res.secret);
        setView('setup-totp');
      } else {
        const res = await authService.setupEmail2FA(password);
        if (!res.success) throw new Error(res.message || 'Failed to set up email 2FA.');
        setView('setup-email');
      }
      setPassword('');
    } catch (err: any) {
      setError(err.message || 'Setup failed.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifySetup = async () => {
    const verificationCode = code.join('');
    if (verificationCode.length < 6 || !setupMethod) return;

    setIsLoading(true);
    setError('');
    try {
      const res = await authService.verifySetup2FA(setupMethod, verificationCode);
      if (!res.success) throw new Error(res.message || 'Verification failed.');

      setSuccess('Two-factor authentication successfully enabled!');
      invalidateCache();

      if (res.backupCodes) {
        setBackupCodes(res.backupCodes);
        setView('backup-codes');
      } else {
        await fetchStatus(true);
        setView('status');
      }
      setCode(['', '', '', '', '', '']);
    } catch (err: any) {
      setError(err.message || 'Invalid verification code.');
    } finally {
      setIsLoading(false);
    }
  };

  // Disable flow
  const promptDisable = (method: 'totp' | 'email') => {
    setDisableMethod(method);
    setPassword('');
    setError('');
    setView('disable');
  };

  const handleDisable = async () => {
    if (!password || !disableMethod) return;

    setIsLoading(true);
    setError('');
    try {
      const res = await authService.disable2FA(disableMethod, password);
      if (!res.success) throw new Error(res.message || 'Failed to disable.');

      setSuccess(`${disableMethod === 'totp' ? 'Authenticator App' : 'Email 2FA'} has been disabled.`);
      setPassword('');
      invalidateCache();
      await fetchStatus(true);
      setView('status');
    } catch (err: any) {
      setError(err.message || 'Failed to disable 2FA.');
    } finally {
      setIsLoading(false);
    }
  };

  // Backup codes
  const copyBackupCodes = () => {
    navigator.clipboard.writeText(backupCodes.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const confirmBackupCodesSaved = async () => {
    invalidateCache();
    await fetchStatus(true);
    setView('status');
  };

  // Navigation
  const resetAndGoBack = () => {
    setView('status');
    setError('');
    setSuccess('');
    setCode(['', '', '', '', '', '']);
    setPassword('');
    setSetupMethod(null);
    setDisableMethod(null);
  };

  const getTitle = () => {
    switch (view) {
      case 'status': return 'Two-Factor Authentication';
      case 'password-prompt': return 'Confirm Password';
      case 'setup-totp': return 'Setup Authenticator App';
      case 'setup-email': return 'Setup Email 2FA';
      case 'disable': return 'Disable 2FA';
      case 'backup-codes': return 'Backup Codes';
    }
  };

  return {
    // State
    view,
    isLoading,
    status,
    error,
    success,
    qrCode,
    secret,
    password,
    setupMethod,
    disableMethod,
    backupCodes,
    copied,
    code,
    inputs,

    // Derived
    hasTotp,
    hasEmail,
    hasAny2FA,

    // Setters (for form inputs)
    setPassword,

    // Actions
    fetchStatus,
    handleCodeChange,
    handleCodePaste,
    handleKeyDown,
    promptSetup,
    handlePasswordSubmit,
    handleVerifySetup,
    promptDisable,
    handleDisable,
    copyBackupCodes,
    confirmBackupCodesSaved,
    resetAndGoBack,
    getTitle,
  };
}
