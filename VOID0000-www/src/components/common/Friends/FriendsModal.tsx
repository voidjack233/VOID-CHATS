import { useState } from 'react';
import { ArrowLeft, X, Users, UserPlus } from 'lucide-react';
import { useScrollLock } from '../../../Services/hooks/common/useScrollLock';
import { useFriendRequests } from '../../../Services/hooks/Friends/useFriendRequests';
import IncomingRequests from './IncomingRequests';
import { FriendRequestSkeleton } from '../Skeleton';
import AddFriend from './AddFriend';

interface FriendsModalProps {
  onClose: () => void;
}

export default function FriendsModal({ onClose }: FriendsModalProps) {
  useScrollLock();
  const [view, setView] = useState<'requests' | 'add_friend'>('requests');

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
            <div className="flex items-center gap-3">
              {view === 'add_friend' ? (
                <button
                  onClick={() => setView('requests')}
                  className="p-2 text-void-text-muted hover:bg-void-bg-hover rounded-lg transition-colors"
                  title="Back"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
              ) : null}
              <div>
                <h2 className="text-xl font-bold text-void-text flex items-center gap-2">
                  {view === 'add_friend' ? (
                    <UserPlus className="w-5 h-5 text-blue-400" />
                  ) : (
                    <Users className="w-5 h-5 text-blue-400" />
                  )}
                  {view === 'add_friend' ? 'Add Friend' : 'Friends'}
                </h2>
                <p className="text-xs text-void-text-muted mt-1">
                  {view === 'add_friend'
                    ? 'Search by username and send a friend request.'
                    : 'Review incoming requests and manage your friend list.'}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {view === 'requests' ? (
                <button
                  onClick={() => setView('add_friend')}
                  className="p-2 text-blue-400 hover:bg-blue-400/10 rounded-lg transition-colors"
                  title="Add Friend"
                >
                  <UserPlus className="w-5 h-5" />
                </button>
              ) : null}
              <button
                onClick={onClose}
                className="p-2 text-void-text-muted hover:bg-void-bg-hover rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Add Friend Button */}
          {view === 'requests' ? (
            <div className="p-3 border-b border-void-border/50">
            <button
              onClick={() => setView('add_friend')}
              className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <UserPlus className="w-4 h-4" />
              Add Friend
            </button>
            </div>
          ) : null}

          {/* Pending Requests */}
          <div className="flex-1 overflow-y-auto p-4">
            {view === 'add_friend' ? (
              <AddFriend />
            ) : requestsLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => <FriendRequestSkeleton key={i} />)}
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
            ) : (
              <div className="flex h-full flex-col items-center justify-center text-center px-6">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-void-bg-hover">
                  <Users className="h-8 w-8 text-void-text-muted" />
                </div>
                <h3 className="text-base font-semibold text-void-text">No pending friend requests</h3>
                <p className="mt-2 max-w-xs text-sm leading-6 text-void-text-muted">
                  Your incoming requests will appear here. You can also search for someone and send a request now.
                </p>
                <button
                  onClick={() => setView('add_friend')}
                  className="mt-5 inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
                >
                  <UserPlus className="h-4 w-4" />
                  Find a Friend
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
