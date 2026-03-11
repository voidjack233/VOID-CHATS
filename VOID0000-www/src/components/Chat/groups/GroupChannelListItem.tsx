import { Hash, Settings2 } from 'lucide-react';
import { Conversation } from '../../../Services/Chat/chatService';

interface GroupChannelListItemProps {
  channel: Conversation;
  isActive: boolean;
  canManage: boolean;
  onSelectChannel: (channel: Conversation) => void;
  onOpenSettings: (channel: Conversation) => void;
}

export default function GroupChannelListItem({
  channel,
  isActive,
  canManage,
  onSelectChannel,
  onOpenSettings,
}: GroupChannelListItemProps) {
  return (
    <div
      data-group-sidebar-action="true"
      className={`group flex items-center gap-1 rounded-lg transition-colors ${
        isActive ? 'bg-void-bg-hover shadow-sm' : 'hover:bg-void-bg-hover/70'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelectChannel(channel)}
        data-group-sidebar-action="true"
        className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm transition-colors ${
          isActive
            ? 'text-void-text'
            : 'text-void-text-muted group-hover:text-void-text'
        }`}
      >
        <Hash className="h-4 w-4 shrink-0" />
        <span className="truncate font-medium">{channel.name}</span>
      </button>

      {canManage && isActive && (
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenSettings(channel);
          }}
          data-group-sidebar-action="true"
          className="mr-1 rounded-md p-1.5 text-void-text-muted transition-colors hover:bg-void-bg-main/70 hover:text-void-text"
          title={`Channel settings for ${channel.name || 'channel'}`}
        >
          <Settings2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
