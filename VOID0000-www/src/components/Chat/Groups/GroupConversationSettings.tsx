import { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, ChevronRight, Lock, X } from 'lucide-react';
import { Conversation, ConversationMember, Message } from '../../../Services/Chat/chatService';
import { useScrollLock } from '../../../Services/hooks/common/useScrollLock';
import ConfirmDialog from './ConversationSettings/ConfirmDialog';
import InvitesTab from './ConversationSettings/InvitesTab';
import MembersTab from './ConversationSettings/MembersTab';
import PermissionsTab from './ConversationSettings/PermissionsTab';
import ProfileTab from './ConversationSettings/ProfileTab';
import {
  getConversationInitial,
  getMemberLabel,
  GroupSettingsTab,
  SETTINGS_SECTIONS,
  SETTINGS_TABS,
} from './ConversationSettings/shared';
import { useGroupSettings } from './useGroupSettings';
import { useMobileView } from './useMobileView';

interface GroupConversationSettingsProps {
  conversation: Conversation;
  currentUserId: string;
  members: ConversationMember[];
  onMessageCreated?: (message: Message) => void;
  onConversationUpdated?: (conversation: Conversation) => Promise<void> | void;
  onMembershipChanged?: () => Promise<void> | void;
  onConversationLeft?: () => void;
  onClose: () => void;
}

const GroupConversationSettings = ({
  conversation,
  currentUserId,
  members,
  onMessageCreated,
  onConversationUpdated,
  onMembershipChanged,
  onConversationLeft,
  onClose,
}: GroupConversationSettingsProps) => {
  useScrollLock();

  const [activeTab, setActiveTab] = useState<GroupSettingsTab>('profile');
  const [floatingNotice, setFloatingNotice] = useState<string | null>(null);
  const { mobileView, setMobileView } = useMobileView(conversation.id);

  const settings = useGroupSettings({
    conversation,
    members,
    currentUserId,
    activeTab,
    onMessageCreated,
    onConversationUpdated,
    onMembershipChanged,
    onLeaveCompleted: () => {
      onClose();
      onConversationLeft?.();
    },
  });

  const { memberList, sortedMembers, permissions, profile, invites, members: membersSection } = settings;
  const { memberActionError, onClearMemberActionError } = membersSection;

  useEffect(() => {
    setActiveTab('profile');
  }, [conversation.id]);

  useEffect(() => {
    if (!memberActionError) {
      setFloatingNotice(null);
      return;
    }

    setFloatingNotice(memberActionError);
    const timeout = window.setTimeout(() => {
      setFloatingNotice(null);
      onClearMemberActionError();
    }, 3200);

    return () => window.clearTimeout(timeout);
  }, [memberActionError, onClearMemberActionError]);

  const openTab = (tab: GroupSettingsTab) => {
    setActiveTab(tab);
    if (window.innerWidth < 768) {
      setMobileView('detail');
    }
  };

  const activeTabMeta = SETTINGS_TABS.find((tab) => tab.id === activeTab);

  const renderActiveTabContent = () => {
    if (activeTab === 'profile') {
      return (
        <ProfileTab
          profileError={profile.profileError}
          profileSuccess={profile.profileSuccess}
          displayedIconUrl={profile.displayedIconUrl}
          profileInitial={getConversationInitial(profile.profileName || conversation.name)}
          canManageProfile={permissions.canManageProfile}
          profileSaving={profile.profileSaving}
          hasRemovableIcon={profile.hasRemovableIcon}
          onProfileFileSelect={profile.onProfileFileSelect}
          onRequestRemoveProfileIcon={profile.onRequestRemoveProfileIcon}
          profileName={profile.profileName}
          onProfileNameChange={profile.onProfileNameChange}
          onProfileNameFocus={profile.onProfileNameFocus}
          onProfileNameBlur={profile.onProfileNameBlur}
          isProfileNameFocused={profile.isProfileNameFocused}
          isProfileDirty={profile.isProfileDirty}
          onRequestSaveProfile={profile.onRequestSaveProfile}
        />
      );
    }

    if (activeTab === 'members') {
      return (
        <MembersTab
          sortedMembers={sortedMembers}
          memberRemovalPaused={membersSection.memberRemovalPaused}
          currentUserId={currentUserId}
          canChangeMemberRoles={permissions.canChangeMemberRoles}
          canKickMembers={permissions.canKickMembers}
          memberMenuUserId={membersSection.memberMenuUserId}
          expandedRoleEditorUserId={membersSection.expandedRoleEditorUserId}
          busyMemberAction={membersSection.busyMemberAction}
          leaveBlockedReason={permissions.leaveBlockedReason}
          leaveButtonLabel={permissions.leaveButtonLabel}
          isOwner={permissions.isOwner}
          canLeaveGroup={permissions.canLeaveGroup}
          canTransferOwnership={permissions.canTransferOwnership}
          onToggleMemberMenu={membersSection.onToggleMemberMenu}
          onToggleRoleEditor={membersSection.onToggleRoleEditor}
          onCloseRoleEditor={membersSection.onCloseRoleEditor}
          onRequestKickMember={membersSection.onRequestKickMember}
          onRequestTransferOwnership={membersSection.onRequestTransferOwnership}
          onChangeMemberRole={membersSection.onChangeMemberRole}
          onUpdateNickname={membersSection.onUpdateNickname}
          onRequestLeaveGroup={membersSection.onRequestLeaveGroup}
        />
      );
    }

    if (activeTab === 'invites') {
      return (
        <InvitesTab
          canManageInvites={permissions.canManageInvites}
          invitesLoading={invites.invitesLoading}
          invitesLoaded={invites.invitesLoaded}
          inviteError={invites.inviteError}
          inviteActionError={invites.inviteActionError}
          isCreatingInvite={invites.isCreatingInvite}
          busyInviteId={invites.busyInviteId}
          busyRequestId={invites.busyRequestId}
          copiedInviteId={invites.copiedInviteId}
          pendingRequests={invites.pendingRequests}
          inviteLinks={invites.inviteLinks}
          joinApprovalsPaused={invites.joinApprovalsPaused}
          joinApprovalsPausedMessage={invites.joinApprovalsPausedMessage}
          onRefreshInvites={invites.onRefreshInvites}
          onCreateInvite={invites.onCreateInvite}
          onDeclineRequest={invites.onDeclineRequest}
          onApproveRequest={invites.onApproveRequest}
          onCopyInvite={invites.onCopyInvite}
          onRevokeInvite={invites.onRevokeInvite}
        />
      );
    }

    if (activeTab === 'permissions') {
      return <PermissionsTab isOwner={permissions.isOwner} conversationId={conversation.id} />;
    }

    return null;
  };

  return (
    <div className="fixed inset-0 z-[320] bg-void-bg-main/90 md:bg-black/55 md:backdrop-blur-sm">
      {floatingNotice && (
        <div className="pointer-events-none fixed inset-x-0 top-4 z-[390] flex justify-center px-4 md:top-6">
          <div className="flex max-w-md items-start gap-3 rounded-2xl border border-red-400/25 bg-red-950/90 px-4 py-3 text-sm text-red-100 shadow-2xl shadow-black/35 backdrop-blur-md">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-300" />
            <p className="leading-relaxed">{floatingNotice}</p>
          </div>
        </div>
      )}
      <div className="flex h-full items-center justify-center p-0 md:p-4">
        <div className="flex h-full w-full flex-col overflow-hidden bg-void-bg-sec md:h-[680px] md:max-w-6xl md:flex-row md:rounded-2xl md:border md:border-void-bg-hover md:shadow-2xl">
          <aside className="hidden w-72 flex-shrink-0 border-r border-void-bg-hover bg-void-bg-main/55 md:flex md:flex-col">
            <div className="border-b border-void-bg-hover px-6 py-5">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-void-text-muted">Group Settings</p>
              <div className="mt-3 flex items-center gap-3">
                {conversation.icon_url ? (
                  <img
                    src={conversation.icon_url}
                    alt=""
                    className="h-10 w-10 rounded-2xl object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-void-accent/15 text-sm font-semibold text-void-accent">
                    {getConversationInitial(conversation.name)}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate font-semibold text-void-text">{conversation.name || 'Unnamed Group'}</p>
                  <p className="text-xs text-void-text-muted">{memberList.length} members</p>
                </div>
              </div>
            </div>

            <nav className="flex-1 overflow-y-auto p-4">
              <div className="space-y-5">
                {SETTINGS_SECTIONS.map((section) => (
                  <div key={section.label}>
                    <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-void-text-muted">
                      {section.label}
                    </p>
                    <div className="space-y-1">
                      {section.tabs.map((tab) => {
                        const isActive = activeTab === tab.id;
                        return (
                          <button
                            key={tab.id}
                            type="button"
                            disabled={tab.disabled}
                            onClick={() => setActiveTab(tab.id)}
                            className={`flex w-full items-center justify-between rounded-xl px-4 py-3 text-left text-sm transition-colors ${
                              tab.disabled
                                ? 'cursor-not-allowed text-void-text-muted/50'
                                : isActive
                                  ? 'bg-void-accent text-white'
                                  : 'text-void-text-muted hover:bg-void-bg-hover hover:text-void-text'
                            }`}
                          >
                            <span className="font-medium">{tab.label}</span>
                            {tab.disabled && <Lock className="h-4 w-4" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </nav>
          </aside>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="sticky top-0 z-10 border-b border-void-bg-hover bg-void-bg-sec px-4 py-4 md:px-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-3 min-w-0">
                    {mobileView === 'detail' ? (
                      <button
                        type="button"
                        onClick={() => setMobileView('menu')}
                        className="rounded-full bg-void-bg-main/80 p-2 text-void-text-muted transition-colors hover:bg-void-bg-main hover:text-void-text md:hidden"
                        aria-label="Back to group settings"
                      >
                        <ArrowLeft className="h-5 w-5" />
                      </button>
                    ) : null}
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-semibold text-void-text">
                        {mobileView === 'menu' ? 'Group Settings' : activeTabMeta?.label}
                      </h2>
                      <p className="mt-1 hidden text-sm text-void-text-muted md:block">
                        {mobileView === 'menu'
                          ? 'Choose a section to manage this group.'
                          : activeTabMeta?.description}
                      </p>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full bg-void-bg-main/80 p-2 text-void-text-muted transition-colors hover:bg-void-bg-main hover:text-void-text"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:p-6">
              <div className="md:hidden">
                {mobileView === 'menu' ? (
                  <div className="space-y-5">
                    <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-4">
                      <div className="flex items-center gap-3">
                        {conversation.icon_url ? (
                          <img
                            src={conversation.icon_url}
                            alt=""
                            className="h-12 w-12 rounded-2xl object-cover"
                          />
                        ) : (
                          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-void-accent/15 text-sm font-semibold text-void-accent">
                            {getConversationInitial(conversation.name)}
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-void-text">{conversation.name || 'Unnamed Group'}</p>
                          <p className="text-xs text-void-text-muted">{memberList.length} members</p>
                        </div>
                      </div>
                    </section>

                    {SETTINGS_SECTIONS.map((section) => (
                      <div key={section.label}>
                        <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-void-text-muted">
                          {section.label}
                        </p>
                        <div className="space-y-2">
                          {section.tabs.map((tab) => (
                            <button
                              key={tab.id}
                              type="button"
                              disabled={tab.disabled}
                              onClick={() => openTab(tab.id)}
                              className={`flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-4 text-left transition-all ${
                                tab.disabled
                                  ? 'cursor-not-allowed border-void-bg-hover bg-void-bg-main/25 text-void-text-muted/50'
                                  : 'border-void-bg-hover bg-void-bg-main/35 text-void-text-muted hover:border-void-bg-hover/80 hover:bg-void-bg-hover/60 hover:text-void-text'
                              }`}
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="truncate font-medium">{tab.label}</span>
                                  {tab.disabled && <Lock className="h-3.5 w-3.5 flex-shrink-0" />}
                                </div>
                              </div>
                              <ChevronRight className="h-4 w-4 flex-shrink-0 text-void-text-muted" />
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  renderActiveTabContent()
                )}
              </div>

              <div className="hidden md:block">
                {renderActiveTabContent()}
              </div>
            </div>
          </div>
        </div>

        {membersSection.kickConfirmMember && (
          <ConfirmDialog
            title="Remove Member"
            description={
              <>
                Remove <span className="font-semibold text-void-text">{getMemberLabel(membersSection.kickConfirmMember)}</span> from this group?
              </>
            }
            detail="They will lose access to future encrypted messages."
            confirmLabel="Remove Member"
            confirmVariant="danger"
            busy={
              membersSection.busyMemberAction?.action === 'kick' &&
              membersSection.busyMemberAction.userId === membersSection.kickConfirmMember.user_id
            }
            onCancel={membersSection.onCancelKickMember}
            onConfirm={() => membersSection.onConfirmKickMember(membersSection.kickConfirmMember!)}
          />
        )}

        {membersSection.leaveConfirmMode && (
          <ConfirmDialog
            title={membersSection.leaveConfirmMode === 'delete' ? 'Delete Group' : 'Leave Group'}
            description={
              membersSection.leaveConfirmMode === 'delete'
                ? 'You are the only member left. Leaving will permanently delete this group.'
                : 'Leave this group now?'
            }
            detail={
              membersSection.leaveConfirmMode === 'delete'
                ? 'This cannot be undone.'
                : 'You will lose access to future encrypted messages.'
            }
            confirmLabel={membersSection.leaveConfirmMode === 'delete' ? 'Delete and Leave' : 'Leave Group'}
            confirmVariant="danger"
            busy={membersSection.busyMemberAction?.action === 'leave'}
            onCancel={membersSection.onCancelLeaveGroup}
            onConfirm={membersSection.onConfirmLeaveGroup}
          />
        )}

        {membersSection.transferConfirmMember && (
          <ConfirmDialog
            title="Transfer Ownership"
            description={
              <>
                Transfer ownership to <span className="font-semibold text-void-text">{getMemberLabel(membersSection.transferConfirmMember)}</span>?
              </>
            }
            detail="You will become an admin after the transfer. Only the new owner can transfer ownership again or delete the group."
            confirmLabel="Transfer Ownership"
            confirmVariant="danger"
            busy={
              membersSection.busyMemberAction?.action === 'transfer' &&
              membersSection.busyMemberAction.userId === membersSection.transferConfirmMember.user_id
            }
            onCancel={membersSection.onCancelTransferOwnership}
            onConfirm={() => membersSection.onConfirmTransferOwnership(membersSection.transferConfirmMember!)}
          />
        )}

        {profile.showRemoveIconConfirm && (
          <ConfirmDialog
            title="Remove Group Icon"
            description="Remove the current group icon from this profile?"
            detail="This only stages the change. Nothing is applied until you press Save Changes."
            confirmLabel="Remove Icon"
            confirmVariant="danger"
            onCancel={profile.onCancelRemoveProfileIcon}
            onConfirm={profile.onConfirmRemoveProfileIcon}
          />
        )}

        {profile.showSaveProfileConfirm && (
          <ConfirmDialog
            title="Save Group Profile"
            description="Apply your staged group profile changes now?"
            detail="This will save the current name and any icon changes you previewed above."
            confirmLabel="Save Changes"
            busy={profile.profileSaving}
            onCancel={profile.onCancelSaveProfile}
            onConfirm={profile.onConfirmSaveProfile}
          />
        )}
      </div>
    </div>
  );
};

export default GroupConversationSettings;
