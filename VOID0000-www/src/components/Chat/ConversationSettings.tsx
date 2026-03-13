import { useEffect, useMemo, useState } from 'react';
import { Camera, Check, ChevronDown, ChevronRight, Copy, ImageOff, Link2, Loader2, Lock, LogOut, MoreHorizontal, RefreshCw, Save, Shield, UserRound, Users, X } from 'lucide-react';
import {
  approveConversationJoinRequest,
  Conversation,
  ConversationInviteLink,
  ConversationJoinRequest,
  ConversationMember,
  createConversationInviteLink,
  declineConversationJoinRequest,
  getConversationInvites,
  removeConversationIcon,
  rotateRemoveMember,
  revokeConversationInviteLink,
  updateConversation,
  updateMemberRole,
  uploadConversationIcon,
} from '../../Services/Chat/chatService';
import { useScrollLock } from '../../Services/hooks/common/useScrollLock';
import UserAvatar from '../common/UserAvatar';

type GroupSettingsTab = 'profile' | 'members' | 'roles' | 'invites' | 'access';

interface ConversationSettingsProps {
  conversation: Conversation;
  currentUserId: string;
  members: ConversationMember[];
  onConversationUpdated?: (conversation: Conversation) => Promise<void> | void;
  onMembershipChanged?: () => Promise<void> | void;
  onClose: () => void;
}

const ROLE_ORDER: Record<string, number> = {
  owner: 0,
  admin: 1,
  member: 2,
  viewer: 3,
};

const ROLE_STYLES: Record<string, string> = {
  owner: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
  admin: 'bg-void-accent/15 text-void-accent ring-1 ring-void-accent/30',
  member: 'bg-void-bg-hover text-void-text-muted ring-1 ring-void-bg-hover',
  viewer: 'bg-sky-500/10 text-sky-300 ring-1 ring-sky-500/25',
};

const VALID_ICON_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const MAX_ICON_FILE_SIZE = 7 * 1024 * 1024;
const JOIN_APPROVALS_PAUSED = false;
const MEMBER_REMOVAL_PAUSED = false;
const JOIN_APPROVALS_PAUSED_MESSAGE =
  'Join approvals are temporarily paused while we stabilize encrypted key delivery.';

const SETTINGS_SECTIONS: Array<{
  label: string;
  tabs: Array<{
    id: GroupSettingsTab;
    label: string;
    description: string;
    disabled?: boolean;
  }>;
}> = [
  {
    label: 'Server',
    tabs: [
      {
        id: 'profile',
        label: 'Profile',
        description: 'Change the group name and icon shown to members.',
      },
    ],
  },
  {
    label: 'People',
    tabs: [
      {
        id: 'members',
        label: 'Members',
        description: 'Browse everyone currently in this group.',
      },
      {
        id: 'roles',
        label: 'Roles',
        description: 'Ranked custom roles will live here next.',
      },
      {
        id: 'invites',
        label: 'Invites',
        description: 'Create invite links and review join requests.',
      },
      {
        id: 'access',
        label: 'Access',
        description: 'Access controls are disabled for now.',
        disabled: true,
      },
    ],
  },
];

const SETTINGS_TABS: Array<{
  id: GroupSettingsTab;
  label: string;
  description: string;
  disabled?: boolean;
}> = SETTINGS_SECTIONS.flatMap((section) => section.tabs);

function getMemberLabel(member: ConversationMember) {
  return member.display_name || member.username || 'Unknown User';
}

function getConversationInitial(name: string | null | undefined) {
  const trimmed = name?.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '#';
}

function getRoleLabel(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return 'Unknown';

  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function isInviteExpired(invite: ConversationInviteLink) {
  if (!invite.expires_at) return false;
  return new Date(invite.expires_at).getTime() <= Date.now();
}

function getRequestLabel(request: ConversationJoinRequest) {
  return request.display_name || request.username || 'Unknown User';
}

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

const ConversationSettings = ({
  conversation,
  currentUserId,
  members,
  onConversationUpdated,
  onMembershipChanged,
  onClose,
}: ConversationSettingsProps) => {
  useScrollLock();

  const [activeTab, setActiveTab] = useState<GroupSettingsTab>('profile');
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
  const [memberActionError, setMemberActionError] = useState('');
  const [memberMenuUserId, setMemberMenuUserId] = useState<string | null>(null);
  const [expandedRoleEditorUserId, setExpandedRoleEditorUserId] = useState<string | null>(null);
  const [kickConfirmMember, setKickConfirmMember] = useState<ConversationMember | null>(null);
  const [busyMemberAction, setBusyMemberAction] = useState<{
    userId: string;
    action: 'role' | 'kick';
  } | null>(null);
  const isGroup = conversation.type === 'group' || conversation.type === 'channel';
  const isOwner = conversation.owner_id === currentUserId;
  const rootConversationId = conversation.parent_conversation_id || conversation.id;
  const currentUserRole =
    memberList.find((member) => member.user_id === currentUserId)?.role ||
    conversation.role ||
    (isOwner ? 'owner' : null);
  const canManageInvites = isOwner && isGroup;
  const canManageProfile =
    conversation.type === 'group' &&
    (isOwner || currentUserRole === 'admin');
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
  const canManageMembers = isOwner && conversation.type === 'group';

  useEffect(() => {
    setActiveTab('profile');
    setMemberMenuUserId(null);
    setExpandedRoleEditorUserId(null);
    setKickConfirmMember(null);
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
    nextRole: 'admin' | 'member' | 'viewer'
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
    } catch (error) {
      console.error('Failed to update member role:', error);
      setMemberActionError(
        error instanceof Error ? error.message : 'Failed to update member role'
      );
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

  if (!isGroup) {
    return (
      <div className="fixed inset-0 z-[320] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
        <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-void-bg-hover bg-void-bg-sec shadow-2xl">
          <div className="flex items-center justify-between border-b border-void-bg-hover px-5 py-4">
            <h2 className="font-semibold text-void-text">Conversation Settings</h2>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4 p-5">
            <div className="flex items-center gap-3 rounded-xl bg-void-bg-main p-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-void-accent/20 text-void-accent">
                <UserRound className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate font-semibold text-void-text">
                  {conversation.dm_display_name || conversation.dm_username || 'Direct Message'}
                </p>
                <p className="text-xs text-void-text-muted">Direct Message</p>
              </div>
            </div>

            <p className="text-sm leading-relaxed text-void-text-muted">
              Server-style settings only apply to groups for now. DMs keep the simple conversation flow.
            </p>
          </div>
        </div>
      </div>
    );
  }

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
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-void-text-muted md:hidden">
                    Server Settings
                  </p>
                  <h2 className="text-lg font-semibold text-void-text">
                    {activeTabMeta?.label}
                  </h2>
                  <p className="mt-1 text-sm text-void-text-muted">
                    {activeTabMeta?.description}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full bg-void-bg-main/80 p-2 text-void-text-muted transition-colors hover:bg-void-bg-main hover:text-void-text"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="mt-4 flex gap-2 overflow-x-auto md:hidden">
                {SETTINGS_TABS.map((tab) => {
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      disabled={tab.disabled}
                      onClick={() => setActiveTab(tab.id)}
                      className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                        tab.disabled
                          ? 'cursor-not-allowed bg-void-bg-main text-void-text-muted/50'
                          : isActive
                            ? 'bg-void-accent text-white'
                            : 'bg-void-bg-main text-void-text-muted'
                      }`}
                    >
                      <span>{tab.label}</span>
                      {tab.disabled && <Lock className="h-3.5 w-3.5" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 md:p-6">
              {activeTab === 'profile' && (
                <div className="space-y-6">
                  {profileError && (
                    <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                      {profileError}
                    </p>
                  )}

                  {profileSuccess && (
                    <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
                      {profileSuccess}
                    </p>
                  )}

                  <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-5">
                    <div className="mb-5">
                      <h3 className="text-sm font-semibold text-void-text">Group Profile</h3>
                      <p className="mt-1 text-sm text-void-text-muted">
                        This is the identity members and invite visitors see for this group.
                      </p>
                    </div>

                    <div className="flex flex-col gap-5 lg:flex-row">
                      <div className="flex flex-col items-start gap-3">
                        {displayedIconUrl ? (
                          <img
                            src={displayedIconUrl}
                            alt=""
                            className="h-24 w-24 rounded-3xl border border-void-bg-hover object-cover"
                          />
                        ) : (
                          <div className="flex h-24 w-24 items-center justify-center rounded-3xl border border-void-bg-hover bg-void-accent/15 text-3xl font-semibold text-void-accent">
                            {profileInitial}
                          </div>
                        )}

                        <div className="flex w-full flex-col gap-2 sm:flex-row">
                          <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-void-bg-hover bg-void-bg-sec/70 px-4 py-2.5 text-sm font-medium text-void-text transition-colors hover:bg-void-bg-hover">
                            <Camera className="h-4 w-4" />
                            Upload Icon
                            <input
                              type="file"
                              accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                              className="hidden"
                              onChange={handleProfileFileSelect}
                              disabled={!canManageProfile || profileSaving}
                            />
                          </label>
                          <button
                            type="button"
                            onClick={handleRemoveProfileIcon}
                            disabled={(!conversation.icon_url && !pendingIconFile) || !canManageProfile || profileSaving}
                            className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-500/10 px-4 py-2.5 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <ImageOff className="h-4 w-4" />
                            Remove Icon
                          </button>
                        </div>

                        <p className="text-xs text-void-text-muted">
                          JPG, PNG, GIF or WebP. Max 7MB. The image is processed and stored for this group automatically.
                        </p>
                      </div>

                      <div className="min-w-0 flex-1 space-y-5">
                        <div>
                          <label className="mb-2 block text-sm font-medium text-void-text-muted">Group Name</label>
                          <input
                            type="text"
                            value={profileName}
                            onChange={(event) => {
                              setProfileName(event.target.value);
                              setProfileError('');
                              setProfileSuccess('');
                            }}
                            maxLength={100}
                            disabled={!canManageProfile || profileSaving}
                            className="w-full rounded-xl border border-void-bg-hover bg-void-bg-hover px-4 py-3 text-sm text-void-text outline-none transition-colors focus:border-void-accent disabled:cursor-not-allowed disabled:opacity-70"
                            placeholder="Unnamed Group"
                          />
                          <div className="mt-2 flex items-center justify-between text-xs text-void-text-muted">
                            <span>The group name is what members see in the sidebar and invite screen.</span>
                            <span>{profileName.length}/100</span>
                          </div>
                        </div>

                        {!canManageProfile && (
                          <div className="rounded-xl border border-void-bg-hover bg-void-bg-sec/60 p-4">
                            <p className="text-sm font-medium text-void-text">Owner or admin only</p>
                            <p className="mt-1 text-sm text-void-text-muted">
                              Only owners and admins can edit the group profile right now.
                            </p>
                          </div>
                        )}

                        <div className="rounded-xl border border-void-bg-hover bg-void-bg-sec/60 p-4">
                          <p className="text-sm font-semibold text-void-text">Fallback identity</p>
                          <p className="mt-2 text-sm text-void-text-muted">
                            If no icon is uploaded, the group automatically falls back to the first letter of its name.
                          </p>
                        </div>

                        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                          <button
                            type="button"
                            onClick={handleSaveProfile}
                            disabled={!isProfileDirty || !canManageProfile || profileSaving}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-void-accent px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-void-accent-hover disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                          >
                            {profileSaving ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Save className="h-4 w-4" />
                            )}
                            Save Changes
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              )}

              {activeTab === 'members' && (
                <div className="space-y-6">
                  {memberActionError && (
                    <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                      {memberActionError}
                    </p>
                  )}

                  <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-5">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-void-text">Current Members</h3>
                        <p className="mt-1 text-sm text-void-text-muted">
                          Manage roles here, and use this list to monitor current membership state.
                        </p>
                      </div>
                      <div className="inline-flex items-center gap-2 rounded-full bg-void-bg-hover px-3 py-1 text-sm font-semibold text-void-text">
                        <Users className="h-4 w-4 text-void-text-muted" />
                        <span>{sortedMembers.length}</span>
                      </div>
                    </div>

                    <div className="mt-5 space-y-3">
                      {MEMBER_REMOVAL_PAUSED && (
                        <div className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                          Member removal is temporarily paused while we stabilize encrypted key delivery.
                        </div>
                      )}

                      {sortedMembers.map((member) => {
                        const isRoleEditorOpen = expandedRoleEditorUserId === member.user_id;
                        const isRoleBusy =
                          busyMemberAction?.userId === member.user_id &&
                          busyMemberAction.action === 'role';
                        const isKickBusy =
                          busyMemberAction?.userId === member.user_id &&
                          busyMemberAction.action === 'kick';

                        return (
                          <div key={member.user_id} className="space-y-2">
                            <div className="flex items-center gap-3 rounded-xl border border-void-bg-hover bg-void-bg-sec/65 px-4 py-3">
                              <UserAvatar
                                src={member.avatar_url}
                                displayName={member.display_name}
                                username={member.username}
                                className="h-10 w-10 rounded-full"
                                fallbackClassName="text-sm"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="truncate font-medium text-void-text">
                                    {getMemberLabel(member)}
                                  </p>
                                  {member.user_id === currentUserId && (
                                    <span className="rounded-full bg-void-accent/15 px-2 py-0.5 text-[11px] font-semibold text-void-accent">
                                      You
                                    </span>
                                  )}
                                </div>
                                <p className="truncate text-sm text-void-text-muted">@{member.username}</p>
                              </div>
                              <span
                                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${ROLE_STYLES[member.role] || ROLE_STYLES.member}`}
                              >
                                {getRoleLabel(member.role)}
                              </span>
                              {canManageMembers && member.user_id !== currentUserId && member.role !== 'owner' && (
                                <div className="relative shrink-0">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setMemberMenuUserId((current) =>
                                        current === member.user_id ? null : member.user_id
                                      )
                                    }
                                    className="rounded-lg p-2 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
                                    title="Member actions"
                                  >
                                    <MoreHorizontal className="h-4 w-4" />
                                  </button>

                                  {memberMenuUserId === member.user_id && (
                                    <div className="absolute right-0 top-11 z-20 w-52 rounded-xl border border-void-bg-hover bg-void-bg-main p-2 shadow-2xl">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setExpandedRoleEditorUserId((current) =>
                                            current === member.user_id ? null : member.user_id
                                          );
                                          setMemberMenuUserId(null);
                                        }}
                                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-void-text transition-colors hover:bg-void-bg-hover"
                                      >
                                        <span>Change Role</span>
                                        {isRoleEditorOpen ? (
                                          <ChevronDown className="h-4 w-4 text-void-text-muted" />
                                        ) : (
                                          <ChevronRight className="h-4 w-4 text-void-text-muted" />
                                        )}
                                      </button>

                                      <div className="my-2 h-px bg-void-bg-hover" />
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setMemberMenuUserId(null);
                                          setKickConfirmMember(member);
                                        }}
                                        disabled={isKickBusy || MEMBER_REMOVAL_PAUSED}
                                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                                      >
                                        <span>{MEMBER_REMOVAL_PAUSED ? 'Member Removal Paused' : 'Kick Member'}</span>
                                        {isKickBusy ? (
                                          <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : null}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>

                            {canManageMembers && member.user_id !== currentUserId && member.role !== 'owner' && isRoleEditorOpen && (
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
                                    onClick={() => setExpandedRoleEditorUserId(null)}
                                    className="rounded-lg p-1.5 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
                                  >
                                    <ChevronDown className="h-4 w-4" />
                                  </button>
                                </div>

                                <div className="grid gap-2 sm:grid-cols-3">
                                  {(['admin', 'member', 'viewer'] as const).map((roleOption) => (
                                    <button
                                      key={roleOption}
                                      type="button"
                                      onClick={() => void handleChangeMemberRole(member, roleOption)}
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
                  </section>

                  <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-5">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-red-500/10 text-red-400">
                        <LogOut className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-semibold text-void-text">Leaving This Group</h3>
                        <p className="mt-1 text-sm leading-relaxed text-void-text-muted">
                          {leaveBlockedReason}
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled
                      className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-red-500/5 px-4 py-3 text-sm font-medium text-red-400/70 ring-1 ring-red-500/10 disabled:cursor-not-allowed md:w-auto"
                    >
                      <LogOut className="h-4 w-4" />
                      {isOwner ? 'Transfer Ownership First' : 'Owner Removal Required'}
                    </button>
                  </section>
                </div>
              )}

              {activeTab === 'roles' && (
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
                          The owner will be able to decide which role can manage members, channels, and future history sharing.
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
              )}

              {activeTab === 'invites' && (
                <div className="space-y-6">
                  <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-4 sm:p-5">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="max-w-2xl">
                        <h3 className="text-sm font-semibold text-void-text">Invite Links</h3>
                        <p className="mt-1 text-sm leading-relaxed text-void-text-muted">
                          Invite links do not add anyone immediately. They create a join request, and approved members
                          only see the history their account is allowed to access.
                        </p>
                      </div>

                      {canManageInvites && (
                        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                          <button
                            type="button"
                            onClick={() => void refreshInvites()}
                            disabled={invitesLoading}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-void-bg-hover bg-void-bg-sec/70 px-4 py-3 text-sm font-medium text-void-text transition-colors hover:bg-void-bg-hover disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                          >
                            <RefreshCw className={`h-4 w-4 ${invitesLoading ? 'animate-spin' : ''}`} />
                            Refresh
                          </button>
                          <button
                            type="button"
                            onClick={handleCreateInvite}
                            disabled={isCreatingInvite}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-void-accent px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-void-accent-hover disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
                          >
                            {isCreatingInvite ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Link2 className="h-4 w-4" />
                            )}
                            Create Invite Link
                          </button>
                        </div>
                      )}
                    </div>

                    {!canManageInvites && (
                      <div className="mt-4 rounded-xl border border-void-bg-hover bg-void-bg-sec/60 p-4">
                        <p className="text-sm font-medium text-void-text">Owner-only section</p>
                        <p className="mt-1 text-sm text-void-text-muted">
                          Only the group owner can create links and approve join requests right now.
                        </p>
                      </div>
                    )}

                    {(inviteError || inviteActionError) && (
                      <div className="mt-4 space-y-2">
                        {inviteError && (
                          <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                            {inviteError}
                          </p>
                        )}
                        {inviteActionError && (
                          <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                            {inviteActionError}
                          </p>
                        )}
                      </div>
                    )}
                  </section>

                  {canManageInvites && (
                    <>
                      <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-4 sm:p-5">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-void-text">Pending Join Requests</h3>
                            <p className="mt-1 text-sm text-void-text-muted">
                              Approval grants access from the member start point, not full back-history.
                            </p>
                          </div>
                          <div className="inline-flex self-start items-center gap-2 rounded-full bg-void-bg-hover px-3 py-1 text-sm font-semibold text-void-text sm:self-auto">
                            <Users className="h-4 w-4 text-void-text-muted" />
                            <span>{pendingRequests.length}</span>
                          </div>
                        </div>

                        <div className="mt-5 space-y-3">
                          {!invitesLoading && invitesLoaded && pendingRequests.length === 0 && (
                            <div className="rounded-xl border border-dashed border-void-bg-hover bg-void-bg-sec/45 px-4 py-5 text-sm text-void-text-muted">
                              No pending requests right now.
                            </div>
                          )}

                          {JOIN_APPROVALS_PAUSED && pendingRequests.length > 0 && (
                            <div className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                              {JOIN_APPROVALS_PAUSED_MESSAGE}
                            </div>
                          )}

                          {pendingRequests.map((request) => {
                            const isBusy = busyRequestId === request.id;

                            return (
                              <div
                                key={request.id}
                                className="flex flex-col gap-4 rounded-xl border border-void-bg-hover bg-void-bg-sec/65 px-4 py-4 md:flex-row md:items-center md:justify-between"
                              >
                                <div className="flex min-w-0 items-start gap-3 sm:items-center">
                                  <UserAvatar
                                    src={request.avatar_url}
                                    displayName={request.display_name}
                                    username={request.username}
                                    className="h-11 w-11 rounded-full"
                                    fallbackClassName="text-sm"
                                  />
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <p className="truncate font-medium text-void-text">
                                        {getRequestLabel(request)}
                                      </p>
                                      <span className="rounded-full bg-void-bg-hover px-2 py-0.5 text-[11px] font-semibold text-void-text-muted">
                                        Requested {formatTimestamp(request.created_at)}
                                      </span>
                                    </div>
                                    <p className="truncate text-sm text-void-text-muted">@{request.username}</p>
                                  </div>
                                </div>

                                <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-row">
                                  <button
                                    type="button"
                                    onClick={() => void handleDeclineRequest(request.id)}
                                    disabled={isBusy}
                                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-void-bg-hover bg-void-bg-sec/70 px-4 py-2.5 text-sm font-medium text-void-text transition-colors hover:bg-void-bg-hover disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                                  >
                                    {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                                    Decline
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleApproveRequest(request)}
                                    disabled={isBusy || JOIN_APPROVALS_PAUSED}
                                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-void-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-void-accent-hover disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
                                  >
                                    {isBusy ? (
                                      <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : JOIN_APPROVALS_PAUSED ? (
                                      <Lock className="h-4 w-4" />
                                    ) : (
                                      <Check className="h-4 w-4" />
                                    )}
                                    {JOIN_APPROVALS_PAUSED ? 'Paused' : 'Approve'}
                                  </button>
                                </div>
                              </div>
                            );
                          })}

                          {invitesLoading && (
                            <div className="flex items-center justify-center gap-3 rounded-xl border border-void-bg-hover bg-void-bg-sec/45 px-4 py-5 text-sm text-void-text-muted">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Loading join requests...
                            </div>
                          )}
                        </div>
                      </section>

                      <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-4 sm:p-5">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-void-text">Recent Invite Links</h3>
                            <p className="mt-1 text-sm text-void-text-muted">
                              Links stay reusable until they expire or you revoke them.
                            </p>
                          </div>
                          <div className="inline-flex self-start items-center gap-2 rounded-full bg-void-bg-hover px-3 py-1 text-sm font-semibold text-void-text sm:self-auto">
                            <Link2 className="h-4 w-4 text-void-text-muted" />
                            <span>{inviteLinks.length}</span>
                          </div>
                        </div>

                        <div className="mt-5 space-y-3">
                          {!invitesLoading && invitesLoaded && inviteLinks.length === 0 && (
                            <div className="rounded-xl border border-dashed border-void-bg-hover bg-void-bg-sec/45 px-4 py-5 text-sm text-void-text-muted">
                              No invite links yet. Create one when you want people to request access.
                            </div>
                          )}

                          {inviteLinks.map((invite) => {
                            const isRevoked = invite.is_revoked;
                            const isExpired = isInviteExpired(invite);
                            const isBusy = busyInviteId === invite.id;
                            const copyLabel = copiedInviteId === invite.id ? 'Copied' : 'Copy Link';
                            const statusLabel = isRevoked
                              ? 'Revoked'
                              : isExpired
                                ? 'Expired'
                                : 'Active';

                            return (
                              <div
                                key={invite.id}
                                className="rounded-xl border border-void-bg-hover bg-void-bg-sec/65 px-4 py-4"
                              >
                                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span
                                        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                                          isRevoked || isExpired
                                            ? 'bg-red-500/10 text-red-300 ring-1 ring-red-500/20'
                                            : 'bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20'
                                        }`}
                                      >
                                        {statusLabel}
                                      </span>
                                      <span className="rounded-full bg-void-bg-hover px-2 py-0.5 text-[11px] font-semibold text-void-text-muted">
                                        Created {formatTimestamp(invite.created_at)}
                                      </span>
                                      {invite.expires_at && (
                                        <span className="rounded-full bg-void-bg-hover px-2 py-0.5 text-[11px] font-semibold text-void-text-muted">
                                          Expires {formatTimestamp(invite.expires_at)}
                                        </span>
                                      )}
                                    </div>

                                    <p className="mt-3 break-all rounded-xl bg-void-bg-main/80 px-3 py-2 text-xs leading-relaxed text-void-text-muted sm:text-sm">
                                      {invite.url}
                                    </p>

                                    <p className="mt-2 text-xs text-void-text-muted">
                                      Uses: {invite.use_count}
                                      {invite.max_uses != null ? ` / ${invite.max_uses}` : ' / unlimited'}
                                    </p>
                                  </div>

                                  <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-row">
                                    <button
                                      type="button"
                                      onClick={() => void handleCopyInvite(invite)}
                                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-void-bg-hover bg-void-bg-sec/70 px-4 py-2.5 text-sm font-medium text-void-text transition-colors hover:bg-void-bg-hover sm:w-auto"
                                    >
                                      {copiedInviteId === invite.id ? (
                                        <Check className="h-4 w-4 text-emerald-300" />
                                      ) : (
                                        <Copy className="h-4 w-4" />
                                      )}
                                      {copyLabel}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void handleRevokeInvite(invite.id)}
                                      disabled={isBusy || isRevoked}
                                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-red-500/10 px-4 py-2.5 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                                    >
                                      {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                                      {isRevoked ? 'Revoked' : 'Revoke'}
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}

                          {invitesLoading && (
                            <div className="flex items-center justify-center gap-3 rounded-xl border border-void-bg-hover bg-void-bg-sec/45 px-4 py-5 text-sm text-void-text-muted">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Loading invite links...
                            </div>
                          )}
                        </div>
                      </section>
                    </>
                  )}
                </div>
              )}

              {activeTab === 'access' && (
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
              )}
            </div>
          </div>
        </div>

        {kickConfirmMember && (
          <div className="fixed inset-0 z-[340] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-2xl border border-void-bg-hover bg-void-bg-sec shadow-2xl">
              <div className="border-b border-void-bg-hover px-5 py-4">
                <h3 className="text-base font-semibold text-void-text">Remove Member</h3>
                <p className="mt-1 text-sm text-void-text-muted">
                  Remove <span className="font-semibold text-void-text">{getMemberLabel(kickConfirmMember)}</span> from this group?
                </p>
                <p className="mt-2 text-xs text-void-text-muted">
                  They will lose access to future encrypted messages.
                </p>
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-4">
                <button
                  type="button"
                  onClick={() => setKickConfirmMember(null)}
                  disabled={
                    busyMemberAction?.action === 'kick' &&
                    busyMemberAction.userId === kickConfirmMember.user_id
                  }
                  className="rounded-xl border border-void-bg-hover bg-void-bg-sec/70 px-4 py-2.5 text-sm font-medium text-void-text transition-colors hover:bg-void-bg-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleKickMember(kickConfirmMember)}
                  disabled={
                    busyMemberAction?.action === 'kick' &&
                    busyMemberAction.userId === kickConfirmMember.user_id
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-500/20 px-4 py-2.5 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busyMemberAction?.action === 'kick' && busyMemberAction.userId === kickConfirmMember.user_id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  Remove Member
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ConversationSettings;
