import { useCallback, useMemo, useState } from 'react';
import {
  Check,
  Loader2,
  Lock,
  PencilLine,
  UserRound,
  X,
} from 'lucide-react';
import UserAvatar from '../../common/UserAvatar';
import {
  sendSystemEvent,
  updateConversationNickname,
  type Conversation,
  type ConversationMember,
  type Message,
} from '../../../Services/Chat/chatService';

interface DirectConversationSettingsProps {
  conversation: Conversation;
  currentUserId: string;
  members: ConversationMember[];
  onMessageCreated?: (message: Message) => void;
  onConversationUpdated?: (conversation: Conversation) => Promise<void> | void;
  onClose: () => void;
}

const dmModeMeta = {
  label: 'MLS',
  description: 'MLS mode is enforced for 1-on-1 conversations.',
};

const dmModeBadgeClassName = 'bg-amber-500/15 text-amber-300 ring-amber-500/30';

function getMemberDisplayName(member: ConversationMember | null | undefined) {
  if (!member) return 'Unknown User';
  return member.display_name || member.username || 'Unknown User';
}

export default function DirectConversationSettings({
  conversation,
  currentUserId,
  members,
  onMessageCreated,
  onConversationUpdated,
  onClose,
}: DirectConversationSettingsProps) {
  const [nicknameEditorUserId, setNicknameEditorUserId] = useState<string | null>(null);
  const [nicknameInput, setNicknameInput] = useState('');
  const [nicknameBusyUserId, setNicknameBusyUserId] = useState<string | null>(null);
  const [nicknameError, setNicknameError] = useState('');
  const [nicknameOverrides, setNicknameOverrides] = useState<Record<string, string | null>>({});

  const participantList = useMemo(() => {
    const unique = new Map<string, ConversationMember>();
    members.forEach((member) => {
      if (!unique.has(member.user_id)) {
        unique.set(member.user_id, member);
      }
    });

    return [...unique.values()].sort((left, right) => {
      if (left.user_id === currentUserId) return -1;
      if (right.user_id === currentUserId) return 1;
      return getMemberDisplayName(left).localeCompare(getMemberDisplayName(right));
    });
  }, [currentUserId, members]);

  const peerMember = useMemo(
    () => participantList.find((member) => member.user_id !== currentUserId) || null,
    [currentUserId, participantList],
  );

  const getEffectiveNickname = useCallback(
    (member: ConversationMember) => {
      if (Object.prototype.hasOwnProperty.call(nicknameOverrides, member.user_id)) {
        return nicknameOverrides[member.user_id] ?? null;
      }
      return member.nickname ?? null;
    },
    [nicknameOverrides],
  );

  const getSystemLabel = useCallback(
    (member: ConversationMember | null | undefined) =>
      member?.display_name || member?.username || 'Someone',
    [],
  );

  const peerDisplayName =
    (peerMember ? getEffectiveNickname(peerMember) : null) ||
    conversation.dm_display_name ||
    conversation.dm_username ||
    getMemberDisplayName(peerMember) ||
    'Direct Message';

  const postNicknameSystemMessage = useCallback(
    async (text: string) => {
      try {
        const message = await sendSystemEvent(
          conversation.id,
          text,
          conversation.current_key_version || 1,
        );
        onMessageCreated?.(message);
      } catch (error) {
        console.warn('Failed to post DM nickname system message:', error);
      }
    },
    [conversation.current_key_version, conversation.id, onMessageCreated],
  );

  const startEditingNickname = useCallback(
    (member: ConversationMember) => {
      setNicknameEditorUserId(member.user_id);
      setNicknameInput(getEffectiveNickname(member) || '');
      setNicknameError('');
    },
    [getEffectiveNickname],
  );

  const stopEditingNickname = useCallback(() => {
    setNicknameEditorUserId(null);
    setNicknameInput('');
    setNicknameError('');
  }, []);

  const saveNickname = useCallback(
    async (member: ConversationMember, nextNickname: string | null) => {
      const normalizedCurrentNickname = getEffectiveNickname(member)?.trim() || null;
      const normalizedNextNickname = nextNickname?.trim() || null;

      if (normalizedCurrentNickname === normalizedNextNickname) {
        stopEditingNickname();
        return;
      }

      setNicknameBusyUserId(member.user_id);
      setNicknameError('');

      try {
        const result = await updateConversationNickname(
          conversation.id,
          member.user_id,
          nextNickname,
        );
        setNicknameOverrides((current) => ({
          ...current,
          [member.user_id]: result.nickname,
        }));

        if (member.user_id !== currentUserId) {
          const nextDmDisplayName =
            result.nickname ||
            member.display_name ||
            member.username ||
            conversation.dm_username ||
            conversation.dm_display_name ||
            'Direct Message';

          await onConversationUpdated?.({
            ...conversation,
            dm_display_name: nextDmDisplayName,
          });
        }

        const actorMember = participantList.find((entry) => entry.user_id === currentUserId) || null;
        const actorLabel = getSystemLabel(actorMember);
        const targetLabel = getSystemLabel(member);
        const text = result.nickname
          ? member.user_id === currentUserId
            ? `${actorLabel} changed their nickname to "${result.nickname}".`
            : `${actorLabel} changed ${targetLabel}'s nickname to "${result.nickname}".`
          : member.user_id === currentUserId
            ? `${actorLabel} cleared their nickname.`
            : `${actorLabel} cleared ${targetLabel}'s nickname.`;

        stopEditingNickname();
        void postNicknameSystemMessage(text);
      } catch (error) {
        console.error('Failed to update DM nickname:', error);
        setNicknameError(error instanceof Error ? error.message : 'Failed to save nickname.');
      } finally {
        setNicknameBusyUserId(null);
      }
    },
    [
      conversation,
      currentUserId,
      getEffectiveNickname,
      getSystemLabel,
      onConversationUpdated,
      participantList,
      postNicknameSystemMessage,
      stopEditingNickname,
    ],
  );

  const handleSaveNickname = useCallback(
    async (member: ConversationMember) => {
      const trimmed = nicknameInput.trim();
      await saveNickname(member, trimmed ? trimmed : null);
    },
    [nicknameInput, saveNickname],
  );

  return (
    <div className="fixed inset-0 z-[320] bg-black/55 backdrop-blur-sm">
      <div className="flex h-full items-center justify-center p-0 md:p-4">
        <div className="flex h-full w-full max-w-4xl flex-col overflow-hidden border border-void-bg-hover bg-void-bg-sec shadow-2xl md:h-[720px] md:rounded-2xl">
          <div className="flex items-center justify-between border-b border-void-bg-hover px-5 py-4 md:px-6">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-void-text">Conversation Settings</h2>
              <p className="mt-1 text-sm text-void-text-muted">
                Customize names in this 1-on-1 chat.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
              aria-label="Close conversation settings"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5 md:p-6">
            <div className="space-y-5">
              <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/50 p-4 md:p-5">
                <div className="flex items-center gap-3">
                  <UserAvatar
                    src={conversation.dm_avatar_url || peerMember?.avatar_url}
                    displayName={peerDisplayName}
                    username={conversation.dm_username || peerMember?.username}
                    className="h-12 w-12 rounded-full"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-void-text">{peerDisplayName}</p>
                    <p className="text-xs text-void-text-muted">Direct Message</p>
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-4 md:p-5">
                <div>
                  <p className="text-sm font-semibold text-void-text">Nicknames</p>
                  <p className="mt-1 text-sm text-void-text-muted">
                    Choose either person in this chat and set a conversation-specific nickname.
                  </p>
                </div>

                <div className="mt-4 space-y-3">
                  {participantList.map((member) => {
                    const effectiveNickname = getEffectiveNickname(member);
                    const isEditing = nicknameEditorUserId === member.user_id;
                    const isBusy = nicknameBusyUserId === member.user_id;
                    const isSelf = member.user_id === currentUserId;

                    return (
                      <div
                        key={member.user_id}
                        className="rounded-2xl border border-void-bg-hover bg-void-bg-sec/70 p-4"
                      >
                        <div className="flex items-start gap-3">
                          <UserAvatar
                            src={member.avatar_url}
                            displayName={member.display_name}
                            username={member.username}
                            className="h-10 w-10 shrink-0 rounded-full"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-semibold text-void-text">
                                {effectiveNickname || getMemberDisplayName(member)}
                              </p>
                              <span className="rounded-full bg-void-bg-hover px-2 py-0.5 text-[11px] text-void-text-muted">
                                {isSelf ? 'You' : 'Participant'}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-void-text-muted">
                              {effectiveNickname
                                ? `Account name: ${getMemberDisplayName(member)}`
                                : `Shown as ${getMemberDisplayName(member)} in this chat`}
                            </p>
                          </div>
                          {!isEditing ? (
                            <button
                              type="button"
                              onClick={() => startEditingNickname(member)}
                              className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-void-bg-hover bg-void-bg-main px-3 py-2 text-xs font-medium text-void-text transition-colors hover:border-void-accent/40 hover:text-white"
                            >
                              <PencilLine className="h-3.5 w-3.5" />
                              {effectiveNickname ? 'Edit' : 'Set'}
                            </button>
                          ) : null}
                        </div>

                        {isEditing ? (
                          <div className="mt-4 space-y-3">
                            <input
                              value={nicknameInput}
                              onChange={(event) => setNicknameInput(event.target.value)}
                              maxLength={32}
                              autoFocus
                              placeholder="Enter a nickname..."
                              className="w-full rounded-xl border border-void-bg-hover bg-void-bg-main px-3 py-2.5 text-sm text-void-text outline-none transition-colors placeholder:text-void-text-muted/70 focus:border-void-accent/50"
                            />
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => { void handleSaveNickname(member); }}
                                className="inline-flex items-center gap-2 rounded-xl bg-void-accent px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                Save nickname
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={stopEditingNickname}
                                className="rounded-xl border border-void-bg-hover bg-void-bg-main px-3 py-2 text-xs font-medium text-void-text-muted transition-colors hover:text-void-text disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Cancel
                              </button>
                              {effectiveNickname ? (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => { void saveNickname(member, null); }}
                                  className="rounded-xl border border-void-bg-hover bg-void-bg-main px-3 py-2 text-xs font-medium text-void-text-muted transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  Clear nickname
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                {nicknameError ? (
                  <p className="mt-3 text-sm text-rose-300">{nicknameError}</p>
                ) : null}
              </section>

              <section className="flex items-start gap-3 rounded-2xl border border-void-bg-hover bg-void-bg-main/35 p-4 md:p-5">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-void-accent/10 text-void-accent">
                  <Lock className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-void-text">Encryption Mode</h3>
                    <span
                      className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${dmModeBadgeClassName}`}
                    >
                      {dmModeMeta.label}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-void-text-muted">
                    {dmModeMeta.description} There are no extra 1-on-1 encryption switches to configure here.
                  </p>
                  <div className="mt-3 inline-flex items-center gap-2 rounded-xl border border-void-bg-hover bg-void-bg-sec px-3 py-2 text-sm text-void-text">
                    <UserRound className="h-4 w-4 text-void-text-muted" />
                    Message Security: MLS
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
