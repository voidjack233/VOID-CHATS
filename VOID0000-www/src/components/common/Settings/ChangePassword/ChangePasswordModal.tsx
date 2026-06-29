import { useEffect, useState } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import { useChangePassword } from '../../../../Services/hooks/Auth/useChangePassword';
import { authService } from '../../../../Services/Auth/authServiceApi';
import { useUser } from '../../../../Services/Auth/UserContext';

interface ChangePasswordModalProps {
  onClose: () => void;
}

export default function ChangePasswordModal({ onClose }: ChangePasswordModalProps) {
  const { recoveryBackupStatus } = useUser();
  const [step, setStep] = useState<'confirm' | 'form'>('confirm');
  const [requires2FA, setRequires2FA] = useState<boolean | null>(null);
  const [twoFactorMethods, setTwoFactorMethods] = useState<string[]>([]);
  const [activeMethod, setActiveMethod] = useState<'totp' | 'email' | 'backup'>('totp');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [emailSending, setEmailSending] = useState(false);
  const [emailCooldown, setEmailCooldown] = useState<number | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [validationError, setValidationError] = useState('');

  const { isLoading, error, success, changePassword, reset } = useChangePassword();
  const normalizedTwoFactorCode =
    activeMethod === 'backup' ? twoFactorCode.trim().toUpperCase() : twoFactorCode.trim();
  const twoFactorCodeReady =
    !requires2FA ||
    (activeMethod === 'backup'
      ? /^[A-F0-9]{8}$/.test(normalizedTwoFactorCode)
      : /^\d{6}$/.test(normalizedTwoFactorCode));

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const res = await authService.get2FAStatus();
        if (cancelled) return;

        const enabledMethods: Array<'totp' | 'email' | 'backup'> = [];
        if (res?.twoFactor?.totp?.enabled) enabledMethods.push('totp');
        if (res?.twoFactor?.email?.enabled) enabledMethods.push('email');
        if (res?.twoFactor?.backupCodesRemaining > 0) enabledMethods.push('backup');

        setRequires2FA(enabledMethods.length > 0);
        setTwoFactorMethods(enabledMethods);

        if (enabledMethods.includes('totp')) setActiveMethod('totp');
        else if (enabledMethods.includes('email')) setActiveMethod('email');
        else if (enabledMethods.includes('backup')) setActiveMethod('backup');
      } catch {
        if (!cancelled) {
          setRequires2FA(false);
          setTwoFactorMethods([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const sendEmailCode = async () => {
    if (emailSending || emailCooldown !== null) return;
    setEmailSending(true);
    setValidationError('');
    try {
      const result = await authService.sendAuthenticated2FAEmailCode('change_password');
      if (result.success) {
        setEmailSent(true);
        setEmailCooldown(
          typeof result.retryAfterSeconds === 'number' && result.retryAfterSeconds > 0
            ? result.retryAfterSeconds
            : 60,
        );
      } else {
        setValidationError(result.message || 'Failed to send email code');
        if (typeof result.retryAfterSeconds === 'number' && result.retryAfterSeconds > 0) {
          setEmailCooldown(result.retryAfterSeconds);
        }
      }
    } catch (err: any) {
      setValidationError(err?.message || 'Failed to send email code');
    } finally {
      setEmailSending(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError('');

    if (newPassword !== confirmPassword) {
      setValidationError('New passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      setValidationError('New password must be at least 8 characters');
      return;
    }

    if (requires2FA && !normalizedTwoFactorCode) {
      setValidationError('Please enter your 2FA code');
      return;
    }

    if (requires2FA && !twoFactorCodeReady) {
      setValidationError(
        activeMethod === 'backup'
          ? 'Backup code must be 8 characters.'
          : '2FA code must be 6 digits.',
      );
      return;
    }

    const result = await changePassword(
      currentPassword,
      newPassword,
      requires2FA ? { method: activeMethod, code: normalizedTwoFactorCode } : null,
    );
    
    if (result) {
      // Close modal after 2 seconds on success
      setTimeout(() => {
        onClose();
      }, 2000);
    }
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  useEffect(() => {
    if (emailCooldown === null) return;
    const timer = window.setInterval(() => {
      setEmailCooldown(prev => {
        if (prev === null) return null;
        if (prev > 1) return prev - 1;
        return null;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [emailCooldown]);

  useEffect(() => {
    setTwoFactorCode('');
    setEmailSent(false);
    setEmailCooldown(null);
    setValidationError('');
  }, [activeMethod]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-void-border bg-void-bg-sec shadow-2xl">
        {/* Header */}
        <div className="p-6 border-b border-void-border flex items-center justify-between">
          <h3 className="text-lg font-semibold text-void-text">Change Password</h3>
          <button
            onClick={handleClose}
            className="p-2 rounded-full hover:bg-void-bg-hover transition-colors"
          >
            <X className="w-5 h-5 text-void-text-muted" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {success ? (
            <div className="text-center py-4">
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4">
                <p className="text-emerald-400">Password changed successfully!</p>
              </div>
            </div>
          ) : step === 'confirm' ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-orange-500/25 bg-orange-500/10 p-4">
                <p className="text-sm font-medium text-orange-100">You are about to change your password.</p>
                <p className="mt-2 text-xs text-orange-100/85">
                  This updates your account login and can affect secure backup recovery on your devices.
                  {requires2FA ? ' Your account also requires a 2FA code before the change is accepted.' : ''}
                </p>
              </div>

              {recoveryBackupStatus === 'PASSWORD_ONLY' ? (
                <div className="rounded-xl border border-void-accent/25 bg-void-accent/10 p-4">
                  <p className="text-sm font-medium text-void-text">Legacy secure-chat recovery is still active.</p>
                  <p className="mt-2 text-xs text-void-text-muted">
                    Changing your password will re-wrap the older password-based backup. After this change, it is still better to create a recovery key in Account settings so future device restore does not depend on your login password.
                  </p>
                </div>
              ) : null}

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleClose}
                  className="flex-1 rounded-lg border border-void-border bg-void-bg-main/70 px-4 py-3 text-void-text transition-colors hover:bg-void-bg-hover"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => setStep('form')}
                  disabled={requires2FA === null}
                  className="flex-1 rounded-lg bg-void-accent px-4 py-3 font-semibold text-white transition-colors hover:bg-void-accent-hover disabled:opacity-50"
                >
                  {requires2FA === null ? 'Checking…' : 'Continue'}
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Current Password */}
              <div>
                <label className="block text-sm font-medium text-void-text mb-2">
                  Current Password
                </label>
                <div className="relative">
                  <input
                    type={showCurrent ? 'text' : 'password'}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full rounded-lg border border-void-border bg-void-bg-main/70 px-4 py-3 pr-12 text-void-text transition-colors focus:border-void-accent focus:outline-none"
                    required
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrent(!showCurrent)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-void-text-muted hover:text-void-text"
                  >
                    {showCurrent ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              {/* New Password */}
              <div>
                <label className="block text-sm font-medium text-void-text mb-2">
                  New Password
                </label>
                <div className="relative">
                  <input
                    type={showNew ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full rounded-lg border border-void-border bg-void-bg-main/70 px-4 py-3 pr-12 text-void-text transition-colors focus:border-void-accent focus:outline-none"
                    required
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew(!showNew)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-void-text-muted hover:text-void-text"
                  >
                    {showNew ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              {/* Confirm Password */}
              <div>
                <label className="block text-sm font-medium text-void-text mb-2">
                  Confirm New Password
                </label>
                <div className="relative">
                  <input
                    type={showConfirm ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full rounded-lg border border-void-border bg-void-bg-main/70 px-4 py-3 pr-12 text-void-text transition-colors focus:border-void-accent focus:outline-none"
                    required
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm(!showConfirm)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-void-text-muted hover:text-void-text"
                  >
                    {showConfirm ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              {/* Error Messages */}
              {(error || validationError) && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                  <p className="text-red-400 text-sm">{validationError || error}</p>
                </div>
              )}

              {requires2FA ? (
                <div className="space-y-3 rounded-xl border border-void-border bg-void-bg-main/55 p-4">
                  <div>
                    <p className="text-sm font-medium text-void-text">Two-Factor Verification</p>
                    <p className="text-xs text-void-text-muted mt-1">Enter a valid code before changing your password.</p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {twoFactorMethods.includes('totp') ? (
                      <button type="button" onClick={() => setActiveMethod('totp')} className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${activeMethod === 'totp' ? 'bg-void-accent text-white' : 'bg-void-bg-hover text-void-text-muted hover:text-void-text'}`}>Authenticator</button>
                    ) : null}
                    {twoFactorMethods.includes('email') ? (
                      <button type="button" onClick={() => setActiveMethod('email')} className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${activeMethod === 'email' ? 'bg-void-accent text-white' : 'bg-void-bg-hover text-void-text-muted hover:text-void-text'}`}>Email</button>
                    ) : null}
                    {twoFactorMethods.includes('backup') ? (
                      <button type="button" onClick={() => setActiveMethod('backup')} className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${activeMethod === 'backup' ? 'bg-void-accent text-white' : 'bg-void-bg-hover text-void-text-muted hover:text-void-text'}`}>Backup code</button>
                    ) : null}
                  </div>

                  {activeMethod === 'email' ? (
                    <div className="space-y-3">
                      {!emailSent ? (
                        <button
                          type="button"
                          onClick={sendEmailCode}
                          disabled={emailSending}
                          className="w-full rounded-lg bg-void-bg-hover px-4 py-3 text-sm text-void-text transition-colors hover:bg-void-bg-hover/80"
                        >
                          {emailSending ? 'Sending code...' : 'Send email code'}
                        </button>
                      ) : null}
                      <input
                        type="text"
                        value={twoFactorCode}
                        onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="Enter 6-digit code"
                        className="w-full rounded-lg border border-void-border bg-void-bg-main/70 px-4 py-3 text-void-text transition-colors focus:border-void-accent focus:outline-none"
                        disabled={isLoading}
                      />
                      {!twoFactorCodeReady && twoFactorCode.length > 0 ? (
                        <p className="text-xs text-amber-400">Enter the full 6-digit code before continuing.</p>
                      ) : null}
                      {emailSent ? (
                        <button
                          type="button"
                          onClick={sendEmailCode}
                          disabled={emailSending || emailCooldown !== null}
                          className="text-xs text-void-accent disabled:opacity-50"
                        >
                          {emailCooldown !== null ? `Resend in ${emailCooldown}s` : emailSending ? 'Sending...' : 'Resend code'}
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={twoFactorCode}
                        onChange={(e) =>
                          setTwoFactorCode(
                            activeMethod === 'backup'
                              ? e.target.value.replace(/[^a-fA-F0-9]/g, '').toUpperCase().slice(0, 8)
                              : e.target.value.replace(/\D/g, '').slice(0, 6),
                          )
                        }
                        placeholder={activeMethod === 'backup' ? 'Enter 8-character backup code' : 'Enter 6-digit code'}
                        className="w-full rounded-lg border border-void-border bg-void-bg-main/70 px-4 py-3 text-void-text transition-colors focus:border-void-accent focus:outline-none"
                        disabled={isLoading}
                      />
                      {!twoFactorCodeReady && twoFactorCode.length > 0 ? (
                        <p className="text-xs text-amber-400">
                          {activeMethod === 'backup'
                            ? 'Enter the full 8-character backup code before continuing.'
                            : 'Enter the full 6-digit code before continuing.'}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isLoading || requires2FA === null || !twoFactorCodeReady}
                className="w-full rounded-lg bg-void-accent py-3 font-semibold text-white transition-colors hover:bg-void-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoading ? 'Changing...' : 'Change Password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
