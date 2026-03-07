// src/components/Chat/MessageInput.tsx
import { Send, Plus, X, Pencil, CornerUpRight, ImageIcon, Loader2 } from 'lucide-react';
import { useMessageInput } from '../../Services/hooks/Chats/useMessageInput';
import { Message, Conversation } from '../../Services/Chat/chatService';

interface MessageInputProps {
  conversation: Conversation;
  encryptionKey: CryptoKey | null;
  keyVersion: number;
  onMessageSent: (message: Message) => void;
  editingMessage?: Message | null;
  onCancelEdit?: () => void;
  replyTo?: Message | null;
  onCancelReply?: () => void;
  onEditComplete?: (messageId: string, newContent: string) => void;
}

const MessageInput = (props: MessageInputProps) => {
  const {
    text,
    setText,
    sending,
    canSend,
    attachments,
    inputRef,
    fileInputRef,
    getPlaceholder,
    handleSend,
    handleKeyDown,
    handleCancelAction,
    handlePaste,
    openFilePicker,
    handleFileChange,
    removeAttachment,
  } = useMessageInput(props);

  const { editingMessage, replyTo, encryptionKey } = props;
  const hasAttachments = attachments.length > 0;
  const hasBanner = !!(editingMessage || replyTo);

  return (
    <div className="p-4 shrink-0">
      {/* Edit / Reply banner */}
      {hasBanner && (
        <div className="flex items-center gap-2 px-2 py-1.5 bg-void-bg-hover/50 rounded-t-lg text-sm text-void-text-muted">
          {editingMessage ? (
            <>
              <Pencil className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-blue-400">Editing message</span>
              <span className="flex-1 truncate text-void-text-muted">
                {editingMessage.content?.substring(0, 50)}
              </span>
            </>
          ) : (
            <>
              <CornerUpRight className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-blue-400 font-medium shrink-0">Replying</span>
              <span className="flex-1 truncate text-void-text-muted">
                {replyTo?.is_deleted
                  ? '[deleted]'
                  : replyTo?.content?.substring(0, 60) || '[encrypted]'}
              </span>
            </>
          )}
          <button onClick={handleCancelAction} className="text-void-text-muted hover:text-void-text">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Attachment preview strip */}
      {hasAttachments && (
        <div className={`flex gap-2 px-3 pt-3 pb-2 bg-void-bg-hover flex-wrap ${hasBanner ? '' : 'rounded-t-lg'}`}>
          {attachments.map((a) => (
            <div key={a.id} className="relative w-16 h-16 rounded-lg overflow-hidden bg-void-bg-main shrink-0">
              {a.preview ? (
                <img src={a.preview} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <ImageIcon className="w-6 h-6 text-void-text-muted" />
                </div>
              )}
              {a.uploading && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <Loader2 className="w-4 h-4 text-white animate-spin" />
                </div>
              )}
              {a.error && (
                <div className="absolute inset-0 bg-red-900/60 flex items-center justify-center">
                  <span className="text-[9px] text-white text-center px-1">{a.error}</span>
                </div>
              )}
              <button
                onClick={() => removeAttachment(a.id)}
                className="absolute top-0.5 right-0.5 w-4 h-4 bg-black/70 hover:bg-black/90 rounded-full flex items-center justify-center text-white"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main input row */}
      <div className={`bg-void-bg-hover flex items-center px-4 py-2.5 ${hasBanner || hasAttachments ? 'rounded-b-lg' : 'rounded-lg'}`}>
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />

        <button
          onClick={openFilePicker}
          disabled={!encryptionKey || attachments.length >= 5}
          className="text-void-text-muted hover:text-void-text mr-3 rounded-full p-1 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Attach image"
        >
          <Plus className="w-5 h-5" />
        </button>

        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={getPlaceholder()}
          disabled={!encryptionKey}
          className="flex-1 bg-transparent border-none focus:outline-none text-void-text placeholder-void-text-muted disabled:opacity-50"
        />

        <button
          onClick={handleSend}
          disabled={!canSend}
          className="text-void-text-muted hover:text-void-accent ml-3 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          {sending ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Send className="w-5 h-5" />
          )}
        </button>
      </div>

      <div className="flex items-center justify-center mt-1.5">
        <span className="text-[10px] text-void-text-muted">Messages are end-to-end encrypted</span>
      </div>
    </div>
  );
};

export default MessageInput;
