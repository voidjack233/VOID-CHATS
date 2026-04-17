import React from 'react';
import { Camera, Loader2, AlertCircle } from 'lucide-react';
import { UserProfileHeaderProps } from './types';
import UserAvatar from '../../common/UserAvatar';

const UserProfileHeader: React.FC<UserProfileHeaderProps & { 
  draftProfile?: any,
  setDraftProfile?: (p: any) => void
}> = ({
  displayProfile,
  draftProfile,
  setDraftProfile,
  previewUrl,
  isEditing,
  isUploading,
  fileInputRef,
  onFileSelect,
  uploadError,
  allowUpload = true,
}) => {
  return (
    <div className="flex items-center gap-5">
      {/* Hidden file input */}
      {isEditing && allowUpload && (
        <input
          type="file"
          ref={fileInputRef}
          onChange={onFileSelect}
          accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
          className="hidden"
        />
      )}

      {/* Avatar Section */}
      <div className="relative group flex-shrink-0">
        <div className="w-[88px] h-[88px] rounded-full bg-void-bg-hover overflow-hidden ring-4 ring-void-bg-secondary shadow-xl">
          <UserAvatar
            src={previewUrl || displayProfile.avatar_url || null}
            displayName={displayProfile.display_name}
            username={displayProfile.username}
            alt="Avatar"
            className="w-full h-full rounded-full"
            fallbackClassName="text-3xl font-bold"
            fallbackTone="plain"
          />
        </div>

        {isUploading && (
          <div className="absolute inset-0 bg-black/60 rounded-full flex items-center justify-center z-20">
            <Loader2 className="w-7 h-7 text-white animate-spin" />
          </div>
        )}

        {/* Camera overlay on hover */}
        {isEditing && allowUpload && !isUploading && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="absolute inset-0 bg-black/50 rounded-full flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer z-10 focus:outline-none"
            title="Change Photo"
          >
            <Camera className="w-5 h-5 text-white mb-0.5" />
            <span className="text-[9px] text-white font-bold uppercase tracking-wider">
              Change
            </span>
          </button>
        )}
      </div>

      {/* Identity Section (Name & Username) */}
      <div className="flex-1 min-w-0 flex flex-col justify-center">
        {isEditing ? (
          <div className="w-full max-w-[200px]">
            <label className="block text-[10px] font-bold text-void-text-muted uppercase tracking-wider mb-1">
              Display Name
            </label>
            <input
              type="text"
              value={draftProfile?.display_name || ''}
              onChange={(e) =>
                setDraftProfile?.({ ...draftProfile, display_name: e.target.value })
              }
              className="w-full bg-gray-900 border border-void-border rounded-md px-2.5 py-1.5 text-void-text text-sm focus:outline-none focus:border-blue-500 transition-colors placeholder-gray-600"
              placeholder="Display Name"
            />
          </div>
        ) : (
          <div>
            <h2 className="text-2xl font-bold text-void-text leading-tight truncate">
              {displayProfile.display_name || displayProfile.username}
            </h2>
            <p className="text-sm text-void-text-muted font-medium">@{displayProfile.username}</p>
          </div>
        )}

        {/* Upload error displayed under name */}
        {uploadError && (
          <div className="mt-2 flex items-center gap-1.5 text-red-400">
            <AlertCircle className="w-3.5 h-3.5" />
            <p className="text-xs">{uploadError}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default UserProfileHeader;
