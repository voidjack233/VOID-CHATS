import { useState, useEffect } from 'react';
import { ensureCSRFToken } from '../../Auth/authServiceApi';
import { isGeneratedFallbackAvatarUrl } from '../../Chat/avatarFallback';
import { API_URL } from '../../config';

export interface ProfileRecord {
  id: string;
  profile_id?: string;
  avatar_url?: string;
  username: string;
  display_name: string;
  bio: string;
  created_at: string;
}

const PROFILE_CACHE_KEY = 'void_profile';
const PROFILE_CACHE_EVENT = 'void:profile-cache-update';

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

  const getAuthHeaders = async (): Promise<HeadersInit> => {
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    const csrfToken = await ensureCSRFToken();
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
    return headers;
  };

  const handleFetchError = async (response: Response, operation: string) => {
    switch (response.status) {
      case 401:
        throw new Error('Please log in to continue.');
      case 403:
        throw new Error(`You don't have permission to ${operation} this profile.`);
      case 404:
        throw new Error('Profile not found.');
      default:
        throw new Error(`Failed to ${operation} profile: ${response.statusText}`);
    }
  };

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
        const headers = await getAuthHeaders();

        const res = await fetch(`${API_URL}/api/users/${profileId}`, {
          method: 'GET',
          headers,
          credentials: 'include',
        });

        if (!res.ok) await handleFetchError(res, 'fetch');

        const data = await res.json();

        if (cancelled) return;

        writeProfileCache(profileId, data);
        setProfile(data);
        setDraftProfile(data);
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || 'Failed to load profile');
      } finally {
        if (cancelled) return;
        setLoading(false);
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

      const headers = await getAuthHeaders();

      const res = await fetch(`${API_URL}/api/users/profile`, {
        method: 'PUT',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          display_name: normalizedDisplayName,
          bio: draftProfile.bio,
        }),
      });

      if (!res.ok) await handleFetchError(res, 'update');

      const updatedProfile = await res.json();

      const baseProfile = profile || draftProfile;
      const newProfileData = {
        ...baseProfile,
        display_name: updatedProfile.display_name ?? normalizedDisplayName,
        bio: updatedProfile.bio
      };

      writeProfileCache(profileId, newProfileData);
      setProfile(newProfileData);
      setDraftProfile(newProfileData);
      setIsEditing(false);
      return newProfileData;
    } catch (err: any) {
      setError(err.message || 'Failed to save profile changes');
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
