import { useState } from 'react';
import { KeyRound, LogOut, ShieldAlert } from 'lucide-react';

interface RecoveryLockScreenProps {
  onRecover: (recoveryPhrase: string) => Promise<void>;
  onLogout: () => Promise<void>;
  loading?: boolean;
}

export default function RecoveryLockScreen({
  onRecover,
  onLogout,
  loading = false,
}: RecoveryLockScreenProps) {
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!recoveryPhrase.trim()) {
      setError('Enter your 12-word recovery phrase.');
      return;
    }

    setIsSubmitting(true);
    try {
      await onRecover(recoveryPhrase);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'INVALID_RECOVERY_PHRASE') {
          setError('That recovery phrase is invalid.');
        } else if (err.message === 'RECOVERY_NOT_CONFIGURED') {
          setError('No recovery phrase is configured for this account yet.');
        } else if (err.message === 'RECOVERY_KEY_MISMATCH') {
          setError('The recovery phrase does not match this account’s active chat identity.');
        } else {
          setError('Failed to unlock your chats. Try again.');
        }
      } else {
        setError('Failed to unlock your chats. Try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <div className="min-h-screen bg-void-bg-main text-void-text flex items-center justify-center p-6">
      <div className="w-full max-w-xl bg-void-bg-sec border border-void-border rounded-2xl shadow-2xl p-8 space-y-6">
        <div className="space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <ShieldAlert className="w-6 h-6 text-amber-400" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">Your chats are locked on this device</h1>
            <p className="text-sm text-void-text-muted mt-2">
              The current device cannot unlock your stored chat identity with the available password state.
              Enter the 12-word recovery phrase to restore the same identity key. If you never configured one,
              sign out and log in again from a device that still has your original keys.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-void-text mb-2">
              Recovery Phrase
            </label>
            <textarea
              value={recoveryPhrase}
              onChange={(e) => setRecoveryPhrase(e.target.value)}
              rows={3}
              disabled={loading || isSubmitting}
              placeholder="word1 word2 word3 ..."
              className="w-full rounded-xl border border-void-border bg-gray-900 px-4 py-3 text-sm text-void-text focus:outline-none focus:border-blue-500 resize-none"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="submit"
              disabled={loading || isSubmitting || isLoggingOut}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white px-4 py-3 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <KeyRound className="w-4 h-4" />
              {loading || isSubmitting ? 'Unlocking...' : 'Unlock Chats'}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              disabled={loading || isSubmitting || isLoggingOut}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-void-border bg-gray-900 text-void-text px-4 py-3 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <LogOut className="w-4 h-4" />
              {isLoggingOut ? 'Signing out...' : 'Sign Out'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
