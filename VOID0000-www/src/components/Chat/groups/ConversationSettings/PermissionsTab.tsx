import { useState } from 'react';
import { Search, ShieldAlert } from 'lucide-react';

type YesNo = boolean;
type WhoOption = 'everyone' | 'admins' | 'owner';

const WHO_OPTIONS: Array<{ value: WhoOption; label: string }> = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'admins', label: 'Admins' },
  { value: 'owner', label: 'Owner' },
];

interface PermissionsState {
  // Admins section
  adminCanRemoveMembers: YesNo;
  adminCanApproveJoinRequests: YesNo;
  adminCanEditMemberNicknames: YesNo;
  adminCanEditGroupProfile: YesNo;
  adminCanManageInviteLinks: YesNo;
  // Members section
  membersCanSetOwnNickname: YesNo;
  // Attachments section
  whoCanSendAttachments: WhoOption;
  // Invites section
  whoCanCreateInviteLinks: WhoOption;
  whoCanApproveRequests: WhoOption;
  // Nickname Rules section
  whoCanEditOtherNicknames: WhoOption;
  whoCanEditOwnNickname: WhoOption;
  // Group Profile section
  whoCanEditGroupProfile: WhoOption;
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: YesNo;
  onChange: (next: YesNo) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="text-sm text-void-text">{label}</span>
      <div className="flex flex-shrink-0 overflow-hidden rounded-lg border border-void-bg-hover bg-void-bg-main">
        <button
          type="button"
          onClick={() => onChange(true)}
          className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
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
          className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
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
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="text-sm text-void-text">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as WhoOption)}
        className="rounded-lg border border-void-bg-hover bg-void-bg-main px-3 py-1.5 text-xs font-semibold text-void-text transition-colors hover:border-void-accent/40 focus:outline-none focus:ring-1 focus:ring-void-accent/50"
      >
        {WHO_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
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

export default function PermissionsTab({ isOwner }: { isOwner: boolean }) {
  const [perms, setPerms] = useState<PermissionsState>({
    adminCanRemoveMembers: true,
    adminCanApproveJoinRequests: true,
    adminCanEditMemberNicknames: true,
    adminCanEditGroupProfile: true,
    adminCanManageInviteLinks: true,
    membersCanSetOwnNickname: true,
    whoCanSendAttachments: 'everyone',
    whoCanCreateInviteLinks: 'admins',
    whoCanApproveRequests: 'admins',
    whoCanEditOtherNicknames: 'admins',
    whoCanEditOwnNickname: 'everyone',
    whoCanEditGroupProfile: 'admins',
  });

  function set<K extends keyof PermissionsState>(key: K, value: PermissionsState[K]) {
    setPerms((prev) => ({ ...prev, [key]: value }));
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

  return (
    <div className="space-y-5">

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

      {/* Members */}
      <SectionCard title="Members">
        <ToggleRow
          label="Set Own Nickname?"
          value={perms.membersCanSetOwnNickname}
          onChange={(v) => set('membersCanSetOwnNickname', v)}
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

      {/* Invites */}
      <SectionCard title="Invites">
        <WhoDropdown
          label="Who can create invite links?"
          value={perms.whoCanCreateInviteLinks}
          onChange={(v) => set('whoCanCreateInviteLinks', v)}
        />
        <WhoDropdown
          label="Who can approve requests?"
          value={perms.whoCanApproveRequests}
          onChange={(v) => set('whoCanApproveRequests', v)}
        />
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
