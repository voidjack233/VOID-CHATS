import type { ReactNode } from 'react';
import { MessageCircle, Settings, Users } from 'lucide-react';
import UserAvatar from '../../components/common/UserAvatar';
import PushNotificationPrompt from '../../components/common/Notifications/PushNotificationPrompt';

export type ChatFilter = 'dm' | 'group';
export type MobileSidebarMode = 'messages' | 'friends';

interface SidebarProfile {
  avatar_url?: string | null;
  display_name?: string | null;
}

interface ChatSidebarProps {
  isOpen: boolean;
  mobileMode: MobileSidebarMode;
  isFriendsPaneVisible: boolean;
  filter: ChatFilter;
  profile?: SidebarProfile | null;
  username?: string | null;
  onOpenFriends: () => void;
  onSelectFilter: (filter: ChatFilter) => void;
  onShowProfile: () => void;
  onShowSettings: () => void;
  children: ReactNode;
}

export default function ChatSidebar({
  isOpen,
  mobileMode,
  isFriendsPaneVisible,
  filter,
  profile,
  username,
  onOpenFriends,
  onSelectFilter,
  onShowProfile,
  onShowSettings,
  children,
}: ChatSidebarProps) {
  const isFriendsMobileActive = mobileMode === 'friends';

  return (
    <div className={`bg-void-bg-main flex-col shrink-0 border-r border-void-bg-sec transition-all ${isOpen ? 'flex' : 'hidden md:flex'} w-full md:w-72`}>
      <div className="h-16 flex items-center px-4 font-bold text-base border-b border-void-bg-sec shrink-0">
        <span>Messages</span>
      </div>

      {mobileMode === 'messages' && !isFriendsPaneVisible ? (
        <PushNotificationPrompt />
      ) : null}

      <div className="px-3 pt-3 pb-2 shrink-0 border-b border-void-bg-sec md:hidden">
        <div className="grid grid-cols-3 gap-1 rounded-2xl border border-void-bg-hover bg-void-bg-sec/80 p-1 shadow-[0_14px_32px_rgba(0,0,0,0.16)]">
          <button
            onClick={onOpenFriends}
            className={`flex items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-semibold transition-all ${
              isFriendsMobileActive
                ? 'bg-void-accent/14 text-void-accent ring-1 ring-void-accent/30'
                : 'text-void-text-muted hover:bg-void-bg-hover/80 hover:text-void-text'
            }`}
            aria-pressed={isFriendsMobileActive}
          >
            <Users className="h-3.5 w-3.5" />
            <span>Friends</span>
          </button>
          <button
            onClick={() => onSelectFilter('dm')}
            className={`flex items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-semibold transition-all ${
              filter === 'dm' && !isFriendsMobileActive
                ? 'bg-void-bg-hover text-void-text ring-1 ring-white/5'
                : 'text-void-text-muted hover:bg-void-bg-hover/80 hover:text-void-text'
            }`}
            aria-pressed={filter === 'dm' && !isFriendsMobileActive}
          >
            <MessageCircle className="h-3.5 w-3.5" />
            <span>DMs</span>
          </button>
          <button
            onClick={() => onSelectFilter('group')}
            className={`flex items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-semibold transition-all ${
              filter === 'group' && !isFriendsMobileActive
                ? 'bg-void-bg-hover text-void-text ring-1 ring-white/5'
                : 'text-void-text-muted hover:bg-void-bg-hover/80 hover:text-void-text'
            }`}
            aria-pressed={filter === 'group' && !isFriendsMobileActive}
          >
            <Users className="h-3.5 w-3.5" />
            <span>Groups</span>
          </button>
        </div>
      </div>

      <div className="hidden px-3 pt-3 pb-2 md:block shrink-0 border-b border-void-bg-sec">
        <button
          onClick={onOpenFriends}
          className={`w-full flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold transition-all ${
            isFriendsPaneVisible
              ? 'bg-void-accent/12 border-void-accent/45 text-void-accent ring-1 ring-void-accent/20'
              : 'border-void-bg-hover bg-void-bg-sec/70 text-void-text-muted hover:bg-void-bg-hover/80 hover:text-void-text'
          }`}
          aria-pressed={isFriendsPaneVisible}
        >
          <Users className="h-4 w-4" />
          <span>Friends</span>
        </button>
      </div>

      <div className="hidden px-3 pt-3 pb-1 md:flex gap-1 shrink-0">
        <button
          onClick={() => onSelectFilter('dm')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded-md transition-all ${
            filter === 'dm'
              ? 'bg-void-bg-hover text-void-text'
              : 'text-void-text-muted hover:bg-void-bg-hover'
          }`}
          aria-pressed={filter === 'dm'}
        >
          <MessageCircle className="w-3.5 h-3.5" /> DMs
        </button>
        <button
          onClick={() => onSelectFilter('group')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded-md transition-all ${
            filter === 'group'
              ? 'bg-void-bg-hover text-void-text'
              : 'text-void-text-muted hover:bg-void-bg-hover'
          }`}
          aria-pressed={filter === 'group'}
        >
          <Users className="w-3.5 h-3.5" /> Groups
        </button>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {children}
      </div>

      <div className="h-[52px] bg-void-bg-main/90 flex items-center px-2 border-t border-void-bg-sec shrink-0">
        <div
          className="flex items-center hover:bg-void-bg-hover p-1 rounded-md cursor-pointer flex-1 min-w-0"
          onClick={onShowProfile}
        >
          <div className="w-8 h-8 rounded-full mr-2 relative shrink-0">
            <UserAvatar
              src={profile?.avatar_url || null}
              displayName={profile?.display_name}
              username={username || undefined}
              alt="Avatar"
              className="w-full h-full rounded-full"
              fallbackClassName="text-xs"
            />
          </div>
          <div className="text-sm font-semibold truncate flex-1">{profile?.display_name || username || 'User'}</div>
        </div>
        <button
          onClick={onShowSettings}
          className="p-1.5 text-void-text-muted hover:text-void-text hover:bg-void-bg-hover rounded-md shrink-0 ml-1"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
