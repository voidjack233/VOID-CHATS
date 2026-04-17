import { useRef } from 'react';
import { X, UserMinus } from 'lucide-react';
import { Friend } from '../../../Services/hooks/Friends/useFriends';
import UserProfileHeader from '../Profile/UserProfileHeader';
import UserProfileFields from '../Profile/UserProfileFields';
import UserProfileStatus from '../Profile/UserProfileStatus';

interface FriendProfileProps {
  friend: Friend;
  onClose: () => void;
  onRemoveFriend?: () => void;
}

export default function FriendProfile({ friend, onClose, onRemoveFriend }: FriendProfileProps) {
  const dummyInputRef = useRef<HTMLInputElement>(null);

  // Map cached Friend data to the shape UserProfileHeader/Fields expect
  const displayProfile = {
    id: friend.profile_id,
    username: friend.username,
    display_name: friend.display_name || '',
    avatar_url: friend.avatar_url || undefined,
    bio: friend.bio || '',
    created_at: friend.member_since || '',
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg bg-void-bg-secondary rounded-2xl shadow-2xl border border-void-border overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Close Button */}
        <div className="absolute top-4 right-4 z-20">
          <button
            onClick={onClose}
            className="p-2 rounded-full bg-void-bg-secondary/50 hover:bg-void-bg-hover text-void-text-muted hover:text-void-text transition-colors focus:outline-none"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Header Section */}
        <div className="p-6 pb-2 flex items-start justify-between gap-4 mt-6">
          <div className="flex-1">
            <UserProfileHeader
              displayProfile={displayProfile}
              previewUrl={null}
              isEditing={false}
              isUploading={false}
              fileInputRef={dummyInputRef}
              onFileSelect={() => {}}
              uploadError={null}
              allowUpload={false} 
            />
          </div>

          {/* Unfriend Action */}
          {onRemoveFriend && (
            <div className="flex-shrink-0 pt-2">
              <button
                onClick={onRemoveFriend}
                className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/50 rounded-full text-xs font-bold flex items-center gap-2 transition-colors focus:outline-none focus:ring-0"
                title="Unfriend"
              >
                <UserMinus className="w-3.5 h-3.5" /> 
                <span className="hidden sm:inline">Unfriend</span>
              </button>
            </div>
          )}
        </div>

        {/* Content Area */}
        <div className="px-8 pb-8 overflow-y-auto">
          <div className="h-px w-full bg-void-border my-4" />

          <UserProfileFields
            displayProfile={displayProfile}
            draftProfile={displayProfile}
            isEditing={false}
            bioError={null}
            error={null}
            uploadError={null}
            setDraftProfile={() => {}}
            handleBioChange={() => {}}
          />

          {displayProfile.created_at && (
            <UserProfileStatus created_at={displayProfile.created_at} />
          )}
        </div>
      </div>
    </div>
  );
}
