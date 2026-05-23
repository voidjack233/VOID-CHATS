// src/components/common/Friends/AddFriend.tsx
import { useState } from 'react';
import { Search, UserPlus, Loader2, Check, Users } from 'lucide-react';
import { API_URL } from '../../../Services/config';
import { useFriendRequests, FriendRequest } from '../../../Services/hooks/Friends/useFriendRequests';
import { useFriends } from '../../../Services/hooks/Friends/useFriends';
import UserAvatar from '../../common/UserAvatar';

interface SearchResult {
  id: string;
  username: string;
  profile_id: string;
  display_name: string | null;
  avatar_url: string | null;
}

type FriendStatus = 'none' | 'friends' | 'incoming';

export default function AddFriend() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendingTo, setSendingTo] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string[]>([]);

  const { sendRequest, incoming } = useFriendRequests();
  const { friends } = useFriends();

  const getFriendStatus = (profileId: string): FriendStatus => {
    if (friends.some((f) => f.profile_id === profileId)) return 'friends';
    if (incoming.some((r: FriendRequest) => r.profile_id === profileId)) return 'incoming';
    return 'none';
  };

  const handleSearch = async () => {
    if (!query.trim()) return;

    try {
      setLoading(true);
      setError(null);

      const res = await fetch(
        `${API_URL}/api/users/search?q=${encodeURIComponent(query.trim())}`,
        { credentials: 'include' }
      );

      if (!res.ok) throw new Error('Search failed');

      const data = await res.json();
      setResults(data.users || []);

      if (data.users?.length === 0) {
        setError('No users found');
      }
    } catch (err: any) {
      setError(err.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handleSendRequest = async (profileId: string) => {
    setSendingTo(profileId);
    const result = await sendRequest(profileId);
    setSendingTo(null);

    if (result.success) {
      setSentTo((prev) => [...prev, profileId]);
    } else {
      setError(result.error || 'Failed to send request');
    }
  };

  const renderStatusBadge = (user: SearchResult) => {
    if (sentTo.includes(user.profile_id)) {
      return (
        <span className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-green-400 bg-green-900/20 rounded-lg">
          <Check className="w-3.5 h-3.5" />
          Sent!
        </span>
      );
    }

    const status = getFriendStatus(user.profile_id);

    switch (status) {
      case 'friends':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-blue-400 bg-blue-900/20 rounded-lg">
            <Users className="w-3.5 h-3.5" />
            Friends
          </span>
        );
      case 'incoming':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-purple-400 bg-purple-900/20 rounded-lg">
            <UserPlus className="w-3.5 h-3.5" />
            Accept?
          </span>
        );
      default:
        return (
          <button
            onClick={() => handleSendRequest(user.profile_id)}
            disabled={sendingTo === user.profile_id}
            className="px-4 py-2 text-sm bg-void-accent hover:bg-void-accent-hover disabled:opacity-50 rounded-lg text-white font-medium transition-colors"
          >
            {sendingTo === user.profile_id ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              'Add Friend'
            )}
          </button>
        );
    }
  };

  return (
    <div className="flex-1 flex flex-col p-6 max-w-3xl mx-auto w-full">
      {/* Header Info */}
      <div className="mb-8">
        <h2 className="text-xl font-bold text-void-text mb-2">ADD FRIEND</h2>
        <p className="text-sm text-void-text-muted">
          You can add friends with their void username.
        </p>
      </div>

      {/* Search Input Box */}
      <div className="bg-void-bg-main p-4 rounded-xl border border-void-border shadow-sm mb-8">
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-void-text-muted" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="You can add friends with their void username."
              className="w-full pl-11 pr-4 py-3 bg-void-bg-sec border border-transparent rounded-lg text-void-text placeholder-gray-500 focus:outline-none focus:border-void-accent transition-colors"
              autoFocus
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={loading || !query.trim()}
            className="px-6 py-3 bg-void-accent hover:bg-void-accent-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white font-medium transition-colors whitespace-nowrap"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : 'Search'}
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </div>

      {/* Results List */}
      <div className="flex-1 overflow-y-auto">
        {results.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-xs font-bold text-void-text-muted uppercase tracking-wider mb-4">
              Search Results
            </h3>
            {results.map((user) => (
              <div
                key={user.profile_id}
                className="flex items-center justify-between p-4 bg-void-bg-sec rounded-xl border border-transparent hover:border-void-border transition-colors group"
              >
                <div className="flex items-center gap-4">
                  <UserAvatar
                    src={user.avatar_url}
                    displayName={user.display_name}
                    username={user.username}
                    alt={user.display_name || user.username}
                    className="w-12 h-12 rounded-full"
                    fallbackClassName="text-base"
                  />
                  <div>
                    <p className="text-void-text font-bold text-base">
                      {user.display_name || user.username}
                    </p>
                    <p className="text-void-text-muted text-sm group-hover:text-void-text transition-colors">
                      @{user.username}
                    </p>
                  </div>
                </div>

                {renderStatusBadge(user)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
