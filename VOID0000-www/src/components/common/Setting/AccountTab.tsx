import { useState } from 'react';
import { Shield, ChevronRight } from 'lucide-react';
import { useAccountSettings } from '../../../Services/hooks/Settings/useAccount';
import ChangePasswordModal from './ChangePassword/ChangePasswordModal';
import ActiveSessionsModal from './ActiveSessions/ActiveSessionsModal';
// Add this new import
import TwoFactorSettingsModal from './2FA/TwoFactorModal'; 

const AccountTab = () => {
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showActiveSessions, setShowActiveSessions] = useState(false);
  // Add state for 2FA modal
  const [showTwoFactor, setShowTwoFactor] = useState(false); 
  
  const { account, loading } = useAccountSettings();

  return (
    <>
      <div className="space-y-4 md:space-y-6 pb-6">
        {/* Profile Information */}
        <div>
          <h4 className="text-xs md:text-sm font-semibold text-gray-400 uppercase mb-3">
            Account Information
          </h4>
          
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Email Address
              </label>
              <div className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-white text-sm truncate">
                {loading ? 'Loading...' : account?.email || 'Not available'}
              </div>
              <p className="text-xs text-gray-500 mt-1">Email cannot be changed yet</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Username
              </label>
              <div className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-white text-sm">
                {loading ? 'Loading...' : account?.username || 'Not available'}
              </div>
              <p className="text-xs text-gray-500 mt-1">Username cannot be changed</p>
            </div>
          </div>
        </div>

        {/* Security */}
        <div className="border-t border-gray-700 pt-4">
          <h4 className="text-xs md:text-sm font-semibold text-gray-400 uppercase mb-3">
            Security
          </h4>
          
          <div className="space-y-2">
            <button 
              onClick={() => setShowChangePassword(true)}
              className="w-full px-3 py-2.5 md:px-4 md:py-3 bg-gray-900 hover:bg-gray-900/70 border border-gray-700 hover:border-blue-500 rounded-lg transition-all active:scale-[0.98]"
            >
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <p className="text-sm font-medium text-white">Change Password</p>
                  <p className="text-xs text-gray-400 mt-0.5 hidden sm:block">Update your password</p>
                </div>
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-gray-400 hidden sm:block" />
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                </div>
              </div>
            </button>

            {/* Updated 2FA Button */}
            <button 
              onClick={() => setShowTwoFactor(true)}
              className="w-full px-3 py-2.5 md:px-4 md:py-3 bg-gray-900 hover:bg-gray-900/70 border border-gray-700 hover:border-blue-500 rounded-lg transition-all active:scale-[0.98]"
            >
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <p className="text-sm font-medium text-white">Two-Factor Authentication</p>
                  <p className="text-xs text-gray-400 mt-0.5 hidden sm:block">Manage your 2FA settings</p>
                </div>
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-gray-400 hidden sm:block" />
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                </div>
              </div>
            </button>

            <button 
              onClick={() => setShowActiveSessions(true)}
              className="w-full px-3 py-2.5 md:px-4 md:py-3 bg-gray-900 hover:bg-gray-900/70 border border-gray-700 hover:border-blue-500 rounded-lg transition-all active:scale-[0.98]"
            >
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <p className="text-sm font-medium text-white">Active Sessions</p>
                  <p className="text-xs text-gray-400 mt-0.5 hidden sm:block">Manage your devices</p>
                </div>
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-gray-400 hidden sm:block" />
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* Danger Zone */}
        <div className="border-t border-gray-700 pt-4">
          <h4 className="text-xs md:text-sm font-semibold text-red-400 uppercase mb-3">
            Danger Zone
          </h4>
          
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

      {/* Modals */}
      {showChangePassword && (
        <ChangePasswordModal onClose={() => setShowChangePassword(false)} />
      )}
      
      {showActiveSessions && (
        <ActiveSessionsModal onClose={() => setShowActiveSessions(false)} />
      )}

      {/* New 2FA Modal */}
      {showTwoFactor && (
        <TwoFactorSettingsModal onClose={() => setShowTwoFactor(false)} />
      )}
    </>
  );
};

export default AccountTab;