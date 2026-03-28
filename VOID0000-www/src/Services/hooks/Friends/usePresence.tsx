import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useUser } from '../../Auth/UserContext';
import { gateway } from '../../Gateway/gateway';
import { fetchWithAuth } from '../../Auth/authServiceApi';

type PresenceStatus = 'online' | 'idle' | 'offline';
const PRESENCE_REFRESH_INTERVAL_MS = 30_000;

interface Presence {
  status: PresenceStatus;
  lastActive: number | null;
}

interface FriendPresenceSnapshot {
  id: string;
  status?: PresenceStatus;
  last_active?: number | null;
}

interface PresenceContextType {
  presences: Map<string, Presence>;
  getPresence: (userId: string) => Presence;
}

const PresenceContext = createContext<PresenceContextType | null>(null);

export function PresenceProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const [presences, setPresences] = useState<Map<string, Presence>>(new Map());

  const getPresence = useCallback((userId: string): Presence => {
    return presences.get(userId) || { status: 'offline', lastActive: null };
  }, [presences]);

  useEffect(() => {
    let cancelled = false;

    if (!user) {
      setPresences(new Map());
      return;
    }

    const applyPresenceSnapshot = (friends: FriendPresenceSnapshot[]) => {
      setPresences(prev => {
        const next = new Map(prev);

        friends.forEach(friend => {
          if (!friend?.id) return;

          next.set(friend.id, {
            status: friend.status || 'offline',
            lastActive: friend.last_active || null,
          });
        });

        return next;
      });
    };

    const syncPresenceFromFriends = async () => {
      try {
        const res = await fetchWithAuth('/api/friends');
        if (!res.ok) return;

        const data = await res.json();
        if (cancelled || !Array.isArray(data?.friends)) return;

        applyPresenceSnapshot(data.friends);
      } catch (err) {
        console.error('Failed to refresh presence snapshot:', err);
      }
    };

    // READY event includes initial friend presences
    const handleReady = (data: {
      presences?: Array<{ user_id: string; status: PresenceStatus; last_active?: number }>;
    }) => {
      if (data.presences) {
        setPresences(prev => {
          const next = new Map(prev);
          data.presences!.forEach(p => {
            next.set(p.user_id, {
              status: p.status,
              lastActive: p.last_active || null,
            });
          });
          return next;
        });
      }

      void syncPresenceFromFriends();
    };

    // Real-time presence updates
    const handlePresenceUpdate = (data: {
      user_id: string;
      status: PresenceStatus;
      last_active?: number;
    }) => {
      setPresences(prev => {
        const next = new Map(prev);
        next.set(data.user_id, {
          status: data.status,
          lastActive: data.last_active || null,
        });
        return next;
      });
    };

    // New friend accepted — set their presence
    const handleFriendAccept = (data: {
      friend: { id: string; status?: string; last_active?: number | null };
    }) => {
      if (data.friend.status) {
        setPresences(prev => {
          const next = new Map(prev);
          next.set(data.friend.id, {
            status: (data.friend.status as PresenceStatus) || 'offline',
            lastActive: data.friend.last_active || Date.now(),
          });
          return next;
        });
      }
    };

    const handleResumed = () => {
      void syncPresenceFromFriends();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void syncPresenceFromFriends();
      }
    };

    void syncPresenceFromFriends();

    const refreshInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void syncPresenceFromFriends();
      }
    }, PRESENCE_REFRESH_INTERVAL_MS);

    gateway.on('READY', handleReady);
    gateway.on('RESUMED', handleResumed);
    gateway.on('PRESENCE_UPDATE', handlePresenceUpdate);
    gateway.on('FRIEND_ACCEPT', handleFriendAccept);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(refreshInterval);
      gateway.off('READY', handleReady);
      gateway.off('RESUMED', handleResumed);
      gateway.off('PRESENCE_UPDATE', handlePresenceUpdate);
      gateway.off('FRIEND_ACCEPT', handleFriendAccept);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user]);

  return (
    <PresenceContext.Provider value={{ presences, getPresence }}>
      {children}
    </PresenceContext.Provider>
  );
}

export function usePresence() {
  const context = useContext(PresenceContext);
  if (!context) throw new Error('usePresence must be used within PresenceProvider');
  return context;
}
