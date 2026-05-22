import { apiJson } from './http';

export interface Friend {
  friendship_id: number;
  friends_since: string;
  id: string;
  username: string;
  profile_id: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  member_since: string | null;
  status?: 'online' | 'idle' | 'offline';
  last_active?: number | null;
}

export interface FriendRequest {
  friendship_id: number;
  created_at: string;
  id: string;
  username: string;
  profile_id: string;
  display_name: string | null;
  avatar_url: string | null;
}

export type OutgoingRequest = FriendRequest;

export interface FriendshipRecord {
  id?: number;
  requester_id?: string;
  addressee_id?: string;
  status?: string;
  [key: string]: unknown;
}

interface FriendsResponse {
  success?: boolean;
  friends?: Friend[];
}

interface FriendRequestsResponse<T> {
  success?: boolean;
  requests?: T[];
}

interface FriendActionResponse {
  success?: boolean;
  message?: string;
}

export interface AcceptFriendRequestResponse extends FriendActionResponse {
  friendship?: FriendshipRecord;
}

export async function getFriends(): Promise<Friend[]> {
  const data = await apiJson<FriendsResponse>('/api/friends', {
    source: 'friendsApi.getFriends',
  });
  return data.friends || [];
}

export async function removeFriend(friendshipId: number): Promise<void> {
  await apiJson<FriendActionResponse>(`/api/friends/${friendshipId}`, {
    method: 'DELETE',
    source: 'friendsApi.removeFriend',
    fallbackMessage: 'Failed to remove friend',
  });
}
export async function getIncomingFriendRequests(): Promise<FriendRequest[]> {
  const data = await apiJson<FriendRequestsResponse<FriendRequest>>('/api/friends/requests/incoming', {
    source: 'friendsApi.getIncomingFriendRequests',
  });
  return data.requests || [];
}

export async function getOutgoingFriendRequests(): Promise<OutgoingRequest[]> {
  const data = await apiJson<FriendRequestsResponse<OutgoingRequest>>('/api/friends/requests/outgoing', {
    source: 'friendsApi.getOutgoingFriendRequests',
  });
  return data.requests || [];
}

export async function acceptFriendRequest(friendshipId: number): Promise<AcceptFriendRequestResponse> {
  return apiJson<AcceptFriendRequestResponse>(`/api/friends/accept/${friendshipId}`, {
    method: 'POST',
    source: 'friendsApi.acceptFriendRequest',
    fallbackMessage: 'Failed to accept friend request',
  });
}

export async function rejectFriendRequest(friendshipId: number): Promise<void> {
  await apiJson<FriendActionResponse>(`/api/friends/reject/${friendshipId}`, {
    method: 'POST',
    source: 'friendsApi.rejectFriendRequest',
    fallbackMessage: 'Failed to reject friend request',
  });
}

export async function sendFriendRequest(profileId: string): Promise<void> {
  await apiJson<FriendActionResponse>(`/api/friends/request/${profileId}`, {
    method: 'POST',
    source: 'friendsApi.sendFriendRequest',
    fallbackMessage: 'Failed to send request',
  });
}

export async function cancelFriendRequest(friendshipId: number): Promise<void> {
  await apiJson<FriendActionResponse>(`/api/friends/cancel/${friendshipId}`, {
    method: 'POST',
    source: 'friendsApi.cancelFriendRequest',
    fallbackMessage: 'Failed to cancel request',
  });
}
