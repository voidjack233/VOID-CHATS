import { Hash, Plus, Users } from 'lucide-react';
import { Conversation } from '../../Services/Chat/chatService';

interface GroupChannelsSidebarProps {
  conversation: Conversation;
  activeChannelId: string;
  onSelectChannel: (channelId: string) => void;
}

const defaultChannels = [
  { id: 'general', name: 'general' },
];

export default function GroupChannelsSidebar({
  conversation,
  activeChannelId,
  onSelectChannel,
}: GroupChannelsSidebarProps) {
  return (
    <aside className="hidden lg:flex w-72 shrink-0 flex-col border-l border-void-bg-hover bg-void-bg-main/55 backdrop-blur-sm">
      <div className="border-b border-void-bg-hover px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-void-accent/15 text-void-accent">
            <Users className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-void-text">
              {conversation.name || 'Unnamed Group'}
            </p>
            <p className="text-xs text-void-text-muted">
              Text channels
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <div className="mb-3 flex items-center justify-between px-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.22em] text-void-text-muted">
            Text Channels
          </span>
          <button
            type="button"
            className="rounded-md p-1 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
            title="Add text channel"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-1">
          {defaultChannels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              onClick={() => onSelectChannel(channel.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                activeChannelId === channel.id
                  ? 'bg-void-bg-hover text-void-text shadow-sm'
                  : 'text-void-text-muted hover:bg-void-bg-hover/70 hover:text-void-text'
              }`}
            >
              <Hash className="h-4 w-4 shrink-0" />
              <span className="truncate font-medium">{channel.name}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
