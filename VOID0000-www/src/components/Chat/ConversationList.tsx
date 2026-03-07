// src/components/Chat/ConversationList.tsx
import { useState, useEffect } from 'react';
import { Hash as HashIcon, MessageCircle, Users, Plus, Search } from 'lucide-react';
import { getConversations, Conversation } from '../../Services/Chat/chatService';
import { usePresence } from '../../Services/hooks/Friends/usePresence';
import PresenceDot from '../common/PresenceDot';
import { gateway } from '../../Services/Gateway/gateway';
import { ConversationItemSkeleton } from '../common/Skeleton';

interface ConversationListProps {
  activeId: string | null;
  onSelect: (conversation: Conversation) => void;
  onCreateGroup: () => void;
  filter: 'dm' | 'group';
  friends: any[];
  refreshTrigger?: number;
}

const ConversationList = ({ activeId, onSelect, onCreateGroup, filter, friends, refreshTrigger }: ConversationListProps) => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  
  const { getPresence } = usePresence();

  // Initial load
  useEffect(() => {
    loadConversations();
  }, []);

  // Refresh when trigger changes
  useEffect(() => {
    if (refreshTrigger) loadConversations();
  }, [refreshTrigger]);

  // Listen for WebSocket events
  useEffect(() => {
    const handleRefresh = () => {
      loadConversations();
    };
    
    gateway.on('MESSAGE_CREATE', handleRefresh);
    gateway.on('REACTION_ADD', handleRefresh);
    
    return () => {
      gateway.off('MESSAGE_CREATE', handleRefresh);
      gateway.off('REACTION_ADD', handleRefresh);
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
    return null;
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
          {avatar ? (
            <img src={avatar} className="w-8 h-8 rounded-full object-cover shrink-0" alt="" />
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