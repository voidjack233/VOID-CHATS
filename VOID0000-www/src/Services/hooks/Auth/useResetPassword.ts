import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { authService } from '../../Auth/authServiceApi';

export const useResetPassword = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const view = searchParams.get('view');
    
    // ONLY run this hook if we're actually on reset-password view
    if (view !== 'reset-password') {
      return;
    }

    const tokenFromURL = searchParams.get('token');

    if (!tokenFromURL) {
      navigate('/auth?view=login');
      return;
    }

    setToken(tokenFromURL);

    const validateToken = async () => {
      try {
        const data = await authService.checkResetToken(tokenFromURL);
        if (!data.success) {
          navigate('/auth?view=login');
        }
      } catch (err) {
        navigate('/auth?view=login');
      }
    };

    validateToken();
  }, [searchParams, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!token) {
      setError('Reset token is missing');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await authService.resetPassword(token, password);
      if (!response.success) throw new Error(response.message);
      setSuccess(true);
      setTimeout(() => navigate('/auth?view=login'), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password reset failed');
    } finally {
      setLoading(false);
    }
  };

  return {
    password,
    setPassword,
    confirmPassword,
    setConfirmPassword,
    error,
    success,
    loading,
    handleSubmit,
    token,
  };
};