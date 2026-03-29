import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, Lock, Shield, X } from 'lucide-react';
import {
  approveConversationJoinRequest,
  Conversation,
  ConversationInviteLink,
  ConversationJoinRequest,
  ConversationMember,
  Message,
  createConversationInviteLink,
  declineConversationJoinRequest,
  getConversationInvites,
  removeConversationIcon,
  rotateRemoveMember,
  revokeConversationInviteLink,
  sendSystemEvent,
  updateConversation,
  updateConversationNickname,
  updateMemberRole,
  uploadConversationIcon,
} from '../../../Services/Chat/chatService';
import { useScrollLock } from '../../../Services/hooks/common/useScrollLock';
import ConfirmDialog from './ConversationSettings/ConfirmDialog';
import InvitesTab from './ConversationSettings/InvitesTab';
import MembersTab from './ConversationSettings/MembersTab';
import PermissionsTab from './ConversationSettings/PermissionsTab';
import ProfileTab from './ConversationSettings/ProfileTab';
import {
  getConversationInitial,
  getMemberLabel,
  getRequestLabel,
  GroupSettingsTab,
  ROLE_ORDER,
  SETTINGS_SECTIONS,
  SETTINGS_TABS,
} from './ConversationSettings/shared';

interface GroupConversationSettingsProps {
  conversation: Conversation;
  currentUserId: string;
  members: ConversationMember[];
  onMessageCreated?: (message: Message) => void;
  onConversationUpdated?: (conversation: Conversation) => Promise<void> | void;
  onMembershipChanged?: () => Promise<void> | void;
  onClose: () => void;
}

const VALID_ICON_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const MAX_ICON_FILE_SIZE = 7 * 1024 * 1024;
const JOIN_APPROVALS_PAUSED = false;
const MEMBER_REMOVAL_PAUSED = false;
const JOIN_APPROVALS_PAUSED_MESSAGE =
  'Join approvals are temporarily paused while we stabilize encrypted key delivery.';

function validateIconFile(file: File) {
  if (!VALID_ICON_TYPES.includes(file.type)) {
    return 'Please select a JPG, PNG, GIF, or WebP image.';
  }

  if (file.size > MAX_ICON_FILE_SIZE) {
    return 'Image is too large. Please choose an image under 7MB.';
  }

  return null;
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }

      reject(new Error('Failed to read the selected image.'));
    };
    reader.onerror = () => reject(new Error('Failed to read the selected image.'));
    reader.readAsDataURL(file);
  });
}

const GroupConversationSettings = ({
  conversation,
  currentUserId,
  members,
  onMessageCreated,
  onConversationUpdated,
  onMembershipChanged,
  onClose,
}: GroupConversationSettingsProps) => {
  useScrollLock();

  const [activeTab, setActiveTab] = useState<GroupSettingsTab>('profile');
  const [mobileView, setMobileView] = useState<'menu' | 'detail'>('menu');
  const [memberList, setMemberList] = useState<ConversationMember[]>(members);
  const [currentKeyVersion, setCurrentKeyVersion] = useState<number>(conversation.current_key_version || 1);
  const [inviteLinks, setInviteLinks] = useState<ConversationInviteLink[]>([]);
  const [pendingRequests, setPendingRequests] = useState<ConversationJoinRequest[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [invitesLoaded, setInvitesLoaded] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteActionError, setInviteActionError] = useState('');
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);
  const [busyInviteId, setBusyInviteId] = useState<number | null>(null);
  const [busyRequestId, setBusyRequestId] = useState<number | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<number | null>(null);
  const [profileName, setProfileName] = useState(conversation.name || '');
  const [profilePreviewUrl, setProfilePreviewUrl] = useState<string | null>(null);
  const [pendingIconFile, setPendingIconFile] = useState<File | null>(null);
  const [removeCurrentIcon, setRemoveCurrentIcon] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');
  const [isProfileNameFocused, setIsProfileNameFocused] = useState(false);
  const [showRemoveIconConfirm, setShowRemoveIconConfirm] = useState(false);
  const [showSaveProfileConfirm, setShowSaveProfileConfirm] = useState(false);
  const [memberActionError, setMemberActionError] = useState('');
  const [memberMenuUserId, setMemberMenuUserId] = useState<string | null>(null);
  const [expandedRoleEditorUserId, setExpandedRoleEditorUserId] = useState<string | null>(null);
  const [kickConfirmMember, setKickConfirmMember] = useState<ConversationMember | null>(null);
  const [busyMemberAction, setBusyMemberAction] = useState<{
    userId: string;
    action: 'role' | 'kick' | 'nickname';
  } | null>(null);
  const isOwner = conversation.owner_id === currentUserId;
  const rootConversationId = conversation.id;
  const currentUserRole =
    memberList.find((member) => member.user_id === currentUserId)?.role ||
    conversation.role ||
    (isOwner ? 'owner' : null);
  const canManageInvites = isOwner;
  const canManageProfile = isOwner || currentUserRole === 'admin';
  const leaveBlockedReason = isOwner
    ? 'Transfer ownership before leaving this group.'
    : 'Secure leave is not available yet. Ask the group owner to remove you from this group.';
  const activeTabMeta = SETTINGS_TABS.find((tab) => tab.id === activeTab);
  const profileInitial = getConversationInitial(profileName || conversation.name);
  const displayedIconUrl = removeCurrentIcon ? (profilePreviewUrl || null) : (profilePreviewUrl || conversation.icon_url || null);
  const trimmedProfileName = profileName.trim();
  const membersSignature = useMemo(
    () =>
      [...members]
        .sort((left, right) => left.user_id.localeCompare(right.user_id))
        .map((member) =>
          [
            member.user_id,
            member.role,
            member.nickname || '',
            member.username,
            member.display_name || '',
            member.avatar_url || '',
            member.joined_at,
            member.joined_key_version ?? '',
            member.history_start_version ?? '',
          ].join(':')
        )
        .join('|'),
    [members]
  );
  const isProfileDirty =
    trimmedProfileName !== (conversation.name || '') ||
    !!pendingIconFile ||
    removeCurrentIcon;
  const canChangeMemberRoles = isOwner || currentUserRole === 'admin';
  const canKickMembers = isOwner;

  const getActorLabel = () => {
    const actor = memberList.find((member) => member.user_id === currentUserId);
    return actor?.display_name || actor?.username || 'A moderator';
  };

  const postMembershipSystemMessage = async (
    text: string,
    keyVersion: number
  ) => {
    try {
      const message = await sendSystemEvent(conversation.id, text, keyVersion);
      onMessageCreated?.(message);
    } catch (error) {
      console.warn('Failed to post membership system message:', error);
    }
  };

  const buildNicknameSystemMessage = (
    targetMember: ConversationMember,
    nextNickname: string | null,
  ) => {
    const actorLabel = getActorLabel();
    const targetLabel = getMemberLabel(targetMember);
    const isSelfChange = targetMember.user_id === currentUserId;

    if (nextNickname) {
      return isSelfChange
        ? `${targetLabel} changed their nickname to "${nextNickname}".`
        : `${actorLabel} changed ${targetLabel}'s nickname to "${nextNickname}".`;
    }

    return isSelfChange
      ? `${targetLabel} cleared their nickname.`
      : `${actorLabel} cleared ${targetLabel}'s nickname.`;
  };

  useEffect(() => {
    setActiveTab('profile');
    setMobileView(window.innerWidth >= 768 ? 'detail' : 'menu');
    setMemberMenuUserId(null);
    setExpandedRoleEditorUserId(null);
    setKickConfirmMember(null);
    setMemberActionError('');
  }, [conversation.id]);

  useEffect(() => {
    const syncMobileView = () => {
      if (window.innerWidth >= 768) {
        setMobileView('detail');
      } else {
        setMobileView('menu');
      }
    };

    syncMobileView();
    window.addEventListener('resize', syncMobileView);

    return () => {
      window.removeEventListener('resize', syncMobileView);
    };
  }, []);

  useEffect(() => {
    setMemberList(members);
  }, [conversation.id, membersSignature]);

  useEffect(() => {
    setCurrentKeyVersion(conversation.current_key_version || 1);
  }, [conversation.id, conversation.current_key_version]);

  useEffect(() => {
    setProfileName(conversation.name || '');
    setProfileError('');
    setProfileSuccess('');
    setPendingIconFile(null);
    setRemoveCurrentIcon(false);
    setProfilePreviewUrl((current) => {
      if (current?.startsWith('blob:')) {
        URL.revokeObjectURL(current);
      }
      return null;
    });
  }, [conversation.id, conversation.name, conversation.icon_url]);

  useEffect(() => {
    return () => {
      if (profilePreviewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(profilePreviewUrl);
      }
    };
  }, [profilePreviewUrl]);

  useEffect(() => {
    if (activeTab !== 'invites' || !canManageInvites) {
      return;
    }

    let ignore = false;

    const loadInvites = async () => {
      try {
        setInvitesLoading(true);
        setInviteError('');
        const data = await getConversationInvites(rootConversationId);
        if (ignore) return;
        setInviteLinks(data.invites);
        setPendingRequests(data.pending_requests);
        setInvitesLoaded(true);
      } catch (error) {
        if (ignore) return;
        console.error('Failed to load conversation invites:', error);
        setInviteError(
          error instanceof Error ? error.message : 'Failed to load invite links'
        );
      } finally {
        if (!ignore) {
          setInvitesLoading(false);
        }
      }
    };

    void loadInvites();

    return () => {
      ignore = true;
    };
  }, [activeTab, canManageInvites, rootConversationId]);

  const sortedMembers = useMemo(() => {
    return [...memberList].sort((left, right) => {
      const roleDelta = (ROLE_ORDER[left.role] ?? 99) - (ROLE_ORDER[right.role] ?? 99);
      if (roleDelta !== 0) return roleDelta;
      return getMemberLabel(left).localeCompare(getMemberLabel(right));
    });
  }, [memberList]);

  const refreshInvites = async () => {
    try {
      setInvitesLoading(true);
      setInviteError('');
      const data = await getConversationInvites(rootConversationId);
      setInviteLinks(data.invites);
      setPendingRequests(data.pending_requests);
      setInvitesLoaded(true);
    } catch (error) {
      console.error('Failed to refresh conversation invites:', error);
      setInviteError(
        error instanceof Error ? error.message : 'Failed to refresh invite links'
      );
    } finally {
      setInvitesLoading(false);
    }
  };

  const handleCreateInvite = async () => {
    try {
      setIsCreatingInvite(true);
      setInviteActionError('');
      const invite = await createConversationInviteLink(rootConversationId);
      setInviteLinks((current) => [invite, ...current.filter((entry) => entry.id !== invite.id)]);
    } catch (error) {
      console.error('Failed to create invite link:', error);
      setInviteActionError(
        error instanceof Error ? error.message : 'Failed to create invite link'
      );
    } finally {
      setIsCreatingInvite(false);
    }
  };

  const handleCopyInvite = async (invite: ConversationInviteLink) => {
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopiedInviteId(invite.id);
      window.setTimeout(() => {
        setCopiedInviteId((current) => (current === invite.id ? null : current));
      }, 1800);
    } catch (error) {
      console.error('Failed to copy invite link:', error);
      setInviteActionError('Failed to copy the invite link');
    }
  };

  const handleRevokeInvite = async (inviteId: number) => {
    try {
      setBusyInviteId(inviteId);
      setInviteActionError('');
      await revokeConversationInviteLink(rootConversationId, inviteId);
      setInviteLinks((current) =>
        current.map((invite) =>
          invite.id === inviteId ? { ...invite, is_revoked: true } : invite
        )
      );
    } catch (error) {
      console.error('Failed to revoke invite link:', error);
      setInviteActionError(
        error instanceof Error ? error.message : 'Failed to revoke invite link'
      );
    } finally {
      setBusyInviteId(null);
    }
  };

  const handleApproveRequest = async (request: ConversationJoinRequest) => {
    if (JOIN_APPROVALS_PAUSED) {
      setInviteActionError(JOIN_APPROVALS_PAUSED_MESSAGE);
      return;
    }

    try {
      setBusyRequestId(request.id);
      setInviteActionError('');

      const result = await approveConversationJoinRequest(
        { ...conversation, current_key_version: currentKeyVersion },
        currentUserId,
        memberList.map((member) => member.user_id),
        request.id,
        request.requester_user_id
      );

      setCurrentKeyVersion(result.key_version);
      setPendingRequests((current) => current.filter((entry) => entry.id !== request.id));
      setMemberList((current) => {
        if (current.some((member) => member.user_id === request.requester_user_id)) {
          return current;
        }

        return [
          ...current,
          {
            user_id: request.requester_user_id,
            role: 'member',
            nickname: null,
            joined_at: new Date().toISOString(),
            joined_key_version: result.key_version,
            history_start_version: result.key_version,
            username: request.username,
            display_name: request.display_name,
            avatar_url: request.avatar_url || null,
            profile_id: request.profile_id,
          },
        ];
      });

      const approvedLabel = getRequestLabel(request);
      const actorLabel = getActorLabel();
      void postMembershipSystemMessage(
        `${actorLabel} approved ${approvedLabel}'s join request.`,
        result.key_version
      );

      void onMembershipChanged?.();
    } catch (error) {
      console.error('Failed to approve join request:', error);
      setInviteActionError(
        error instanceof Error ? error.message : 'Failed to approve join request'
      );
      void refreshInvites();
    } finally {
      setBusyRequestId(null);
    }
  };

  const handleDeclineRequest = async (requestId: number) => {
    try {
      setBusyRequestId(requestId);
      setInviteActionError('');
      await declineConversationJoinRequest(rootConversationId, requestId);
      setPendingRequests((current) => current.filter((entry) => entry.id !== requestId));
    } catch (error) {
      console.error('Failed to decline join request:', error);
      setInviteActionError(
        error instanceof Error ? error.message : 'Failed to decline join request'
      );
    } finally {
      setBusyRequestId(null);
    }
  };

  const handleProfileFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const validationError = validateIconFile(file);
    if (validationError) {
      setProfileError(validationError);
      event.target.value = '';
      return;
    }

    setProfileError('');
    setProfileSuccess('');
    setPendingIconFile(file);
    setRemoveCurrentIcon(false);
    setProfilePreviewUrl((current) => {
      if (current?.startsWith('blob:')) {
        URL.revokeObjectURL(current);
      }
      return URL.createObjectURL(file);
    });
    event.target.value = '';
  };

  const handleRemoveProfileIcon = () => {
    setProfileError('');
    setProfileSuccess('');
    setPendingIconFile(null);
    setProfilePreviewUrl((current) => {
      if (current?.startsWith('blob:')) {
        URL.revokeObjectURL(current);
      }
      return null;
    });

    if (conversation.icon_url) {
      setRemoveCurrentIcon(true);
    }
  };

  const handleRequestRemoveProfileIcon = () => {
    if ((!conversation.icon_url && !pendingIconFile) || !canManageProfile || profileSaving) {
      return;
    }

    setShowRemoveIconConfirm(true);
  };

  const handleConfirmRemoveProfileIcon = () => {
    handleRemoveProfileIcon();
    setShowRemoveIconConfirm(false);
  };

  const handleRequestSaveProfile = () => {
    if (!canManageProfile || !isProfileDirty || profileSaving) {
      return;
    }

    setShowSaveProfileConfirm(true);
  };

  const handleSaveProfile = async () => {
    if (!canManageProfile) {
      setProfileError('Only the owner or an admin can update this group profile.');
      return;
    }

    if (!trimmedProfileName) {
      setProfileError('Group name is required.');
      return;
    }

    setProfileSaving(true);
    setProfileError('');
    setProfileSuccess('');

    try {
      let latestConversation = conversation;

      if (trimmedProfileName !== (conversation.name || '')) {
        const { conversation: updatedConversation } = await updateConversation(rootConversationId, {
          name: trimmedProfileName,
        });
        latestConversation = updatedConversation;
        await onConversationUpdated?.(updatedConversation);
      }

      if (removeCurrentIcon && conversation.icon_url) {
        const { conversation: updatedConversation } = await removeConversationIcon(rootConversationId);
        latestConversation = updatedConversation;
        await onConversationUpdated?.(updatedConversation);
      }

      if (pendingIconFile) {
        const base64Image = await readFileAsDataURL(pendingIconFile);
        const { conversation: updatedConversation } = await uploadConversationIcon(rootConversationId, base64Image);
        latestConversation = updatedConversation;
        await onConversationUpdated?.(updatedConversation);
      }

      setProfileName(latestConversation.name || '');
      setPendingIconFile(null);
      setRemoveCurrentIcon(false);
      setProfilePreviewUrl((current) => {
        if (current?.startsWith('blob:')) {
          URL.revokeObjectURL(current);
        }
        return null;
      });
      setProfileSuccess('Group profile updated.');
      window.setTimeout(() => {
        setProfileSuccess('');
      }, 2500);
    } catch (error) {
      console.error('Failed to update group profile:', error);
      setProfileError(
        error instanceof Error ? error.message : 'Failed to update group profile'
      );
    } finally {
      setProfileSaving(false);
    }
  };

  const handleChangeMemberRole = async (
    targetMember: ConversationMember,
    nextRole: 'admin' | 'member'
  ) => {
    if (targetMember.role === nextRole) {
      setMemberMenuUserId(null);
      return;
    }

    try {
      setBusyMemberAction({ userId: targetMember.user_id, action: 'role' });
      setMemberActionError('');
      await updateMemberRole(rootConversationId, targetMember.user_id, nextRole);
      setMemberList((current) =>
        current.map((member) =>
          member.user_id === targetMember.user_id
            ? { ...member, role: nextRole }
            : member
        )
      );
      setExpandedRoleEditorUserId(null);
      setMemberMenuUserId(null);
      void onMembershipChanged?.();
    } catch (error) {
      console.error('Failed to update member role:', error);
      setMemberActionError(
        error instanceof Error ? error.message : 'Failed to update member role'
      );
    } finally {
      setBusyMemberAction(null);
    }
  };

  const handleUpdateNickname = async (
    targetMember: ConversationMember,
    nickname: string | null
  ): Promise<boolean> => {
    const normalizedCurrentNickname = targetMember.nickname?.trim() || null;
    const normalizedNextNickname = nickname?.trim() || null;

    if (normalizedCurrentNickname === normalizedNextNickname) {
      return true;
    }

    try {
      setBusyMemberAction({ userId: targetMember.user_id, action: 'nickname' });
      setMemberActionError('');
      const result = await updateConversationNickname(rootConversationId, targetMember.user_id, nickname);
      setMemberList((current) =>
        current.map((member) =>
          member.user_id === targetMember.user_id
            ? { ...member, nickname: result.nickname }
            : member
        )
      );
      void postMembershipSystemMessage(
        buildNicknameSystemMessage(targetMember, result.nickname),
        currentKeyVersion
      );
      void onMembershipChanged?.();
      return true;
    } catch (error) {
      console.error('Failed to update nickname:', error);
      setMemberActionError(
        error instanceof Error ? error.message : 'Failed to update nickname'
      );
      return false;
    } finally {
      setBusyMemberAction(null);
    }
  };

  const handleKickMember = async (targetMember: ConversationMember) => {
    if (MEMBER_REMOVAL_PAUSED) {
      setMemberActionError('Member removal is temporarily paused while we stabilize encrypted key delivery.');
      return;
    }

    try {
      setBusyMemberAction({ userId: targetMember.user_id, action: 'kick' });
      setMemberActionError('');

      const remainingMemberIds = memberList
        .filter((member) => member.user_id !== targetMember.user_id)
        .map((member) => member.user_id);

      const result = await rotateRemoveMember(
        { ...conversation, current_key_version: currentKeyVersion },
        currentUserId,
        remainingMemberIds,
        targetMember.user_id
      );

      setCurrentKeyVersion(result.key_version);
      setMemberList((current) =>
        current.filter((member) => member.user_id !== targetMember.user_id)
      );
      setExpandedRoleEditorUserId((current) =>
        current === targetMember.user_id ? null : current
      );
      setMemberMenuUserId(null);
      setKickConfirmMember(null);

      const actorLabel = getActorLabel();
      const targetLabel = getMemberLabel(targetMember);
      void postMembershipSystemMessage(
        `${actorLabel} removed ${targetLabel} from the group.`,
        result.key_version
      );

      void onMembershipChanged?.();
    } catch (error) {
      console.error('Failed to remove member:', error);
      setMemberActionError(
        error instanceof Error ? error.message : 'Failed to remove member'
      );
    } finally {
      setBusyMemberAction(null);
    }
  };

  const openTab = (tab: GroupSettingsTab) => {
    setActiveTab(tab);
    if (window.innerWidth < 768) {
      setMobileView('detail');
    }
  };

  const renderActiveTabContent = () => {
    if (activeTab === 'profile') {
      return (
        <ProfileTab
          profileError={profileError}
          profileSuccess={profileSuccess}
          displayedIconUrl={displayedIconUrl}
          profileInitial={profileInitial}
          canManageProfile={canManageProfile}
          profileSaving={profileSaving}
          hasRemovableIcon={Boolean(conversation.icon_url || pendingIconFile)}
          onProfileFileSelect={handleProfileFileSelect}
          onRequestRemoveProfileIcon={handleRequestRemoveProfileIcon}
          profileName={profileName}
          onProfileNameChange={(value) => {
            setProfileName(value);
            setProfileError('');
            setProfileSuccess('');
          }}
          onProfileNameFocus={() => setIsProfileNameFocused(true)}
          onProfileNameBlur={() => setIsProfileNameFocused(false)}
          isProfileNameFocused={isProfileNameFocused}
          isProfileDirty={isProfileDirty}
          onRequestSaveProfile={handleRequestSaveProfile}
        />
      );
    }

    if (activeTab === 'members') {
      return (
        <MembersTab
          memberActionError={memberActionError}
          sortedMembers={sortedMembers}
          memberRemovalPaused={MEMBER_REMOVAL_PAUSED}
          currentUserId={currentUserId}
          canChangeMemberRoles={canChangeMemberRoles}
          canKickMembers={canKickMembers}
          memberMenuUserId={memberMenuUserId}
          expandedRoleEditorUserId={expandedRoleEditorUserId}
          busyMemberAction={busyMemberAction}
          leaveBlockedReason={leaveBlockedReason}
          isOwner={isOwner}
          onToggleMemberMenu={(userId) =>
            setMemberMenuUserId((current) => (current === userId ? null : userId))
          }
          onToggleRoleEditor={(userId) => {
            setExpandedRoleEditorUserId((current) => (current === userId ? null : userId));
            setMemberMenuUserId(null);
          }}
          onCloseRoleEditor={() => setExpandedRoleEditorUserId(null)}
          onRequestKickMember={(member) => {
            setMemberMenuUserId(null);
            setKickConfirmMember(member);
          }}
          onChangeMemberRole={(member, nextRole) => {
            void handleChangeMemberRole(member, nextRole);
          }}
          onUpdateNickname={(member, nickname) =>
            handleUpdateNickname(member, nickname)
          }
        />
      );
    }

    if (activeTab === 'roles') {
      return (
        <div className="space-y-6">
          <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-5">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-void-accent/15 text-void-accent">
                <Shield className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-void-text">Ranked Roles</h3>
                <p className="mt-1 text-sm leading-relaxed text-void-text-muted">
                  This screen is the next step after member controls. It will let the owner
                  define ranked roles and choose which powers each role can exercise.
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-void-bg-hover bg-void-bg-sec/60 p-4">
                <p className="text-sm font-semibold text-void-text">Hierarchy</p>
                <p className="mt-2 text-sm text-void-text-muted">
                  Roles will depend on rank, not just labels, so higher roles can manage lower ones cleanly.
                </p>
              </div>
              <div className="rounded-xl border border-void-bg-hover bg-void-bg-sec/60 p-4">
                <p className="text-sm font-semibold text-void-text">Permissions</p>
                <p className="mt-2 text-sm text-void-text-muted">
                  The owner will be able to decide which role can manage members and future history sharing.
                </p>
              </div>
              <div className="rounded-xl border border-void-bg-hover bg-void-bg-sec/60 p-4">
                <p className="text-sm font-semibold text-void-text">Owner-Only Powers</p>
                <p className="mt-2 text-sm text-void-text-muted">
                  Ownership transfer and the highest-rank powers will stay non-delegable.
                </p>
              </div>
            </div>
          </section>
        </div>
      );
    }

    if (activeTab === 'invites') {
      return (
        <InvitesTab
          canManageInvites={canManageInvites}
          invitesLoading={invitesLoading}
          invitesLoaded={invitesLoaded}
          inviteError={inviteError}
          inviteActionError={inviteActionError}
          isCreatingInvite={isCreatingInvite}
          busyInviteId={busyInviteId}
          busyRequestId={busyRequestId}
          copiedInviteId={copiedInviteId}
          pendingRequests={pendingRequests}
          inviteLinks={inviteLinks}
          joinApprovalsPaused={JOIN_APPROVALS_PAUSED}
          joinApprovalsPausedMessage={JOIN_APPROVALS_PAUSED_MESSAGE}
          onRefreshInvites={refreshInvites}
          onCreateInvite={handleCreateInvite}
          onDeclineRequest={handleDeclineRequest}
          onApproveRequest={handleApproveRequest}
          onCopyInvite={handleCopyInvite}
          onRevokeInvite={handleRevokeInvite}
        />
      );
    }

    if (activeTab === 'permissions') {
      return <PermissionsTab isOwner={isOwner} conversationId={rootConversationId} />;
    }

    return (
      <section className="rounded-2xl border border-dashed border-void-bg-hover bg-void-bg-main/30 p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-void-bg-hover text-void-text-muted">
          <Lock className="h-5 w-5" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-void-text">
          Access Disabled For Now
        </h3>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-void-text-muted">
          This section is intentionally visible so the server settings structure is in place, but the controls
          stay disabled until the member and role flows are fully settled.
        </p>
      </section>
    );
  };

  return (
    <div className="fixed inset-0 z-[320] bg-black/55 backdrop-blur-sm">
      <div className="flex h-full items-center justify-center p-0 md:p-4">
        <div className="flex h-full w-full flex-col overflow-hidden border border-void-bg-hover bg-void-bg-sec shadow-2xl md:h-[680px] md:max-w-6xl md:flex-row md:rounded-2xl">
          <aside className="hidden w-72 flex-shrink-0 border-r border-void-bg-hover bg-void-bg-main/55 md:flex md:flex-col">
            <div className="border-b border-void-bg-hover px-6 py-5">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-void-text-muted">Server Settings</p>
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
            <div className="sticky top-0 z-10 border-b border-void-bg-hover bg-void-bg-sec px-5 py-4 md:px-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-3 min-w-0">
                    {mobileView === 'detail' ? (
                      <button
                        type="button"
                        onClick={() => setMobileView('menu')}
                        className="rounded-full bg-void-bg-main/80 p-2 text-void-text-muted transition-colors hover:bg-void-bg-main hover:text-void-text md:hidden"
                        aria-label="Back to server settings"
                      >
                        <ArrowLeft className="h-5 w-5" />
                      </button>
                    ) : null}
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-void-text-muted md:hidden">
                        Server Settings
                      </p>
                      <h2 className="text-lg font-semibold text-void-text">
                        {mobileView === 'menu' ? 'Server Settings' : activeTabMeta?.label}
                      </h2>
                      <p className="mt-1 text-sm text-void-text-muted">
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

            <div className="flex-1 overflow-y-auto p-5 md:p-6">
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
                                <p className="mt-1 text-xs leading-relaxed text-void-text-muted">
                                  {tab.description}
                                </p>
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

        {kickConfirmMember && (
          <ConfirmDialog
            title="Remove Member"
            description={
              <>
                Remove <span className="font-semibold text-void-text">{getMemberLabel(kickConfirmMember)}</span> from this group?
              </>
            }
            detail="They will lose access to future encrypted messages."
            confirmLabel="Remove Member"
            confirmVariant="danger"
            busy={
              busyMemberAction?.action === 'kick' &&
              busyMemberAction.userId === kickConfirmMember.user_id
            }
            onCancel={() => setKickConfirmMember(null)}
            onConfirm={() => void handleKickMember(kickConfirmMember)}
          />
        )}

        {showRemoveIconConfirm && (
          <ConfirmDialog
            title="Remove Group Icon"
            description="Remove the current group icon from this profile?"
            detail="This only stages the change. Nothing is applied until you press Save Changes."
            confirmLabel="Remove Icon"
            confirmVariant="danger"
            onCancel={() => setShowRemoveIconConfirm(false)}
            onConfirm={handleConfirmRemoveProfileIcon}
          />
        )}

        {showSaveProfileConfirm && (
          <ConfirmDialog
            title="Save Group Profile"
            description="Apply your staged group profile changes now?"
            detail="This will save the current name and any icon changes you previewed above."
            confirmLabel="Save Changes"
            busy={profileSaving}
            onCancel={() => setShowSaveProfileConfirm(false)}
            onConfirm={() => {
              setShowSaveProfileConfirm(false);
              void handleSaveProfile();
            }}
          />
        )}
      </div>
    </div>
  );
};

export default GroupConversationSettings;
