import { useState } from 'react';
import { authService } from '../../Auth/authServiceApi';
import { useUser } from '../../Auth/UserContext';
import { keyManager } from '../../Crypto/keyManager';
import { uploadPublicKey, backupKeyToServer, fetchKeyBackup } from '../../Chat/chatService';

export function useChangePassword() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const { user, setLoginPassword } = useUser();

  const changePassword = async (currentPassword: string, newPassword: string) => {
    setIsLoading(true);
    setError('');
    setSuccess(false);

    try {
      const result = await authService.changePassword(currentPassword, newPassword);

      if (!result.success) {
        setError(result.message || 'Failed to change password');
        return false;
      }

      // Re-encrypt the key backup with the new password so restores still work
      if (user?.id) {
        keyManager.reEncryptBackup(user.id, newPassword, {
          uploadPublicKey: async (pubKey, keyId) => await uploadPublicKey(pubKey, keyId),
          backupToServer: async (data) => await backupKeyToServer(data),
          fetchBackup: async () => await fetchKeyBackup(),
        }).catch((err) => {
          console.warn('🔑 Backup re-encryption failed (non-critical):', err);
        });
      }

      setLoginPassword(newPassword);
      setSuccess(true);
      return true;
    } catch (err) {
      setError('Something went wrong. Please try again.');
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const reset = () => {
    setError('');
    setSuccess(false);
  };

  return {
    isLoading,
    error,
    success,
    changePassword,
    reset,
  };
}