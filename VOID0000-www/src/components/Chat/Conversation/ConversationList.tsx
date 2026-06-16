// src/components/Chat/Conversation/ConversationList.tsx
import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { MessageCircle, Users, Plus, Search } from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import { Conversation, getConversations, markAsRead, closeDM, muteDM } from '../../../Services/Chat/chatService';
import {
  applyLiveMessageDeletePreview,
  applyLiveMessageEditPreview,
  applyLiveMessagePreview,
  getConversationPreview,
  hydrateConversationPreviewsFromStore,
  subscribeConversationPreviewCache,
} from '../../../Services/Chat/conversationPreviewCache';
import {
  playIncomingMessageSound,
  primeIncomingMessageSound,
} from '../../../Services/Chat/messageNotificationSound';
import { debugLog } from '../../../Services/utils/debugLog';
import { usePresence } from '../../../Services/hooks/Friends/usePresence';
import PresenceDot from '../../common/PresenceDot';
import { gateway } from '../../../Services/Gateway/gateway';
import { ConversationItemSkeleton } from '../../common/Skeleton';
import UserAvatar from '../../common/UserAvatar';
import MessagePreviewText from '../Messages/MessagePreviewText';

interface ConversationListProps {
  activeId: string | null;
  onSelect: (conversation: Conversation) => void;
  onCreateGroup: () => void;
  filter: 'dm' | 'group';
  friends: any[];
  refreshTrigger?: number;
  bumpConversationId?: string | null;
  currentUserId?: string | null;
}

const CONVERSATION_LIST_CACHE_TTL_MS = 60_000;
const GATEWAY_CONVERSATION_RESYNC_GAP_MS = 15_000;

const conversationListCache = new Map<string, {
  conversations: Conversation[];
  updatedAt: number;
}>();

const conversationListRequests = new Map<string, Promise<Conversation[]>>();

function getConversationListCacheKey(userId: string | null | undefined): string | null {
  return userId || null;
}

function readCachedConversationList(userId: string | null | undefined): Conversation[] | null {
  const cacheKey = getConversationListCacheKey(userId);
  if (!cacheKey) return null;

  const cached = conversationListCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.updatedAt > CONVERSATION_LIST_CACHE_TTL_MS) return null;
  return cached.conversations;
}

function writeCachedConversationList(
  userId: string | null | undefined,
  conversations: Conversation[],
): void {
  const cacheKey = getConversationListCacheKey(userId);
  if (!cacheKey) return;

  conversationListCache.set(cacheKey, {
    conversations,
    updatedAt: Date.now(),
  });
}

async function fetchConversationList(
  userId: string | null | undefined,
  force = false,
): Promise<Conversation[]> {
  const cacheKey = getConversationListCacheKey(userId);

  if (!force) {
    const cached = readCachedConversationList(userId);
    if (cached) return cached;
  }

  if (!cacheKey) {
    return getConversations();
  }

  const existingRequest = conversationListRequests.get(cacheKey);
  if (!force && existingRequest) {
    return existingRequest;
  }

  const request = getConversations()
    .then((conversations) => {
      writeCachedConversationList(userId, conversations);
      return conversations;
    })
    .finally(() => {
      conversationListRequests.delete(cacheKey);
    });

  conversationListRequests.set(cacheKey, request);
  return request;
}

const ConversationList = ({
  activeId,
  onSelect,
  onCreateGroup,
  filter,
  friends,
  refreshTrigger,
  bumpConversationId,
  currentUserId,
}: ConversationListProps) => {
  const cachedInitialConversations = readCachedConversationList(currentUserId);
  const [conversations, setConversations] = useState<Conversation[]>(() => cachedInitialConversations || []);
  const [loading, setLoading] = useState(!cachedInitialConversations);
  const [search, setSearch] = useState('');
  const [, setPreviewVersion] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ conv: Conversation; x: number; y: number } | null>(null);
  const knownIdsRef = useRef<Set<string>>(new Set());
  const conversationsRef = useRef<Conversation[]>([]);
  const activeIdRef = useRef<string | null>(activeId);
  const currentUserIdRef = useRef<string | null>(currentUserId || null);
  const friendsRef = useRef(friends);
  const readReceiptInFlightRef = useRef<Set<string>>(new Set());
  const lastGatewayResyncAtRef = useRef(0);
  // Tracks muted_until per conversation ID. Survives the conversation being
  // removed from the list (e.g. after Close Chat or DM_HIDDEN), so the sound
  // gate still works for hidden-but-muted DMs.
  const mutedUntilMapRef = useRef<Map<string, string | null>>(new Map());

  const { getPresence } = usePresence();

  const commitConversations = (value: SetStateAction<Conversation[]>) => {
    setConversations((prev) => {
      const next = typeof value === 'function'
        ? (value as (previous: Conversation[]) => Conversation[])(prev)
        : value;
      writeCachedConversationList(currentUserIdRef.current, next);
      return next;
    });
  };

  useEffect(() => {
    conversationsRef.current = conversations;
    knownIdsRef.current = new Set(conversations.map((c) => c.id));
    // Keep muted_until map in sync. We never delete entries here so that
    // the mute state survives a conversation being hidden from the list.
    conversations.forEach((c) => {
      mutedUntilMapRef.current.set(c.id, c.muted_until ?? null);
    });
  }, [conversations]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    currentUserIdRef.current = currentUserId || null;
  }, [currentUserId]);

  useEffect(() => {
    friendsRef.current = friends;
  }, [friends]);

  useEffect(() => subscribeConversationPreviewCache(() => {
    setPreviewVersion((value) => value + 1);
  }), []);

  // Close context menu on any mousedown outside of it.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [contextMenu]);

  useEffect(() => {
    primeIncomingMessageSound();
  }, []);

  useEffect(() => {
    if (conversations.length === 0) return;
    void hydrateConversationPreviewsFromStore(
      conversations.map((conversation) => conversation.id),
      currentUserId || null,
    );
  }, [conversations, currentUserId]);

  const loadConversations = async (options?: { force?: boolean }) => {
    try {
      const convos = await fetchConversationList(currentUserIdRef.current, options?.force === true);
      commitConversations(convos);
    } catch (err) {
      console.error('Failed to load conversations:', err);
    } finally {
      setLoading(false);
    }
  };

  const markConversationAsRead = async (
    conversationId: string,
    routeId: string,
    messageId: string,
  ) => {
    const requestKey = `${conversationId}:${messageId}`;
    if (readReceiptInFlightRef.current.has(requestKey)) return;

    readReceiptInFlightRef.current.add(requestKey);
    commitConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              unread_count: 0,
              last_read_message_id: messageId,
            }
          : conversation
      )
    );

    try {
      await markAsRead(routeId, messageId);
    } catch (err) {
      console.error('Failed to mark conversation as read:', err);
      void loadConversations({ force: true });
    } finally {
      readReceiptInFlightRef.current.delete(requestKey);
    }
  };

  useEffect(() => {
    void loadConversations();
  }, [currentUserId]);

  useEffect(() => {
    if (refreshTrigger) {
      void loadConversations({ force: true });
    }
  }, [refreshTrigger]);

  useEffect(() => {
    if (!bumpConversationId) return;
    commitConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === bumpConversationId);
      if (idx <= 0) return prev;
      const next = [...prev];
      const moved = next.splice(idx, 1)[0] as Conversation;
      next.unshift(moved);
      return next;
    });
  }, [bumpConversationId]);

  useEffect(() => {
    const activeConversation = conversations.find((conversation) => conversation.id === activeId);
    if (!activeConversation || !activeConversation.last_message_id || (activeConversation.unread_count ?? 0) <= 0) {
      return;
    }

    const routeId = activeConversation.public_id || activeConversation.id;
    void markConversationAsRead(activeConversation.id, routeId, activeConversation.last_message_id);
  }, [activeId, conversations]);

  useEffect(() => {
    const handleMessageCreate = (data: any) => {
      const conversationId = data?.conversation_id;
      if (!conversationId) return;

      const currentUserIdValue = currentUserIdRef.current;
      const activeConversationId = activeIdRef.current;
      const isSender = Boolean(currentUserIdValue && data?.sender_id === currentUserIdValue);
      const shouldPlayIncomingSound = !isSender
        && (document.visibilityState === 'hidden' || activeConversationId !== conversationId);

      if (shouldPlayIncomingSound) {
        const mutedUntil = mutedUntilMapRef.current.get(conversationId);
        const isMuted = !!mutedUntil && new Date(mutedUntil) > new Date();
        if (!isMuted) {
          void playIncomingMessageSound();
        }
      }

      if (!knownIdsRef.current.has(conversationId)) {
        void loadConversations({ force: true });
        return;
      }

      const knownConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId);
      const nextMessageId = typeof data?.message_id === 'string' ? data.message_id : null;

      commitConversations((prev) => {
        const idx = prev.findIndex((conversation) => conversation.id === conversationId);
        if (idx === -1) return prev;

        const next = [...prev];
        const conversation = next.splice(idx, 1)[0] as Conversation;
        const isActiveConversation = activeConversationId === conversationId;
        const unreadCount = isSender || isActiveConversation
          ? 0
          : Math.max(0, (conversation.unread_count ?? 0) + 1);

        next.unshift({
          ...conversation,
          updated_at: data?.created_at || new Date().toISOString(),
          unread_count: unreadCount,
          last_message_id: nextMessageId || conversation.last_message_id || null,
          last_message_sender_id: data?.sender_id || conversation.last_message_sender_id || null,
          last_read_message_id: isSender
            ? nextMessageId || conversation.last_read_message_id
            : conversation.last_read_message_id,
        });

        return next;
      });

      if (!isSender && activeConversationId === conversationId && nextMessageId && knownConversation) {
        const routeId = knownConversation.public_id || knownConversation.id;
        void markConversationAsRead(knownConversation.id, routeId, nextMessageId);
      }

      void applyLiveMessagePreview(data, currentUserIdValue).catch((error) => {
        console.warn('[CONVERSATION_LIST] failed to update live preview', error);
      });
    };

    const handleConversationUpdate = (data: any) => {
      const updated = data?.conversation as Conversation | undefined;
      if (!updated?.id) return;

      if (!knownIdsRef.current.has(updated.id)) {
        void loadConversations({ force: true });
        return;
      }

      commitConversations((prev) =>
        prev.map((conversation) => (conversation.id === updated.id ? { ...conversation, ...updated } : conversation))
      );
    };

    const handleMessageUpdate = (data: any) => {
      const conversationId = data?.conversation_id;
      if (!conversationId || !knownIdsRef.current.has(conversationId)) return;

      void applyLiveMessageEditPreview(data, currentUserIdRef.current).catch((error) => {
        console.warn('[CONVERSATION_LIST] failed to update edited preview', error);
      });
    };

    const handleMessageDelete = (data: any) => {
      const conversationId = data?.conversation_id;
      if (!conversationId || !knownIdsRef.current.has(conversationId)) return;

      void applyLiveMessageDeletePreview(data, currentUserIdRef.current).catch((error) => {
        console.warn('[CONVERSATION_LIST] failed to update deleted preview', error);
      });
    };

    const handleMemberLeave = (data: any) => {
      const conversationId = data?.conversation_id;
      const userId = data?.user_id || data?.member_user_id || data?.target_user_id || null;
      if (!conversationId) return;

      commitConversations((prev) =>
        prev
          .filter((conversation) => !(conversation.id === conversationId && userId == null))
          .map((conversation) =>
            conversation.id === conversationId
              ? { ...conversation, member_count: Math.max(0, (conversation.member_count ?? 1) - 1) }
              : conversation
          )
      );
    };

    const handleGatewayResync = () => {
      const now = Date.now();
      if (now - lastGatewayResyncAtRef.current < GATEWAY_CONVERSATION_RESYNC_GAP_MS) {
        return;
      }
      lastGatewayResyncAtRef.current = now;
      debugLog('[WS_RESYNC] refreshing conversation list after gateway resume/ready');
      void loadConversations();
    };

    const handleDmHidden = (data: any) => {
      const conversationId = data?.conversation_id;
      if (!conversationId) return;
      commitConversations((prev) => prev.filter((c) => c.id !== conversationId));
    };

    const handleMemberNicknameUpdate = (data: any) => {
      const targetUserId = data?.user_id;
      const eventConversationId = data?.conversation_id;
      const eventConversationPublicId = data?.conversation_public_id || null;
      const nickname =
        typeof data?.nickname === 'string' && data.nickname.trim().length > 0
          ? data.nickname.trim()
          : null;
      const currentUserIdValue = currentUserIdRef.current;

      if (!targetUserId || !currentUserIdValue || targetUserId === currentUserIdValue) {
        return;
      }

      commitConversations((prev) =>
        prev.map((conversation) => {
          if (conversation.type !== 'dm') {
            return conversation;
          }

          const matchesPeer =
            (eventConversationId && conversation.id === eventConversationId) ||
            (eventConversationPublicId &&
              conversation.public_id &&
              String(conversation.public_id) === String(eventConversationPublicId)) ||
            (conversation.dm_user_id && conversation.dm_user_id === targetUserId) ||
            false;

          if (!matchesPeer) {
            return conversation;
          }

          const friend = friendsRef.current.find((entry) => entry.id === targetUserId) || null;
          return {
            ...conversation,
            dm_display_name:
              nickname ||
              friend?.display_name ||
              friend?.username ||
              conversation.dm_username ||
              conversation.dm_display_name,
          };
        }),
      );
    };

    gateway.on('MESSAGE_CREATE', handleMessageCreate);
    gateway.on('MESSAGE_UPDATE', handleMessageUpdate);
    gateway.on('MESSAGE_DELETE', handleMessageDelete);
    gateway.on('CONVERSATION_UPDATE', handleConversationUpdate);
    gateway.on('MEMBER_LEAVE', handleMemberLeave);
    gateway.on('MEMBER_NICKNAME_UPDATE', handleMemberNicknameUpdate);
    gateway.on('READY', handleGatewayResync);
    gateway.on('RESUMED', handleGatewayResync);
    gateway.on('DM_HIDDEN', handleDmHidden);

    return () => {
      gateway.off('MESSAGE_CREATE', handleMessageCreate);
      gateway.off('MESSAGE_UPDATE', handleMessageUpdate);
      gateway.off('MESSAGE_DELETE', handleMessageDelete);
      gateway.off('CONVERSATION_UPDATE', handleConversationUpdate);
      gateway.off('MEMBER_LEAVE', handleMemberLeave);
      gateway.off('MEMBER_NICKNAME_UPDATE', handleMemberNicknameUpdate);
      gateway.off('READY', handleGatewayResync);
      gateway.off('RESUMED', handleGatewayResync);
      gateway.off('DM_HIDDEN', handleDmHidden);
    };
  }, []);

  const tabFilteredConversations = conversations.filter((conversation) => conversation.type === filter);

  const searchFiltered = search.trim()
    ? tabFilteredConversations.filter((conversation) => {
        const name = conversation.type === 'dm'
          ? (conversation.dm_display_name || conversation.dm_username || '')
          : (conversation.name || '');
        return name.toLowerCase().includes(search.toLowerCase());
      })
    : tabFilteredConversations;

  const getDisplayName = (conversation: Conversation) => {
    if (conversation.type === 'dm') {
      return conversation.dm_display_name || conversation.dm_username || 'Unknown';
    }
    return conversation.name || 'Unnamed';
  };

  const getAvatar = (conversation: Conversation) => {
    if (conversation.type === 'dm' && conversation.dm_avatar_url) {
      return conversation.dm_avatar_url;
    }
    if (conversation.type === 'group' && conversation.icon_url) {
      return conversation.icon_url;
    }
    return null;
  };

  const getPreview = (conversation: Conversation) => {
    const preview = getConversationPreview(conversation.id);
    return preview || null;
  };

  const getInitial = (name: string | null | undefined) => {
    const trimmed = name?.trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '#';
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'dm':
        return <MessageCircle className="w-4 h-4 opacity-60" />;
      case 'group':
        return <Users className="w-4 h-4 opacity-60" />;
      default:
        return null;
    }
  };

  const handleCloseChat = async (conv: Conversation) => {
    setContextMenu(null);
    commitConversations((prev) => prev.filter((c) => c.id !== conv.id));
    try {
      await closeDM(conv.id);
    } catch (err) {
      console.error('Failed to close DM:', err);
      void loadConversations({ force: true });
    }
  };

  const handleToggleMute = async (conv: Conversation) => {
    setContextMenu(null);
    const isMuted = !!conv.muted_until && new Date(conv.muted_until) > new Date();
    const nextMutedUntil = isMuted ? null : '2099-12-31T23:59:59Z';
    // Write to the ref first so the sound gate picks it up immediately,
    // even before the state update propagates.
    mutedUntilMapRef.current.set(conv.id, nextMutedUntil);
    commitConversations((prev) =>
      prev.map((c) => c.id === conv.id ? { ...c, muted_until: nextMutedUntil } : c)
    );
    try {
      await muteDM(conv.id, !isMuted);
    } catch (err) {
      console.error('Failed to update DM mute:', err);
      void loadConversations({ force: true });
    }
  };

  const ConvItem = ({ conv }: { conv: Conversation }) => {
    const isActive = activeId === conv.id;
    const avatar = getAvatar(conv);
    const preview = getPreview(conv);
    const unreadCount = Math.max(0, conv.unread_count ?? 0);
    const unreadLabel = unreadCount > 99 ? '99+' : String(unreadCount);
    const hasUnread = unreadCount > 0 && !isActive;
    const isMuted = !!conv.muted_until && new Date(conv.muted_until) > new Date();

    const friend = conv.type === 'dm'
      ? friends.find((friendItem) => friendItem.username === conv.dm_username)
      : null;

    const presence = friend
      ? getPresence(friend.id || friend.user_id || friend.profile_id)
      : { status: 'offline' as const };

    const handleContextMenu = (e: React.MouseEvent) => {
      if (conv.type !== 'dm') return;
      e.preventDefault();
      setContextMenu({ conv, x: e.clientX, y: e.clientY });
    };

    return (
      <button
        onClick={() => onSelect(conv)}
        onContextMenu={handleContextMenu}
        className={`w-full flex items-center gap-2.5 border-b border-void-bg-hover/75 px-3 py-2.5 text-left transition-colors last:border-b-0 active:bg-void-bg-hover/70 md:rounded-md md:border-b-0 md:px-2 md:py-1.5 ${
          isActive
            ? 'bg-void-bg-hover text-void-text'
            : 'text-void-text-muted hover:bg-void-bg-hover/60 hover:text-void-text'
        }`}
      >
        <div className="relative shrink-0">
          {conv.type === 'dm' ? (
            <UserAvatar
              src={avatar}
              displayName={conv.dm_display_name}
              username={conv.dm_username}
              className="w-8 h-8 rounded-full shrink-0"
              fallbackClassName="text-xs"
            />
          ) : avatar ? (
            <img src={avatar} className="w-8 h-8 rounded-full object-cover shrink-0" alt="" />
          ) : conv.type === 'group' ? (
            <div className="w-8 h-8 rounded-full bg-void-accent/15 text-void-accent flex items-center justify-center shrink-0 text-xs font-semibold">
              {getInitial(conv.name)}
            </div>
          ) : (
            <div className="w-8 h-8 rounded-full bg-void-bg-hover flex items-center justify-center shrink-0">
              {getIcon(conv.type)}
            </div>
          )}

          {conv.type === 'dm' && (
            <div className="absolute bottom-0 right-0 translate-x-1/4 translate-y-1/4 z-10">
              <PresenceDot
                status={presence.status as 'online' | 'idle' | 'offline'}
                size="sm"
              />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 text-left">
          <div className={`truncate text-sm ${hasUnread ? 'font-semibold text-void-text' : 'font-medium text-void-text'}`}>
            {getDisplayName(conv)}
          </div>
          {preview && (
            <div className={`truncate text-xs ${hasUnread ? 'text-void-text/90' : 'text-void-text-muted'}`}>
              <MessagePreviewText content={preview} fallback="" maxLength={60} />
            </div>
          )}
        </div>

        <div className="ml-auto shrink-0 flex items-center gap-1">
          {isMuted && (
            <svg className="w-3 h-3 text-void-text-muted opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          )}
          {unreadCount > 0 && (
            <span className="inline-flex min-w-[1.35rem] justify-center rounded-full bg-void-accent px-1.5 py-0.5 text-[10px] font-bold leading-none text-white shadow-sm">
              {unreadLabel}
            </span>
          )}
        </div>
      </button>
    );
  };

  if (loading) {
    return (
      <div className="flex-1 py-2 px-2 space-y-0.5">
        {[...Array(6)].map((_, i) => <ConversationItemSkeleton key={i} />)}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-2 py-2">
      <div className="px-1 mb-3 shrink-0">
        <div className="flex items-center bg-void-bg-hover/50 rounded-md px-2 py-1.5">
          <Search className="w-3.5 h-3.5 text-void-text-muted mr-1.5" />
          <input
            type="text"
            placeholder={`Search ${filter === 'dm' ? 'DMs' : 'Groups'}...`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent text-sm w-full focus:outline-none text-void-text placeholder-void-text-muted"
          />
        </div>
      </div>

      <div className="flex items-center justify-between px-3 mb-2 shrink-0">
        <p className="text-xs font-bold text-void-text-muted uppercase tracking-wider">
          {filter === 'dm' ? 'Direct Messages' : 'Your Groups'}
        </p>

        {filter === 'group' && (
          <button
            onClick={onCreateGroup}
            className="text-void-text-muted hover:text-void-text transition-colors p-1 hover:bg-void-bg-hover rounded-md"
            title="Create new group"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 bg-void-bg-sec/20 md:bg-transparent">
        {searchFiltered.length === 0 ? (
          <div className="text-center px-4 py-8">
            <p className="text-sm text-void-text-muted">
              {search.trim()
                ? 'No results found'
                : `No ${filter === 'dm' ? 'DMs' : 'groups'} yet.`}
            </p>
          </div>
        ) : (
          <Virtuoso
            data={searchFiltered}
            className="h-full"
            computeItemKey={(_index, conversation) => conversation.id}
            overscan={320}
            itemContent={(_index, conv) => <ConvItem conv={conv} />}
          />
        )}
      </div>

      {contextMenu && (
        <div
          className="fixed z-50 min-w-[160px] rounded-md border border-void-border bg-void-bg-secondary py-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="w-full px-3 py-1.5 text-left text-sm text-void-text-muted hover:bg-void-bg-hover hover:text-void-text transition-colors"
            onClick={() => handleCloseChat(contextMenu.conv)}
          >
            Close Chat
          </button>
          <button
            className="w-full px-3 py-1.5 text-left text-sm text-void-text-muted hover:bg-void-bg-hover hover:text-void-text transition-colors"
            onClick={() => handleToggleMute(contextMenu.conv)}
          >
            {contextMenu.conv.muted_until && new Date(contextMenu.conv.muted_until) > new Date()
              ? `Unmute ${getDisplayName(contextMenu.conv)}`
              : `Mute ${getDisplayName(contextMenu.conv)}`}
          </button>
        </div>
      )}
    </div>
  );
};

export default ConversationList;
