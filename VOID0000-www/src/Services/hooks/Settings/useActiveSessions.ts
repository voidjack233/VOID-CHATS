import { useState, useEffect } from 'react';

import {
  getActiveSessions,
  revokeAllSessions as revokeAllSessionsApi,
  revokeSession as revokeSessionApi,
} from '../../api/usersApi';
import type { Session } from '../../api/usersApi';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const useActiveSessions = () => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const fetchSessions = async () => {
    try {
      setLoading(true);
      setError(null);

      const activeSessions = await getActiveSessions();
      setSessions(activeSessions);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to load sessions'));
    } finally {
      setLoading(false);
    }
  };

  const revokeSession = async (sessionId: string) => {
    try {
      setRevoking(sessionId);
      setError(null);

      await revokeSessionApi(sessionId);

      // Remove from local state
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to revoke session'));
    } finally {
      setRevoking(null);
    }
  };

  const revokeAllSessions = async () => {
    try {
      setRevoking('__all__');
      setError(null);

      await revokeAllSessionsApi();

      // Keep only current session
      setSessions(prev => prev.filter(s => s.is_current));
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to revoke sessions'));
    } finally {
      setRevoking(null);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  return {
    sessions,
    loading,
    error,
    revoking,
    revokeSession,
    revokeAllSessions,
    refreshSessions: fetchSessions,
  };
};
