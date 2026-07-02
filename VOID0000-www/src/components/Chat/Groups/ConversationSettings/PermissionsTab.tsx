import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Search, ShieldAlert } from 'lucide-react';
import type { GroupPermissions } from '../../../../Services/Chat/chatTypes';
import {
  getConversationPermissions,
  updateConversationPermissions,
} from '../../../../Services/Chat/conversationService';

type WhoOption = 'everyone' | 'admins' | 'owner';

const WHO_OPTIONS: Array<{ value: WhoOption; label: string }> = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'admins', label: 'Admins' },
  { value: 'owner', label: 'Owner' },
];

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-sm text-void-text">{label}</span>
      <div className="flex w-full flex-shrink-0 overflow-hidden rounded-lg border border-void-bg-hover bg-void-bg-main sm:w-auto">
        <button
          type="button"
          onClick={() => onChange(true)}
          className={`flex-1 px-4 py-2 text-xs font-semibold transition-colors sm:flex-none sm:py-1.5 ${
            value
              ? 'bg-void-accent text-white'
              : 'text-void-text-muted hover:bg-void-bg-hover hover:text-void-text'
          }`}
        >
          Yes
        </button>
        <button
          type="button"
          onClick={() => onChange(false)}
          className={`flex-1 px-4 py-2 text-xs font-semibold transition-colors sm:flex-none sm:py-1.5 ${
            !value
              ? 'bg-void-bg-hover text-void-text'
              : 'text-void-text-muted hover:bg-void-bg-hover hover:text-void-text'
          }`}
        >
          No
        </button>
      </div>
    </div>
  );
}

function WhoDropdown({
  label,
  value,
  onChange,
}: {
  label: string;
  value: WhoOption;
  onChange: (next: WhoOption) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = WHO_OPTIONS.find((option) => option.value === value) || WHO_OPTIONS[0];

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  return (
    <div className="flex flex-col items-start gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-sm text-void-text">{label}</span>
      <div ref={menuRef} className="relative w-full flex-shrink-0 sm:w-auto">
        <button
          type="button"
          onClick={() => setIsOpen((current) => !current)}
          className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-xs font-semibold shadow-sm transition-colors sm:min-w-[136px] sm:py-2 ${
            isOpen
              ? 'border-void-accent/50 bg-void-bg-hover text-void-text ring-1 ring-void-accent/30'
              : 'border-void-bg-hover bg-void-bg-main text-void-text hover:border-void-accent/40 hover:bg-void-bg-hover/70'
          }`}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
        >
          <span>{selectedOption?.label || 'Select'}</span>
          <ChevronDown
            className={`h-3.5 w-3.5 text-void-text-muted transition-transform ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {isOpen && (
          <div
            role="listbox"
            className="absolute inset-x-0 top-[calc(100%+0.45rem)] z-20 overflow-hidden rounded-xl border border-void-bg-hover bg-void-bg-main p-1.5 shadow-2xl sm:left-auto sm:min-w-[180px]"
          >
            {WHO_OPTIONS.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setIsOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs font-semibold transition-colors ${
                    isSelected
                      ? 'bg-void-accent/15 text-void-accent'
                      : 'text-void-text hover:bg-void-bg-hover'
                  }`}
                >
                  <span>{option.label}</span>
                  {isSelected ? <Check className="h-3.5 w-3.5" /> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-4 sm:p-5">
      <h3 className="mb-1 text-sm font-semibold text-void-text">{title}</h3>
      <div className="divide-y divide-void-bg-hover">{children}</div>
    </section>
  );
}

function toSnake(perms: CamelPermissions): Partial<GroupPermissions> {
  return {
    admin_can_remove_members: perms.adminCanRemoveMembers,
    admin_can_approve_join_requests: perms.adminCanApproveJoinRequests,
    admin_can_edit_member_nicknames: perms.adminCanEditMemberNicknames,
    admin_can_edit_group_profile: perms.adminCanEditGroupProfile,
    admin_can_manage_invite_links: perms.adminCanManageInviteLinks,
    who_can_send_attachments: perms.whoCanSendAttachments,
    who_can_create_invite_links: perms.whoCanCreateInviteLinks,
    who_can_approve_requests: perms.whoCanApproveRequests,
    who_can_edit_other_nicknames: perms.whoCanEditOtherNicknames,
    who_can_edit_own_nickname: perms.whoCanEditOwnNickname,
    who_can_edit_group_profile: perms.whoCanEditGroupProfile,
  };
}

function fromSnake(perms: GroupPermissions) {
  return {
    adminCanRemoveMembers: perms.admin_can_remove_members,
    adminCanApproveJoinRequests: perms.admin_can_approve_join_requests,
    adminCanEditMemberNicknames: perms.admin_can_edit_member_nicknames,
    adminCanEditGroupProfile: perms.admin_can_edit_group_profile,
    adminCanManageInviteLinks: perms.admin_can_manage_invite_links,
    whoCanSendAttachments: perms.who_can_send_attachments,
    whoCanCreateInviteLinks: perms.who_can_create_invite_links,
    whoCanApproveRequests: perms.who_can_approve_requests,
    whoCanEditOtherNicknames: perms.who_can_edit_other_nicknames,
    whoCanEditOwnNickname: perms.who_can_edit_own_nickname,
    whoCanEditGroupProfile: perms.who_can_edit_group_profile,
  };
}

interface CamelPermissions {
  adminCanRemoveMembers: boolean;
  adminCanApproveJoinRequests: boolean;
  adminCanEditMemberNicknames: boolean;
  adminCanEditGroupProfile: boolean;
  adminCanManageInviteLinks: boolean;
  whoCanSendAttachments: WhoOption;
  whoCanCreateInviteLinks: WhoOption;
  whoCanApproveRequests: WhoOption;
  whoCanEditOtherNicknames: WhoOption;
  whoCanEditOwnNickname: WhoOption;
  whoCanEditGroupProfile: WhoOption;
}

export default function PermissionsTab({
  isOwner,
  conversationId,
}: {
  isOwner: boolean;
  conversationId: string;
}) {
  const [perms, setPerms] = useState<CamelPermissions | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getConversationPermissions(conversationId)
      .then((data) => {
        if (!cancelled) {
          setPerms(fromSnake(data));
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load permissions');
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [conversationId]);

  const save = useCallback(
    (updated: CamelPermissions) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        setSaving(true);
        try {
          const result = await updateConversationPermissions(conversationId, toSnake(updated));
          setPerms(fromSnake(result));
          setError(null);
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : 'Failed to save permissions');
        } finally {
          setSaving(false);
        }
      }, 400);
    },
    [conversationId],
  );

  function set<K extends keyof CamelPermissions>(key: K, value: CamelPermissions[K]) {
    setPerms((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [key]: value };
      save(next);
      return next;
    });
  }

  if (!isOwner) {
    return (
      <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-void-bg-hover text-void-text-muted">
          <ShieldAlert className="h-5 w-5" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-void-text">Owner Only</h3>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-void-text-muted">
          Permissions can only be changed by the group owner.
        </p>
      </section>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-void-text-muted" />
      </div>
    );
  }

  if (!perms) {
    return (
      <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-6 text-center">
        <p className="text-sm text-void-text-muted">{error || 'Could not load permissions.'}</p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-2.5 text-xs text-red-300/80">
          {error}
        </div>
      )}

      {saving && (
        <div className="flex items-center gap-2 text-xs text-void-text-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          Saving...
        </div>
      )}

      {/* Admins */}
      <SectionCard title="Admins">
        <ToggleRow
          label="Remove Members?"
          value={perms.adminCanRemoveMembers}
          onChange={(v) => set('adminCanRemoveMembers', v)}
        />
        <ToggleRow
          label="Approve Join Requests?"
          value={perms.adminCanApproveJoinRequests}
          onChange={(v) => set('adminCanApproveJoinRequests', v)}
        />
        <ToggleRow
          label="Edit Member Nicknames?"
          value={perms.adminCanEditMemberNicknames}
          onChange={(v) => set('adminCanEditMemberNicknames', v)}
        />
        <ToggleRow
          label="Edit Group Profile?"
          value={perms.adminCanEditGroupProfile}
          onChange={(v) => set('adminCanEditGroupProfile', v)}
        />
        <ToggleRow
          label="Manage Invite Links?"
          value={perms.adminCanManageInviteLinks}
          onChange={(v) => set('adminCanManageInviteLinks', v)}
        />
      </SectionCard>

      {/* Attachments */}
      <SectionCard title="Attachments">
        <WhoDropdown
          label="Who can send attachments?"
          value={perms.whoCanSendAttachments}
          onChange={(v) => set('whoCanSendAttachments', v)}
        />
        <div className="py-3">
          <p className="mb-3 text-sm font-medium text-void-text">Restricted Members</p>
          <p className="mb-3 text-xs leading-relaxed text-void-text-muted">
            Block specific members from sending attachments.
          </p>
          <div className="flex items-center gap-2 rounded-xl border border-void-bg-hover bg-void-bg-sec/60 px-3 py-2.5 text-sm text-void-text-muted">
            <Search className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="text-xs">Search members…</span>
          </div>
        </div>
      </SectionCard>

      {/* Nickname Rules */}
      <SectionCard title="Nickname Rules">
        <WhoDropdown
          label="Who can edit other members' nicknames?"
          value={perms.whoCanEditOtherNicknames}
          onChange={(v) => set('whoCanEditOtherNicknames', v)}
        />
        <WhoDropdown
          label="Who can edit their own nickname?"
          value={perms.whoCanEditOwnNickname}
          onChange={(v) => set('whoCanEditOwnNickname', v)}
        />
      </SectionCard>

      {/* Group Profile */}
      <SectionCard title="Group Profile">
        <WhoDropdown
          label="Who can edit the group name and image?"
          value={perms.whoCanEditGroupProfile}
          onChange={(v) => set('whoCanEditGroupProfile', v)}
        />
      </SectionCard>

      {/* Safety */}
      <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-4 sm:p-5">
        <h3 className="mb-3 text-sm font-semibold text-void-text">Safety</h3>
        <div className="space-y-2">
          <p className="rounded-xl border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-xs leading-relaxed text-amber-300/80">
            Owner is always allowed to manage the server.
          </p>
          <p className="rounded-xl border border-void-bg-hover bg-void-bg-sec/50 px-4 py-3 text-xs leading-relaxed text-void-text-muted">
            Some permissions can still be overridden by ownership.
          </p>
        </div>
      </section>
    </div>
  );
}
