import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Crown, Loader2, LogOut, MoreHorizontal, Pencil, Users } from 'lucide-react';
import UserAvatar from '../../../common/UserAvatar';
import type { ConversationMember } from '../../../../Services/Chat/chatService';
import {
  EDITABLE_ROLE_OPTIONS,
  getMemberLabel,
  getRoleLabel,
  ROLE_STYLES,
} from './shared';

interface BusyMemberAction {
  userId: string;
  action: 'role' | 'kick' | 'nickname' | 'leave' | 'transfer';
}

interface MembersTabProps {
  sortedMembers: ConversationMember[];
  memberRemovalPaused: boolean;
  currentUserId: string;
  canChangeMemberRoles: boolean;
  canKickMembers: boolean;
  memberMenuUserId: string | null;
  expandedRoleEditorUserId: string | null;
  busyMemberAction: BusyMemberAction | null;
  leaveBlockedReason: string;
  leaveButtonLabel: string;
  isOwner: boolean;
  canLeaveGroup: boolean;
  canTransferOwnership: boolean;
  onToggleMemberMenu: (userId: string) => void;
  onToggleRoleEditor: (userId: string) => void;
  onCloseRoleEditor: () => void;
  onRequestKickMember: (member: ConversationMember) => void;
  onRequestTransferOwnership: (member: ConversationMember) => void;
  onChangeMemberRole: (member: ConversationMember, nextRole: 'admin' | 'member') => void;
  onUpdateNickname: (member: ConversationMember, nickname: string | null) => Promise<boolean>;
  onRequestLeaveGroup: () => void;
}

export default function MembersTab({
  sortedMembers,
  memberRemovalPaused,
  currentUserId,
  canChangeMemberRoles,
  canKickMembers,
  memberMenuUserId,
  expandedRoleEditorUserId,
  busyMemberAction,
  leaveBlockedReason,
  leaveButtonLabel,
  isOwner,
  canLeaveGroup,
  canTransferOwnership,
  onToggleMemberMenu,
  onToggleRoleEditor,
  onCloseRoleEditor,
  onRequestKickMember,
  onRequestTransferOwnership,
  onChangeMemberRole,
  onUpdateNickname,
  onRequestLeaveGroup,
}: MembersTabProps) {
  const [nicknameEditorUserId, setNicknameEditorUserId] = useState<string | null>(null);
  const [nicknameInput, setNicknameInput] = useState('');
  const nicknameEditorMember =
    nicknameEditorUserId
      ? sortedMembers.find((member) => member.user_id === nicknameEditorUserId) || null
      : null;
  const isLeavingGroup = busyMemberAction?.action === 'leave';

  const openNicknameEditor = (member: ConversationMember) => {
    setNicknameEditorUserId(member.user_id);
    setNicknameInput(member.nickname || '');
    onToggleMemberMenu(member.user_id);
  };

  const closeNicknameEditor = () => {
    setNicknameEditorUserId(null);
    setNicknameInput('');
  };

  const handleNicknameSave = async (member: ConversationMember) => {
    const trimmed = nicknameInput.trim();
    const ok = await onUpdateNickname(member, trimmed === '' ? null : trimmed);
    if (ok) closeNicknameEditor();
  };

  const handleNicknameInputChange = (value: string) => {
    // Keep nicknames single-line even though we render a textarea for mobile keyboard behavior.
    setNicknameInput(value.replace(/[\r\n]+/g, ' '));
  };

  return (
    <div className="space-y-6">
      <section className="md:rounded-2xl md:border md:border-void-bg-hover md:bg-void-bg-main/40 md:p-5">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-void-text">Current Members</h3>
            <p className="mt-1 hidden text-sm text-void-text-muted md:block">
              Manage roles here, and use this list to monitor current membership state.
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full bg-void-bg-hover px-3 py-1 text-sm font-semibold text-void-text">
            <Users className="h-4 w-4 text-void-text-muted" />
            <span>{sortedMembers.length}</span>
          </div>
        </div>

        <div className="mt-4 space-y-3 md:mt-5">
          {memberRemovalPaused && (
            <div className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              Member removal is temporarily paused while we stabilize encrypted key delivery.
            </div>
          )}

          <div className="-mr-1 max-h-[min(52dvh,28rem)] space-y-3 overflow-y-auto overscroll-contain pr-1 md:max-h-[min(44dvh,22rem)]">
            {sortedMembers.map((member) => {
              const isRoleEditorOpen = expandedRoleEditorUserId === member.user_id;
              const isRoleBusy =
                busyMemberAction?.userId === member.user_id &&
                busyMemberAction.action === 'role';
              const isKickBusy =
                busyMemberAction?.userId === member.user_id &&
                busyMemberAction.action === 'kick';
              const isTransferBusy =
                busyMemberAction?.userId === member.user_id &&
                busyMemberAction.action === 'transfer';
              const isRegularMember = member.role === 'member' || member.role === 'viewer';
              const canTransferToThisMember =
                canTransferOwnership &&
                member.user_id !== currentUserId &&
                member.role !== 'owner';
              const canChangeThisMemberRole =
                canChangeMemberRoles &&
                member.user_id !== currentUserId &&
                member.role !== 'owner' &&
                (isOwner || isRegularMember);
              const canKickThisMember =
                canKickMembers &&
                member.user_id !== currentUserId &&
                member.role !== 'owner' &&
                (isOwner || isRegularMember);
              const hasModActions = canTransferToThisMember || canChangeThisMemberRole || canKickThisMember;

              const primaryLabel = member.nickname || getMemberLabel(member);
              const secondaryLabel = member.nickname
                ? getMemberLabel(member)
                : null;

              return (
                <div key={member.user_id} className="space-y-2">
                  <div className="flex items-start gap-3 rounded-xl border border-void-bg-hover bg-void-bg-sec/65 p-3 md:items-center md:px-4 md:py-3">
                    <UserAvatar
                      src={member.avatar_url}
                      displayName={member.display_name}
                      username={member.username}
                      className="h-10 w-10 shrink-0 rounded-full"
                      fallbackClassName="text-sm"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-medium text-void-text">
                          {primaryLabel}
                        </p>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold md:hidden ${ROLE_STYLES[member.role] || ROLE_STYLES.member}`}
                        >
                          {getRoleLabel(member.role)}
                        </span>
                        {member.user_id === currentUserId && (
                          <span className="rounded-full bg-void-accent/15 px-2 py-0.5 text-[11px] font-semibold text-void-accent">
                            You
                          </span>
                        )}
                      </div>
                      {secondaryLabel ? (
                        <p className="truncate text-sm text-void-text-muted">
                          {secondaryLabel} &middot; @{member.username}
                        </p>
                      ) : (
                        <p className="truncate text-sm text-void-text-muted">@{member.username}</p>
                      )}
                    </div>
                    <span
                      className={`hidden rounded-full px-2.5 py-1 text-[11px] font-semibold md:inline-flex ${ROLE_STYLES[member.role] || ROLE_STYLES.member}`}
                    >
                      {getRoleLabel(member.role)}
                    </span>
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        onClick={() => onToggleMemberMenu(member.user_id)}
                        className="rounded-lg p-2 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
                        title="Member actions"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>

                      {memberMenuUserId === member.user_id && (
                        <>
                          <button
                            type="button"
                            onClick={() => onToggleMemberMenu(member.user_id)}
                            className="fixed inset-0 z-[29] bg-black/45 md:hidden"
                            aria-label="Close member actions"
                          />
                          <div className="fixed inset-x-0 bottom-0 z-30 rounded-t-3xl border border-void-bg-hover bg-void-bg-main p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl md:absolute md:inset-x-auto md:bottom-auto md:right-0 md:top-11 md:z-20 md:w-[min(13rem,calc(100vw-3rem))] md:rounded-xl md:p-2">
                            <button
                              type="button"
                              onClick={() => openNicknameEditor(member)}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-void-text transition-colors hover:bg-void-bg-hover"
                            >
                              <Pencil className="h-3.5 w-3.5 text-void-text-muted" />
                              <span>{member.nickname ? 'Edit Nickname' : 'Set Nickname'}</span>
                            </button>

                            {hasModActions && (
                              <div className="my-2 h-px bg-void-bg-hover" />
                            )}

                            {canTransferToThisMember && (
                              <button
                                type="button"
                                onClick={() => onRequestTransferOwnership(member)}
                                disabled={isTransferBusy}
                                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-amber-200 transition-colors hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                <span className="inline-flex items-center gap-2">
                                  <Crown className="h-3.5 w-3.5" />
                                  Transfer Ownership
                                </span>
                                {isTransferBusy ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : null}
                              </button>
                            )}

                            {canChangeThisMemberRole && (
                              <button
                                type="button"
                                onClick={() => onToggleRoleEditor(member.user_id)}
                                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-void-text transition-colors hover:bg-void-bg-hover"
                              >
                                <span>Change Role</span>
                                {isRoleEditorOpen ? (
                                  <ChevronDown className="h-4 w-4 text-void-text-muted" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 text-void-text-muted" />
                                )}
                              </button>
                            )}

                            {canKickThisMember && (
                              <button
                                type="button"
                                onClick={() => onRequestKickMember(member)}
                                disabled={isKickBusy || memberRemovalPaused}
                                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                <span>{memberRemovalPaused ? 'Member Removal Paused' : 'Kick Member'}</span>
                                {isKickBusy ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : null}
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {canChangeThisMemberRole && isRoleEditorOpen && (
                    <div className="rounded-xl border border-void-bg-hover bg-void-bg-main/55 px-4 py-3">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-void-text">Change Role</p>
                          <p className="mt-1 text-xs text-void-text-muted">
                            Update what {getMemberLabel(member)} can do in this group.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={onCloseRoleEditor}
                          className="rounded-lg p-1.5 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </button>
                      </div>

                      <div className="grid gap-2 md:grid-cols-2">
                        {EDITABLE_ROLE_OPTIONS.map((roleOption) => (
                          <button
                            key={roleOption}
                            type="button"
                            onClick={() => onChangeMemberRole(member, roleOption)}
                            disabled={isRoleBusy}
                            className={`flex items-center justify-between rounded-xl px-4 py-3 text-left text-sm transition-colors ${
                              member.role === roleOption
                                ? 'bg-void-accent/15 text-void-accent ring-1 ring-void-accent/30'
                                : 'bg-void-bg-sec/70 text-void-text hover:bg-void-bg-hover'
                            } disabled:cursor-not-allowed disabled:opacity-60`}
                          >
                            <span>{getRoleLabel(roleOption)}</span>
                            {member.role === roleOption && <Check className="h-4 w-4" />}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {nicknameEditorMember && (
        <div className="fixed inset-0 z-[340] flex items-end justify-center bg-black/65 p-0 backdrop-blur-sm md:items-center md:p-4">
          <div className="w-full max-w-md rounded-t-3xl border border-void-bg-hover bg-void-bg-sec shadow-2xl md:rounded-2xl">
            <div className="border-b border-void-bg-hover px-5 py-4">
              <h3 className="text-base font-semibold text-void-text">
                Nickname for {getMemberLabel(nicknameEditorMember)}
              </h3>
              <p className="mt-1 text-sm text-void-text-muted">
                Set a group-specific nickname for this member.
              </p>
            </div>

            <div className="space-y-3 px-5 py-4">
              <textarea
                value={nicknameInput}
                onChange={(e) => handleNicknameInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleNicknameSave(nicknameEditorMember);
                  }
                  if (e.key === 'Escape') closeNicknameEditor();
                }}
                maxLength={32}
                placeholder="Enter a nickname..."
                autoFocus
                autoComplete="off"
                spellCheck={false}
                rows={1}
                className="w-full resize-none overflow-hidden rounded-xl border border-void-bg-hover bg-void-bg-main px-3 py-3 text-sm text-void-text placeholder-void-text-muted outline-none focus:border-void-accent/50 focus:ring-1 focus:ring-void-accent/25"
              />

              {nicknameEditorMember.nickname && (
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await onUpdateNickname(nicknameEditorMember, null);
                    if (ok) closeNicknameEditor();
                  }}
                  disabled={busyMemberAction?.userId === nicknameEditorMember.user_id && busyMemberAction.action === 'nickname'}
                  className="text-sm text-void-text-muted transition-colors hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Remove nickname
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 md:flex md:items-center md:justify-end md:pb-4">
              <button
                type="button"
                onClick={closeNicknameEditor}
                className="rounded-xl border border-void-bg-hover bg-void-bg-sec/70 px-4 py-2.5 text-sm font-medium text-void-text transition-colors hover:bg-void-bg-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { void handleNicknameSave(nicknameEditorMember); }}
                disabled={busyMemberAction?.userId === nicknameEditorMember.user_id && busyMemberAction.action === 'nickname'}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-void-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-void-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busyMemberAction?.userId === nicknameEditorMember.user_id && busyMemberAction.action === 'nickname' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Save nickname
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="md:rounded-2xl md:border md:border-void-bg-hover md:bg-void-bg-main/40 md:p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-red-500/10 text-red-400">
            <LogOut className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-void-text">Leaving This Group</h3>
            <p className="mt-1 text-xs leading-relaxed text-void-text-muted md:text-sm">
              {leaveBlockedReason}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onRequestLeaveGroup}
          disabled={!canLeaveGroup || isLeavingGroup}
          className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-60 md:w-auto ${
            canLeaveGroup
              ? 'bg-red-500/10 text-red-300 ring-red-500/20 hover:bg-red-500/15'
              : 'bg-red-500/5 text-red-400/70 ring-red-500/10'
          }`}
        >
          {isLeavingGroup ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <LogOut className="h-4 w-4" />
          )}
          {leaveButtonLabel}
        </button>
      </section>
    </div>
  );
}
