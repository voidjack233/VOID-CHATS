import { createContext, useContext, useState, useEffect, useCallback, ReactNode, useRef } from 'react';
import { useUser } from '../../Auth/UserContext';
import { gateway } from '../../Gateway/gateway';
import { fetchWithAuth } from '../../Auth/authServiceApi';

type PresenceStatus = 'online' | 'idle' | 'offline';
const PRESENCE_STARTUP_FALLBACK_DELAY_MS = 1_500;

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
const PRESENCE_MIN_SYNC_GAP_MS = 10_000;

export function PresenceProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const [presences, setPresences] = useState<Map<string, Presence>>(new Map());
  const lastSyncAtRef = useRef(0);
  const syncInFlightRef = useRef<Promise<void> | null>(null);

  const getPresence = useCallback((userId: string): Presence => {
    return presences.get(userId) || { status: 'offline', lastActive: null };
  }, [presences]);

  useEffect(() => {
    let cancelled = false;
    let startupFallbackTimer: number | null = null;

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

    const syncPresenceFromFriends = async (force = false) => {
      const now = Date.now();
      if (syncInFlightRef.current) return syncInFlightRef.current;
      if (!force && now - lastSyncAtRef.current < PRESENCE_MIN_SYNC_GAP_MS) return;

      const task = (async () => {
        try {
          const res = await fetchWithAuth('/api/friends/presence');
          if (!res.ok) return;

          const data = await res.json();
          if (cancelled || !Array.isArray(data?.presences)) return;

          applyPresenceSnapshot(
            data.presences.map((presence: { user_id: string; status?: PresenceStatus; last_active?: number | null }) => ({
              id: presence.user_id,
              status: presence.status,
              last_active: presence.last_active,
            }))
          );
          lastSyncAtRef.current = Date.now();
        } catch (err) {
          console.error('Failed to refresh presence snapshot:', err);
        } finally {
          syncInFlightRef.current = null;
        }
      })();

      syncInFlightRef.current = task;
      return task;
    };

    // READY event includes initial friend presences
    const handleReady = (data: {
      presences?: Array<{ user_id: string; status: PresenceStatus; last_active?: number }>;
    }) => {
      if (Array.isArray(data.presences)) {
        applyPresenceSnapshot(data.presences.map((presence) => ({
          id: presence.user_id,
          status: presence.status,
          last_active: presence.last_active,
        })));
        lastSyncAtRef.current = Date.now();

        if (startupFallbackTimer !== null) {
          window.clearTimeout(startupFallbackTimer);
          startupFallbackTimer = null;
        }
      }
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
      void syncPresenceFromFriends(true);
    };

    // READY normally supplies the initial snapshot. Keep one delayed HTTP
    // fallback for providers that mount after READY has already fired.
    startupFallbackTimer = window.setTimeout(() => {
      startupFallbackTimer = null;
      void syncPresenceFromFriends();
    }, PRESENCE_STARTUP_FALLBACK_DELAY_MS);

    gateway.on('READY', handleReady);
    gateway.on('RESUMED', handleResumed);
    gateway.on('PRESENCE_UPDATE', handlePresenceUpdate);
    gateway.on('FRIEND_ACCEPT', handleFriendAccept);

    return () => {
      cancelled = true;
      if (startupFallbackTimer !== null) {
        window.clearTimeout(startupFallbackTimer);
      }
      gateway.off('READY', handleReady);
      gateway.off('RESUMED', handleResumed);
      gateway.off('PRESENCE_UPDATE', handlePresenceUpdate);
      gateway.off('FRIEND_ACCEPT', handleFriendAccept);
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
