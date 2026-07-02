import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Link2, Loader2, Lock, RefreshCw, Users, X } from 'lucide-react';
import UserAvatar from '../../../common/UserAvatar';
import type {
  ConversationInviteLink,
  ConversationJoinRequest,
} from '../../../../Services/Chat/chatService';
import {
  formatTimestamp,
  getRequestLabel,
  isInviteExpired,
} from './shared';

interface InvitesTabProps {
  canManageInvites: boolean;
  invitesLoading: boolean;
  invitesLoaded: boolean;
  inviteError: string;
  inviteActionError: string;
  isCreatingInvite: boolean;
  busyInviteId: number | null;
  busyRequestId: number | null;
  copiedInviteId: number | null;
  pendingRequests: ConversationJoinRequest[];
  inviteLinks: ConversationInviteLink[];
  joinApprovalsPaused: boolean;
  joinApprovalsPausedMessage: string;
  onRefreshInvites: () => Promise<void> | void;
  onCreateInvite: () => Promise<void> | void;
  onDeclineRequest: (requestId: number) => Promise<void> | void;
  onApproveRequest: (request: ConversationJoinRequest) => Promise<void> | void;
  onCopyInvite: (invite: ConversationInviteLink) => Promise<void> | void;
  onRevokeInvite: (inviteId: number) => Promise<void> | void;
}

export default function InvitesTab({
  canManageInvites,
  invitesLoading,
  invitesLoaded,
  inviteError,
  inviteActionError,
  isCreatingInvite,
  busyInviteId,
  busyRequestId,
  copiedInviteId,
  pendingRequests,
  inviteLinks,
  joinApprovalsPaused,
  joinApprovalsPausedMessage,
  onRefreshInvites,
  onCreateInvite,
  onDeclineRequest,
  onApproveRequest,
  onCopyInvite,
  onRevokeInvite,
}: InvitesTabProps) {
  const [hiddenInviteLinkIds, setHiddenInviteLinkIds] = useState<Set<number>>(new Set());
  const staleInviteLinkIds = useMemo(() => (
    inviteLinks
      .filter((invite) => invite.is_revoked || isInviteExpired(invite))
      .map((invite) => invite.id)
  ), [inviteLinks]);
  const visibleInviteLinks = useMemo(() => (
    inviteLinks.filter((invite) => !hiddenInviteLinkIds.has(invite.id))
  ), [hiddenInviteLinkIds, inviteLinks]);
  const hiddenInviteLinkCount = inviteLinks.length - visibleInviteLinks.length;
  const visibleStaleInviteCount = visibleInviteLinks.filter(
    (invite) => invite.is_revoked || isInviteExpired(invite),
  ).length;

  useEffect(() => {
    setHiddenInviteLinkIds((current) => {
      if (current.size === 0) {
        return current;
      }

      const inviteIds = new Set(inviteLinks.map((invite) => invite.id));
      const next = new Set(
        [...current].filter((inviteId) => inviteIds.has(inviteId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [inviteLinks]);

  const hideStaleInviteLinks = () => {
    setHiddenInviteLinkIds((current) => {
      const next = new Set(current);
      staleInviteLinkIds.forEach((inviteId) => next.add(inviteId));
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-4 sm:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="max-w-2xl">
            <h3 className="text-sm font-semibold text-void-text">Invite Links</h3>
          </div>

          {canManageInvites && (
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <button
                type="button"
                onClick={() => void onCreateInvite()}
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
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onRefreshInvites()}
                  disabled={invitesLoading}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-void-bg-hover bg-void-bg-sec/70 px-3 py-2 text-xs font-semibold text-void-text transition-colors hover:bg-void-bg-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${invitesLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
                <div className="inline-flex items-center gap-2 rounded-full bg-void-bg-hover px-3 py-1 text-sm font-semibold text-void-text">
                  <Users className="h-4 w-4 text-void-text-muted" />
                  <span>{pendingRequests.length}</span>
                </div>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {!invitesLoading && invitesLoaded && pendingRequests.length === 0 && (
                <div className="rounded-xl border border-dashed border-void-bg-hover bg-void-bg-sec/45 px-4 py-5 text-sm text-void-text-muted">
                  No pending requests right now.
                </div>
              )}

              {joinApprovalsPaused && pendingRequests.length > 0 && (
                <div className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                  {joinApprovalsPausedMessage}
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

                    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-row">
                      <button
                        type="button"
                        onClick={() => void onDeclineRequest(request.id)}
                        disabled={isBusy}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-void-bg-hover bg-void-bg-sec/70 px-4 py-2.5 text-sm font-medium text-void-text transition-colors hover:bg-void-bg-hover disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                      >
                        {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                        Decline
                      </button>
                      <button
                        type="button"
                        onClick={() => void onApproveRequest(request)}
                        disabled={isBusy || joinApprovalsPaused}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-void-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-void-accent-hover disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
                      >
                        {isBusy ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : joinApprovalsPaused ? (
                          <Lock className="h-4 w-4" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                        {joinApprovalsPaused ? 'Paused' : 'Approve'}
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
                <p className="mt-1 text-xs text-void-text-muted">
                  Expired and revoked links can be hidden from this view when they get noisy.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {visibleStaleInviteCount > 0 && (
                  <button
                    type="button"
                    onClick={hideStaleInviteLinks}
                    className="inline-flex items-center justify-center rounded-xl border border-void-bg-hover bg-void-bg-sec/70 px-3 py-2 text-xs font-semibold text-void-text transition-colors hover:bg-void-bg-hover"
                  >
                    Hide expired
                  </button>
                )}
                {hiddenInviteLinkCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setHiddenInviteLinkIds(new Set())}
                    className="inline-flex items-center justify-center rounded-xl border border-void-bg-hover bg-void-bg-sec/70 px-3 py-2 text-xs font-semibold text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
                  >
                    Show all
                  </button>
                )}
                <div className="inline-flex items-center gap-2 rounded-full bg-void-bg-hover px-3 py-1 text-sm font-semibold text-void-text">
                  <Link2 className="h-4 w-4 text-void-text-muted" />
                  <span>
                    {visibleInviteLinks.length}
                    {hiddenInviteLinkCount > 0 ? ` / ${inviteLinks.length}` : ''}
                  </span>
                </div>
              </div>
            </div>

            {hiddenInviteLinkCount > 0 && (
              <p className="mt-4 rounded-xl border border-void-bg-hover bg-void-bg-sec/45 px-4 py-3 text-xs leading-relaxed text-void-text-muted">
                Hidden {hiddenInviteLinkCount} expired or revoked invite {hiddenInviteLinkCount === 1 ? 'link' : 'links'} in this view.
              </p>
            )}

            <div className="mt-5 max-h-[min(46dvh,24rem)] space-y-3 overflow-y-auto overscroll-contain pr-1">
              {!invitesLoading && invitesLoaded && visibleInviteLinks.length === 0 && (
                <div className="rounded-xl border border-dashed border-void-bg-hover bg-void-bg-sec/45 px-4 py-5 text-sm text-void-text-muted">
                  {inviteLinks.length === 0
                    ? 'No invite links yet. Create one when you want people to request access.'
                    : 'All expired or revoked invite links are hidden.'}
                </div>
              )}

              {visibleInviteLinks.map((invite) => {
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

                      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-row">
                        <button
                          type="button"
                          onClick={() => void onCopyInvite(invite)}
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
                          onClick={() => void onRevokeInvite(invite.id)}
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
  );
}
