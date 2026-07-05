import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  approveConversationJoinRequest,
  Conversation,
  ConversationInviteLink,
  ConversationJoinRequest,
  ConversationMember,
  Message,
  createConversationInviteLink,
  deleteConversation,
  declineConversationJoinRequest,
  getConversationInvites,
  leaveConversation,
  removeConversationIcon,
  rotateRemoveMember,
  revokeConversationInviteLink,
  sendSystemEvent,
  transferConversationOwnership,
  updateConversation,
  updateConversationNickname,
  updateMemberRole,
  uploadConversationIcon,
} from '../../../Services/Chat/chatService';
import {
  getMemberLabel,
  getRequestLabel,
  GroupSettingsTab,
  ROLE_ORDER,
} from './ConversationSettings/shared';

const VALID_ICON_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const MAX_ICON_FILE_SIZE = 7 * 1024 * 1024;
const JOIN_APPROVALS_PAUSED = false;
const MEMBER_REMOVAL_PAUSED = false;
const JOIN_APPROVALS_PAUSED_MESSAGE =
  'Join approvals are temporarily paused while we stabilize encrypted key delivery.';

function validateIconFile(file: File): string | null {
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

interface UseGroupSettingsInput {
  conversation: Conversation;
  members: ConversationMember[];
  currentUserId: string;
  activeTab: GroupSettingsTab;
  onMessageCreated?: (message: Message) => void;
  onConversationUpdated?: (conversation: Conversation) => Promise<void> | void;
  onMembershipChanged?: () => Promise<void> | void;
  onLeaveCompleted?: () => void;
}

export function useGroupSettings({
  conversation,
  members,
  currentUserId,
  activeTab,
  onMessageCreated,
  onConversationUpdated,
  onMembershipChanged,
  onLeaveCompleted,
}: UseGroupSettingsInput) {
  // ── member list ──────────────────────────────────────────────────────────
  const [memberList, setMemberList] = useState<ConversationMember[]>(members);
  const [currentKeyVersion, setCurrentKeyVersion] = useState<number>(
    conversation.current_key_version || 1
  );

  // ── invites ───────────────────────────────────────────────────────────────
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

  // ── profile ───────────────────────────────────────────────────────────────
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

  // ── member actions ────────────────────────────────────────────────────────
  const [memberActionError, setMemberActionError] = useState('');
  const [memberMenuUserId, setMemberMenuUserId] = useState<string | null>(null);
  const [expandedRoleEditorUserId, setExpandedRoleEditorUserId] = useState<string | null>(null);
  const [kickConfirmMember, setKickConfirmMember] = useState<ConversationMember | null>(null);
  const [transferConfirmMember, setTransferConfirmMember] = useState<ConversationMember | null>(null);
  const [leaveConfirmMode, setLeaveConfirmMode] = useState<'leave' | 'delete' | null>(null);
  const [busyMemberAction, setBusyMemberAction] = useState<{
    userId: string;
    action: 'role' | 'kick' | 'nickname' | 'leave' | 'transfer';
  } | null>(null);

  // ── derived ───────────────────────────────────────────────────────────────
  const isOwner = conversation.owner_id === currentUserId;
  const currentUserRole =
    memberList.find((member) => member.user_id === currentUserId)?.role ||
    conversation.role ||
    (isOwner ? 'owner' : null);
  const canManageInvites = isOwner;
  const canManageProfile = isOwner || currentUserRole === 'admin';
  const isSoloOwner = isOwner && memberList.length <= 1;
  const canLeaveGroup = !isOwner || isSoloOwner;
  const canTransferOwnership = isOwner && memberList.length > 1;
  const leaveBlockedReason = isOwner
    ? isSoloOwner
      ? 'You are the only member. Leaving will permanently delete this group.'
      : 'Transfer ownership before leaving this group.'
    : 'Leave this group. You will lose access to future messages.';
  const leaveButtonLabel = isOwner
    ? isSoloOwner
      ? 'Delete Group and Leave'
      : 'Transfer Ownership First'
    : 'Leave Group';
  const canChangeMemberRoles = isOwner || currentUserRole === 'admin';
  const canKickMembers =
    isOwner ||
    (currentUserRole === 'admin' && (conversation.permissions?.admin_can_remove_members ?? true));

  const trimmedProfileName = profileName.trim();
  const displayedIconUrl = removeCurrentIcon
    ? profilePreviewUrl || null
    : profilePreviewUrl || conversation.icon_url || null;
  const isProfileDirty =
    trimmedProfileName !== (conversation.name || '') ||
    !!pendingIconFile ||
    removeCurrentIcon;

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

  const sortedMembers = useMemo(
    () =>
      [...memberList].sort((left, right) => {
        const roleDelta = (ROLE_ORDER[left.role] ?? 99) - (ROLE_ORDER[right.role] ?? 99);
        if (roleDelta !== 0) return roleDelta;
        return getMemberLabel(left).localeCompare(getMemberLabel(right));
      }),
    [memberList]
  );

  // ── sync effects ──────────────────────────────────────────────────────────
  useEffect(() => {
    setMemberMenuUserId(null);
    setExpandedRoleEditorUserId(null);
    setKickConfirmMember(null);
    setTransferConfirmMember(null);
    setLeaveConfirmMode(null);
    setMemberActionError('');
  }, [conversation.id]);

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
        const data = await getConversationInvites(conversation.id);
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
  }, [activeTab, canManageInvites, conversation.id]);

  // ── helpers ───────────────────────────────────────────────────────────────
  const getActorLabel = () => {
    const actor = memberList.find((member) => member.user_id === currentUserId);
    return actor?.display_name || actor?.username || 'A moderator';
  };

  const postMembershipSystemMessage = async (text: string, keyVersion: number) => {
    try {
      const message = await sendSystemEvent(conversation.id, text, keyVersion);
      onMessageCreated?.(message);
    } catch (error) {
      console.warn('Failed to post membership system message:', error);
    }
  };

  const buildNicknameSystemMessage = (
    targetMember: ConversationMember,
    nextNickname: string | null
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

  const buildRoleSystemMessage = (
    targetMember: ConversationMember,
    nextRole: 'admin' | 'member'
  ) => {
    const actorLabel = getActorLabel();
    const targetLabel = getMemberLabel(targetMember);

    return nextRole === 'admin'
      ? `${actorLabel} made ${targetLabel} an admin.`
      : `${actorLabel} removed ${targetLabel}'s admin role.`;
  };

  const buildTransferOwnershipSystemMessage = (targetMember: ConversationMember) => {
    const actorLabel = getActorLabel();
    const targetLabel = getMemberLabel(targetMember);
    return `${actorLabel} transferred group ownership to ${targetLabel}.`;
  };

  const clearMemberActionError = useCallback(() => {
    setMemberActionError('');
  }, []);

  // ── invite handlers ───────────────────────────────────────────────────────
  const refreshInvites = async () => {
    try {
      setInvitesLoading(true);
      setInviteError('');
      const data = await getConversationInvites(conversation.id);
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
      const invite = await createConversationInviteLink(conversation.id);
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
      await revokeConversationInviteLink(conversation.id, inviteId);
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
      await declineConversationJoinRequest(conversation.id, requestId);
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

  // ── profile handlers ──────────────────────────────────────────────────────
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
        const { conversation: updatedConversation } = await updateConversation(conversation.id, {
          name: trimmedProfileName,
        });
        latestConversation = updatedConversation;
        await onConversationUpdated?.(updatedConversation);
      }

      if (removeCurrentIcon && conversation.icon_url) {
        const { conversation: updatedConversation } = await removeConversationIcon(conversation.id);
        latestConversation = updatedConversation;
        await onConversationUpdated?.(updatedConversation);
      }

      if (pendingIconFile) {
        const base64Image = await readFileAsDataURL(pendingIconFile);
        const { conversation: updatedConversation } = await uploadConversationIcon(
          conversation.id,
          base64Image
        );
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

  // ── member action handlers ────────────────────────────────────────────────
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
      await updateMemberRole(conversation.id, targetMember.user_id, nextRole);
      setMemberList((current) =>
        current.map((member) =>
          member.user_id === targetMember.user_id ? { ...member, role: nextRole } : member
        )
      );
      setExpandedRoleEditorUserId(null);
      setMemberMenuUserId(null);
      void postMembershipSystemMessage(
        buildRoleSystemMessage(targetMember, nextRole),
        currentKeyVersion
      );
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
      const result = await updateConversationNickname(
        conversation.id,
        targetMember.user_id,
        nickname
      );
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
      setMemberActionError(
        'Member removal is temporarily paused while we stabilize encrypted key delivery.'
      );
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

  const handleTransferOwnership = async (targetMember: ConversationMember) => {
    if (!canTransferOwnership) {
      setMemberActionError('Only the current owner can transfer ownership.');
      return;
    }

    if (targetMember.user_id === currentUserId) {
      setMemberActionError('Choose a different member to transfer ownership to.');
      return;
    }

    try {
      setBusyMemberAction({ userId: targetMember.user_id, action: 'transfer' });
      setMemberActionError('');

      const { conversation: updatedConversation } = await transferConversationOwnership(
        conversation.id,
        targetMember.user_id
      );

      setMemberList((current) =>
        current.map((member) => {
          if (member.user_id === targetMember.user_id) {
            return { ...member, role: 'owner' };
          }
          if (member.user_id === currentUserId) {
            return { ...member, role: 'admin' };
          }
          return member;
        })
      );
      setExpandedRoleEditorUserId(null);
      setMemberMenuUserId(null);
      setTransferConfirmMember(null);

      await onConversationUpdated?.(updatedConversation);
      void postMembershipSystemMessage(
        buildTransferOwnershipSystemMessage(targetMember),
        currentKeyVersion
      );
      void onMembershipChanged?.();
    } catch (error) {
      console.error('Failed to transfer ownership:', error);
      setMemberActionError(
        error instanceof Error ? error.message : 'Failed to transfer ownership'
      );
    } finally {
      setBusyMemberAction(null);
    }
  };

  const handleRequestLeaveGroup = () => {
    if (!canLeaveGroup) {
      return;
    }

    setMemberActionError('');
    setMemberMenuUserId(null);
    setExpandedRoleEditorUserId(null);
    setKickConfirmMember(null);
    setLeaveConfirmMode(isSoloOwner ? 'delete' : 'leave');
  };

  const handleLeaveGroup = async () => {
    if (!canLeaveGroup) {
      setMemberActionError('Transfer ownership before leaving this group.');
      return;
    }

    const currentMember = memberList.find((member) => member.user_id === currentUserId);
    if (!currentMember) {
      setMemberActionError('Could not find your group membership. Refresh and try again.');
      return;
    }

    try {
      setBusyMemberAction({ userId: currentUserId, action: 'leave' });
      setMemberActionError('');

      if (isSoloOwner) {
        await deleteConversation(conversation.id);
      } else {
        await leaveConversation(conversation.id);
        setMemberList((current) =>
          current.filter((member) => member.user_id !== currentUserId)
        );
      }

      setExpandedRoleEditorUserId(null);
      setMemberMenuUserId(null);
      setLeaveConfirmMode(null);

      onLeaveCompleted?.();
    } catch (error) {
      console.error('Failed to leave group:', error);
      setMemberActionError(
        error instanceof Error ? error.message : 'Failed to leave group'
      );
    } finally {
      setBusyMemberAction(null);
    }
  };

  // ── return ────────────────────────────────────────────────────────────────
  return {
    memberList,
    sortedMembers,

    permissions: {
      isOwner,
      canManageInvites,
      canManageProfile,
      canChangeMemberRoles,
      canKickMembers,
      canLeaveGroup,
      canTransferOwnership,
      leaveBlockedReason,
      leaveButtonLabel,
    },

    profile: {
      profileName,
      profilePreviewUrl,
      profileSaving,
      profileError,
      profileSuccess,
      isProfileNameFocused,
      displayedIconUrl,
      isProfileDirty,
      hasRemovableIcon: Boolean(conversation.icon_url || pendingIconFile),
      showRemoveIconConfirm,
      showSaveProfileConfirm,
      onProfileNameChange: (value: string) => {
        setProfileName(value);
        setProfileError('');
        setProfileSuccess('');
      },
      onProfileNameFocus: () => setIsProfileNameFocused(true),
      onProfileNameBlur: () => setIsProfileNameFocused(false),
      onProfileFileSelect: handleProfileFileSelect,
      onRequestRemoveProfileIcon: handleRequestRemoveProfileIcon,
      onConfirmRemoveProfileIcon: handleConfirmRemoveProfileIcon,
      onCancelRemoveProfileIcon: () => setShowRemoveIconConfirm(false),
      onRequestSaveProfile: handleRequestSaveProfile,
      onConfirmSaveProfile: () => {
        setShowSaveProfileConfirm(false);
        void handleSaveProfile();
      },
      onCancelSaveProfile: () => setShowSaveProfileConfirm(false),
    },

    invites: {
      inviteLinks,
      pendingRequests,
      invitesLoading,
      invitesLoaded,
      inviteError,
      inviteActionError,
      isCreatingInvite,
      busyInviteId,
      busyRequestId,
      copiedInviteId,
      joinApprovalsPaused: JOIN_APPROVALS_PAUSED,
      joinApprovalsPausedMessage: JOIN_APPROVALS_PAUSED_MESSAGE,
      onRefreshInvites: refreshInvites,
      onCreateInvite: handleCreateInvite,
      onCopyInvite: handleCopyInvite,
      onRevokeInvite: handleRevokeInvite,
      onApproveRequest: handleApproveRequest,
      onDeclineRequest: handleDeclineRequest,
    },

    members: {
      memberActionError,
      onClearMemberActionError: clearMemberActionError,
      memberMenuUserId,
      expandedRoleEditorUserId,
      kickConfirmMember,
      transferConfirmMember,
      leaveConfirmMode,
      busyMemberAction,
      memberRemovalPaused: MEMBER_REMOVAL_PAUSED,
      onToggleMemberMenu: (userId: string) =>
        setMemberMenuUserId((current) => (current === userId ? null : userId)),
      onToggleRoleEditor: (userId: string) => {
        setExpandedRoleEditorUserId((current) => (current === userId ? null : userId));
        setMemberMenuUserId(null);
      },
      onCloseRoleEditor: () => setExpandedRoleEditorUserId(null),
      onRequestKickMember: (member: ConversationMember) => {
        setMemberMenuUserId(null);
        setKickConfirmMember(member);
      },
      onRequestTransferOwnership: (member: ConversationMember) => {
        setMemberMenuUserId(null);
        setExpandedRoleEditorUserId(null);
        setKickConfirmMember(null);
        setTransferConfirmMember(member);
      },
      onChangeMemberRole: (member: ConversationMember, nextRole: 'admin' | 'member') =>
        void handleChangeMemberRole(member, nextRole),
      onUpdateNickname: handleUpdateNickname,
      onConfirmKickMember: (member: ConversationMember) => void handleKickMember(member),
      onCancelKickMember: () => setKickConfirmMember(null),
      onConfirmTransferOwnership: (member: ConversationMember) => void handleTransferOwnership(member),
      onCancelTransferOwnership: () => setTransferConfirmMember(null),
      onRequestLeaveGroup: handleRequestLeaveGroup,
      onConfirmLeaveGroup: () => void handleLeaveGroup(),
      onCancelLeaveGroup: () => setLeaveConfirmMode(null),
    },
  };
}
