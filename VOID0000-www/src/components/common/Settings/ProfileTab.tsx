import { useState } from 'react';
import { Camera, Loader2, Save, CheckCircle } from 'lucide-react';
import { ProfileFormSkeleton } from '../Skeleton';
import { useUser } from '../../../Services/Auth/UserContext';
import { useProfileRecord, writeProfileCache } from '../../../Services/hooks/profile/useProfileRecord';
import { useProfileAvatarUpload } from '../../../Services/hooks/profile/useProfileAvatarUpload';
import UserAvatar from '../../common/UserAvatar';

const ProfileTab = () => {
  const { user } = useUser();
  const profileId = user?.profile_id;

  const {
    profile,
    draftProfile,
    setDraftProfile,
    setProfile,
    saveProfileFields,
    loading,
    error,
    saving,
  } = useProfileRecord(profileId || '');

  const {
    uploadProfileAvatar,
    validateFile,
    isUploading: isAvatarUploading,
    uploadError: hookUploadError,
    fileInputRef,
  } = useProfileAvatarUpload();

  const [bioError, setBioError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [localUploadError, setLocalUploadError] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [saveCooldown, setSaveCooldown] = useState(false);

  const finalUploadError = localUploadError || hookUploadError;
  const isGlobalLoading = saving || isAvatarUploading;

  // Dirty detection — only enable save when something actually changed
  // Trim values so trailing spaces don't count as changes
  const isDirty = (() => {
    if (pendingFile) return true;
    if (!profile || !draftProfile) return false;

    const origName = (profile.display_name || '').trim();
    const draftName = (draftProfile.display_name || '').trim();
    const origBio = (profile.bio || '').trim();
    const draftBio = (draftProfile.bio || '').trim();

    return origName !== draftName || origBio !== draftBio;
  })();

  const canSave = isDirty && !bioError && !isGlobalLoading && !saveCooldown;

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const validationError = validateFile(file);
      if (validationError) {
        setLocalUploadError(validationError);
        return;
      }
      setLocalUploadError(null);
      setPendingFile(file);
      setPreviewUrl(URL.createObjectURL(file));
    }
  };

  const handleBioChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newBio = e.target.value;
    if (newBio.length > 200) {
      setBioError('Maximum 200 characters reached');
      setDraftProfile({ ...draftProfile!, bio: newBio.slice(0, 200) });
      return;
    }
    setBioError(null);
    setDraftProfile({ ...draftProfile!, bio: newBio });
  };

  const handleSave = async () => {
    if (!canSave || !profileId) return;

    try {
      // Start cooldown immediately to prevent double-clicks
      setSaveCooldown(true);

      let newAvatarUrl: string | null = null;

      if (pendingFile) {
        newAvatarUrl = await uploadProfileAvatar(pendingFile);
      }

      const savedProfile = await saveProfileFields();
      const baseProfile = savedProfile || profile || draftProfile;
      if (!baseProfile) {
        throw new Error('Profile is not loaded.');
      }

      let finalAvatarUrl = newAvatarUrl || baseProfile.avatar_url;
      if (newAvatarUrl) {
        finalAvatarUrl = `${newAvatarUrl}?t=${Date.now()}`;
      }

      const finalProfile = {
        ...baseProfile,
        avatar_url: finalAvatarUrl,
      };

      setProfile(finalProfile);
      setDraftProfile(finalProfile);
      writeProfileCache(profileId, finalProfile);

      setPendingFile(null);
      setPreviewUrl(null);
      setIsSuccess(true);
      setTimeout(() => setIsSuccess(false), 3000);

      // 3 second cooldown before allowing another save
      setTimeout(() => setSaveCooldown(false), 3000);
    } catch (err) {
      console.error('Save failed:', err);
      setSaveCooldown(false); // Release cooldown on error so user can retry
    }
  };

  if (loading) return <ProfileFormSkeleton />;

  if (!profile || !draftProfile) {
    return (
      <div className="text-center py-12 text-void-text-muted">
        Unable to load profile
      </div>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6 pb-6">
      {/* Success Banner */}
      {isSuccess && (
        <div className="flex items-center gap-2 p-3 bg-green-900/30 border border-green-700/50 rounded-lg">
          <CheckCircle className="w-4 h-4 text-green-400" />
          <p className="text-sm text-green-300">Profile updated successfully!</p>
        </div>
      )}

      {/* Avatar */}
      <div>
        <h4 className="text-xs md:text-sm font-semibold text-void-text-muted uppercase mb-3">
          Profile Photo
        </h4>

        <div className="flex items-center gap-4">
          <div className="relative group">
            <div className="w-20 h-20 rounded-full bg-void-bg-hover overflow-hidden ring-2 ring-void-border">
              <UserAvatar
                src={previewUrl || profile?.avatar_url || null}
                displayName={profile?.display_name}
                username={profile?.username}
                alt="Avatar"
                className="w-full h-full rounded-full"
                fallbackClassName="text-2xl font-bold"
                fallbackTone="plain"
              />
            </div>

            {isAvatarUploading && (
              <div className="absolute inset-0 bg-black/60 rounded-full flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-white animate-spin" />
              </div>
            )}

            <button
              onClick={() => fileInputRef.current?.click()}
              className="absolute inset-0 bg-black/50 rounded-full flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer focus:outline-none"
              title="Change Photo"
            >
              <Camera className="w-5 h-5 text-white mb-0.5" />
              <span className="text-[9px] text-white font-bold uppercase tracking-wider">
                Change
              </span>
            </button>
          </div>

          <div>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 bg-gray-900 hover:bg-gray-900/70 border border-void-border hover:border-blue-500 rounded-lg text-sm text-void-text transition-all"
            >
              Upload Photo
            </button>
            <p className="text-xs text-void-text-muted mt-1">JPG, PNG, GIF or WebP. Max 5MB.</p>
          </div>

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileSelect}
            accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
            className="hidden"
          />
        </div>

        {finalUploadError && (
          <p className="text-xs text-red-400 mt-2">{finalUploadError}</p>
        )}
      </div>

      {/* Display Name */}
      <div className="border-t border-void-border pt-4">
        <h4 className="text-xs md:text-sm font-semibold text-void-text-muted uppercase mb-3">
          Display Name
        </h4>

        <div>
          <input
            type="text"
            value={draftProfile.display_name || ''}
            onChange={(e) =>
              setDraftProfile({ ...draftProfile, display_name: e.target.value })
            }
            className="w-full bg-gray-900 border border-void-border rounded-lg px-4 py-3 text-void-text text-sm focus:outline-none focus:border-blue-500 transition-colors"
            placeholder="Enter a display name"
          />
          <p className="text-xs text-void-text-muted mt-1">
            This is how others will see you. Your username stays @{profile.username}
          </p>
        </div>
      </div>

      {/* Bio */}
      <div className="border-t border-void-border pt-4">
        <h4 className="text-xs md:text-sm font-semibold text-void-text-muted uppercase mb-3">
          About Me
        </h4>

        <div>
          <textarea
            value={draftProfile.bio || ''}
            onChange={handleBioChange}
            maxLength={200}
            placeholder="Tell us about yourself..."
            className={`w-full bg-gray-900 border rounded-lg px-4 py-3 text-void-text text-sm resize-none focus:outline-none transition-colors ${
              bioError
                ? 'border-red-500 focus:border-red-500'
                : 'border-void-border focus:border-blue-500'
            }`}
            rows={3}
          />
          <div className="flex justify-between mt-1">
            <span className={`text-xs ${bioError ? 'text-red-400' : 'text-void-text-muted'}`}>
              {draftProfile.bio?.length || 0}/200
            </span>
            {bioError && <span className="text-xs text-red-400">{bioError}</span>}
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-900/30 border border-red-700/50 rounded-lg">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* Save Button */}
      <div className="border-t border-void-border pt-4">
        <button
          onClick={handleSave}
          disabled={!canSave}
          className={`px-5 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 transition-all ${
            !canSave
              ? 'bg-void-bg-hover text-void-text-muted cursor-not-allowed'
              : 'bg-blue-500 hover:bg-blue-600 text-white active:scale-[0.98]'
          }`}
        >
          {isGlobalLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {isGlobalLoading ? 'Saving...' : saveCooldown ? 'Saved!' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
};

export default ProfileTab;
