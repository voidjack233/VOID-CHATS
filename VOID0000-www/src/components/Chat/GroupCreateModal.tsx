// src/components/Chat/GroupCreateModal.tsx
import { useState, useEffect } from 'react';
import { X, Check } from 'lucide-react';
import { fetchWithAuth } from '../../Services/Auth/authServiceApi';
import { createConversation } from '../../Services/Chat/chatService';

interface Friend {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string;
}

interface GroupCreateModalProps {
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}

const GroupCreateModal = ({ onClose, onCreated }: GroupCreateModalProps) => {
  const [name, setName] = useState('');
  const [friends, setFriends] = useState<Friend[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadFriends();
  }, []);

  const loadFriends = async () => {
    try {
      const res = await fetchWithAuth('/api/friends');
      const data = await res.json();
      if (data.success) {
        setFriends(data.friends || []);
      }
    } catch (err) {
      console.error('Failed to load friends:', err);
    } finally {
      setLoading(false);
    }
  };

  const toggleFriend = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (selected.size === 0) {
      setError('Select at least one member');
      return;
    }

    setCreating(true);
    setError('');

    try {
      const { conversation } = await createConversation('group', name.trim(), Array.from(selected));
      onCreated(conversation.id);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-800 rounded-xl w-full max-w-md mx-4 shadow-2xl border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-bold text-white">Create Group</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Name */}
          <div>
            <label className="text-sm text-gray-400 mb-1 block">Group Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Group"
              maxLength={100}
              className="w-full bg-gray-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-gray-500"
            />
          </div>

          {/* Friend selection */}
          <div>
            <label className="text-sm text-gray-400 mb-1 block">
              Add friends ({selected.size} selected)
            </label>
            <div className="max-h-48 overflow-y-auto space-y-1 bg-gray-900/50 rounded-lg p-2">
              {loading ? (
                <div className="flex justify-center py-4">
                  <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : friends.length === 0 ? (
                <p className="text-center text-gray-500 text-sm py-4">No friends yet</p>
              ) : (
                friends.map((friend) => (
                  <button
                    key={friend.id}
                    onClick={() => toggleFriend(friend.id)}
                    className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md transition-colors ${
                      selected.has(friend.id)
                        ? 'bg-indigo-500/20 text-white'
                        : 'hover:bg-gray-800 text-gray-300'
                    }`}
                  >
                    <img
                      src={friend.avatar_url}
                      className="w-8 h-8 rounded-full object-cover"
                      alt=""
                    />
                    <span className="flex-1 text-sm text-left truncate">
                      {friend.display_name || friend.username}
                    </span>
                    {selected.has(friend.id) && (
                      <Check className="w-4 h-4 text-indigo-400" />
                    )}
                  </button>
                ))
              )}
            </div>
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create Group'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GroupCreateModal;