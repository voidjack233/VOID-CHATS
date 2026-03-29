import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, RefreshCcw, ShieldAlert, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '../../../Services/Auth/UserContext';
import { keyManager } from '../../../Services/Crypto/keyManager';
import { useScrollLock } from '../../../Services/hooks/common/useScrollLock';

interface RecoveryPhraseModalProps {
  onClose: () => void;
  required?: boolean;
}

export default function RecoveryPhraseModal({ onClose, required = false }: RecoveryPhraseModalProps) {
  useScrollLock();
  const navigate = useNavigate();
  const { keyStatus, saveRecoveryPhrase, logout } = useUser();
  const [recoveryKey, setRecoveryKey] = useState('');
  const [hasAcknowledged, setHasAcknowledged] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setRecoveryKey(keyManager.generateRecoveryPhrase());
  }, []);

  const keyChunks = useMemo(() => recoveryKey.split('-').filter(Boolean), [recoveryKey]);
  const shouldShowSignOut = keyStatus !== 'SECURE' && !success;

  const handleRegenerate = () => {
    setRecoveryKey(keyManager.generateRecoveryPhrase());
    setHasAcknowledged(false);
    setCopyState('idle');
    setError('');
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopyState('copied');
    } catch (err) {
      console.error('Failed to copy recovery key:', err);
    }
  };

  const handleSave = async () => {
    if (!hasAcknowledged) {
      setError('Confirm that you stored the recovery key before continuing.');
      return;
    }

    setIsSaving(true);
    setError('');

    try {
      await saveRecoveryPhrase(recoveryKey);
      setSuccess(true);
    } catch (err) {
      if (err instanceof Error && err.message === 'INVALID_RECOVERY_PHRASE') {
        setError('The generated recovery key was invalid. Generate a new one and try again.');
      } else if (err instanceof Error && err.message === 'PASSWORD_BACKUP_REQUIRED') {
        setError('Sign out and log in again with your account password on this device before saving a recovery key.');
      } else if (err instanceof Error && err.message === 'KEY_ID_MISMATCH') {
        setError('This device’s chat identity changed before the recovery key was saved. Refresh the app and try again.');
      } else if (err instanceof Error && err.message === 'AUTH_REQUIRED') {
        setError('Your session expired. Sign in again and then save the recovery key.');
      } else {
        setError('Failed to save the recovery key. Try again.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = () => {
    if (required && !success) {
      return;
    }

    if (!isSaving && !isLoggingOut) {
      onClose();
    }
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logout();
      navigate('/auth', { replace: true });
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-void-bg-main/90 md:flex md:items-center md:justify-center md:bg-black/50 md:backdrop-blur-sm">
      <div className="flex h-full w-full flex-col bg-void-bg-sec md:mx-4 md:h-auto md:max-h-[92vh] md:max-w-2xl md:rounded-2xl md:border md:border-void-bg-hover md:shadow-2xl md:overflow-hidden">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-void-bg-hover bg-void-bg-sec/95 px-4 py-4 backdrop-blur-sm md:px-6 md:py-5">
          <div>
            <h3 className="text-lg font-semibold text-void-text">
              {keyStatus === 'SECURE' ? 'Rotate Recovery Key' : 'Set Up Recovery Key'}
            </h3>
            <p className="text-sm text-void-text-muted mt-1">
              This key restores the same chat identity if password-based restore fails.
            </p>
            {required && (
              <p className="text-xs text-amber-300 mt-2">
                Recovery setup is required before you can continue into chats.
              </p>
            )}
          </div>
          {!required && (
            <button
              onClick={handleClose}
              className="mt-0.5 rounded-full p-2 hover:bg-void-bg-hover transition-colors"
              disabled={isSaving}
            >
              <X className="w-5 h-5 text-void-text-muted" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 md:px-6 md:py-6">
          {success ? (
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-5 text-center md:p-6">
              <Check className="w-8 h-8 text-emerald-400 mx-auto mb-3" />
              <p className="text-emerald-300 font-medium">Recovery key saved.</p>
              <p className="text-sm text-emerald-200/80 mt-2">
                Keep the key offline. It is the last-resort way to recover your chats.
              </p>
            </div>
          ) : (
            <div className="space-y-5 md:space-y-6">
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 md:p-5">
                <div className="flex items-start gap-3">
                  <ShieldAlert className="w-5 h-5 text-amber-400 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-amber-100/90 space-y-1">
                    <p>Store this recovery key offline. Anyone with it can recover your chat identity.</p>
                    <p>Legacy 12-word recovery phrases are still supported for older accounts.</p>
                    {keyStatus === 'SECURE' && (
                      <p>Saving this key replaces your previous recovery key.</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-void-bg-hover bg-void-bg-main/70 p-4 md:p-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-void-text-muted">
                    Recovery Key
                  </p>
                  <span className="rounded-full bg-void-bg-hover px-2.5 py-1 text-[11px] font-semibold text-void-text-muted">
                    Activation format
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:gap-3">
                  {keyChunks.map((chunk, index) => (
                    <div
                      key={`${index + 1}-${chunk}`}
                      className="rounded-xl border border-void-bg-hover bg-void-bg-sec/80 px-3 py-2.5"
                    >
                      <span className="text-xs text-void-text-muted">{index + 1}</span>
                      <p className="mt-1 break-words text-sm font-mono font-semibold tracking-wide text-void-text">
                        {chunk}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-void-bg-hover bg-void-bg-main px-4 py-3 text-sm font-medium text-void-text transition-colors hover:border-void-accent hover:bg-void-bg-hover"
                >
                  <Copy className="w-4 h-4" />
                  {copyState === 'copied' ? 'Copied' : 'Copy key'}
                </button>
                <button
                  type="button"
                  onClick={handleRegenerate}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-void-bg-hover bg-void-bg-main px-4 py-3 text-sm font-medium text-void-text transition-colors hover:border-void-accent hover:bg-void-bg-hover"
                >
                  <RefreshCcw className="w-4 h-4" />
                  Regenerate
                </button>
              </div>

              <label className="flex items-start gap-3 rounded-2xl border border-void-bg-hover bg-void-bg-main/80 px-4 py-3.5">
                <input
                  type="checkbox"
                  checked={hasAcknowledged}
                  onChange={(e) => setHasAcknowledged(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-void-bg-hover bg-void-bg-sec text-void-accent focus:ring-void-accent"
                />
                <span className="text-sm text-void-text-muted">
                  I saved this recovery key somewhere safe and understand it can recover my chat history.
                </span>
              </label>

              {error && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              <div className="flex flex-col-reverse gap-3 pt-1 sm:flex-row sm:justify-end">
                {!required && !shouldShowSignOut && (
                  <button
                    type="button"
                    onClick={handleClose}
                    className="w-full rounded-xl border border-void-bg-hover bg-void-bg-main px-4 py-3 text-sm font-medium text-void-text transition-colors hover:bg-void-bg-hover sm:w-auto"
                    disabled={isSaving || isLoggingOut}
                  >
                    Cancel
                  </button>
                )}
                {shouldShowSignOut && (
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="w-full rounded-xl border border-void-bg-hover bg-void-bg-main px-4 py-3 text-sm font-medium text-void-text transition-colors hover:bg-void-bg-hover sm:w-auto"
                    disabled={isSaving || isLoggingOut}
                  >
                    {isLoggingOut ? 'Signing out...' : 'Sign Out'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving || isLoggingOut || keyChunks.length === 0 || !hasAcknowledged}
                  className="w-full rounded-xl bg-void-accent px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-void-accent-hover disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                >
                  {isSaving ? 'Saving...' : keyStatus === 'SECURE' ? 'Replace Key' : 'Save Recovery Key'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
