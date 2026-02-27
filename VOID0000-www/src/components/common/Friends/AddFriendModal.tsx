import { useState } from 'react';
import { X, Search, UserPlus, User, Loader2, Check, Users } from 'lucide-react';
import { API_URL } from '../../../Services/config';
import { useFriendRequests, FriendRequest } from '../../../Services/hooks/Friends/useFriendRequests';
import { useFriends } from '../../../Services/hooks/Friends/useFriends';
import { useScrollLock } from '../../../Services/hooks/common/useScrollLock';

interface AddFriendModalProps {
    onClose: () => void;
}

interface SearchResult {
    id: string;
    username: string;
    profile_id: string;
    display_name: string | null;
    avatar_url: string | null;
}

type FriendStatus = 'none' | 'friends' | 'incoming';

export default function AddFriendModal({ onClose }: AddFriendModalProps) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sendingTo, setSendingTo] = useState<string | null>(null);
    const [sentTo, setSentTo] = useState<string[]>([]);

    const { sendRequest, incoming } = useFriendRequests();
    const { friends } = useFriends();

    useScrollLock();

    const getFriendStatus = (profileId: string): FriendStatus => {
        if (friends.some(f => f.profile_id === profileId)) return 'friends';
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
            setSentTo(prev => [...prev, profileId]);
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
                        className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg text-white transition-colors"
                    >
                        {sendingTo === user.profile_id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            'Add'
                        )}
                    </button>
                );
        }
    };

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="bg-gray-800 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">

                {/* Header */}
                <div className="p-4 border-b border-gray-700 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <UserPlus className="w-5 h-5 text-blue-400" />
                        <h3 className="text-lg font-semibold text-white">Add Friend</h3>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-full hover:bg-gray-700 transition-colors"
                    >
                        <X className="w-5 h-5 text-gray-400" />
                    </button>
                </div>

                {/* Search Input */}
                <div className="p-4">
                    <div className="flex gap-2">
                        <div className="flex-1 relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                            <input
                                type="text"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Search by username..."
                                className="w-full pl-10 pr-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                                autoFocus
                            />
                        </div>
                        <button
                            onClick={handleSearch}
                            disabled={loading || !query.trim()}
                            className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white font-medium transition-colors"
                        >
                            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Search'}
                        </button>
                    </div>

                    {error && (
                        <p className="mt-3 text-sm text-red-400">{error}</p>
                    )}
                </div>

                {/* Results */}
                <div className="max-h-64 overflow-y-auto">
                    {results.length > 0 && (
                        <div className="px-4 pb-4 space-y-2">
                            {results.map((user) => (
                                <div
                                    key={user.profile_id}
                                    className="flex items-center justify-between p-3 bg-gray-900/50 rounded-lg"
                                >
                                    <div className="flex items-center gap-3">
                                        {user.avatar_url ? (
                                            <img
                                                src={user.avatar_url}
                                                alt={user.display_name || user.username}
                                                className="w-10 h-10 rounded-full object-cover"
                                            />
                                        ) : (
                                            <div className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center">
                                                <User className="w-5 h-5 text-gray-400" />
                                            </div>
                                        )}
                                        <div>
                                            <p className="text-white font-medium">
                                                {user.display_name || user.username}
                                            </p>
                                            <p className="text-gray-500 text-sm">@{user.username}</p>
                                        </div>
                                    </div>

                                    {renderStatusBadge(user)}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}