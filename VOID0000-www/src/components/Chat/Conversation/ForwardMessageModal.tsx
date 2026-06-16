import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Search, Send, X } from 'lucide-react';
import { Conversation, Message, getConversations } from '../../../Services/Chat/chatService';
import UserAvatar from '../../common/UserAvatar';
import MessagePreviewText from '../Messages/MessagePreviewText';

interface ForwardMessageModalProps {
  isOpen: boolean;
  message: Message | null;
  currentConversationId?: string | null;
  onClose: () => void;
  onForward: (conversation: Conversation) => Promise<void> | void;
}

function getConversationLabel(conversation: Conversation) {
  if (conversation.type === 'dm') {
    return (
      conversation.dm_display_name ||
      conversation.dm_username ||
      'Direct message'
    );
  }

  return conversation.name || 'Unnamed group';
}

function getConversationSubtitle(conversation: Conversation) {
  if (conversation.type === 'dm') {
    return conversation.dm_username ? `@${conversation.dm_username}` : 'Direct message';
  }

  return `${conversation.member_count} member${conversation.member_count === 1 ? '' : 's'}`;
}

function getForwardPreview(message: Message | null) {
  if (!message) return null;
  if (message.is_deleted) return '[deleted]';
  if (message.content && message.content !== '[encrypted]') {
    return message.content;
  }
  if ((message.attachments?.length ?? 0) > 0) {
    return '[attachment]';
  }
  return '[encrypted]';
}

export default function ForwardMessageModal({
  isOpen,
  message,
  currentConversationId,
  onClose,
  onForward,
}: ForwardMessageModalProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [search, setSearch] = useState('');
  const [submittingConversationId, setSubmittingConversationId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setSearch('');
      setLoadError('');
      setSubmitError('');
      setSubmittingConversationId(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError('');
    setSubmitError('');

    void getConversations()
      .then((items) => {
        if (!cancelled) {
          setConversations(items);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load conversations');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const filteredConversations = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    if (!normalizedSearch) {
      return conversations;
    }

    return conversations.filter((conversation) => {
      const haystacks = [
        conversation.name || '',
        conversation.dm_display_name || '',
        conversation.dm_username || '',
      ].map((value) => value.toLowerCase());

      return haystacks.some((value) => value.includes(normalizedSearch));
    });
  }, [conversations, search]);

  if (!isOpen || !message) {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4">
      <button
        type="button"
        aria-label="Close forward message dialog"
        onClick={() => {
          if (!submittingConversationId) {
            onClose();
          }
        }}
        className="absolute inset-0"
      />
      <div
        className="relative z-[1] flex w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-void-bg-hover bg-void-bg-main/95 shadow-[0_28px_80px_rgba(0,0,0,0.45)] supports-[backdrop-filter]:backdrop-blur"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-void-bg-hover/80 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-void-text">Forward message</h2>
            <p className="mt-1 text-sm text-void-text-muted">
              Pick where this message should go.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={Boolean(submittingConversationId)}
            className="rounded-full p-2 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b border-void-bg-hover/80 px-5 py-4">
          <div className="rounded-2xl bg-void-bg-hover/55 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-void-text-muted">
              Forwarding
            </div>
            <div className="mt-2 text-sm text-void-text">
              <MessagePreviewText
                content={getForwardPreview(message)}
                maxLength={140}
                fallback="[encrypted]"
              />
            </div>
          </div>
        </div>

        <div className="px-5 py-4">
          <label className="flex items-center gap-3 rounded-2xl border border-void-bg-hover bg-void-bg-hover/35 px-4 py-3">
            <Search className="h-4 w-4 text-void-text-muted" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search conversations"
              className="w-full bg-transparent text-sm text-void-text placeholder:text-void-text-muted focus:outline-none"
            />
          </label>
        </div>

        <div className="max-h-[24rem] overflow-y-auto px-3 pb-3">
          {submitError ? (
            <div className="px-4 pb-3 text-sm text-orange-400">{submitError}</div>
          ) : null}
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-void-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading conversations…
            </div>
          ) : loadError ? (
            <div className="px-4 py-8 text-sm text-orange-400">{loadError}</div>
          ) : filteredConversations.length === 0 ? (
            <div className="px-4 py-8 text-sm text-void-text-muted">
              No conversations matched that search.
            </div>
          ) : (
            filteredConversations.map((conversation) => {
              const isSubmitting = submittingConversationId === conversation.id;
              const isCurrentConversation = conversation.id === currentConversationId;
              const label = getConversationLabel(conversation);
              const subtitle = getConversationSubtitle(conversation);

              return (
                <button
                  key={conversation.id}
                  type="button"
                  disabled={Boolean(submittingConversationId)}
                  onClick={async () => {
                    try {
                      setSubmitError('');
                      setSubmittingConversationId(conversation.id);
                      await onForward(conversation);
                      onClose();
                    } catch (err) {
                      setSubmitError(err instanceof Error ? err.message : 'Failed to forward message');
                    } finally {
                      setSubmittingConversationId(null);
                    }
                  }}
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-void-bg-hover/70 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {conversation.type === 'dm' ? (
                    <UserAvatar
                      src={conversation.dm_avatar_url}
                      displayName={conversation.dm_display_name}
                      username={conversation.dm_username}
                      className="h-11 w-11 shrink-0 rounded-full"
                      fallbackClassName="text-sm"
                    />
                  ) : (
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-void-accent/12 text-sm font-semibold text-void-accent">
                      {label.trim().charAt(0).toUpperCase() || '#'}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-void-text">{label}</span>
                      {isCurrentConversation ? (
                        <span className="shrink-0 rounded-full bg-void-accent/12 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-void-accent">
                          Current
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-void-text-muted">{subtitle}</div>
                  </div>
                  {isSubmitting ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-void-text-muted" />
                  ) : (
                    <Send className="h-4 w-4 shrink-0 text-void-text-muted" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
