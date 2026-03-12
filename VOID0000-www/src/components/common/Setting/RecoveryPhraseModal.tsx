import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, RefreshCcw, ShieldAlert, X } from 'lucide-react';
import { useUser } from '../../../Services/Auth/UserContext';
import { keyManager } from '../../../Services/Crypto/keyManager';
import { useScrollLock } from '../../../Services/hooks/common/useScrollLock';

interface RecoveryPhraseModalProps {
  onClose: () => void;
  required?: boolean;
}

export default function RecoveryPhraseModal({ onClose, required = false }: RecoveryPhraseModalProps) {
  useScrollLock();
  const { keyStatus, saveRecoveryPhrase } = useUser();
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [hasAcknowledged, setHasAcknowledged] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setRecoveryPhrase(keyManager.generateRecoveryPhrase());
  }, []);

  const words = useMemo(() => recoveryPhrase.split(' ').filter(Boolean), [recoveryPhrase]);

  const handleRegenerate = () => {
    setRecoveryPhrase(keyManager.generateRecoveryPhrase());
    setHasAcknowledged(false);
    setCopyState('idle');
    setError('');
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryPhrase);
      setCopyState('copied');
    } catch (err) {
      console.error('Failed to copy recovery phrase:', err);
    }
  };

  const handleSave = async () => {
    if (!hasAcknowledged) {
      setError('Confirm that you stored the recovery phrase before continuing.');
      return;
    }

    setIsSaving(true);
    setError('');

    try {
      await saveRecoveryPhrase(recoveryPhrase);
      setSuccess(true);
    } catch (err) {
      if (err instanceof Error && err.message === 'INVALID_RECOVERY_PHRASE') {
        setError('The generated recovery phrase was invalid. Generate a new one and try again.');
      } else {
        setError('Failed to save the recovery phrase. Try again.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = () => {
    if (required && !success) {
      return;
    }

    if (!isSaving) {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-void-bg-main/90 md:flex md:items-center md:justify-center md:bg-black/50 md:backdrop-blur-sm">
      <div className="flex h-full w-full flex-col bg-void-bg-sec md:mx-4 md:h-auto md:max-h-[92vh] md:max-w-2xl md:rounded-2xl md:border md:border-void-bg-hover md:shadow-2xl md:overflow-hidden">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-void-bg-hover bg-void-bg-sec/95 px-4 py-4 backdrop-blur-sm md:px-6 md:py-5">
          <div>
            <h3 className="text-lg font-semibold text-void-text">
              {keyStatus === 'SECURE' ? 'Rotate Recovery Phrase' : 'Set Up Recovery Phrase'}
            </h3>
            <p className="text-sm text-void-text-muted mt-1">
              This phrase restores the same chat identity if password-based restore fails.
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
              <p className="text-emerald-300 font-medium">Recovery phrase saved.</p>
              <p className="text-sm text-emerald-200/80 mt-2">
                Keep the phrase offline. It is the last-resort way to recover your chats.
              </p>
            </div>
          ) : (
            <div className="space-y-5 md:space-y-6">
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 md:p-5">
                <div className="flex items-start gap-3">
                  <ShieldAlert className="w-5 h-5 text-amber-400 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-amber-100/90 space-y-1">
                    <p>Store these 12 words offline. Anyone with them can recover your chat identity.</p>
                    {keyStatus === 'SECURE' && (
                      <p>Saving this phrase replaces your previous recovery phrase.</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-void-bg-hover bg-void-bg-main/70 p-4 md:p-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-void-text-muted">
                    Recovery Words
                  </p>
                  <span className="rounded-full bg-void-bg-hover px-2.5 py-1 text-[11px] font-semibold text-void-text-muted">
                    12 words
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:gap-3">
                  {words.map((word, index) => (
                    <div
                      key={`${index + 1}-${word}`}
                      className="rounded-xl border border-void-bg-hover bg-void-bg-sec/80 px-3 py-2.5"
                    >
                      <span className="text-xs text-void-text-muted">{index + 1}</span>
                      <p className="mt-1 break-words text-sm font-medium text-void-text">{word}</p>
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
                  {copyState === 'copied' ? 'Copied' : 'Copy phrase'}
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
                  I saved these words somewhere safe and understand they can recover my chat history.
                </span>
              </label>

              {error && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              <div className="flex flex-col-reverse gap-3 pt-1 sm:flex-row sm:justify-end">
                {!required && (
                  <button
                    type="button"
                    onClick={handleClose}
                    className="w-full rounded-xl border border-void-bg-hover bg-void-bg-main px-4 py-3 text-sm font-medium text-void-text transition-colors hover:bg-void-bg-hover sm:w-auto"
                    disabled={isSaving}
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving || words.length !== 12 || !hasAcknowledged}
                  className="w-full rounded-xl bg-void-accent px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-void-accent-hover disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                >
                  {isSaving ? 'Saving...' : keyStatus === 'SECURE' ? 'Replace Phrase' : 'Save Recovery Phrase'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
