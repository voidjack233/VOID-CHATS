import { useState } from 'react';
import { Hash, X } from 'lucide-react';
import { Conversation, createConversation } from '../../../Services/Chat/chatService';

interface CreateChannelModalProps {
  group: Conversation;
  initialCategoryId?: string | null;
  onClose: () => void;
  onCreated: (channel: Conversation) => void;
}

export default function CreateChannelModal({
  group,
  initialCategoryId,
  onClose,
  onCreated,
}: CreateChannelModalProps) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    const trimmed = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!trimmed) {
      setError('Channel name is required');
      return;
    }

    setCreating(true);
    setError('');

    try {
      const { conversation } = await createConversation(
        'channel',
        trimmed,
        [],
        group.public_id || group.id,
        initialCategoryId || null
      );
      onCreated(conversation);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create channel');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-void-border bg-void-bg-sec shadow-2xl">
        <div className="flex items-center justify-between border-b border-void-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Hash className="h-4 w-4 text-void-accent" />
            <h2 className="text-base font-semibold text-void-text">Create Text Channel</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div>
            <label className="mb-1 block text-sm text-void-text-muted">Channel Name</label>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="announcements"
              maxLength={100}
              className="w-full rounded-lg bg-void-bg-hover px-3 py-2 text-sm text-void-text placeholder-void-text-muted focus:outline-none focus:ring-2 focus:ring-void-accent"
            />
            <p className="mt-2 text-xs text-void-text-muted">
              This will be created inside <span className="font-semibold text-void-text">{group.name || 'this group'}</span>.
            </p>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-void-border px-5 py-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-void-text-muted transition-colors hover:text-void-text"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="rounded-lg bg-void-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-void-accent-hover disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create Channel'}
          </button>
        </div>
      </div>
    </div>
  );
}
