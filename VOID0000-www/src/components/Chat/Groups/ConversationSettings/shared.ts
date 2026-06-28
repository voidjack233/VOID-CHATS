import type {
  ConversationInviteLink,
  ConversationJoinRequest,
  ConversationMember,
} from '../../../../Services/Chat/chatService';

export type GroupSettingsTab = 'profile' | 'members' | 'invites' | 'permissions';

export const ROLE_ORDER: Record<string, number> = {
  owner: 0,
  admin: 1,
  member: 2,
  viewer: 3,
};

export const ROLE_STYLES: Record<string, string> = {
  owner: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
  admin: 'bg-void-accent/15 text-void-accent ring-1 ring-void-accent/30',
  member: 'bg-void-bg-hover text-void-text-muted ring-1 ring-void-bg-hover',
  viewer: 'bg-sky-500/10 text-sky-300 ring-1 ring-sky-500/25',
};

export const EDITABLE_ROLE_OPTIONS = ['admin', 'member'] as const;

export const SETTINGS_SECTIONS: Array<{
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
        id: 'invites',
        label: 'Invites',
        description: 'Create invite links and review join requests.',
      },
    ],
  },
  {
    label: 'Moderation',
    tabs: [
      {
        id: 'permissions',
        label: 'Permissions',
        description: 'Control what admins and members can do in this group.',
      },
    ],
  },
];

export const SETTINGS_TABS = SETTINGS_SECTIONS.flatMap((section) => section.tabs);

export function getMemberLabel(member: ConversationMember) {
  return member.display_name || member.username || 'Unknown User';
}

export function getConversationInitial(name: string | null | undefined) {
  const trimmed = name?.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '#';
}

export function getRoleLabel(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function formatTimestamp(value: string | null | undefined) {
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

export function isInviteExpired(invite: ConversationInviteLink) {
  if (!invite.expires_at) return false;
  return new Date(invite.expires_at).getTime() <= Date.now();
}

export function getRequestLabel(request: ConversationJoinRequest) {
  return request.display_name || request.username || 'Unknown User';
}
