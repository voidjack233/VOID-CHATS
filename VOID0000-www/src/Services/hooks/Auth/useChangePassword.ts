import { useState } from 'react';
import { authService } from '../../Auth/authServiceApi';

export function useChangePassword() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

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