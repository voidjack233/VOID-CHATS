import { apiJson, apiRequest, createApiError, parseApiJson } from './http';

export interface AccountData {
  id: string;
  email: string;
  username: string;
  profile_id?: string;
  created_at?: string;
}

export interface UserSearchResult {
  id: string;
  username: string;
  profile_id: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface ProfileRecord {
  id: string;
  profile_id?: string;
  avatar_url?: string;
  username: string;
  display_name: string;
  bio: string;
  created_at: string;
}

export interface Session {
  id: string;
  device_id: string;
  device_name: string | null;
  device_type: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  updated_at: string;
  last_live_at?: string | null;
  expires_at: string;
  is_current: boolean;
  has_live_session?: boolean;
  is_recently_active?: boolean;
}

interface AccountResponse {
  success?: boolean;
  account?: AccountData;
}

interface SearchResponse {
  success?: boolean;
  users?: UserSearchResult[];
}

interface SessionsResponse {
  success?: boolean;
  sessions?: Session[];
}

interface UpdateProfileInput {
  display_name: string;
  bio: string;
}

function createProfileError(response: Response, data: unknown, operation: string): Error {
  switch (response.status) {
    case 401:
      return new Error('Please log in to continue.');
    case 403:
      return new Error(`You don't have permission to ${operation} this profile.`);
    case 404:
      return new Error('Profile not found.');
    default:
      return createApiError(data, `Failed to ${operation} profile: ${response.statusText}`, {
        status: response.status,
        statusCode: response.status,
      });
  }
}

export async function getAccount(): Promise<AccountData | null> {
  const data = await apiJson<AccountResponse>('/api/users/account', {
    source: 'usersApi.getAccount',
    fallbackMessage: 'Failed to fetch account',
  });
  return data.account || null;
}

export async function searchUsers(query: string): Promise<UserSearchResult[]> {
  const params = new URLSearchParams({ q: query.trim() });
  const data = await apiJson<SearchResponse>(`/api/users/search?${params.toString()}`, {
    source: 'usersApi.searchUsers',
    fallbackMessage: 'Search failed',
  });
  return data.users || [];
}

export async function getUserProfile(profileId: string): Promise<ProfileRecord> {
  const response = await apiRequest(`/api/users/${profileId}`, {
    method: 'GET',
    source: 'usersApi.getUserProfile',
  });
  const data = await parseApiJson(response);

  if (!response.ok) {
    throw createProfileError(response, data, 'fetch');
  }

  if (data && typeof data === 'object' && 'success' in data && data.success === false) {
    throw createApiError(data, 'Failed to fetch profile', {
      status: response.status,
      statusCode: response.status,
    });
  }

  return data as ProfileRecord;
}

export async function updateProfile(input: UpdateProfileInput): Promise<Partial<ProfileRecord>> {
  const response = await apiRequest('/api/users/profile', {
    method: 'PUT',
    source: 'usersApi.updateProfile',
    body: JSON.stringify(input),
  });
  const data = await parseApiJson(response);

  if (!response.ok) {
    throw createProfileError(response, data, 'update');
  }

  if (data && typeof data === 'object' && 'success' in data && data.success === false) {
    throw createApiError(data, 'Failed to update profile', {
      status: response.status,
      statusCode: response.status,
    });
  }

  return data as Partial<ProfileRecord>;
}

export async function getActiveSessions(): Promise<Session[]> {
  const data = await apiJson<SessionsResponse>('/api/users/sessions', {
    source: 'usersApi.getActiveSessions',
    fallbackMessage: 'Failed to fetch sessions',
  });
  return data.sessions || [];
}

export async function revokeSession(sessionId: string): Promise<void> {
  await apiJson('/api/users/sessions/' + sessionId, {
    method: 'DELETE',
    source: 'usersApi.revokeSession',
    fallbackMessage: 'Failed to revoke session',
  });
}
export async function revokeAllSessions(): Promise<void> {
  await apiJson('/api/users/sessions', {
    method: 'DELETE',
    source: 'usersApi.revokeAllSessions',
    fallbackMessage: 'Failed to revoke sessions',
  });
}
