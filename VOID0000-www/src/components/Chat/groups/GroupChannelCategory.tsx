import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { Conversation } from '../../../Services/Chat/chatService';
import GroupChannelListItem from './GroupChannelListItem';

interface GroupChannelCategoryProps {
  category: {
    id: string;
    name: string;
    channels: Conversation[];
  };
  activeChannelId: string;
  canManageChannels: boolean;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onSelectChannel: (channel: Conversation) => void;
  onOpenChannelSettings: (channel: Conversation) => void;
  onCreateChannel: (categoryId?: string | null) => void;
  showCreateChannelButton?: boolean;
}

export default function GroupChannelCategory({
  category,
  activeChannelId,
  canManageChannels,
  isCollapsed,
  onToggleCollapse,
  onSelectChannel,
  onOpenChannelSettings,
  onCreateChannel,
  showCreateChannelButton = false,
}: GroupChannelCategoryProps) {
  const visibleChannels = isCollapsed
    ? category.channels.filter((channel) => channel.id === activeChannelId)
    : category.channels;

  return (
    <section>
      <div className="mb-2 flex items-center gap-1 px-2">
        <button
          type="button"
          onClick={onToggleCollapse}
          data-group-sidebar-action="true"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-[11px] font-bold uppercase tracking-[0.22em] text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
        >
          {isCollapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{category.name}</span>
        </button>
        {canManageChannels && showCreateChannelButton && (
          <button
            type="button"
            onClick={() => onCreateChannel(category.id)}
            data-group-sidebar-action="true"
            className="rounded-md p-1 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
            title={`Add channel to ${category.name.toLowerCase()}`}
          >
            <Plus className="h-4 w-4" />
          </button>
        )}
      </div>

      {visibleChannels.length === 0 ? (
        !isCollapsed ? (
          <div className="rounded-lg border border-dashed border-void-bg-hover px-3 py-4 text-center text-sm text-void-text-muted">
            No channels in this category yet.
          </div>
        ) : null
      ) : (
        <div className="space-y-1">
          {visibleChannels.map((channel) => (
            <GroupChannelListItem
              key={channel.id}
              channel={channel}
              isActive={activeChannelId === channel.id}
              canManage={canManageChannels}
              onSelectChannel={onSelectChannel}
              onOpenSettings={onOpenChannelSettings}
            />
          ))}
        </div>
      )}
    </section>
  );
}
