import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ExternalLink, Link2, Loader2, Users } from 'lucide-react';
import { useUser } from '../../../Services/Auth/UserContext';
import type { InvitePreview } from '../../../Services/Chat/chatTypes';
import {
  getInvitePreview,
  getInviteRequestStatus,
  requestJoinByInviteCode,
} from '../../../Services/Chat/inviteService';

interface InviteEmbedProps {
  inviteCode: string;
  inviteUrl: string;
  onOpenInvite: (url: string) => void;
}

const invitePreviewCache = new Map<string, InvitePreview | null>();
const inviteStatusCache = new Map<string, {
  status: 'none' | 'pending' | 'declined' | 'approved' | 'member';
  conversationPublicId: string | null;
}>();

function formatExpiry(expiresAt: string | null) {
  if (!expiresAt) return 'No expiration';
  return new Date(expiresAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getInviteInitial(name: string | null | undefined) {
  const trimmed = name?.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '#';
}

export default function InviteEmbed({
  inviteCode,
  inviteUrl,
  onOpenInvite,
}: InviteEmbedProps) {
  const navigate = useNavigate();
  const { user } = useUser();
  const [preview, setPreview] = useState<InvitePreview | null>(() => invitePreviewCache.get(inviteCode) ?? null);
  const [loading, setLoading] = useState(!invitePreviewCache.has(inviteCode));
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<'none' | 'pending' | 'declined' | 'approved' | 'member'>(
    () => inviteStatusCache.get(`${inviteCode}:${user?.id || 'guest'}`)?.status || 'none',
  );
  const [statusConversationPublicId, setStatusConversationPublicId] = useState<string | null>(
    () => inviteStatusCache.get(`${inviteCode}:${user?.id || 'guest'}`)?.conversationPublicId || null,
  );
  const [requesting, setRequesting] = useState(false);
  const [statusNote, setStatusNote] = useState('');

  const statusCacheKey = `${inviteCode}:${user?.id || 'guest'}`;

  useEffect(() => {
    let ignore = false;

    if (invitePreviewCache.has(inviteCode)) {
      setPreview(invitePreviewCache.get(inviteCode) ?? null);
      setLoading(false);
      setLoadError('');
      return undefined;
    }

    setLoading(true);
    setLoadError('');

    void getInvitePreview(inviteCode)
      .then((result) => {
        if (ignore) return;
        invitePreviewCache.set(inviteCode, result);
        setPreview(result);
      })
      .catch((error) => {
        if (ignore) return;
        console.error('Failed to load invite embed preview:', error);
        invitePreviewCache.set(inviteCode, null);
        setPreview(null);
        setLoadError(error instanceof Error ? error.message : 'Invite preview unavailable');
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [inviteCode]);

  useEffect(() => {
    let ignore = false;

    if (!user) {
      setStatus('none');
      setStatusConversationPublicId(null);
      setStatusNote('');
      return undefined;
    }

    const cached = inviteStatusCache.get(statusCacheKey);
    if (cached) {
      setStatus(cached.status);
      setStatusConversationPublicId(cached.conversationPublicId);
    }

    void getInviteRequestStatus(inviteCode)
      .then((result) => {
        if (ignore) return;
        const next = {
          status: result.status,
          conversationPublicId: result.conversation_public_id || null,
        };
        inviteStatusCache.set(statusCacheKey, next);
        setStatus(next.status);
        setStatusConversationPublicId(next.conversationPublicId);
      })
      .catch((error) => {
        if (ignore) return;
        console.error('Failed to load invite request status:', error);
      });

    return () => {
      ignore = true;
    };
  }, [inviteCode, statusCacheKey, user]);

  const subtitle = useMemo(() => {
    if (!preview) return 'Invite preview unavailable';
    const ownerLabel = preview.owner_display_name || preview.owner_username || 'Someone';
    return `${ownerLabel} invited you to join this group`;
  }, [preview]);

  const actionLabel = status === 'member'
    ? 'Open Group'
    : status === 'pending'
      ? 'Request Pending'
      : 'Join Group';
  const hasPreview = Boolean(preview);
  const hasLoadError = Boolean(loadError) && !loading;

  const handleJoinAction = async () => {
    if (!user) {
      onOpenInvite(inviteUrl);
      return;
    }

    if (status === 'member') {
      const groupId = statusConversationPublicId || preview?.conversation_public_id || null;
      if (groupId) {
        navigate(`/chats/${groupId}`);
      } else {
        onOpenInvite(inviteUrl);
      }
      return;
    }

    if (status === 'pending' || requesting) {
      return;
    }

    setRequesting(true);
    setStatusNote('');

    try {
      const result = await requestJoinByInviteCode(inviteCode, user.id);
      const next = {
        status: result.status,
        conversationPublicId: preview?.conversation_public_id || null,
      } as const;
      inviteStatusCache.set(statusCacheKey, next);
      setStatus(next.status);
      setStatusConversationPublicId(next.conversationPublicId);
      setStatusNote('Join request sent.');
    } catch (error: any) {
      if (error?.code === 'ALREADY_MEMBER') {
        const next = {
          status: 'member' as const,
          conversationPublicId: error.conversation_public_id || preview?.conversation_public_id || null,
        };
        inviteStatusCache.set(statusCacheKey, next);
        setStatus(next.status);
        setStatusConversationPublicId(next.conversationPublicId);
        setStatusNote('You are already a member.');
        return;
      }

      console.error('Failed to request join from invite embed:', error);
      setStatusNote(error?.message || 'Failed to join from this invite.');
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-void-bg-hover bg-void-bg-sec/85 p-4 text-left shadow-md">
      <button
        type="button"
        onClick={() => onOpenInvite(inviteUrl)}
        disabled={loading}
        className="w-full text-left transition-colors hover:opacity-95 focus:outline-none focus:ring-2 focus:ring-void-accent/40 rounded-xl disabled:cursor-default disabled:hover:opacity-100"
      >
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-void-text-muted">
          <Link2 className="h-4 w-4" />
          Invite Link
        </div>

        <div className="flex min-h-12 items-center gap-3">
          {loading ? (
            <div className="h-12 w-12 animate-pulse rounded-2xl bg-void-bg-main/70" />
          ) : preview?.conversation_icon_url ? (
            <img
              src={preview.conversation_icon_url}
              alt=""
              className="h-12 w-12 rounded-2xl object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-void-accent/15 text-lg font-semibold text-void-accent">
              {getInviteInitial(preview?.conversation_name)}
            </div>
          )}

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="truncate text-sm font-semibold text-void-text">
              {loading ? (
                <span className="block h-4 w-36 animate-pulse rounded bg-void-bg-main/70" />
              ) : (
                preview?.conversation_name || 'VOID Group Invite'
              )}
            </p>
            <p className="min-h-[16px] truncate text-xs text-void-text-muted">
              {loading ? (
                <span className="block h-3.5 w-44 animate-pulse rounded bg-void-bg-main/60" />
              ) : (
                subtitle
              )}
            </p>
          </div>

          {loading ? (
            <div className="h-4 w-4 flex-shrink-0 rounded bg-void-bg-main/60" />
          ) : (
            <ExternalLink className="h-4 w-4 flex-shrink-0 text-void-text-muted" />
          )}
        </div>
      </button>

      <div className="min-h-[28px]">
        {loading ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-void-text-muted">
            <span className="inline-flex h-7 w-24 animate-pulse rounded-full bg-void-bg-main/70 px-2.5 py-1" />
            <span className="inline-flex h-7 w-28 animate-pulse rounded-full bg-void-bg-main/70 px-2.5 py-1" />
          </div>
        ) : hasPreview && preview ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-void-text-muted">
            <span className="inline-flex items-center gap-1 rounded-full bg-void-bg-main/70 px-2.5 py-1">
              <Users className="h-3.5 w-3.5" />
              {preview.member_count} members
            </span>
            <span className="rounded-full bg-void-bg-main/70 px-2.5 py-1">
              Expires {formatExpiry(preview.expires_at)}
            </span>
          </div>
        ) : (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {loadError || 'This invite link is unavailable.'}
          </div>
        )}
      </div>

      <div className="border-t border-void-bg-hover pt-4">
        {loading ? (
          <div className="inline-flex h-[42px] w-full animate-pulse items-center justify-center gap-2 rounded-xl bg-void-bg-main/70 text-sm font-semibold text-transparent">
            Loading
          </div>
        ) : (
          <button
            type="button"
            onClick={handleJoinAction}
            disabled={hasLoadError || requesting || status === 'pending'}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-void-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-void-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {requesting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : status === 'member' ? (
              <ExternalLink className="h-4 w-4" />
            ) : status === 'pending' ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <Users className="h-4 w-4" />
            )}
            {requesting ? 'Joining...' : actionLabel}
          </button>
        )}

        <div className="min-h-[16px] pt-2">
          {statusNote ? (
            <p className={`text-xs ${statusNote.toLowerCase().includes('failed') ? 'text-red-300' : 'text-void-text-muted'}`}>
              {statusNote}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
