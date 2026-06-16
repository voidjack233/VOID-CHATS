// src/components/Chat/Composer/MessageInput.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Send,
  Plus,
  X,
  Pencil,
  CornerUpRight,
  Loader2,
  Image,
  FileText,
  TimerReset,
  Eye,
  EyeOff,
} from 'lucide-react';
import type { ConversationSecurityState } from '../../../Services/Chat/conversationSecurityState';
import { useMessageInput } from '../../../Services/hooks/Chats/useMessageInput';
import { Message, Conversation, ConversationMember } from '../../../Services/Chat/chatService';
import AttachmentLimitModal from '../Attachments/AttachmentLimitModal';
import AttachmentOptionsSheet from '../Attachments/AttachmentOptionsSheet';
import MessagePreviewText from '../Messages/MessagePreviewText';
import UserAvatar from '../../common/UserAvatar';

interface MessageInputProps {
  currentUserId?: string;
  conversation: Conversation;
  encryptionKey: CryptoKey | null;
  keyVersion: number;
  conversationSecurityState?: ConversationSecurityState;
  onMessageSent: (message: Message) => void;
  shouldJumpToPresentAfterOwnSend?: () => boolean;
  onOwnMessageSentFromHistory?: (message: Message) => Promise<void> | void;
  onSendError?: (message: string | null) => void;
  onEncryptionKeyResolved?: (key: CryptoKey, version: number) => void;
  editingMessage?: Message | null;
  onCancelEdit?: () => void;
  replyTo?: Message | null;
  onCancelReply?: () => void;
  onEditComplete?: (
    messageId: string,
    updates: {
      content: string;
      mentions?: Array<{ user_id: string; username: string }>;
      forwarded?: Message['forwarded'];
      link_preview?: Message['link_preview'];
      message_type?: string | null;
    },
  ) => void;
  members?: ConversationMember[];
}

interface MentionSuggestion {
  userId: string;
  username: string;
  primaryLabel: string;
  secondaryLabel: string | null;
  avatarUrl: string | null;
}

interface MentionQueryState {
  start: number;
  end: number;
  query: string;
}

function getActiveMentionQuery(text: string, cursor: number) {
  if (cursor < 0 || cursor > text.length) return null;

  const beforeCursor = text.slice(0, cursor);
  const start = beforeCursor.lastIndexOf('@');
  if (start === -1) return null;

  const previousChar = start > 0 ? text[start - 1] : '';
  if (previousChar && !/[\s([{'"`]/.test(previousChar)) {
    return null;
  }

  const rawQuery = text.slice(start + 1, cursor);
  if (/[\s\n]/.test(rawQuery)) {
    return null;
  }

  let end = cursor;
  while (end < text.length && /[A-Za-z0-9._-]/.test(text[end] || '')) {
    end += 1;
  }

  return {
    start,
    end,
    query: rawQuery,
  };
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
    toggleAttachmentSpoiler,
    retryAttachment,
    dismissAttachmentAlert,
  } = useMessageInput(props);

  const { editingMessage, replyTo, encryptionKey } = props;
  const hasAttachments = attachments.length > 0;
  const hasBanner = !!(editingMessage || replyTo);
  const isGroupConversation = props.conversation.type === 'group';
  const inputDisabled =
    props.conversationSecurityState?.canSend === false ||
    !encryptionKey;
  const isSecureChatPreparing =
    !encryptionKey &&
    props.conversationSecurityState?.status !== 'blocked';

  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [activeMentionQuery, setActiveMentionQuery] = useState<MentionQueryState | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [mobileAttachmentMenuId, setMobileAttachmentMenuId] = useState<string | null>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);

  const groupMembers = useMemo(() => {
    if (!isGroupConversation || !props.members) {
      return [];
    }

    const deduped = new Map<string, ConversationMember>();
    props.members.forEach((member) => {
      if (!member?.user_id || !member.username) return;
      deduped.set(member.user_id, member);
    });

    return Array.from(deduped.values());
  }, [isGroupConversation, props.members]);

  const mentionSuggestions = useMemo<MentionSuggestion[]>(() => {
    if (!activeMentionQuery) {
      return [];
    }

    const normalizedQuery = activeMentionQuery.query.trim().toLowerCase();

    return groupMembers
      .map((member) => {
        const primaryLabel =
          member.nickname ||
          member.display_name ||
          member.username;
        const secondaryLabel = member.nickname || member.display_name
          ? `@${member.username}`
          : null;

        return {
          userId: member.user_id,
          username: member.username,
          primaryLabel,
          secondaryLabel,
          avatarUrl: member.avatar_url,
        };
      })
      .filter((member) => {
        if (!normalizedQuery) return true;

        const haystacks = [
          member.username,
          member.primaryLabel,
          member.secondaryLabel || '',
        ].map((value) => value.toLowerCase());

        return haystacks.some((value) => value.includes(normalizedQuery));
      })
      .sort((a, b) => {
        const aStarts = a.username.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
        const bStarts = b.username.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.primaryLabel.localeCompare(b.primaryLabel);
      })
      .slice(0, 6);
  }, [activeMentionQuery, groupMembers]);

  const showMentionSuggestions =
    Boolean(activeMentionQuery) &&
    mentionSuggestions.length > 0 &&
    !inputDisabled;
  const mobileAttachmentMenu = attachments.find(
    (attachment) => attachment.id === mobileAttachmentMenuId,
  ) ?? null;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }, [inputRef, text]);

  useEffect(() => {
    if (!showMentionSuggestions) {
      setActiveMentionIndex(0);
      return;
    }

    setActiveMentionIndex((current) =>
      Math.min(current, Math.max(mentionSuggestions.length - 1, 0)),
    );
  }, [mentionSuggestions.length, showMentionSuggestions]);

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

  const syncMentionQuery = useCallback((nextText?: string, explicitCursor?: number | null) => {
    if (!isGroupConversation) {
      setActiveMentionQuery(null);
      return;
    }

    const sourceText = typeof nextText === 'string' ? nextText : text;
    const cursor = explicitCursor ?? inputRef.current?.selectionStart ?? sourceText.length;
    setActiveMentionQuery(getActiveMentionQuery(sourceText, cursor));
  }, [inputRef, isGroupConversation, text]);

  const handleSelectMention = useCallback((member: MentionSuggestion) => {
    if (!activeMentionQuery) return;

    const mentionToken = `@${member.username}`;
    const before = text.slice(0, activeMentionQuery.start);
    const after = text.slice(activeMentionQuery.end);
    const needsTrailingSpace =
      after.length === 0 ? true : !/^[\s.,!?;:)\]}]/.test(after);
    const trailing = needsTrailingSpace ? ' ' : '';
    const nextValue = `${before}${mentionToken}${trailing}${after}`;
    const nextCursor = before.length + mentionToken.length + trailing.length;

    setText(nextValue);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCursor, nextCursor);
      syncMentionQuery(nextValue, nextCursor);
    });
  }, [activeMentionQuery, inputRef, setText, syncMentionQuery, text]);

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionSuggestions) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveMentionIndex((current) => (current + 1) % mentionSuggestions.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveMentionIndex((current) =>
          current === 0 ? mentionSuggestions.length - 1 : current - 1,
        );
        return;
      }

      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        handleSelectMention(mentionSuggestions[activeMentionIndex]!);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setActiveMentionQuery(null);
        return;
      }
    }

    handleKeyDown(event);
  };

  return (
    <>
      <AttachmentLimitModal
        isOpen={Boolean(attachmentAlert)}
        onClose={dismissAttachmentAlert}
        title={attachmentAlert?.title}
        message={attachmentAlert?.message || ''}
      />
      <AttachmentOptionsSheet
        attachment={mobileAttachmentMenu}
        onClose={() => setMobileAttachmentMenuId(null)}
        onToggleSpoiler={toggleAttachmentSpoiler}
        onRemove={removeAttachment}
      />
      <div
        data-chat-message-input="true"
        className="sticky bottom-0 z-20 shrink-0 border-t border-void-bg-hover/80 bg-void-bg-sec/95 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] supports-[backdrop-filter]:backdrop-blur md:static md:border-t-0 md:bg-transparent md:pb-4"
      >
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

      {slowmodeRemaining > 0 && (
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
        <div className={`flex gap-3 px-3 pt-3 pb-2 bg-void-bg-hover flex-wrap ${hasBanner ? '' : 'rounded-t-lg'}`}>
          {attachments.map((a) => (
            <div
              key={a.id}
              className={`relative overflow-hidden rounded-lg bg-void-bg-main shrink-0 ${
                a.preview
                  ? 'h-20 w-20 md:h-40 md:w-40'
                  : 'flex h-16 w-40 items-center gap-2 px-3 md:h-20 md:w-52'
              }`}
            >
              {a.preview ? (
                <button
                  type="button"
                  onClick={() => setMobileAttachmentMenuId((current) => (
                    current === a.id ? null : a.id
                  ))}
                  className="block h-full w-full touch-manipulation md:pointer-events-none"
                  aria-label={`Options for ${a.name}`}
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <img
                    src={a.preview}
                    alt=""
                    className={`h-full w-full object-cover transition ${
                      a.spoiler ? 'scale-105 blur-xl brightness-50' : ''
                    }`}
                  />
                </button>
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
                <div className="absolute inset-0 bg-red-900/65 flex flex-col items-center justify-center gap-1 px-1">
                  <span className="text-[9px] text-white text-center">{a.error}</span>
                  <button
                    type="button"
                    onClick={() => retryAttachment(a.id)}
                    className="rounded-full bg-white/15 px-2 py-0.5 text-[9px] font-semibold text-white hover:bg-white/25"
                  >
                    Retry
                  </button>
                </div>
              )}
              {a.preview && !a.uploading && !a.error ? (
                <button
                  type="button"
                  onClick={() => toggleAttachmentSpoiler(a.id)}
                  className={`absolute bottom-2 left-2 hidden h-8 w-8 items-center justify-center rounded-full border text-white shadow-lg transition md:flex ${
                    a.spoiler
                      ? 'border-void-accent/60 bg-void-accent'
                      : 'border-white/15 bg-black/70 hover:bg-black/90'
                  }`}
                  aria-label={a.spoiler ? 'Remove spoiler' : 'Mark as spoiler'}
                  title={a.spoiler ? 'Remove spoiler' : 'Mark as spoiler'}
                >
                  {a.spoiler ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              ) : null}
              {a.preview && a.spoiler ? (
                <div className="pointer-events-none absolute left-1 top-1 md:left-2 md:top-2">
                  <span className="rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
                    Spoiler
                  </span>
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                className={`absolute right-1 top-1 h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white hover:bg-black/90 ${
                  a.preview ? 'hidden md:flex' : 'flex'
                }`}
                aria-label="Remove attachment"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main input row */}
      <div className={`bg-void-bg-hover flex items-center px-4 py-2.5 ${hasBanner || hasAttachments ? 'rounded-b-lg' : 'rounded-lg'}`}>
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
        <div ref={attachMenuRef} className="relative mr-3">
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
          {showMentionSuggestions ? (
            <div
              className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-2xl border border-void-bg-hover bg-void-bg-main/95 shadow-2xl supports-[backdrop-filter]:backdrop-blur"
            >
              <div className="border-b border-void-bg-hover/80 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-void-text-muted">
                Mention Someone
              </div>
              <div className="max-h-64 overflow-y-auto py-1">
                {mentionSuggestions.map((member, index) => {
                  const isActive = index === activeMentionIndex;

                  return (
                    <button
                      key={member.userId}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        handleSelectMention(member);
                      }}
                      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                        isActive ? 'bg-void-accent/12' : 'hover:bg-void-bg-hover/80'
                      }`}
                    >
                      <UserAvatar
                        src={member.avatarUrl}
                        displayName={member.primaryLabel}
                        username={member.username}
                        className="h-8 w-8 shrink-0 rounded-full"
                        fallbackClassName="text-[11px]"
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-void-text">
                          {member.primaryLabel}
                        </div>
                        <div className="truncate text-xs text-void-text-muted">
                          {member.secondaryLabel || `@${member.username}`}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              syncMentionQuery(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={handleComposerKeyDown}
            onClick={() => syncMentionQuery()}
            onKeyUp={() => syncMentionQuery()}
            onSelect={() => syncMentionQuery()}
            onPaste={handlePaste}
            placeholder={getPlaceholder()}
            disabled={inputDisabled}
            autoComplete="off"
            spellCheck="false"
            enterKeyHint="enter"
            rows={1}
            className="block w-full min-h-8 border-none bg-transparent text-void-text focus:outline-none placeholder-void-text-muted disabled:opacity-50 resize-none max-h-32 overflow-y-auto py-1.5 leading-5"
          />
        </div>

        <button
          onClick={handleSend}
          disabled={!canSend}
          className="text-void-text-muted hover:text-void-accent ml-3 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          {sending || isSecureChatPreparing ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Send className="w-5 h-5" />
          )}
        </button>
      </div>

      <div className="mt-1.5 flex min-h-[16px] items-center justify-center">
        <span className="text-[10px] text-void-text-muted">
          Messages are end-to-end encrypted
        </span>
      </div>
      </div>
    </>
  );
};

export default MessageInput;
