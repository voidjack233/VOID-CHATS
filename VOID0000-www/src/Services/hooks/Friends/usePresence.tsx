import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { gateway } from '../../Gateway/gateway';

type PresenceStatus = 'online' | 'idle' | 'offline';

interface Presence {
  status: PresenceStatus;
  lastActive: number | null;
}

interface PresenceContextType {
  presences: Map<string, Presence>;
  getPresence: (userId: string) => Presence;
}

const PresenceContext = createContext<PresenceContextType | null>(null);

export function PresenceProvider({ children }: { children: ReactNode }) {
  const [presences, setPresences] = useState<Map<string, Presence>>(new Map());

  const getPresence = useCallback((userId: string): Presence => {
    return presences.get(userId) || { status: 'offline', lastActive: null };
  }, [presences]);

  useEffect(() => {
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
      friend: { id: string; status?: string };
    }) => {
      if (data.friend.status) {
        setPresences(prev => {
          const next = new Map(prev);
          next.set(data.friend.id, {
            status: (data.friend.status as PresenceStatus) || 'offline',
            lastActive: Date.now(),
          });
          return next;
        });
      }
    };

    gateway.on('READY', handleReady);
    gateway.on('PRESENCE_UPDATE', handlePresenceUpdate);
    gateway.on('FRIEND_ACCEPT', handleFriendAccept);

    return () => {
      gateway.off('READY', handleReady);
      gateway.off('PRESENCE_UPDATE', handlePresenceUpdate);
      gateway.off('FRIEND_ACCEPT', handleFriendAccept);
    };
  }, []);

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