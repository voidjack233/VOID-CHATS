import { Camera, ImageOff, Loader2, Save } from 'lucide-react';

interface ProfileTabProps {
  profileError: string;
  profileSuccess: string;
  displayedIconUrl: string | null;
  profileInitial: string;
  canManageProfile: boolean;
  profileSaving: boolean;
  hasRemovableIcon: boolean;
  onProfileFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onRequestRemoveProfileIcon: () => void;
  profileName: string;
  onProfileNameChange: (value: string) => void;
  onProfileNameFocus: () => void;
  onProfileNameBlur: () => void;
  isProfileNameFocused: boolean;
  isProfileDirty: boolean;
  onRequestSaveProfile: () => void;
}

export default function ProfileTab({
  profileError,
  profileSuccess,
  displayedIconUrl,
  profileInitial,
  canManageProfile,
  profileSaving,
  hasRemovableIcon,
  onProfileFileSelect,
  onRequestRemoveProfileIcon,
  profileName,
  onProfileNameChange,
  onProfileNameFocus,
  onProfileNameBlur,
  isProfileNameFocused,
  isProfileDirty,
  onRequestSaveProfile,
}: ProfileTabProps) {
  return (
    <div className="space-y-6">
      {profileError && (
        <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {profileError}
        </p>
      )}

      {profileSuccess && (
        <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          {profileSuccess}
        </p>
      )}

      <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-4 sm:p-5">
        <div className="mb-5">
          <h3 className="text-sm font-semibold text-void-text">Group Profile</h3>
          <p className="mt-1 hidden text-sm text-void-text-muted md:block">
            This is the identity members and invite visitors see for this group.
          </p>
        </div>

        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 text-center">
          <div className="flex flex-col items-center gap-3">
            {displayedIconUrl ? (
              <img
                src={displayedIconUrl}
                alt=""
                className="h-24 w-24 rounded-3xl border border-void-bg-hover object-cover"
              />
            ) : (
              <div className="flex h-24 w-24 items-center justify-center rounded-3xl border border-void-bg-hover bg-void-accent/15 text-3xl font-semibold text-void-accent">
                {profileInitial}
              </div>
            )}

            {canManageProfile && (
              <>
                <div className="flex w-full flex-col justify-center gap-2 sm:flex-row">
                  <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-void-bg-hover bg-void-bg-sec/70 px-4 py-2.5 text-sm font-medium text-void-text transition-colors hover:bg-void-bg-hover">
                    <Camera className="h-4 w-4" />
                    Upload Icon
                    <input
                      type="file"
                      accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                      className="hidden"
                      onChange={onProfileFileSelect}
                      disabled={profileSaving}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={onRequestRemoveProfileIcon}
                    disabled={!hasRemovableIcon || profileSaving}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-500/10 px-4 py-2.5 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <ImageOff className="h-4 w-4" />
                    Remove Icon
                  </button>
                </div>

                <p className="max-w-sm text-xs text-void-text-muted">
                  JPG, PNG, GIF or WebP. Max 7MB. The image is processed and stored for this group automatically.
                </p>
              </>
            )}
          </div>

          <div className="w-full space-y-4">
            <div className="rounded-2xl border border-void-bg-hover bg-void-bg-sec/55 p-4 text-left">
              <label htmlFor="group-profile-name" className="sr-only">Group Name</label>
              <input
                id="group-profile-name"
                type="text"
                value={profileName}
                onChange={(event) => onProfileNameChange(event.target.value)}
                onFocus={onProfileNameFocus}
                onBlur={onProfileNameBlur}
                maxLength={100}
                disabled={!canManageProfile || profileSaving}
                className="w-full rounded-xl border border-void-bg-hover bg-void-bg-hover px-4 py-3 text-center text-sm text-void-text outline-none transition-colors focus:border-void-accent disabled:cursor-not-allowed disabled:opacity-70"
                placeholder="Unnamed Group"
              />
              <div className="mt-3 flex items-start justify-between gap-4 text-xs text-void-text-muted">
                <div>
                  <p className="font-medium text-void-text">Group Name</p>
                  <p className="mt-1">The group name is what members see in the sidebar and invite screen.</p>
                </div>
                {isProfileNameFocused ? (
                  <span className="shrink-0 rounded-full border border-void-bg-hover bg-void-bg-main/70 px-2 py-1 text-[11px]">
                    {profileName.length}/100
                  </span>
                ) : null}
              </div>
            </div>

            {canManageProfile && (
              <div className="w-full">
                <button
                  type="button"
                  onClick={onRequestSaveProfile}
                  disabled={!isProfileDirty || profileSaving}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-void-accent px-4 py-3.5 text-sm font-medium text-white transition-colors hover:bg-void-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {profileSaving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save Changes
                </button>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
