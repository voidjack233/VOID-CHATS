import { useEffect } from 'react';
import { Check, X, User } from 'lucide-react';
import { FriendRequest, useFriendRequests } from '../../../Services/hooks/Friends/useFriendRequests';

interface IncomingRequestsProps {
  requests: FriendRequest[];
  onAccept: (friendshipId: number) => Promise<{ success: boolean }>;
  onReject: (friendshipId: number) => Promise<{ success: boolean }>;
}

export default function IncomingRequests({ requests, onAccept, onReject }: IncomingRequestsProps) {
  // Access the markAsSeen function
  const { markAsSeen } = useFriendRequests();

  // Trigger the "Seen" action when this component MOUNTS
  useEffect(() => {
    markAsSeen();
  }, []); 

  return (
    <div className="space-y-2">
      {requests.map((request) => (
        <div
          key={request.friendship_id}
          className="flex items-center justify-between p-3 bg-gray-900/50 rounded-lg"
        >
          <div className="flex items-center gap-3">
            {request.avatar_url ? (
              <img
                src={request.avatar_url}
                alt={request.display_name || request.username}
                className="w-10 h-10 rounded-full object-cover"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-void-bg-hover flex items-center justify-center">
                <User className="w-5 h-5 text-void-text-muted" />
              </div>
            )}
            <div>
              <p className="text-void-text font-medium">
                {request.display_name || request.username}
              </p>
              <p className="text-void-text-muted text-sm">@{request.username}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onAccept(request.friendship_id)}
              className="p-2 text-green-400 hover:bg-green-900/20 rounded-lg transition-colors"
              title="Accept"
            >
              <Check className="w-4 h-4" />
            </button>
            <button
              onClick={() => onReject(request.friendship_id)}
              className="p-2 text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
              title="Reject"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}