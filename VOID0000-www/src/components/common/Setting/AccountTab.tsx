import { useState } from 'react';
import { Shield, ChevronRight, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAccountSettings } from '../../../Services/hooks/Settings/useAccount';
import { useUser } from '../../../Services/Auth/UserContext';
import ChangePasswordModal from './ChangePassword/ChangePasswordModal';
import ActiveSessionsModal from './ActiveSessions/ActiveSessionsModal';
import TwoFactorSettingsModal from './2FA/TwoFactorModal';

const AccountTab = () => {
  const navigate = useNavigate();
  const { logout } = useUser();
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showActiveSessions, setShowActiveSessions] = useState(false);
  const [showTwoFactor, setShowTwoFactor] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const { account, loading } = useAccountSettings();

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
          <button className="w-full px-3 py-2.5 md:px-4 md:py-3 bg-red-900/20 hover:bg-red-900/30 border border-red-800/50 hover:border-red-700 rounded-lg transition-all active:scale-[0.98]">
            <div className="flex items-center justify-between">
              <div className="text-left">
                <p className="text-sm font-medium text-red-400">Delete Account</p>
                <p className="text-xs text-red-300/70 mt-0.5 hidden sm:block">Permanently delete your account</p>
              </div>
              <ChevronRight className="w-4 h-4 text-red-400" />
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