import { createContext, useContext, useState, useEffect, useCallback, ReactNode, useMemo, useRef } from 'react';
import { useUser } from '../../Auth/UserContext'; 
import { gateway } from '../../Gateway/gateway';
import { chatCryptoProtocolService } from '../../Crypto/protocols/chatCryptoProtocolService';
import { fetchAppBootstrap } from '../../bootstrap';
import {
  acceptFriendRequest as acceptFriendRequestApi,
  cancelFriendRequest as cancelFriendRequestApi,
  getIncomingFriendRequests,
  getOutgoingFriendRequests,
  rejectFriendRequest as rejectFriendRequestApi,
  sendFriendRequest as sendFriendRequestApi,
} from '../../api/friendsApi';
import type { FriendRequest, OutgoingRequest } from '../../api/friendsApi';

export type { FriendRequest, OutgoingRequest } from '../../api/friendsApi';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface FriendContextType {
  incoming: FriendRequest[];
  outgoing: OutgoingRequest[];
  unreadCount: number;
  loading: boolean;
  acceptRequest: (id: number) => Promise<{ success: boolean }>;
  rejectRequest: (id: number) => Promise<{ success: boolean }>;
  markAsSeen: () => void;
  refreshRequests: () => Promise<void>;
  sendRequest: (profileId: string) => Promise<{ success: boolean; error?: string }>;
  cancelRequest: (friendshipId: number) => Promise<{ success: boolean; error?: string }>;
}

const FriendContext = createContext<FriendContextType | null>(null);

export function FriendProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const hasFetched = useRef(false);
  
  const [lastSeenTime, setLastSeenTime] = useState(() => {
    return localStorage.getItem('void_friends_last_seen') || '0';
  });

  const unreadCount = useMemo(() => {
    if (!incoming.length) return 0;
    const lastSeen = new Date(lastSeenTime).getTime();
    
    return incoming.filter(req => {
      const reqTime = new Date(req.created_at).getTime();
      return reqTime > lastSeen;
    }).length;
  }, [incoming, lastSeenTime]);

  const markAsSeen = () => {
    const now = new Date().toISOString();
    localStorage.setItem('void_friends_last_seen', now);
    setLastSeenTime(now); 
  };

  const fetchRequests = useCallback(async () => {
    if (!user) return;
    try {
      setLoading(true);
      if (!hasFetched.current) {
        const bootstrap = await fetchAppBootstrap();
        if (bootstrap?.user?.id === user.id && bootstrap.friend_requests) {
          setIncoming(bootstrap.friend_requests.incoming || []);
          setOutgoing(bootstrap.friend_requests.outgoing || []);
          hasFetched.current = true;
          return;
        }
      }

      const [incomingRequests, outgoingRequests] = await Promise.all([
        getIncomingFriendRequests(),
        getOutgoingFriendRequests(),
      ]);
      setIncoming(incomingRequests);
      setOutgoing(outgoingRequests);
      hasFetched.current = true;
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  // --- Actions ---
  const acceptRequest = async (friendshipId: number) => {
    try {
      const data = await acceptFriendRequestApi(friendshipId);
      // Update cache directly
      setIncoming(prev => prev.filter(r => r.friendship_id !== friendshipId));

      const requesterId = data?.friendship?.requester_id;
      if (user?.id && typeof requesterId === 'string' && requesterId.length > 0) {
        // Best-effort warmup for DM crypto bootstrap.
        void chatCryptoProtocolService.preWarmForDm(user.id, requesterId);
      }
      return { success: true };
    } catch { return { success: false }; }
  };

  const rejectRequest = async (friendshipId: number) => {
    try {
      await rejectFriendRequestApi(friendshipId);
      setIncoming(prev => prev.filter(r => r.friendship_id !== friendshipId));
      return { success: true };
    } catch { return { success: false }; }
  };

  const sendRequest = async (profileId: string) => {
    try {
      await sendFriendRequestApi(profileId);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err, 'Failed to send request') };
    }
  };

  const cancelRequest = async (friendshipId: number) => {
    try {
      await cancelFriendRequestApi(friendshipId);
      setOutgoing(prev => prev.filter(r => r.friendship_id !== friendshipId));
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err, 'Failed to cancel request') };
    }
  };

  useEffect(() => {
    if (!user) return;

    // Only fetch once
    if (!hasFetched.current) {
      fetchRequests();
    }

    // FRIEND_REQUEST: New request came in — add to cache directly from WS data
    const handleNewRequest = (data: {
      friendship_id: number;
      from: {
        id: string;
        username: string;
        profile_id: string;
        display_name: string | null;
        avatar_url: string | null;
      };
      timestamp: number;
    }) => {
      setIncoming(prev => {
        // Don't add duplicates
        if (prev.some(r => r.friendship_id === data.friendship_id)) return prev;

        return [
          {
            friendship_id: data.friendship_id,
            created_at: new Date(data.timestamp).toISOString(),
            id: data.from.id,
            username: data.from.username,
            profile_id: data.from.profile_id,
            display_name: data.from.display_name,
            avatar_url: data.from.avatar_url,
          },
          ...prev,
        ];
      });
    };

    // FRIEND_ACCEPT: Request was accepted — remove from incoming and outgoing
    const handleAccepted = (data: { friendship_id: number }) => {
      setIncoming(prev => prev.filter(r => r.friendship_id !== data.friendship_id));
      setOutgoing(prev => prev.filter(r => r.friendship_id !== data.friendship_id));
    };

    // FRIEND_REMOVE: Unfriended — remove from incoming if pending
    const handleRemoved = (data: { friendship_id: number }) => {
      setIncoming(prev => prev.filter(r => r.friendship_id !== data.friendship_id));
    };

    gateway.on('FRIEND_REQUEST', handleNewRequest);
    gateway.on('FRIEND_ACCEPT', handleAccepted);
    gateway.on('FRIEND_REMOVE', handleRemoved);

    return () => {
      gateway.off('FRIEND_REQUEST', handleNewRequest);
      gateway.off('FRIEND_ACCEPT', handleAccepted);
      gateway.off('FRIEND_REMOVE', handleRemoved);
    };
  }, [user, fetchRequests]);

  return (
    <FriendContext.Provider value={{
      incoming,
      outgoing,
      unreadCount,
      loading,
      acceptRequest,
      rejectRequest,
      markAsSeen,
      refreshRequests: fetchRequests,
      sendRequest,
      cancelRequest
    }}>
      {children}
    </FriendContext.Provider>
  );
}

export function useFriendRequests() {
  const context = useContext(FriendContext);
  if (!context) throw new Error('useFriendRequests must be used within FriendProvider');
  return context;
}
