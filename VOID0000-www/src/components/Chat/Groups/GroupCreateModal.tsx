// src/components/Chat/Groups/GroupCreateModal.tsx
import { useState, useRef } from 'react';
import { X, Camera } from 'lucide-react';
import { createSecureGroup, uploadConversationIcon } from '../../../Services/Chat/chatService';

interface GroupCreateModalProps {
  onClose: () => void;
  onCreated: (conversationId: string) => void;
  currentUserId: string;
}

const GroupCreateModal = ({ onClose, onCreated, currentUserId }: GroupCreateModalProps) => {
  const [name, setName] = useState('');
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [iconData, setIconData] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result as string;
      setIconPreview(result);
      setIconData(result);
    };
    reader.readAsDataURL(file);
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Group name is required');
      return;
    }

    setCreating(true);
    setError('');

    try {
      const { conversation } = await createSecureGroup(name.trim(), [], currentUserId);

      if (iconData) {
        try {
          await uploadConversationIcon(conversation.id, iconData);
        } catch {
          // Icon upload failure is non-fatal
        }
      }

      onCreated(conversation.id);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create secure group');
    } finally {
      setCreating(false);
    }
  };

  const initial = name.trim() ? name.trim().charAt(0).toUpperCase() : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-void-bg-sec rounded-xl w-full max-w-sm mx-4 shadow-2xl border border-void-border">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-void-border">
          <h2 className="text-lg font-bold text-void-text">Create Secure Group</h2>
          <button onClick={onClose} className="text-void-text-muted hover:text-void-text transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Avatar preview + upload */}
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="relative group w-20 h-20 rounded-full overflow-hidden shrink-0 focus:outline-none"
              title="Upload group photo"
            >
              {iconPreview ? (
                <img src={iconPreview} className="w-full h-full object-cover" alt="" />
              ) : (
                <div className="w-full h-full bg-void-accent/15 text-void-accent flex items-center justify-center text-2xl font-bold">
                  {initial ?? <Camera className="w-7 h-7 opacity-40" />}
                </div>
              )}
              {/* Overlay on hover */}
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <Camera className="w-5 h-5 text-white" />
              </div>
            </button>
            <p className="text-xs text-void-text-muted">Optional group photo</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePhotoChange}
            />
          </div>

          {/* Name */}
          <div>
            <label className="text-sm text-void-text-muted mb-1 block">Group Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Secure Group"
              maxLength={100}
              className="w-full bg-void-bg-hover text-void-text rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-void-text-muted"
            />
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-void-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-void-text-muted hover:text-void-text transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            {creating ? 'Generating Keys...' : 'Create Group'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GroupCreateModal;
