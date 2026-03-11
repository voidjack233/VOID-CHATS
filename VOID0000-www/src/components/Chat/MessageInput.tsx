// src/components/Chat/MessageInput.tsx
import { useState, useRef, useEffect } from 'react';
import { Send, Plus, X, Pencil, CornerUpRight, ImageIcon, Loader2, Image, FileText, TimerReset } from 'lucide-react';
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
    sendError,
    slowmodeRemaining,
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

  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    if (!attachMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setAttachMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [attachMenuOpen]);

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

      {!sendError && slowmodeRemaining > 0 && props.conversation.type === 'channel' && (
        <div
          className={`flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-void-text-muted ${
            hasBanner || hasAttachments ? 'bg-void-bg-hover/50' : ''
          } ${hasBanner ? '' : 'rounded-t-lg'}`}
        >
          <TimerReset className="h-3.5 w-3.5 text-void-accent" />
          <span>Slowmode is enabled. You can send again in {slowmodeRemaining}s.</span>
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
      <div className={`bg-void-bg-hover flex items-end px-4 py-2.5 ${hasBanner || hasAttachments ? 'rounded-b-lg' : 'rounded-lg'}`}>
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />

        {/* Attach menu */}
        <div ref={attachMenuRef} className="relative mr-3 pb-1">
          <button
            onClick={() => setAttachMenuOpen((o) => !o)}
            disabled={!encryptionKey || attachments.length >= 5}
            className={`rounded-full p-1 transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${attachMenuOpen ? 'text-void-accent' : 'text-void-text-muted hover:text-void-text'
              }`}
            title="Attach"
          >
            <Plus className={`w-5 h-5 transition-transform duration-150 ${attachMenuOpen ? 'rotate-45' : ''}`} />
          </button>

          {attachMenuOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-44 bg-void-bg-main border border-void-bg-hover rounded-xl shadow-2xl py-1.5 z-50">
              {/* Media */}
              <button
                onClick={() => { openFilePicker(); setAttachMenuOpen(false); }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-void-text hover:bg-void-bg-hover transition-colors"
              >
                <Image className="w-4 h-4 text-void-accent" />
                Media
              </button>
              {/* Files — disabled */}
              <button
                disabled
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-void-text-muted opacity-40 cursor-not-allowed"
                title="Coming soon"
              >
                <FileText className="w-4 h-4" />
                Files
                <span className="ml-auto text-[10px] bg-void-bg-hover px-1.5 py-0.5 rounded-full">Soon</span>
              </button>
            </div>
          )}
        </div>

        {/* REPLACED INPUT WITH TEXTAREA */}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={getPlaceholder()}
          disabled={!encryptionKey}
          autoComplete="off"
          spellCheck="false"
          enterKeyHint="enter" // <-- This forces the mobile keyboard to show "Return"
          rows={1}
          className="flex-1 bg-transparent border-none focus:outline-none text-void-text placeholder-void-text-muted disabled:opacity-50 resize-none max-h-32 overflow-y-auto py-1"
        />

        <button
          onClick={handleSend}
          disabled={!canSend}
          className="text-void-text-muted hover:text-void-accent ml-3 pb-1 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          {sending ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Send className="w-5 h-5" />
          )}
        </button>
      </div>

      <div className="mt-1.5 flex min-h-[16px] items-center justify-center">
        {sendError ? (
          <span className="text-[10px] text-orange-400">
            {sendError}
          </span>
        ) : (
          <span className="text-[10px] text-void-text-muted">Messages are end-to-end encrypted</span>
        )}
      </div>
    </div>
  );
};

export default MessageInput;
