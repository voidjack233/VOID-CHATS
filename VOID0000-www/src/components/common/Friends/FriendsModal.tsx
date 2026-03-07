// import { useState } from 'react';
import { X, Users, UserPlus, Loader2 } from 'lucide-react';
import { useScrollLock } from '../../../Services/hooks/common/useScrollLock';
import { useFriendRequests } from '../../../Services/hooks/Friends/useFriendRequests';
import IncomingRequests from './IncomingRequests';
// import AddFriendModal from './AddFriend'

interface FriendsModalProps {
  onClose: () => void;
}

export default function FriendsModal({ onClose }: FriendsModalProps) {
  useScrollLock();
  // const [showAddFriend, setShowAddFriend] = useState(false);

  const {
    incoming,
    loading: requestsLoading,
    acceptRequest,
    rejectRequest,
  } = useFriendRequests();

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="relative w-full max-w-lg mx-4 h-[500px] flex flex-col bg-void-bg-secondary rounded-2xl shadow-2xl overflow-hidden border border-void-border">

          {/* Header */}
          <div className="p-4 border-b border-void-border flex justify-between items-center bg-void-bg-secondary/50">
            <h2 className="text-xl font-bold text-void-text flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-400" />
              Friends
            </h2>
            <div className="flex gap-2">
              <button
                // onClick={() => setShowAddFriend(true)}
                className="p-2 text-blue-400 hover:bg-blue-400/10 rounded-lg transition-colors"
                title="Add Friend"
              >
                <UserPlus className="w-5 h-5" />
              </button>
              <button
                onClick={onClose}
                className="p-2 text-void-text-muted hover:bg-void-bg-hover rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Add Friend Button */}
          <div className="p-3 border-b border-void-border/50">
            <button
              // onClick={() => setShowAddFriend(true)}
              className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <UserPlus className="w-4 h-4" />
              Add Friend
            </button>
          </div>

          {/* Pending Requests */}
          <div className="flex-1 overflow-y-auto p-4">
            {requestsLoading ? (
              <div className="flex flex-col items-center justify-center py-12">
                <Loader2 className="w-8 h-8 text-blue-400 animate-spin mb-4" />
                <p className="text-void-text-muted">Loading...</p>
              </div>
            ) : incoming.length > 0 ? (
              <>
                <h3 className="text-xs font-semibold text-void-text-muted uppercase tracking-wide mb-3">
                  Pending Requests ({incoming.length})
                </h3>
                <IncomingRequests
                  requests={incoming}
                  onAccept={acceptRequest}
                  onReject={rejectRequest}
                />
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* {showAddFriend && (
        <AddFriendModal onClose={() => setShowAddFriend(false)} />
      )} */}
    </>
  );
}