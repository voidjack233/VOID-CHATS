import { ArrowLeft, SlidersHorizontal, Users } from 'lucide-react';
import type { Conversation } from '../../Services/Chat/chatService';
import UserAvatar from '../../components/common/UserAvatar';

interface ConversationHeaderProps {
  type: Conversation['type'];
  title: string;
  subtitle: string;
  dmAvatarUrl: string | null;
  dmDisplayName: string | null;
  dmUsername: string | null;
  groupIconUrl: string | null;
  onBack: () => void;
  onOpenSettings: () => void;
}

export default function ConversationHeader({
  type,
  title,
  subtitle,
  dmAvatarUrl,
  dmDisplayName,
  dmUsername,
  groupIconUrl,
  onBack,
  onOpenSettings,
}: ConversationHeaderProps) {
  const icon = type === 'dm' ? (
    <UserAvatar
      src={dmAvatarUrl}
      displayName={dmDisplayName}
      username={dmUsername}
      className="w-8 h-8 rounded-full mr-3 shrink-0"
      fallbackClassName="text-sm"
    />
  ) : type === 'group' ? (
    groupIconUrl ? (
      <img
        src={groupIconUrl}
        alt=""
        className="mr-3 h-8 w-8 shrink-0 rounded-full object-cover"
      />
    ) : (
      <div className="mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-void-accent/15 text-xs font-semibold text-void-accent">
        {title.trim().charAt(0).toUpperCase() || '#'}
      </div>
    )
  ) : (
    <Users className="w-5 h-5 text-void-text-muted mr-2 shrink-0" />
  );

  return (
    <nav
      data-chat-conversation-header="true"
      className="sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between border-b border-void-bg-hover bg-void-bg-sec/95 px-4 shadow-sm supports-[backdrop-filter]:backdrop-blur md:relative md:top-auto md:bg-void-bg-sec"
    >
      <div className="flex items-center min-w-0 flex-1">
        <button
          onClick={onBack}
          className="mr-3 p-1 text-void-text-muted hover:text-void-text hover:bg-void-bg-hover rounded-md md:hidden shrink-0 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        {icon}
        <div className="min-w-0">
          <h1 className="text-lg font-bold truncate">{title}</h1>
          {subtitle && (
            <p className="truncate text-xs font-medium text-void-text-muted">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      <button
        onClick={onOpenSettings}
        className="p-2 rounded-lg text-void-text-muted hover:text-void-text hover:bg-void-bg-hover transition-colors shrink-0 ml-2"
        title="Conversation settings"
      >
        <SlidersHorizontal className="w-4 h-4" />
      </button>
    </nav>
  );
}
