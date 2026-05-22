import { useState, useEffect } from 'react';
import { isGeneratedFallbackAvatarUrl } from '../../Chat/avatarFallback';
import { getUserProfile, updateProfile } from '../../api/usersApi';
import type { ProfileRecord } from '../../api/usersApi';

export type { ProfileRecord } from '../../api/usersApi';

const PROFILE_CACHE_KEY = 'void_profile';
const PROFILE_CACHE_EVENT = 'void:profile-cache-update';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

type ProfileCacheEventDetail = {
  profileId: string;
  profile: ProfileRecord | null;
};

const getCachedProfile = (profileId: string): ProfileRecord | null => {
  try {
    const cached = localStorage.getItem(`${PROFILE_CACHE_KEY}_${profileId}`);
    if (!cached) return null;

    const parsed = JSON.parse(cached) as ProfileRecord;
    if (isGeneratedFallbackAvatarUrl(parsed.avatar_url)) {
      parsed.avatar_url = undefined;
    }
    return parsed;
  } catch {
    localStorage.removeItem(`${PROFILE_CACHE_KEY}_${profileId}`);
    return null;
  }
};

const notifyProfileCacheUpdate = (profileId: string, profile: ProfileRecord | null) => {
  window.dispatchEvent(new CustomEvent<ProfileCacheEventDetail>(PROFILE_CACHE_EVENT, {
    detail: { profileId, profile },
  }));
};

export const writeProfileCache = (profileId: string, data: ProfileRecord) => {
  localStorage.setItem(`${PROFILE_CACHE_KEY}_${profileId}`, JSON.stringify(data));
  notifyProfileCacheUpdate(profileId, data);
};

export const clearProfileCache = (profileId: string) => {
  localStorage.removeItem(`${PROFILE_CACHE_KEY}_${profileId}`);
  notifyProfileCacheUpdate(profileId, null);
};

export const useProfileRecord = (profileId: string) => {
  const [profile, setProfile] = useState<ProfileRecord | null>(() => getCachedProfile(profileId));
  const [draftProfile, setDraftProfile] = useState<ProfileRecord | null>(() => getCachedProfile(profileId));
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(() => !getCachedProfile(profileId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profileId || !/^\d+$/.test(profileId)) {
      setProfile(null);
      setDraftProfile(null);
      setError('No profile ID provided');
      setLoading(false);
      return;
    }

    const cached = getCachedProfile(profileId);
    if (cached) {
      setProfile(cached);
      setDraftProfile(cached);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const fetchProfile = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = await getUserProfile(profileId);

        if (cancelled) return;

        writeProfileCache(profileId, data);
        setProfile(data);
        setDraftProfile(data);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(getErrorMessage(err, 'Failed to load profile'));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchProfile();
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  useEffect(() => {
    const handleProfileCacheUpdate = (event: Event) => {
      const { profileId: updatedProfileId, profile: updatedProfile } =
        (event as CustomEvent<ProfileCacheEventDetail>).detail || {};

      if (updatedProfileId !== profileId) return;

      setProfile(updatedProfile);
      setDraftProfile(updatedProfile);
      setError(null);
      setLoading(false);
    };

    window.addEventListener(PROFILE_CACHE_EVENT, handleProfileCacheUpdate);
    return () => window.removeEventListener(PROFILE_CACHE_EVENT, handleProfileCacheUpdate);
  }, [profileId]);

  const saveProfileFields = async (): Promise<ProfileRecord | null> => {
    if (!draftProfile) return null;

    try {
      setSaving(true);
      setError(null);
      const normalizedDisplayName = (draftProfile.display_name || '').trim();

      const updatedProfile = await updateProfile({
        display_name: normalizedDisplayName,
        bio: draftProfile.bio,
      });

      const baseProfile = profile || draftProfile;
      const newProfileData = {
        ...baseProfile,
        display_name: updatedProfile.display_name ?? normalizedDisplayName,
        bio: updatedProfile.bio ?? draftProfile.bio ?? '',
      };

      writeProfileCache(profileId, newProfileData);
      setProfile(newProfileData);
      setDraftProfile(newProfileData);
      setIsEditing(false);
      return newProfileData;
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to save profile changes'));
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const cancelEditing = () => {
    setDraftProfile(profile);
    setIsEditing(false);
    setError(null);
  };

  return {
    profile,
    draftProfile,
    setDraftProfile,
    setProfile,
    isEditing,
    setIsEditing,
    saveProfileFields,
    cancelEditing,
    loading,
    saving,
    error,
  };
};
