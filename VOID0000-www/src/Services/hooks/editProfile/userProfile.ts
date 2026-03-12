import { useState, useEffect } from 'react';
import { ensureCSRFToken } from '../../Auth/authServiceApi';
import { isGeneratedFallbackAvatarUrl } from '../../Chat/avatarFallback';

export interface UserProfileData {
  id: string;
  profile_id?: string;
  avatar_url?: string;
  username: string;
  display_name: string;
  bio: string;
  created_at: string;
}

import { API_URL } from '../../config';
const PROFILE_CACHE_KEY = 'void_profile';

const getCachedProfile = (profileId: string): UserProfileData | null => {
  const cached = localStorage.getItem(`${PROFILE_CACHE_KEY}_${profileId}`);
  if (!cached) return null;

  const parsed = JSON.parse(cached) as UserProfileData;
  if (isGeneratedFallbackAvatarUrl(parsed.avatar_url)) {
    parsed.avatar_url = undefined;
  }
  return parsed;
};

const setCachedProfile = (profileId: string, data: UserProfileData) => {
  localStorage.setItem(`${PROFILE_CACHE_KEY}_${profileId}`, JSON.stringify(data));
};

export const clearProfileCache = (profileId: string) => {
  localStorage.removeItem(`${PROFILE_CACHE_KEY}_${profileId}`);
};

export const useUserProfile = (profileId: string) => {
  const cached = getCachedProfile(profileId);
  
  const [profile, setProfile] = useState<UserProfileData | null>(cached);
  const [tempProfile, setTempProfile] = useState<UserProfileData | null>(cached);
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(!cached);
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
      setError('No profile ID provided');
      setLoading(false);
      return;
    }

    if (cached) {
      return;
    }

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
        
        setCachedProfile(profileId, data);
        setProfile(data);
        setTempProfile(data);
      } catch (err: any) {
        setError(err.message || 'Failed to load profile');
      } finally {
        setLoading(false);
      }
    };

    fetchProfile();
  }, [profileId, cached]);

  const saveProfile = async () => {
    if (!tempProfile) return;

    try {
      setSaving(true);
      setError(null);

      const headers = await getAuthHeaders();

      const res = await fetch(`${API_URL}/api/users/profile`, {
        method: 'PUT',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          display_name: tempProfile.display_name,
          bio: tempProfile.bio,
        }),
      });

      if (!res.ok) await handleFetchError(res, 'update');

      const updatedProfile = await res.json();

      const newProfileData = {
        ...profile!,
        display_name: updatedProfile.display_name,
        bio: updatedProfile.bio
      };

      setCachedProfile(profileId, newProfileData);
      setProfile(newProfileData);
      setTempProfile(newProfileData);
      setIsEditing(false);
    } catch (err: any) {
      setError(err.message || 'Failed to save profile changes');
    } finally {
      setSaving(false);
    }
  };

  const cancelEditing = () => {
    setTempProfile(profile);
    setIsEditing(false);
    setError(null);
  };

  return {
    profile,
    tempProfile,
    setTempProfile,
    setProfile,
    isEditing,
    setIsEditing,
    saveProfile,
    cancelEditing,
    loading,
    saving,
    error,
  };
};
