import { useRef } from 'react';
import { X } from 'lucide-react';
import { useScrollLock } from '../../../Services/hooks/common/useScrollLock';
import { useProfileRecord } from '../../../Services/hooks/profile/useProfileRecord';
import UserProfileHeader from './UserProfileHeader';
import UserProfileFields from './UserProfileFields';
import UserProfileStatus from './UserProfileStatus';
import UserProfileLoading from './UserProfileLoading';
import UserProfileError from './UserProfileError';
import UserProfileEmpty from './UserProfileEmpty';
import { UserProfileProps } from './types';

const UserProfileModal: React.FC<UserProfileProps> = ({ profileId, onClose }) => {
  useScrollLock(); // Lock scroll when profile modal is open
  const dummyInputRef = useRef<HTMLInputElement>(null);

  const {
    profile,
    loading,
    error,
  } = useProfileRecord(profileId);

  if (loading) return <UserProfileLoading />;
  if (error) return <UserProfileError error={error} onClose={onClose} />;
  if (!profile) return <UserProfileEmpty onClose={onClose} />;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg bg-void-bg-sec rounded-2xl shadow-2xl border border-void-border overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Close Button */}
        <div className="absolute top-4 right-4 z-20">
          <button
            onClick={onClose}
            className="p-2 rounded-full bg-void-bg-sec/50 hover:bg-void-bg-hover text-void-text-muted hover:text-void-text transition-colors focus:outline-none"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Header Section */}
        <div className="p-6 pb-2 mt-6">
          <UserProfileHeader
            displayProfile={profile}
            previewUrl={null}
            isEditing={false}
            isUploading={false}
            fileInputRef={dummyInputRef}
            onFileSelect={() => {}}
            uploadError={null}
            allowUpload={false}
          />
        </div>

        {/* Content Area */}
        <div className="px-8 pb-8 overflow-y-auto">
          <div className="h-px w-full bg-void-border my-4" />

          <UserProfileFields
            displayProfile={profile}
            draftProfile={profile}
            isEditing={false}
            bioError={null}
            error={null}
            uploadError={null}
            setDraftProfile={() => {}}
            handleBioChange={() => {}}
          />

          {profile.created_at && (
            <UserProfileStatus created_at={profile.created_at} />
          )}
        </div>
      </div>
    </div>
  );
};

export default UserProfileModal;
