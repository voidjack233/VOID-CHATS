import { useState } from 'react';
import { UserMinus, Users } from 'lucide-react';
import { Friend } from '../../../Services/hooks/Friends/useFriends';
import PresenceDot from '../../common/PresenceDot';
import UserAvatar from '../../common/UserAvatar';

interface GroupedFriends {
  online: Friend[];
  idle: Friend[];
  offline: Friend[];
}

interface FriendsListProps {
  grouped: GroupedFriends;
  onRemove: (friendshipId: number) => Promise<{ success: boolean }>;
  onSelect: (profileId: string) => void;
}

export default function FriendsList({ grouped, onRemove, onSelect }: FriendsListProps) {
  const [confirmFriend, setConfirmFriend] = useState<Friend | null>(null);
  const [removing, setRemoving] = useState(false);

  const totalFriends = grouped.online.length + grouped.idle.length + grouped.offline.length;

  if (totalFriends === 0) {
    return (
      <div className="text-center py-12">
        <Users className="w-12 h-12 text-void-text-muted mx-auto mb-3" />
        <p className="text-void-text-muted">No friends yet</p>
        <p className="text-void-text-muted text-sm mt-1">Send a friend request to get started!</p>
      </div>
    );
  }

  const handleRemoveClick = (e: React.MouseEvent, friend: Friend) => {
    e.stopPropagation();
    setConfirmFriend(friend);
  };

  const handleConfirmRemove = async () => {
    if (!confirmFriend) return;
    setRemoving(true);
    await onRemove(confirmFriend.friendship_id);
    setRemoving(false);
    setConfirmFriend(null);
  };

  const renderFriendItem = (friend: Friend, status: 'online' | 'idle' | 'offline') => (
    <div
      key={friend.friendship_id}
      onClick={() => onSelect(friend.profile_id)}
      className={`flex items-center justify-between p-3 bg-gray-900/50 rounded-lg hover:bg-void-bg-hover/50 transition-colors cursor-pointer group ${
        status === 'offline' ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="relative flex-shrink-0">
          <UserAvatar
            src={friend.avatar_url}
            displayName={friend.display_name}
            username={friend.username}
            alt={friend.display_name || friend.username}
            className="w-10 h-10 rounded-full"
            fallbackClassName="text-sm"
          />
          <span className="absolute -bottom-0.5 -right-0.5">
            <PresenceDot status={status} size="md" />
          </span>
        </div>
        <div>
          <p className="text-void-text font-medium">
            {friend.display_name || friend.username}
          </p>
          <p className="text-void-text-muted text-sm">@{friend.username}</p>
        </div>
      </div>

      {confirmFriend?.friendship_id === friend.friendship_id ? (
        <span className="px-3 py-1.5 text-xs text-yellow-400 bg-yellow-900/20 rounded-lg">
          Confirm...
        </span>
      ) : (
        <button
          onClick={(e) => handleRemoveClick(e, friend)}
          className="p-2 text-void-text-muted group-hover:text-void-text-muted hover:!text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
          title="Remove friend"
        >
          <UserMinus className="w-4 h-4" />
        </button>
      )}
    </div>
  );

  const renderSection = (
    label: string,
    friends: Friend[],
    status: 'online' | 'idle' | 'offline',
    colorClass: string
  ) => {
    if (friends.length === 0) return null;

    return (
      <div>
        <div className="flex items-center gap-2 px-1 mb-2">
          <span className={`text-xs font-semibold uppercase tracking-wider ${colorClass}`}>
            {label}
          </span>
          <span className="text-xs text-void-text-muted">{friends.length}</span>
        </div>
        <div className="space-y-1.5">
          {friends.map(friend => renderFriendItem(friend, status))}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="space-y-4">
        {renderSection('Online', grouped.online, 'online', 'text-green-400')}
        {renderSection('Idle', grouped.idle, 'idle', 'text-yellow-400')}
        {renderSection('Offline', grouped.offline, 'offline', 'text-void-text-muted')}
      </div>

      {/* Unfriend Confirmation Dialog */}
      {confirmFriend && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-void-bg-secondary rounded-2xl shadow-2xl border border-void-border p-6 max-w-sm w-full mx-4">
            <h3 className="text-void-text font-semibold text-lg mb-2">Remove Friend</h3>
            <p className="text-void-text-muted text-sm mb-6">
              Are you sure you want to unfriend{' '}
              <span className="text-void-text font-medium">
                {confirmFriend.display_name || confirmFriend.username}
              </span>
              ? 
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmFriend(null)}
                disabled={removing}
                className="flex-1 py-2.5 rounded-lg bg-void-bg-hover hover:bg-void-bg-hover text-void-text text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmRemove}
                disabled={removing}
                className="flex-1 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                {removing ? 'Removing...' : 'Unfriend'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
