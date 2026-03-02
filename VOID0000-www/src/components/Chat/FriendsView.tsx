// src/components/Chat/FriendsView.tsx
import { useState } from 'react';
import { MessageCircle, Search, UserPlus } from 'lucide-react';
import { usePresence } from '../../Services/hooks/Friends/usePresence';

interface Friend {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string;
  status?: string;
}

interface FriendsViewProps {
  friends: Friend[];
  onStartDM: (userId: string) => void;
  onShowFriendsModal: () => void;
}

const FriendsView = ({ friends, onStartDM, onShowFriendsModal }: FriendsViewProps) => {
  const { getPresence: getPresenceData } = usePresence();
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'online' | 'all'>('online');

  // Replace the old getPresence:
  const getPresence = (userId: string) => getPresenceData(userId).status;

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online': return 'bg-green-500';
      case 'idle': return 'bg-yellow-500';
      default: return 'bg-gray-500';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'online': return 'Online';
      case 'idle': return 'Idle';
      default: return 'Offline';
    }
  };

  const filtered = friends
    .filter((f) => {
      if (tab === 'online') {
        const status = getPresence(f.id);
        return status === 'online' || status === 'idle';
      }
      return true;
    })
    .filter((f) => {
      if (!search.trim()) return true;
      const name = f.display_name || f.username;
      return name.toLowerCase().includes(search.toLowerCase());
    })
    .sort((a, b) => {
      // Online first, then idle, then offline
      const order: Record<string, number> = { online: 0, idle: 1, offline: 2 };
      const aStatus = getPresence(a.id);
      const bStatus = getPresence(b.id);
      return (order[aStatus] ?? 2) - (order[bStatus] ?? 2);
    });

  const onlineCount = friends.filter((f) => {
    const s = getPresence(f.id);
    return s === 'online' || s === 'idle';
  }).length;

  return (
    <div className="flex-1 flex flex-col bg-gray-800">
      {/* Header */}
      <div className="h-16 border-b border-gray-700 flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold">Friends</h1>
          <div className="flex items-center gap-1 bg-gray-900 rounded-lg p-0.5">
            <button
              onClick={() => setTab('online')}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${
                tab === 'online'
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Online
            </button>
            <button
              onClick={() => setTab('all')}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${
                tab === 'all'
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              All
            </button>
          </div>
        </div>
        <button
          onClick={onShowFriendsModal}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg transition-colors"
        >
          <UserPlus className="w-4 h-4" />
          Add Friend
        </button>
      </div>

      {/* Search */}
      <div className="px-6 py-3">
        <div className="flex items-center bg-gray-900 rounded-lg px-3 py-2">
          <Search className="w-4 h-4 text-gray-500 mr-2" />
          <input
            type="text"
            placeholder="Search friends"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent text-sm w-full focus:outline-none text-gray-200 placeholder-gray-500"
          />
        </div>
      </div>

      {/* Count */}
      <div className="px-6 pb-2">
        <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">
          {tab === 'online'
            ? `Online — ${onlineCount}`
            : `All Friends — ${friends.length}`}
        </p>
      </div>

      {/* Friend List */}
      <div className="flex-1 overflow-y-auto px-4">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-500">
            {tab === 'online' ? (
              <>
                <div className="w-16 h-16 bg-gray-700 rounded-full flex items-center justify-center mb-4">
                  <div className="w-4 h-4 bg-gray-500 rounded-full" />
                </div>
                <p className="text-sm">No friends online right now</p>
              </>
            ) : (
              <>
                <p className="text-sm">No friends found</p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((friend) => {
              const presence = getPresence(friend.id);
              return (
                <div
                  key={friend.id}
                  className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-gray-700/40 group transition-colors"
                >
                  {/* Avatar with status */}
                  <div className="relative shrink-0">
                    <img
                      src={friend.avatar_url}
                      className={`w-10 h-10 rounded-full object-cover ${
                        presence === 'offline' ? 'opacity-50 grayscale' : ''
                      }`}
                      alt=""
                    />
                    <div
                      className={`absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full border-[2.5px] border-gray-800 ${getStatusColor(presence)}`}
                    />
                  </div>

                  {/* Name + status */}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">
                      {friend.display_name || friend.username}
                    </div>
                    <div className="text-xs text-gray-500">
                      {getStatusText(presence)}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => onStartDM(friend.id)}
                      className="p-2 hover:bg-gray-600 rounded-full text-gray-400 hover:text-white transition-colors"
                      title="Message"
                    >
                      <MessageCircle className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default FriendsView;