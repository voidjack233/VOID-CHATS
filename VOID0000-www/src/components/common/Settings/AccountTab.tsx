import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronRight, Copy, KeyRound, LogOut, Shield } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAccountSettings } from '../../../Services/hooks/Settings/useAccount';
import { useUser } from '../../../Services/Auth/UserContext';
import { fetchKeyBackup } from '../../../Services/Chat/chatService';
import ChangePasswordModal from './ChangePassword/ChangePasswordModal';
import ActiveSessionsModal from './ActiveSessions/ActiveSessionsModal';
import TwoFactorSettingsModal from './2FA/TwoFactorModal';

const AccountTab = () => {
  const navigate = useNavigate();
  const {
    generateRecoveryKey,
    logout,
    keyStatus,
    recoveryBackupStatus,
    keyStatusLoading,
    setupRecoveryKey,
  } = useUser();
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showActiveSessions, setShowActiveSessions] = useState(false);
  const [showTwoFactor, setShowTwoFactor] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [recoveryKeyCopied, setRecoveryKeyCopied] = useState(false);
  const [recoveryKeyStatus, setRecoveryKeyStatus] = useState('');
  const [recoveryKeyConfigured, setRecoveryKeyConfigured] = useState<boolean | null>(null);
  const [recoveryKeyConfiguredAt, setRecoveryKeyConfiguredAt] = useState<string | null>(null);
  const [confirmRecoveryKeyRotation, setConfirmRecoveryKeyRotation] = useState(false);
  const [isSettingRecoveryKey, setIsSettingRecoveryKey] = useState(false);

  const { account, loading } = useAccountSettings();

  useEffect(() => {
    let cancelled = false;

    const loadRecoveryKeyStatus = async () => {
      try {
        const backup = await fetchKeyBackup();
        if (cancelled) return;

        const isConfigured = Boolean(
          backup?.recovery_encrypted_private_key &&
          backup.recovery_iv &&
          backup.recovery_salt &&
          backup.recovery_key_id
        );
        setRecoveryKeyConfigured(isConfigured);
        setRecoveryKeyConfiguredAt(backup?.recovery_configured_at || null);
      } catch {
        if (cancelled) return;
        setRecoveryKeyConfigured(false);
        setRecoveryKeyConfiguredAt(null);
      }
    };

    void loadRecoveryKeyStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      await logout();
      navigate('/auth', { replace: true });
    } catch (error) {
      console.error('Logout failed', error);
      setIsLoggingOut(false);
    }
  };

  const handleGenerateRecoveryKey = async () => {
    if (recoveryKeyConfigured && !confirmRecoveryKeyRotation && !recoveryKey) {
      setConfirmRecoveryKeyRotation(true);
      setRecoveryKeyStatus('');
      return;
    }

    setIsSettingRecoveryKey(true);
    setRecoveryKeyStatus('');
    setRecoveryKeyCopied(false);

    try {
      const nextRecoveryKey = generateRecoveryKey();
      await setupRecoveryKey(nextRecoveryKey);
      setRecoveryKey(nextRecoveryKey);
      setRecoveryKeyConfigured(true);
      setRecoveryKeyConfiguredAt(new Date().toISOString());
      setConfirmRecoveryKeyRotation(false);
      setRecoveryKeyStatus('Recovery key is ready. Save it somewhere safe; it will not be shown again after you close settings.');
    } catch (error) {
      console.error('Failed to set up recovery key', error);
      setRecoveryKey('');
      setConfirmRecoveryKeyRotation(false);
      setRecoveryKeyStatus(
        error instanceof Error && error.message === 'PASSWORD_BACKUP_REQUIRED'
          ? 'Secure chat backup is still initializing. Try again after opening chat once.'
          : 'Could not create a recovery key yet. Try again in a moment.'
      );
    } finally {
      setIsSettingRecoveryKey(false);
    }
  };

  const recoveryConfiguredLabel = recoveryKeyConfiguredAt
    ? `Configured ${new Date(recoveryKeyConfiguredAt).toLocaleDateString()}`
    : 'Configured';

  const secureBackupDescription = keyStatusLoading
    ? 'Checking secure backup status...'
    : keyStatus !== 'SECURE'
      ? 'Your secure chat backup is being initialized automatically for this account.'
      : recoveryBackupStatus === 'RECOVERY_KEY_READY'
        ? 'Your chat identity is backed up and new devices can be restored with your recovery key.'
        : 'Your chat identity is backed up, but new devices still fall back to your account password until you add a recovery key.';

  const secureBackupBadge =
    keyStatusLoading
      ? 'Checking'
      : keyStatus !== 'SECURE'
        ? 'Initializing'
        : recoveryBackupStatus === 'RECOVERY_KEY_READY'
          ? 'Recovery Ready'
          : 'Legacy Password';

  const handleCopyRecoveryKey = async () => {
    if (!recoveryKey) return;
    await navigator.clipboard.writeText(recoveryKey);
    setRecoveryKeyCopied(true);
    window.setTimeout(() => setRecoveryKeyCopied(false), 1600);
  };

  return (
    <>
      <div className="space-y-4 md:space-y-6 pb-6">
        {/* Account Information */}
        <div>
          <h4 className="text-xs md:text-sm font-semibold text-void-text-muted uppercase mb-3">
            Account Information
          </h4>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-void-text mb-1">Email Address</label>
              <div className="w-full bg-gray-900 border border-void-border rounded-lg px-4 py-3 text-void-text text-sm truncate">
                {loading ? 'Loading...' : account?.email || 'Not available'}
              </div>
              <p className="text-xs text-void-text-muted mt-1">Email cannot be changed yet</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-void-text mb-1">Username</label>
              <div className="w-full bg-gray-900 border border-void-border rounded-lg px-4 py-3 text-void-text text-sm">
                {loading ? 'Loading...' : account?.username || 'Not available'}
              </div>
              <p className="text-xs text-void-text-muted mt-1">Username cannot be changed</p>
            </div>
          </div>
        </div>

        {/* Security */}
        <div className="border-t border-void-border pt-4">
          <h4 className="text-xs md:text-sm font-semibold text-void-text-muted uppercase mb-3">Security</h4>
          <div className="space-y-2">
            <div className="w-full px-3 py-2.5 md:px-4 md:py-3 bg-gray-900 border border-void-border rounded-lg">
              <div className="flex items-center justify-between gap-3">
                <div className="text-left">
                  <p className="text-sm font-medium text-void-text">Secure Chat Backup</p>
                  <p className="text-xs text-void-text-muted mt-0.5 hidden sm:block">
                    {secureBackupDescription}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] uppercase tracking-wide ${
                    keyStatus === 'SECURE' && !keyStatusLoading
                      ? recoveryBackupStatus === 'RECOVERY_KEY_READY'
                        ? 'text-emerald-400'
                        : 'text-orange-300'
                      : 'text-void-text-muted'
                  }`}>
                    {secureBackupBadge}
                  </span>
                  <Shield className="w-4 h-4 text-void-text-muted hidden sm:block" />
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-void-border bg-gray-900 px-3 py-3 md:px-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-void-text">Recovery Key</p>
                    {recoveryKeyConfigured ? (
                      <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                        {recoveryConfiguredLabel}
                      </span>
                    ) : recoveryKeyConfigured === null ? (
                      <span className="rounded-full border border-void-border bg-void-bg-main/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-void-text-muted">
                        Checking
                      </span>
                    ) : (
                      <span className="rounded-full border border-orange-500/25 bg-orange-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-300">
                        Not set
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-void-text-muted">
                    {recoveryKeyConfigured && !recoveryKey
                      ? 'A recovery key is already active. VOID cannot show it again. Rotate only if you lost it, because the old key will stop working.'
                      : recoveryBackupStatus === 'PASSWORD_ONLY'
                        ? 'Right now this account can still recover secure chat with your account password. Create a recovery key so new devices do not depend on that legacy fallback.'
                        : 'Use this key to restore encrypted chats on a new device. Keep it private; losing it can lock you out of old chat history.'}
                  </p>
                </div>
                <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-void-text-muted" />
              </div>

              {recoveryBackupStatus === 'PASSWORD_ONLY' && !recoveryKey && !confirmRecoveryKeyRotation ? (
                <div className="mt-3 rounded-xl border border-orange-500/25 bg-orange-500/10 p-3">
                  <p className="text-xs text-orange-100/90">
                    This account is still using the older password-based recovery fallback for secure chat. A recovery key makes new-device restore safer and less dependent on your login password.
                  </p>
                </div>
              ) : null}

              {confirmRecoveryKeyRotation && !recoveryKey ? (
                <div className="mt-3 rounded-xl border border-orange-500/25 bg-orange-500/10 p-3">
                  <p className="text-xs text-orange-100/90">
                    Rotating creates a new recovery key and replaces the old one. If another device only has the old key, that old key will no longer unlock future recovery backups.
                  </p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={handleGenerateRecoveryKey}
                      disabled={isSettingRecoveryKey}
                      className="inline-flex justify-center rounded-lg bg-orange-600 px-3 py-2 text-xs font-semibold text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isSettingRecoveryKey ? 'Rotating...' : 'Yes, Rotate Key'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmRecoveryKeyRotation(false);
                        setRecoveryKeyStatus('');
                      }}
                      disabled={isSettingRecoveryKey}
                      className="inline-flex justify-center rounded-lg border border-void-border bg-void-bg-main/80 px-3 py-2 text-xs font-semibold text-void-text hover:bg-void-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}

              {recoveryKey ? (
                <div className="mt-3 rounded-xl border border-blue-500/20 bg-blue-500/10 p-3">
                  <code className="block break-all font-mono text-sm tracking-wide text-blue-100">
                    {recoveryKey}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopyRecoveryKey}
                    className="mt-3 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700"
                  >
                    {recoveryKeyCopied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {recoveryKeyCopied ? 'Copied' : 'Copy recovery key'}
                  </button>
                </div>
              ) : null}

              {recoveryKeyStatus ? (
                <p className={`mt-2 text-xs ${recoveryKey ? 'text-emerald-300' : 'text-orange-300'}`}>
                  {recoveryKeyStatus}
                </p>
              ) : null}

              <button
                type="button"
                onClick={handleGenerateRecoveryKey}
                disabled={
                  isSettingRecoveryKey ||
                  keyStatusLoading ||
                  recoveryKeyConfigured === null ||
                  confirmRecoveryKeyRotation ||
                  Boolean(recoveryKey)
                }
                className="mt-3 w-full rounded-lg border border-void-border bg-void-bg-main/70 px-3 py-2.5 text-sm font-medium text-void-text transition-all hover:border-blue-500 hover:bg-void-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSettingRecoveryKey
                  ? 'Creating recovery key...'
                  : recoveryKey
                    ? 'Recovery Key Created'
                    : recoveryKeyConfigured
                      ? 'Rotate Recovery Key'
                      : 'Create Recovery Key'}
              </button>
            </div>

            <button
              onClick={() => setShowChangePassword(true)}
              className="w-full px-3 py-2.5 md:px-4 md:py-3 bg-gray-900 hover:bg-gray-900/70 border border-void-border hover:border-blue-500 rounded-lg transition-all active:scale-[0.98]"
            >
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <p className="text-sm font-medium text-void-text">Change Password</p>
                  <p className="text-xs text-void-text-muted mt-0.5 hidden sm:block">Update your password</p>
                </div>
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-void-text-muted hidden sm:block" />
                  <ChevronRight className="w-4 h-4 text-void-text-muted" />
                </div>
              </div>
            </button>

            <button
              onClick={() => setShowTwoFactor(true)}
              className="w-full px-3 py-2.5 md:px-4 md:py-3 bg-gray-900 hover:bg-gray-900/70 border border-void-border hover:border-blue-500 rounded-lg transition-all active:scale-[0.98]"
            >
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <p className="text-sm font-medium text-void-text">Two-Factor Authentication</p>
                  <p className="text-xs text-void-text-muted mt-0.5 hidden sm:block">Manage your 2FA settings</p>
                </div>
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-void-text-muted hidden sm:block" />
                  <ChevronRight className="w-4 h-4 text-void-text-muted" />
                </div>
              </div>
            </button>

            <button
              onClick={() => setShowActiveSessions(true)}
              className="w-full px-3 py-2.5 md:px-4 md:py-3 bg-gray-900 hover:bg-gray-900/70 border border-void-border hover:border-blue-500 rounded-lg transition-all active:scale-[0.98]"
            >
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <p className="text-sm font-medium text-void-text">Active Sessions</p>
                  <p className="text-xs text-void-text-muted mt-0.5 hidden sm:block">Manage your devices</p>
                </div>
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-void-text-muted hidden sm:block" />
                  <ChevronRight className="w-4 h-4 text-void-text-muted" />
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* Logout */}
        <div className="border-t border-void-border pt-4">
          <button
            onClick={handleLogout}
            disabled={isLoggingOut}
            className="w-full px-3 py-2.5 md:px-4 md:py-3 bg-gray-900 hover:bg-gray-900/70 border border-void-border hover:border-orange-500 rounded-lg transition-all active:scale-[0.98] disabled:opacity-50"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <LogOut className="w-4 h-4 text-orange-400" />
                <div className="text-left">
                  <p className="text-sm font-medium text-orange-400">
                    {isLoggingOut ? 'Logging out...' : 'Log Out'}
                  </p>
                  <p className="text-xs text-void-text-muted mt-0.5 hidden sm:block">Sign out of your account</p>
                </div>
              </div>
              {isLoggingOut ? (
                <div className="w-4 h-4 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
              ) : (
                <ChevronRight className="w-4 h-4 text-orange-400" />
              )}
            </div>
          </button>
        </div>

        {/* Danger Zone */}
        <div className="border-t border-void-border pt-4">
          <h4 className="text-xs md:text-sm font-semibold text-red-400 uppercase mb-3">Danger Zone</h4>
          <button
            disabled
            className="w-full cursor-not-allowed px-3 py-2.5 md:px-4 md:py-3 bg-red-900/10 border border-red-900/40 rounded-lg transition-all opacity-70"
          >
            <div className="flex items-center justify-between">
              <div className="text-left">
                <p className="text-sm font-medium text-red-400">Delete Account</p>
                <p className="text-xs text-red-300/70 mt-0.5 hidden sm:block">
                  Account deletion is not available in this app.
                </p>
              </div>
              <span className="rounded-full border border-red-800/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-red-300/80">
                Unavailable
              </span>
            </div>
          </button>
        </div>
      </div>

      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
      {showActiveSessions && <ActiveSessionsModal onClose={() => setShowActiveSessions(false)} />}
      {showTwoFactor && <TwoFactorSettingsModal onClose={() => setShowTwoFactor(false)} />}
    </>
  );
};

export default AccountTab;
