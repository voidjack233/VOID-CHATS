// src/components/Chat/MessageView.tsx
import { useState, useCallback } from 'react';
import { Hash, MessageCircle, Users, Pencil, Trash2, Reply, CornerUpRight, Smile } from 'lucide-react';
import { useMessageList } from '../../Services/hooks/Chats/useMessageList';
import { useMessageDisplay } from '../../Services/hooks/Chats/useMessageDisplay';
import { useReactions } from '../../Services/hooks/Chats/useReactions';
import { Message, Conversation, ConversationMember } from '../../Services/Chat/chatService';
import { useUser } from '../../Services/Auth/UserContext';
import EmojiPicker from './EmojiPicker';
import ReactionBar from './ReactionBar';

interface MessageViewProps {
  conversation: Conversation;
  encryptionKey: CryptoKey | null;
  encryptionError?: string | null; // <-- Added to catch the error state
  members: Record<string, ConversationMember>;
  onReply?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  newMessage?: Message | null;
  userAvatar?: string;
  gateway?: any;
  messageUpdate?: { message_id: string; content: string; is_edited: boolean; edited_at: string } | null;
  messageDelete?: { message_id: string } | null;
}

const MessageView = ({
  conversation,
  encryptionKey,
  encryptionError, // <-- Destructured here
  members,
  onReply,
  onEdit,
  newMessage,
  userAvatar,
  gateway,
  messageUpdate,
  messageDelete,
}: MessageViewProps) => {
  const { user } = useUser();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<{
    messageId: string;
    position: { x: number; y: number };
  } | null>(null);

  // Reactions hook — no separate API call, reads from message data
  const {
    getMessageReactions,
    handleToggleReaction,
    initReactionsFromMessages,
  } = useReactions(conversation.id, gateway);

  // Messages hook — passes initReactionsFromMessages as callback
  const {
    messages,
    loading,
    loadingMore,
    hasMore,
    bottomRef,
    containerRef,
    handleScroll,
    handleDelete,
    getReplyParent,
  } = useMessageList(
    conversation.id,
    encryptionKey,
    newMessage,
    messageUpdate,
    messageDelete,
    initReactionsFromMessages
  );

  const { formatTime, getSenderName, getSenderAvatarUrl } = useMessageDisplay(members, userAvatar);

  const openEmojiPicker = useCallback((messageId: string, event: React.MouseEvent) => {
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    setEmojiPickerTarget({
      messageId,
      position: { x: rect.left, y: rect.top },
    });
  }, []);

  const handleEmojiSelect = useCallback(
    (emoji: string) => {
      if (emojiPickerTarget && user?.id) {
        handleToggleReaction(emojiPickerTarget.messageId, emoji, user.id);
      }
      setEmojiPickerTarget(null);
    },
    [emojiPickerTarget, user?.id, handleToggleReaction]
  );

  const getConversationIcon = () => {
    switch (conversation.type) {
      case 'dm': return <MessageCircle className="w-10 h-10 text-white" />;
      case 'group': return <Users className="w-10 h-10 text-white" />;
      default: return <Hash className="w-10 h-10 text-white" />;
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // <-- Added Error Catch Block
  if (encryptionError) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-400 p-4 text-center">
        <p>Encryption Error: {encryptionError}</p>
      </div>
    );
  }

  if (!encryptionKey) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <p>Setting up encryption...</p>
      </div>
    );
  }

  const rendered = [...messages].reverse();

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-1">
      {loadingMore && (
        <div className="flex justify-center py-2">
          <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!hasMore && (
        <div className="mt-4 mb-6">
          <div className="w-16 h-16 bg-gray-700 rounded-full flex items-center justify-center mb-4">
            {getConversationIcon()}
          </div>
          <h1 className="text-2xl font-bold mb-1">
            {conversation.type === 'dm' ? conversation.dm_display_name || conversation.dm_username : conversation.name}
          </h1>
          <p className="text-gray-400 text-sm">This is the beginning of your conversation.</p>
        </div>
      )}

      {rendered.map((msg, index) => {
        const prevMsg = index > 0 ? rendered[index - 1] : null;
        const timeDiff = prevMsg ? new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime() : 0;
        const isReply = !!msg.reply_to;
        const isConsecutive = !isReply && prevMsg && prevMsg.sender_id === msg.sender_id && timeDiff < 5 * 60 * 1000;

        const replyParent = msg.reply_to ? getReplyParent(msg.reply_to) : null;
        const msgReactions = getMessageReactions(msg.message_id);

        return (
          <div
            key={msg.message_id}
            onMouseEnter={() => setHoveredId(msg.message_id)}
            onMouseLeave={() => setHoveredId(null)}
            className={`flex hover:bg-gray-700/30 p-2 -mx-2 rounded-md transition-colors relative group ${isConsecutive ? 'mt-0' : 'mt-4'}`}
          >
            {isConsecutive ? (
              <div className="w-10 mr-3 flex-shrink-0 flex items-center justify-center opacity-0 group-hover:opacity-100">
                <span className="text-[10px] text-gray-500 font-mono">
                  {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ) : (
              <div className="w-10 h-10 rounded-full overflow-hidden mr-3 flex-shrink-0 bg-gray-700 mt-0.5">
                <img src={getSenderAvatarUrl(msg.sender_id)} alt="avatar" className="w-full h-full object-cover" />
              </div>
            )}

            <div className="flex-1 min-w-0">
              {msg.reply_to && (
                <div className="flex items-center gap-1.5 mb-1 text-xs text-gray-500 cursor-pointer hover:text-gray-400 transition-colors">
                  <CornerUpRight className="w-3 h-3 text-gray-600 flex-shrink-0" />
                  {replyParent ? (
                    <>
                      <span className="font-semibold text-indigo-400/70">{getSenderName(replyParent.sender_id)}</span>
                      <span className="truncate max-w-[300px] text-gray-500">
                        {replyParent.is_deleted
                          ? '[deleted]'
                          : replyParent.content
                            ? replyParent.content.length > 80
                              ? replyParent.content.substring(0, 80) + '...'
                              : replyParent.content
                            : '[encrypted]'}
                      </span>
                    </>
                  ) : (
                    <span className="text-gray-600 italic">Loading reply...</span>
                  )}
                </div>
              )}

              {!isConsecutive && (
                <div className="flex items-baseline gap-2 mb-0.5">
                  <span className="font-semibold text-sm text-indigo-400">{getSenderName(msg.sender_id)}</span>
                  <span className="text-xs text-gray-500">{formatTime(msg.created_at)}</span>
                </div>
              )}

              <div className="flex items-baseline gap-2">
                <p className={`text-sm ${msg.is_deleted ? 'text-gray-600 italic' : 'text-gray-300'}`}>
                  {msg.content || '[encrypted]'}
                </p>
                {msg.is_edited && !msg.is_deleted && <span className="text-[10px] text-gray-500">(edited)</span>}
              </div>

              {!msg.is_deleted && (
                <ReactionBar
                  reactions={msgReactions}
                  currentUserId={user?.id || ''}
                  onToggle={(emoji) => user?.id && handleToggleReaction(msg.message_id, emoji, user.id)}
                  onAddReaction={() => {
                    const el = document.querySelector(`[data-msg-id="${msg.message_id}"]`);
                    if (el) {
                      const rect = el.getBoundingClientRect();
                      setEmojiPickerTarget({
                        messageId: msg.message_id,
                        position: { x: rect.left, y: rect.bottom + 8 },
                      });
                    }
                  }}
                />
              )}
            </div>

            {hoveredId === msg.message_id && !msg.is_deleted && (
              <div
                data-msg-id={msg.message_id}
                className="absolute right-2 top-1 flex items-center gap-0.5 bg-gray-800 border border-gray-700 rounded-md p-0.5 shadow-lg z-10"
              >
                <button
                  onClick={(e) => openEmojiPicker(msg.message_id, e)}
                  className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-gray-200"
                  title="Add reaction"
                >
                  <Smile className="w-3.5 h-3.5" />
                </button>
                {onReply && (
                  <button onClick={() => onReply(msg)} className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-gray-200">
                    <Reply className="w-3.5 h-3.5" />
                  </button>
                )}
                {msg.sender_id === user?.id && onEdit && (
                  <button onClick={() => onEdit(msg)} className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-gray-200">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
                {msg.sender_id === user?.id && (
                  <button onClick={() => handleDelete(msg.message_id)} className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-red-400">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {messages.length === 0 && !loading && (
        <p className="text-center text-gray-500 text-sm py-8">No messages yet. Say something!</p>
      )}

      <div ref={bottomRef} />

      {emojiPickerTarget && (
        <EmojiPicker
          onSelect={handleEmojiSelect}
          onClose={() => setEmojiPickerTarget(null)}
          position={emojiPickerTarget.position}
        />
      )}
    </div>
  );
};

export default MessageView;