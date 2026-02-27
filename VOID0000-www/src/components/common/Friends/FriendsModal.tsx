import { useState, useMemo } from 'react';
import { X, Users, UserPlus, Loader2 } from 'lucide-react';
import { useScrollLock } from '../../../Services/hooks/common/useScrollLock';
import { useFriends, Friend } from '../../../Services/hooks/Friends/useFriends';
import { useFriendRequests } from '../../../Services/hooks/Friends/useFriendRequests';
import { usePresence } from '../../../Services/hooks/Friends/usePresence';
import FriendsList from './FriendsList';
import IncomingRequests from './IncomingRequests';
import AddFriendModal from './AddFriendModal';
import FriendProfile from './FriendProfile';

interface FriendsModalProps {
  onClose: () => void;
}

type Tab = 'friends' | 'requests';

export default function FriendsModal({ onClose }: FriendsModalProps) {
  useScrollLock();
  const [activeTab, setActiveTab] = useState<Tab>('friends');
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [selectedFriend, setSelectedFriend] = useState<Friend | null>(null);

  const { friends, loading: friendsLoading, removeFriend } = useFriends();
  const {
    incoming,
    loading: requestsLoading,
    acceptRequest,
    rejectRequest,
  } = useFriendRequests();
  const { getPresence } = usePresence();

  const loading = friendsLoading || requestsLoading;

  // Group friends by presence status
  const grouped = useMemo(() => {
    const online: Friend[] = [];
    const idle: Friend[] = [];
    const offline: Friend[] = [];

    friends.forEach(friend => {
      const { status } = getPresence(friend.id);
      if (status === 'online') online.push(friend);
      else if (status === 'idle') idle.push(friend);
      else offline.push(friend);
    });

    const sortByName = (a: Friend, b: Friend) =>
      (a.display_name || a.username).toLowerCase().localeCompare(
        (b.display_name || b.username).toLowerCase()
      );

    online.sort(sortByName);
    idle.sort(sortByName);
    offline.sort(sortByName);

    return { online, idle, offline };
  }, [friends, getPresence]);

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="relative w-full max-w-lg mx-4 h-[600px] flex flex-col bg-gray-800 rounded-2xl shadow-2xl overflow-hidden border border-gray-700">

          {/* Header */}
          <div className="p-4 border-b border-gray-700 flex justify-between items-center bg-gray-800/50">
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-400" />
              Friends
            </h2>
            <div className="flex gap-2">
              <button
                onClick={() => setShowAddFriend(true)}
                className="p-2 text-blue-400 hover:bg-blue-400/10 rounded-lg transition-colors"
                title="Add Friend"
              >
                <UserPlus className="w-5 h-5" />
              </button>
              <button
                onClick={onClose}
                className="p-2 text-gray-400 hover:bg-gray-700 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex p-2 gap-2 bg-gray-900/30">
            {[
              { id: 'friends', label: 'My Friends', count: friends.length },
              { id: 'requests', label: 'Requests', count: incoming.length },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as Tab)}
                className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                  activeTab === tab.id
                    ? 'bg-gray-700 text-white shadow-lg'
                    : 'text-gray-400 hover:bg-gray-700/50 hover:text-gray-200'
                }`}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className={`px-1.5 py-0.5 text-xs rounded-full ${
                    activeTab === tab.id
                      ? 'bg-blue-500/20 text-blue-400'
                      : 'bg-gray-700 text-gray-400'
                  }`}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-12">
                <Loader2 className="w-8 h-8 text-blue-400 animate-spin mb-4" />
                <p className="text-gray-400">Loading...</p>
              </div>
            ) : (
              <>
                {activeTab === 'friends' && (
                  <FriendsList
                    grouped={grouped}
                    onRemove={removeFriend}
                    onSelect={(profileId) => {
                      const friend = friends.find(f => f.profile_id === profileId);
                      if (friend) setSelectedFriend(friend);
                    }}
                  />
                )}
                {activeTab === 'requests' && (
                  <IncomingRequests
                    requests={incoming}
                    onAccept={acceptRequest}
                    onReject={rejectRequest}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {selectedFriend && (
        <FriendProfile
          friend={selectedFriend}
          onClose={() => setSelectedFriend(null)}
        />
      )}

      {showAddFriend && (
        <AddFriendModal onClose={() => setShowAddFriend(false)} />
      )}
    </>
  );
}