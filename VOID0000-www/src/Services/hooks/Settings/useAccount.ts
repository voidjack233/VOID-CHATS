import { useState, useEffect } from 'react';

import { API_URL } from '../../config';

interface AccountData {
  id: string;
  email: string;
  username: string;
  created_at?: string;
}

export const useAccountSettings = () => {
  const [account, setAccount] = useState<AccountData | null>(() => {
    // Load from localStorage immediately
    const cached = localStorage.getItem('void_user');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.email && parsed.username) {
        return parsed;
      }
    }
    return null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // If already have data, don't fetch
    if (account?.email && account?.username) {
      return;
    }

    // Only fetch if no cached data
    const fetchAccount = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API_URL}/api/users/account`, {
          credentials: 'include',
        });

        if (!res.ok) throw new Error('Failed to fetch');

        const data = await res.json();

        if (data.success && data.account) {
          setAccount(data.account);
          localStorage.setItem('void_user', JSON.stringify(data.account));
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchAccount();
  }, [account]);

  return { account, loading, error };
};
