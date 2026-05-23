import { useState, useEffect } from 'react';
import { ensureCSRFToken } from '../../Auth/authServiceApi';

import { API_URL } from '../../config';

interface Session {
  id: string;
  device_id: string;
  device_name: string | null;
  device_type: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  updated_at: string;
  last_live_at?: string | null;
  expires_at: string;
  is_current: boolean;
  has_live_session?: boolean;
  is_recently_active?: boolean;
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

      const res = await fetch(`${API_URL}/api/users/sessions`, {
        method: 'GET',
        credentials: 'include',
      });

      if (!res.ok) throw new Error('Failed to fetch sessions');

      const data = await res.json();
      setSessions(data.sessions);
    } catch (err: any) {
      setError(err.message || 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  };

  const revokeSession = async (sessionId: string) => {
    try {
      setRevoking(sessionId);
      setError(null);

      const csrfToken = await ensureCSRFToken();

      const res = await fetch(`${API_URL}/api/users/sessions/${sessionId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          'X-CSRF-Token': csrfToken || '',
        },
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to revoke session');
      }

      // Remove from local state
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch (err: any) {
      setError(err.message || 'Failed to revoke session');
    } finally {
      setRevoking(null);
    }
  };

  const revokeAllSessions = async () => {
    try {
      setRevoking('__all__');
      setError(null);

      const csrfToken = await ensureCSRFToken();

      const res = await fetch(`${API_URL}/api/users/sessions`, {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          'X-CSRF-Token': csrfToken || '',
        },
      });

      if (!res.ok) throw new Error('Failed to revoke sessions');

      // Keep only current session
      setSessions(prev => prev.filter(s => s.is_current));
    } catch (err: any) {
      setError(err.message || 'Failed to revoke sessions');
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
