import { createContext, useContext, useState, useEffect, useCallback, ReactNode, useRef } from 'react';
import { useUser } from '../../Auth/UserContext';
import { gateway } from '../../Gateway/gateway';
import { chatCryptoProtocolService } from '../../Crypto/protocols/chatCryptoProtocolService';
import { fetchAppBootstrap } from '../../bootstrap';
import {
  getFriends as getFriendsApi,
  removeFriend as removeFriendApi,
} from '../../api/friendsApi';
import type { Friend } from '../../api/friendsApi';

export type { Friend } from '../../api/friendsApi';

const FRIENDS_RESYNC_MIN_GAP_MS = 60_000;

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface FriendsContextType {
  friends: Friend[];
  loading: boolean;
  error: string | null;
  removeFriend: (friendshipId: number) => Promise<{ success: boolean; error?: string }>;
  refreshFriends: () => Promise<void>;
}

const FriendsContext = createContext<FriendsContextType | null>(null);

export function FriendsProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasFetched = useRef(false);
  const lastFetchAtRef = useRef(0);
  const fetchInFlightRef = useRef<Promise<void> | null>(null);

  const fetchFriends = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && fetchInFlightRef.current) {
      return fetchInFlightRef.current;
    }

    if (
      !force &&
      hasFetched.current &&
      now - lastFetchAtRef.current < FRIENDS_RESYNC_MIN_GAP_MS
    ) {
      return;
    }

    const task = (async () => {
      try {
        setLoading(true);
        setError(null);

        if (!hasFetched.current) {
          const bootstrap = await fetchAppBootstrap();
          const bootstrapFriends = bootstrap?.friends;
          if (bootstrap?.user?.id === user?.id && Array.isArray(bootstrapFriends)) {
            setFriends(bootstrapFriends);
            hasFetched.current = true;
            lastFetchAtRef.current = Date.now();
            return;
          }
        }

        const apiFriends = await getFriendsApi();
        setFriends(apiFriends);
        hasFetched.current = true;
        lastFetchAtRef.current = Date.now();
      } catch (err: unknown) {
        setError(getErrorMessage(err, 'Failed to fetch friends'));
      } finally {
        setLoading(false);
        fetchInFlightRef.current = null;
      }
    })();

    fetchInFlightRef.current = task;
    return task;
  }, [user?.id]);

  const removeFriend = async (friendshipId: number) => {
    try {
      await removeFriendApi(friendshipId);
      setFriends(prev => prev.filter(f => f.friendship_id !== friendshipId));
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err, 'Failed to remove friend') };
    }
  };

  useEffect(() => {
    if (!user) {
      setFriends([]);
      hasFetched.current = false;
      lastFetchAtRef.current = 0;
      fetchInFlightRef.current = null;
      return;
    }

    if (!hasFetched.current) {
      void fetchFriends(true);
    }

    // PROFILE_UPDATE: Update specific friend in cache
    const handleProfileUpdate = (data: {
      user_id: string;
      profile_id: string;
      display_name?: string;
      avatar_url?: string;
      bio?: string;
    }) => {
      setFriends(prev =>
        prev.map(f =>
          f.id === data.user_id
            ? {
              ...f,
              display_name: data.display_name ?? f.display_name,
              avatar_url: data.avatar_url ?? f.avatar_url,
              bio: data.bio ?? f.bio,
            }
            : f
        )
      );
    };

    // FRIEND_ACCEPT: Add new friend to cache
    const handleFriendAccept = (data: {
      friendship_id: number;
      friend: {
        id: string;
        username: string;
        profile_id: string;
        display_name: string | null;
        avatar_url: string | null;
        bio: string | null;
        member_since: string | null;
        status?: 'online' | 'idle' | 'offline';
        last_active?: number | null;
      };
    }) => {
      setFriends(prev => {
        if (prev.some(f => f.friendship_id === data.friendship_id)) return prev;

        return [
          ...prev,
          {
            friendship_id: data.friendship_id,
            friends_since: new Date().toISOString(),
            id: data.friend.id,
            username: data.friend.username,
            profile_id: data.friend.profile_id,
            display_name: data.friend.display_name,
            avatar_url: data.friend.avatar_url,
            bio: data.friend.bio,
            member_since: data.friend.member_since,
            status: data.friend.status,
            last_active: data.friend.last_active,
          },
        ];
      });

      if (user?.id && typeof data?.friend?.id === 'string' && data.friend.id.length > 0) {
        // Best-effort warmup for both accepter and requester clients.
        void chatCryptoProtocolService.preWarmForDm(user.id, data.friend.id);
      }
    };

    // FRIEND_REMOVE: Remove from cache
    const handleFriendRemove = (data: { friendship_id: number }) => {
      setFriends(prev => prev.filter(f => f.friendship_id !== data.friendship_id));
    };

    gateway.on('PROFILE_UPDATE', handleProfileUpdate);
    gateway.on('FRIEND_ACCEPT', handleFriendAccept);
    gateway.on('FRIEND_REMOVE', handleFriendRemove);

    const handleResumed = () => {
      void fetchFriends();
    };
    gateway.on('RESUMED', handleResumed);

    return () => {
      gateway.off('PROFILE_UPDATE', handleProfileUpdate);
      gateway.off('FRIEND_ACCEPT', handleFriendAccept);
      gateway.off('FRIEND_REMOVE', handleFriendRemove);
      gateway.off('RESUMED', handleResumed);
    };
  }, [user, fetchFriends]);

  return (
    <FriendsContext.Provider value={{
      friends,
      loading,
      error,
      removeFriend,
      refreshFriends: fetchFriends,
    }}>
      {children}
    </FriendsContext.Provider>
  );
}

export function useFriends() {
  const context = useContext(FriendsContext);
  if (!context) throw new Error('useFriends must be used within FriendsProvider');
  return context;
}
