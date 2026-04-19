// src/components/Chat/MessageInput.tsx
import { useState, useRef, useEffect } from 'react';
import { Send, Plus, X, Pencil, CornerUpRight, Loader2, Image, FileText, TimerReset } from 'lucide-react';
import type { ConversationSecurityState } from '../../Services/Chat/conversationSecurityState';
import { useMessageInput } from '../../Services/hooks/Chats/useMessageInput';
import { Message, Conversation } from '../../Services/Chat/chatService';
import AttachmentLimitModal from './AttachmentLimitModal';
import FormattedMessageText from './FormattedMessageText';
import MessagePreviewText from './MessagePreviewText';

interface MessageInputProps {
  currentUserId?: string;
  conversation: Conversation;
  encryptionKey: CryptoKey | null;
  keyVersion: number;
  conversationSecurityState?: ConversationSecurityState;
  onMessageSent: (message: Message) => void;
  onEncryptionKeyResolved?: (key: CryptoKey, version: number) => void;
  editingMessage?: Message | null;
  onCancelEdit?: () => void;
  replyTo?: Message | null;
  onCancelReply?: () => void;
  onEditComplete?: (messageId: string, newContent: string) => void;
}

function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
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
    attachmentAlert,
    attachmentsAllowed,
    attachmentsRestrictionLabel,
    inputRef,
    mediaInputRef,
    fileInputRef,
    imageAccept,
    getPlaceholder,
    handleSend,
    handleKeyDown,
    handleCancelAction,
    handlePaste,
    openMediaPicker,
    openFilePicker,
    handleFileChange,
    removeAttachment,
    dismissAttachmentAlert,
  } = useMessageInput(props);

  const { editingMessage, replyTo, encryptionKey } = props;
  const hasAttachments = attachments.length > 0;
  const hasBanner = !!(editingMessage || replyTo);
  const hasCodeFenceDraft = text.includes('```');
  const showComposerPreview = text.length > 0 && !hasCodeFenceDraft;
  const canBootstrapDmOnSend =
    props.conversation.type === 'dm' &&
    Boolean(props.currentUserId) &&
    Boolean(props.conversation.dm_user_id) &&
    props.conversationSecurityState?.canSend !== false;
  const inputDisabled =
    props.conversationSecurityState?.canSend === false ||
    (!encryptionKey && !canBootstrapDmOnSend);

  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const composerPreviewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    const preview = composerPreviewRef.current;

    if (!input || !preview) return;

    input.style.height = 'auto';
    const targetHeight = Math.min(Math.max(input.scrollHeight, preview.scrollHeight), 120);
    input.style.height = `${targetHeight}px`;
  }, [inputRef, text]);

  const syncComposerScroll = () => {
    if (!inputRef.current || !composerPreviewRef.current) return;
    composerPreviewRef.current.scrollTop = inputRef.current.scrollTop;
    composerPreviewRef.current.scrollLeft = inputRef.current.scrollLeft;
  };

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
    <>
      <AttachmentLimitModal
        isOpen={Boolean(attachmentAlert)}
        onClose={dismissAttachmentAlert}
        title={attachmentAlert?.title}
        message={attachmentAlert?.message || ''}
      />
      <div className="sticky bottom-0 z-20 shrink-0 border-t border-void-bg-hover/80 bg-void-bg-sec/95 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] supports-[backdrop-filter]:backdrop-blur md:static md:border-t-0 md:bg-transparent md:pb-4">
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
                  : (
                    <MessagePreviewText
                      content={replyTo?.content}
                      maxLength={60}
                      fallback="[encrypted]"
                    />
                  )}
              </span>
            </>
          )}
          <button onClick={handleCancelAction} className="text-void-text-muted hover:text-void-text">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {!sendError && slowmodeRemaining > 0 && (
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
            <div
              key={a.id}
              className={`relative overflow-hidden rounded-lg bg-void-bg-main shrink-0 ${
                a.preview ? 'w-16 h-16' : 'flex w-40 h-16 items-center gap-2 px-3'
              }`}
            >
              {a.preview ? (
                <img src={a.preview} alt="" className="w-full h-full object-cover" />
              ) : (
                <>
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-void-bg-hover">
                    <FileText className="w-5 h-5 text-void-text-muted" />
                  </div>
                  <div className="min-w-0 flex-1 pr-3">
                    <div className="truncate text-xs font-medium text-void-text">
                      {a.name}
                    </div>
                    <div className="truncate text-[10px] text-void-text-muted">
                      {formatAttachmentSize(a.size)}
                    </div>
                  </div>
                </>
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
          ref={mediaInputRef}
          type="file"
          accept={imageAccept}
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />

        {/* Attach menu */}
        <div ref={attachMenuRef} className="relative mr-3 pb-1">
          <button
            onClick={() => setAttachMenuOpen((o) => !o)}
            disabled={inputDisabled || attachments.length >= 5}
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
                onClick={() => {
                  if (!attachmentsAllowed) return;
                  openMediaPicker();
                  setAttachMenuOpen(false);
                }}
                disabled={!attachmentsAllowed || attachments.length >= 5}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                  attachmentsAllowed && attachments.length < 5
                    ? 'text-void-text hover:bg-void-bg-hover'
                    : 'text-void-text-muted opacity-50 cursor-not-allowed'
                }`}
                title={
                  !attachmentsAllowed && attachmentsRestrictionLabel
                    ? `Only ${attachmentsRestrictionLabel.toLowerCase()} can send media in this group`
                    : undefined
                }
              >
                <Image className={`w-4 h-4 ${attachmentsAllowed ? 'text-void-accent' : 'text-void-text-muted'}`} />
                Media
                {!attachmentsAllowed && attachmentsRestrictionLabel && (
                  <span className="ml-auto text-[10px] bg-void-bg-hover px-1.5 py-0.5 rounded-full">
                    {attachmentsRestrictionLabel}
                  </span>
                )}
              </button>
              <button
                onClick={() => {
                  if (!attachmentsAllowed) return;
                  openFilePicker();
                  setAttachMenuOpen(false);
                }}
                disabled={!attachmentsAllowed || attachments.length >= 5}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                  attachmentsAllowed && attachments.length < 5
                    ? 'text-void-text hover:bg-void-bg-hover'
                    : 'text-void-text-muted opacity-50 cursor-not-allowed'
                }`}
                title={
                  !attachmentsAllowed && attachmentsRestrictionLabel
                    ? `Only ${attachmentsRestrictionLabel.toLowerCase()} can send files in this group`
                    : undefined
                }
              >
                <FileText className={`w-4 h-4 ${attachmentsAllowed ? 'text-void-accent' : 'text-void-text-muted'}`} />
                Files
                {!attachmentsAllowed && attachmentsRestrictionLabel && (
                  <span className="ml-auto text-[10px] bg-void-bg-hover px-1.5 py-0.5 rounded-full">
                    {attachmentsRestrictionLabel}
                  </span>
                )}
              </button>
            </div>
          )}
        </div>

        <div className="relative flex-1">
          {showComposerPreview ? (
            <div
              ref={composerPreviewRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden py-1 text-void-text"
            >
              <div className="whitespace-pre-wrap break-words leading-5">
                <FormattedMessageText
                  content={text}
                  linkClassName="font-medium underline decoration-current/70 decoration-2 underline-offset-2"
                  interactiveSpoilers={false}
                  codeBlockVariant="composer"
                  authoringMode
                />
              </div>
            </div>
          ) : null}

          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={syncComposerScroll}
            placeholder={getPlaceholder()}
            disabled={inputDisabled}
            autoComplete="off"
            spellCheck="false"
            enterKeyHint="enter"
            rows={1}
            className={`w-full border-none bg-transparent focus:outline-none placeholder-void-text-muted disabled:opacity-50 resize-none max-h-32 overflow-y-auto py-1 leading-5 ${
              showComposerPreview ? 'text-transparent caret-void-text' : 'text-void-text'
            }`}
          />
        </div>

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
        ) : props.conversationSecurityState?.detail ? (
          <span className="text-[10px] text-void-text-muted">
            {props.conversationSecurityState.detail}
          </span>
        ) : (
          <span className="text-[10px] text-void-text-muted">
            Messages are end-to-end encrypted
          </span>
        )}
      </div>
      </div>
    </>
  );
};

export default MessageInput;
