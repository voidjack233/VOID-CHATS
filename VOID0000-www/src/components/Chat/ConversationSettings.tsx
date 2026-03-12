import { useState } from 'react';
import { X, LogOut, Users } from 'lucide-react';
import { Conversation } from '../../Services/Chat/chatService';
import { fetchWithAuth } from '../../Services/Auth/authServiceApi';

interface ConversationSettingsProps {
  conversation: Conversation;
  currentUserId: string;
  onClose: () => void;
  onLeft?: () => void;
}

const ConversationSettings = ({ conversation, currentUserId, onClose, onLeft }: ConversationSettingsProps) => {
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');

  const isGroup = conversation.type === 'group' || conversation.type === 'channel';
  const isOwner = conversation.owner_id === currentUserId;

  const handleLeave = async () => {
    if (isOwner) {
      setError('Transfer ownership before leaving this group.');
      return;
    }

    if (!confirm('Leave this conversation?')) return;
    setLeaving(true);
    setError('');
    try {
      const res = await fetchWithAuth(`/api/conversations/${conversation.id}/members/${currentUserId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to leave');
      onLeft?.();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLeaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm bg-void-bg-sec rounded-2xl shadow-2xl border border-void-bg-hover overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-void-bg-hover">
          <h2 className="font-semibold text-void-text">
            {isGroup ? 'Group Settings' : 'Conversation Settings'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-void-bg-hover text-void-text-muted hover:text-void-text transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Conversation info */}
          <div className="flex items-center gap-3 p-3 bg-void-bg-main rounded-xl">
            <div className="w-10 h-10 rounded-full bg-void-accent/20 flex items-center justify-center flex-shrink-0">
              <Users className="w-5 h-5 text-void-accent" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-void-text truncate">
                {isGroup ? (conversation.name || 'Unnamed Group') : (conversation.dm_display_name || conversation.dm_username || 'Direct Message')}
              </p>
              <p className="text-xs text-void-text-muted">
                {isGroup ? `${conversation.member_count} members` : 'Direct Message'}
              </p>
            </div>
          </div>

          {error && <p className="text-xs text-red-400 text-center">{error}</p>}

          {/* Leave */}
          {isGroup && (
            <button
              onClick={handleLeave}
              disabled={leaving}
              className="w-full flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              <LogOut className="w-4 h-4" />
              {leaving ? 'Leaving...' : isOwner ? 'Transfer Ownership First' : 'Leave Group'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ConversationSettings;
