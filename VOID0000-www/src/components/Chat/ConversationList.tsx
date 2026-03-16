// src/components/Chat/ConversationList.tsx
import { useState, useEffect, useRef } from 'react';
import { Hash as HashIcon, MessageCircle, Users, Plus, Search } from 'lucide-react';
import { getConversations, getConversation, Conversation } from '../../Services/Chat/chatService';
import { usePresence } from '../../Services/hooks/Friends/usePresence';
import PresenceDot from '../common/PresenceDot';
import { gateway } from '../../Services/Gateway/gateway';
import { ConversationItemSkeleton } from '../common/Skeleton';
import UserAvatar from '../common/UserAvatar';

interface ConversationListProps {
  activeId: string | null;
  onSelect: (conversation: Conversation) => void;
  onCreateGroup: () => void;
  filter: 'dm' | 'group';
  friends: any[];
  refreshTrigger?: number;
  bumpConversationId?: string | null;
}

const ConversationList = ({ activeId, onSelect, onCreateGroup, filter, friends, refreshTrigger, bumpConversationId }: ConversationListProps) => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const knownIdsRef = useRef<Set<string>>(new Set());
  
  const { getPresence } = usePresence();

  // Keep ref in sync
  useEffect(() => {
    knownIdsRef.current = new Set(conversations.map((c) => c.id));
  }, [conversations]);

  // Move a conversation to the top when the parent signals a sent message
  useEffect(() => {
    if (!bumpConversationId) return;
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === bumpConversationId);
      if (idx <= 0) return prev;
      const next = [...prev];
      const moved = next.splice(idx, 1)[0] as Conversation;
      next.unshift(moved);
      return next;
    });
  }, [bumpConversationId]);


  // Initial load
  useEffect(() => {
    loadConversations();
  }, []);

  // Refresh when trigger changes
  useEffect(() => {
    if (refreshTrigger) loadConversations();
  }, [refreshTrigger]);

  // Listen for WebSocket events — patch local state instead of refetching
  useEffect(() => {
    const handleMessageCreate = async (data: any) => {
      const conversationId = data?.conversation_id;
      if (!conversationId) return;

      if (knownIdsRef.current.has(conversationId)) {
        // Existing conversation — move it to the top
        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === conversationId);
          if (idx <= 0) return prev; // already first or not found
          const next = [...prev];
          const moved = next.splice(idx, 1)[0] as Conversation;
          next.unshift(moved);
          return next;
        });
      } else {
        // New conversation — fetch just this one and prepend it
        try {
          const { conversation } = await getConversation(conversationId);
          setConversations((prev) =>
            prev.some((c) => c.id === conversationId) ? prev : [conversation, ...prev]
          );
        } catch {}
      }
    };

    const handleConversationUpdate = async (data: any) => {
      const updated = data?.conversation as Conversation | undefined;
      if (!updated) return;

      const alreadyKnown = knownIdsRef.current.has(updated.id);

      if (alreadyKnown) {
        // Existing conversation — merge the partial update in place
        setConversations((prev) =>
          prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c))
        );
      } else {
        // New conversation (e.g. just approved into a group).
        // The broadcast payload is partial (no name/icon), so fetch the
        // full conversation before adding it to the list.
        try {
          const { conversation } = await getConversation(updated.public_id || updated.id);
          // The single-conversation endpoint doesn't compute member_count;
          // derive it from the members array when it's missing or zero.
          const hydrated: Conversation = {
            ...conversation,
            member_count: conversation.member_count || (conversation as any).members?.length || updated.member_count || 0,
          };
          setConversations((prev) =>
            prev.some((c) => c.id === hydrated.id) ? prev : [hydrated, ...prev]
          );
        } catch {
          // Fallback: use the partial payload so the entry at least appears
          setConversations((prev) =>
            prev.some((c) => c.id === updated.id) ? prev : [updated, ...prev]
          );
        }
      }
    };

    const handleMemberLeave = (data: any) => {
      const conversationId = data?.conversation_id;
      const userId = data?.user_id || data?.member_user_id || data?.target_user_id || null;
      if (!conversationId) return;
      setConversations((prev) =>
        prev
          .filter((c) => !(c.id === conversationId && userId == null))
          .map((c) =>
            c.id === conversationId
              ? { ...c, member_count: Math.max(0, (c.member_count ?? 1) - 1) }
              : c
          )
      );
    };

    gateway.on('MESSAGE_CREATE', handleMessageCreate);
    gateway.on('CONVERSATION_UPDATE', handleConversationUpdate);
    gateway.on('MEMBER_LEAVE', handleMemberLeave);

    return () => {
      gateway.off('MESSAGE_CREATE', handleMessageCreate);
      gateway.off('CONVERSATION_UPDATE', handleConversationUpdate);
      gateway.off('MEMBER_LEAVE', handleMemberLeave);
    };
  }, []);

  const loadConversations = async () => {
    try {
      const convos = await getConversations();
      setConversations(convos);
    } catch (err) {
      console.error('Failed to load conversations:', err);
    } finally {
      setLoading(false);
    }
  };

  const tabFilteredConversations = conversations.filter((c) => c.type === filter);

  const searchFiltered = search.trim()
    ? tabFilteredConversations.filter((c) => {
        const name = c.type === 'dm'
          ? (c.dm_display_name || c.dm_username || '')
          : (c.name || '');
        return name.toLowerCase().includes(search.toLowerCase());
      })
    : tabFilteredConversations;

  const getDisplayName = (conv: Conversation) => {
    if (conv.type === 'dm') {
      return conv.dm_display_name || conv.dm_username || 'Unknown';
    }
    return conv.name || 'Unnamed';
  };

  const getAvatar = (conv: Conversation) => {
    if (conv.type === 'dm' && conv.dm_avatar_url) {
      return conv.dm_avatar_url;
    }
    if (conv.type === 'group' && conv.icon_url) {
      return conv.icon_url;
    }
    return null;
  };

  const getInitial = (name: string | null | undefined) => {
    const trimmed = name?.trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '#';
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'dm': return <MessageCircle className="w-4 h-4 opacity-60" />;
      case 'group': return <Users className="w-4 h-4 opacity-60" />;
      case 'channel': return <HashIcon className="w-4 h-4 opacity-60" />;
      default: return null;
    }
  };

  const ConvItem = ({ conv }: { conv: Conversation }) => {
    const isActive = activeId === conv.id;
    const avatar = getAvatar(conv);

    const friend = conv.type === 'dm' 
      ? friends.find(f => f.username === conv.dm_username) 
      : null;

    const presence = friend 
      ? getPresence(friend.id || friend.user_id || friend.profile_id) 
      : { status: 'offline' as const };

    return (
      <button
        onClick={() => onSelect(conv)}
        className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md transition-colors ${
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

        <div className="flex-1 min-w-0 text-left">
          <div className="text-sm font-medium truncate text-void-text">{getDisplayName(conv)}</div>
          {conv.type !== 'dm' && (
            <div className="text-xs text-void-text-muted">{conv.member_count} members</div>
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
    <div className="flex-1 overflow-y-auto py-2 px-2 flex flex-col">
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

      <div className="space-y-0.5 flex-1">
        {searchFiltered.length === 0 ? (
          <div className="text-center px-4 py-8">
            <p className="text-sm text-void-text-muted">
              {search.trim() 
                ? 'No results found' 
                : `No ${filter === 'dm' ? 'DMs' : 'groups'} yet.`}
            </p>
          </div>
        ) : (
          searchFiltered.map((conv) => <ConvItem key={conv.id} conv={conv} />)
        )}
      </div>
    </div>
  );
};

export default ConversationList;
