// src/components/Chat/FriendsView.tsx
import { useState, useEffect, useRef } from 'react';
import { MessageCircle, Search, UserPlus, MoreVertical, UserMinus } from 'lucide-react';
import { usePresence } from '../../../Services/hooks/Friends/usePresence';
import { Friend, useFriends } from '../../../Services/hooks/Friends/useFriends';
import { useFriendRequests } from '../../../Services/hooks/Friends/useFriendRequests';
import FriendProfile from './FriendProfile';
import AddFriend from './AddFriend';
import IncomingRequests from './IncomingRequests';

interface FriendsViewProps {
  friends: Friend[];
  onStartDM: (userId: string) => void;
}

const FriendsView = ({ friends, onStartDM }: FriendsViewProps) => {
  const { getPresence: getPresenceData } = usePresence();
  const { removeFriend } = useFriends();
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'online' | 'all' | 'pending' | 'add_friend'>('online');
  const { incoming, outgoing, acceptRequest, rejectRequest, cancelRequest } = useFriendRequests();
  
  const [selectedFriend, setSelectedFriend] = useState<Friend | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [friendToRemove, setFriendToRemove] = useState<Friend | null>(null); // State for confirmation modal
  
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const hasPending = incoming.length > 0 || outgoing.length > 0;

  useEffect(() => {
    if (tab === 'pending' && !hasPending) {
      setTab('online');
    }
  }, [hasPending, tab]);

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

  const getAvatarUrl = (friend: Friend) => {
    return friend.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${friend.username}`;
  };

  // Execution of the confirmed removal
  const handleConfirmRemove = () => {
    if (friendToRemove) {
      removeFriend(friendToRemove.friendship_id);
      setFriendToRemove(null);
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
    <div className="flex-1 flex flex-col bg-void-bg-sec relative">
      {/* Header */}
      <div className="h-16 border-b border-void-bg-hover flex items-center justify-between px-6 shrink-0 z-10">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold text-void-text">Friends</h1>
          <div className="flex items-center gap-1 bg-void-bg-main rounded-lg p-0.5">
            <button
              onClick={() => setTab('online')}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${
                tab === 'online' ? 'bg-void-bg-hover text-void-text' : 'text-void-text-muted hover:text-void-text'
              }`}
            >
              Online
            </button>
            <button
              onClick={() => setTab('all')}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${
                tab === 'all' ? 'bg-void-bg-hover text-void-text' : 'text-void-text-muted hover:text-void-text'
              }`}
            >
              All
            </button>
            {hasPending && (
              <button
                onClick={() => setTab('pending')}
                className={`relative px-3 py-1 text-sm rounded-md transition-colors ${
                  tab === 'pending' ? 'bg-void-bg-hover text-void-text' : 'text-void-text-muted hover:text-void-text'
                }`}
              >
                Pending
                {incoming.length > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                    {incoming.length}
                  </span>
                )}
              </button>
            )}
          </div>
          
          <button
            onClick={() => setTab('add_friend')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors ${
              tab === 'add_friend' 
                ? 'bg-transparent text-void-accent border border-void-accent/50 cursor-default' 
                : 'bg-void-accent hover:bg-void-accent-hover text-white' 
            }`}
          >
            <UserPlus className="w-4 h-4" />
            <span className="hidden sm:inline">Add Friend</span>
          </button>
        </div>        
      </div>

      {tab === 'add_friend' ? (
        <AddFriend />
      ) : tab === 'pending' ? (
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {incoming.length === 0 && outgoing.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-void-text-muted">
              <p className="text-sm">No pending requests</p>
            </div>
          ) : (
            <>
              {incoming.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-void-text-muted uppercase tracking-wide mb-2">
                    Incoming — {incoming.length}
                  </p>
                  <IncomingRequests
                    requests={incoming}
                    onAccept={acceptRequest}
                    onReject={rejectRequest}
                  />
                </div>
              )}
              {outgoing.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-void-text-muted uppercase tracking-wide mb-2">
                    Sent — {outgoing.length}
                  </p>
                  <div className="space-y-2">
                    {outgoing.map((req) => (
                      <div key={req.friendship_id} className="flex items-center justify-between p-3 bg-void-bg-hover/30 rounded-lg">
                        <div className="flex items-center gap-3">
                          <img
                            src={req.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${req.username}`}
                            alt={req.username}
                            className="w-10 h-10 rounded-full object-cover"
                          />
                          <div>
                            <p className="text-void-text font-medium text-sm">{req.display_name || req.username}</p>
                            <p className="text-void-text-muted text-xs">@{req.username} · Pending</p>
                          </div>
                        </div>
                        <button
                          onClick={() => cancelRequest(req.friendship_id)}
                          className="px-3 py-1 text-xs text-red-400 border border-red-400/30 rounded-md hover:bg-red-400/10 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="px-6 py-3">
            <div className="flex items-center bg-void-bg-main rounded-lg px-3 py-2">
              <Search className="w-4 h-4 text-void-text-muted mr-2" />
              <input
                type="text"
                placeholder="Search friends"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="bg-transparent text-sm w-full focus:outline-none text-void-text placeholder-void-text-muted"
              />
            </div>
          </div>

          <div className="px-6 pb-2">
            <p className="text-xs font-bold text-void-text-muted uppercase tracking-wider">
              {tab === 'online' ? `Online — ${onlineCount}` : `All Friends — ${friends.length}`}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto px-4 pb-16">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-void-text-muted">
                <p className="text-sm">{tab === 'online' ? 'No friends online right now' : 'No friends found'}</p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {filtered.map((friend) => {
                  const presence = getPresence(friend.id);
                  const isMenuOpen = openMenuId === friend.id;

                  return (
                    <div
                      key={friend.id}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-void-bg-hover/40 group transition-colors relative"
                    >
                      {/* Avatar -> Profile */}
                      <div 
                        className="relative shrink-0 cursor-pointer"
                        onClick={() => setSelectedFriend(friend)}
                      >
                        <img
                          src={getAvatarUrl(friend)}
                          className={`w-10 h-10 rounded-full object-cover ${
                            presence === 'offline' ? 'opacity-50 grayscale' : ''
                          }`}
                          alt=""
                        />
                        <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-void-bg-sec ${getStatusColor(presence)}`} />
                      </div>

                      {/* Info -> Start DM */}
                      <div 
                        className="flex-1 min-w-0 cursor-pointer py-1"
                        onClick={() => onStartDM(friend.id)}
                      >
                        <div className="font-medium text-sm truncate text-void-text">
                          {friend.display_name || friend.username}
                        </div>
                        <div className="text-xs text-void-text-muted">
                          {getStatusText(presence)}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1" ref={isMenuOpen ? menuRef : undefined}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation(); // Prevents the row click (Start DM) from firing
                            onStartDM(friend.id);
                          }}
                          className="p-2 text-void-text-muted hover:text-void-text hover:bg-void-bg-hover rounded-full transition-colors"
                          title="Message"
                        >
                          <MessageCircle className="w-5 h-5" />
                        </button>

                        {/* More Options Menu */}
                        <div className="relative">
                          <button
                            onClick={(e) => {
                              e.stopPropagation(); // Prevent the row click
                              setOpenMenuId(isMenuOpen ? null : friend.id);
                            }}
                            className={`p-2 rounded-full transition-colors ${
                              isMenuOpen 
                                ? 'bg-void-bg-hover text-void-text' 
                                : 'text-void-text-muted hover:text-void-text hover:bg-void-bg-hover'
                            }`}
                            title="More Options"
                          >
                            <MoreVertical className="w-5 h-5" />
                          </button>

                          {/* Changed to top-full mt-2 so it flows down.
                              Added Discord dark colors.
                           */}
                          {isMenuOpen && (
                            <div className="absolute right-0 top-full mt-2 z-50 w-48 bg-[#111214] border border-black/20 rounded-md shadow-2xl p-2 animate-in fade-in zoom-in duration-100">
                              <button
                                onClick={(e) => { 
                                  e.stopPropagation(); 
                                  setFriendToRemove(friend); 
                                  setOpenMenuId(null); 
                                }}
                                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[#f23f43] hover:bg-[#f23f43] hover:text-white rounded-sm transition-colors"
                              >
                                <UserMinus className="w-4 h-4" />
                                Remove Friend
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {selectedFriend && (
        <FriendProfile 
          friend={selectedFriend} 
          onClose={() => setSelectedFriend(null)} 
        />
      )}

      {/* Confirmation Modal Container */}
      {friendToRemove && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="bg-void-bg-sec border border-void-bg-hover rounded-xl shadow-2xl p-6 w-full max-w-sm animate-in fade-in zoom-in-95 duration-200">
            <h2 className="text-lg font-bold text-void-text mb-2">Remove Friend</h2>
            <p className="text-void-text-muted text-sm mb-6">
              Are you sure you want to permanently remove <strong className="text-void-text">{friendToRemove.display_name || friendToRemove.username}</strong> from your friends list?
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setFriendToRemove(null)}
                className="px-4 py-2 text-sm font-medium text-void-text hover:underline transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmRemove}
                className="px-4 py-2 text-sm font-medium bg-[#f23f43] hover:bg-[#da373c] text-white rounded-md transition-colors shadow-sm"
              >
                Remove Friend
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FriendsView;