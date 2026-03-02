// src/components/Chat/MessageInput.tsx
import { Send, Plus, X, Pencil } from 'lucide-react';
import { useMessageInput } from '../../Services/hooks/Chats/useMessageInput'; // Adjust path as needed
import { Message, Conversation } from '../../Services/Chat/chatService';

interface MessageInputProps {
  conversation: Conversation;
  encryptionKey: CryptoKey | null;
  keyVersion: number;
  onMessageSent: (message: Message) => void;
  editingMessage?: Message | null;
  onCancelEdit?: () => void;
  replyTo?: string | null;
  onCancelReply?: () => void;
}

const MessageInput = (props: MessageInputProps) => {
  const {
    text,
    setText,
    sending,
    inputRef,
    getPlaceholder,
    handleSend,
    handleKeyDown,
    handleCancelAction
  } = useMessageInput(props);

  const { editingMessage, replyTo, encryptionKey } = props;

  return (
    <div className="p-4 shrink-0">
      {/* Edit / Reply indicator */}
      {(editingMessage || replyTo) && (
        <div className="flex items-center gap-2 mb-2 px-2 py-1.5 bg-gray-700/50 rounded-t-lg text-sm text-gray-400">
          {editingMessage ? (
            <>
              <Pencil className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-blue-400">Editing message</span>
              <span className="flex-1 truncate text-gray-500">
                {editingMessage.content?.substring(0, 50)}
              </span>
            </>
          ) : (
            <>
              <span className="text-blue-400">Replying to message</span>
            </>
          )}
          <button
            onClick={handleCancelAction}
            className="text-gray-500 hover:text-gray-300"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className={`bg-gray-700 flex items-center px-4 py-2.5 ${editingMessage || replyTo ? 'rounded-b-lg' : 'rounded-lg'}`}>
        <button className="text-gray-400 hover:text-gray-200 mr-3 bg-gray-600 rounded-full p-1">
          <Plus className="w-5 h-5" />
        </button>
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={getPlaceholder()}
          disabled={!encryptionKey || sending}
          className="flex-1 bg-transparent border-none focus:outline-none text-gray-100 placeholder-gray-400 disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={!text.trim() || !encryptionKey || sending}
          className="text-gray-400 hover:text-indigo-400 ml-3 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <Send className="w-5 h-5" />
        </button>
      </div>

      {/* E2E indicator */}
      <div className="flex items-center justify-center mt-1.5">
        <span className="text-[10px] text-gray-600">Messages are end-to-end encrypted</span>
      </div>
    </div>
  );
};

export default MessageInput;