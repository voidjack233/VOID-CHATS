import { useState, useEffect } from 'react';

import { getAccount } from '../../api/usersApi';
import type { AccountData } from '../../api/usersApi';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to fetch';
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
        const accountData = await getAccount();

        if (accountData) {
          setAccount(accountData);
          localStorage.setItem('void_user', JSON.stringify(accountData));
        }
      } catch (err: unknown) {
        setError(getErrorMessage(err));
      } finally {
        setLoading(false);
      }
    };

    fetchAccount();
  }, [account]);

  return { account, loading, error };
};
