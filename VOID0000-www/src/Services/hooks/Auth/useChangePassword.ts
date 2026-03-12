import { useState } from 'react';
import { authService } from '../../Auth/authServiceApi';
import { useUser } from '../../Auth/UserContext';
import { keyManager } from '../../Crypto/keyManager';

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
      let keyBackup = null;
      if (user?.id) {
        try {
          keyBackup = await keyManager.prepareBackup(user.id, newPassword);
        } catch (err) {
          if (!(err instanceof Error) || err.message !== 'LOCAL_KEY_MISSING') {
            throw err;
          }
        }
      }

      const result = await authService.changePassword(currentPassword, newPassword, keyBackup);

      if (!result.success) {
        setError(result.message || 'Failed to change password');
        return false;
      }

      setLoginPassword(newPassword);
      setSuccess(true);
      return true;
    } catch {
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
