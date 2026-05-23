import { createContext, useContext, useState, useEffect, useCallback, ReactNode, useMemo, useRef } from 'react';
import { API_URL } from '../../config';
import { ensureCSRFToken } from '../../Auth/authServiceApi';
import { useUser } from '../../Auth/UserContext'; 
import { gateway } from '../../Gateway/gateway';
import { chatCryptoProtocolService } from '../../Crypto/protocols/chatCryptoProtocolService';
import { fetchAppBootstrap } from '../../bootstrap';

export interface FriendRequest {
  friendship_id: number;
  created_at: string;
  id: string;
  username: string;
  profile_id: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface OutgoingRequest {
  friendship_id: number;
  created_at: string;
  id: string;
  username: string;
  profile_id: string;
  display_name: string | null;
  avatar_url: string | null;
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

      const [inRes, outRes] = await Promise.all([
        fetch(`${API_URL}/api/friends/requests/incoming`, { credentials: 'include' }),
        fetch(`${API_URL}/api/friends/requests/outgoing`, { credentials: 'include' }),
      ]);
      const [inData, outData] = await Promise.all([inRes.json(), outRes.json()]);
      if (inData.success) setIncoming(inData.requests || []);
      if (outData.success) setOutgoing(outData.requests || []);
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
      const csrf = await ensureCSRFToken();
      const res = await fetch(`${API_URL}/api/friends/accept/${friendshipId}`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf || '' },
        credentials: 'include'
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        // Update cache directly
        setIncoming(prev => prev.filter(r => r.friendship_id !== friendshipId));

        const requesterId = data?.friendship?.requester_id;
        if (user?.id && typeof requesterId === 'string' && requesterId.length > 0) {
          // Best-effort warmup for DM crypto bootstrap.
          void chatCryptoProtocolService.preWarmForDm(user.id, requesterId);
        }
        return { success: true };
      }
      return { success: false };
    } catch (err) { return { success: false }; }
  };

  const rejectRequest = async (friendshipId: number) => {
    try {
      const csrf = await ensureCSRFToken();
      const res = await fetch(`${API_URL}/api/friends/reject/${friendshipId}`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf || '' },
        credentials: 'include'
      });
      if (res.ok) {
        setIncoming(prev => prev.filter(r => r.friendship_id !== friendshipId));
        return { success: true };
      }
      return { success: false };
    } catch (err) { return { success: false }; }
  };

  const sendRequest = async (profileId: string) => {
    try {
      const csrf = await ensureCSRFToken();
      const res = await fetch(`${API_URL}/api/friends/request/${profileId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf || ''
        },
        credentials: 'include'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send request');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  };

  const cancelRequest = async (friendshipId: number) => {
    try {
      const csrf = await ensureCSRFToken();
      const res = await fetch(`${API_URL}/api/friends/cancel/${friendshipId}`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf || '' },
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to cancel request');
      setOutgoing(prev => prev.filter(r => r.friendship_id !== friendshipId));
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
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
