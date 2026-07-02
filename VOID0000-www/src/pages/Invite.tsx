import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Lock, Users } from 'lucide-react';
import {
  getInvitePreview,
  getInviteRequestStatus,
  InvitePreview,
  requestJoinByInviteCode,
} from '../Services/Chat/chatService';
import { useUser } from '../Services/Auth/UserContext';

const PENDING_INVITE_PATH_KEY = 'void_pending_invite_path';

function formatExpiry(expiresAt: string | null) {
  if (!expiresAt) return 'No expiration';
  return new Date(expiresAt).toLocaleString();
}

function getInviteInitial(name: string | null | undefined) {
  const trimmed = name?.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '#';
}

export default function InvitePage() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { user, loading } = useUser();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [status, setStatus] = useState<'none' | 'pending' | 'declined' | 'approved' | 'member'>('none');
  const [statusConversationPublicId, setStatusConversationPublicId] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canRequestJoin = status === 'none' || status === 'declined' || status === 'approved';

  useEffect(() => {
    let ignore = false;

    const load = async () => {
      setPageLoading(true);
      setError('');
      setNotice('');

      try {
        const nextPreview = await getInvitePreview(code);
        if (ignore) return;
        setPreview(nextPreview);

        if (user) {
          const nextStatus = await getInviteRequestStatus(code);
          if (ignore) return;
          setStatus(nextStatus.status);
          setStatusConversationPublicId(nextStatus.conversation_public_id || null);
        } else {
          setStatus('none');
          setStatusConversationPublicId(null);
        }
      } catch (err: any) {
        if (ignore) return;
        setError(err.message || 'This invite is unavailable.');
      } finally {
        if (!ignore) {
          setPageLoading(false);
        }
      }
    };

    void load();

    return () => {
      ignore = true;
    };
  }, [code, user?.id]);

  const title = useMemo(() => {
    if (!preview?.conversation_name) return 'Group Invite';
    return preview.conversation_name;
  }, [preview?.conversation_name]);

  const handleLogin = () => {
    sessionStorage.setItem(PENDING_INVITE_PATH_KEY, `/invite/${code}`);
    navigate('/auth?view=login');
  };

  const handleRequestJoin = async () => {
    if (!user) {
      handleLogin();
      return;
    }

    setRequesting(true);
    setError('');
    setNotice('');

    try {
      const result = await requestJoinByInviteCode(code, user.id);
      setStatus(result.status);
      setNotice('Join request sent. The owner needs to approve it before you can enter.');
    } catch (err: any) {
      if (err?.code === 'ALREADY_MEMBER') {
        setStatus('member');
        setStatusConversationPublicId(err.conversation_public_id || preview?.conversation_public_id || null);
        setNotice('You are already a member of this group.');
        return;
      }

      setError(err.message || 'Failed to request access.');
    } finally {
      setRequesting(false);
    }
  };

  const handleOpenGroup = () => {
    const groupId = statusConversationPublicId || preview?.conversation_public_id;
    if (groupId) {
      navigate(`/chats/${groupId}`);
    } else {
      navigate('/chats');
    }
  };

  if (pageLoading || loading) {
    return (
      <div className="min-h-screen bg-void-bg-main flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-void-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-void-bg-main text-void-text">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center px-4 py-10">
        <div className="w-full overflow-hidden rounded-3xl border border-void-bg-hover bg-void-bg-sec shadow-2xl">
          <div className="border-b border-void-bg-hover bg-void-bg-main/60 px-6 py-8">
            <div className="flex items-center gap-4">
              {preview?.conversation_icon_url ? (
                <img
                  src={preview.conversation_icon_url}
                  alt=""
                  className="h-16 w-16 rounded-3xl object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-void-accent/15 text-2xl font-semibold text-void-accent">
                  {getInviteInitial(preview?.conversation_name)}
                </div>
              )}
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-void-text-muted">Invite Link</p>
                <h1 className="mt-2 truncate text-2xl font-semibold">{title}</h1>
                <p className="mt-2 text-sm text-void-text-muted">
                  {preview
                    ? `${preview.owner_display_name || preview.owner_username || 'Unknown owner'} is inviting people to this group.`
                    : 'This invite link is no longer available.'}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-6 px-6 py-8">
            {error && (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {error}
              </div>
            )}

            {notice && (
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
                {notice}
              </div>
            )}

            {preview && (
              <>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-2xl border border-void-bg-hover bg-void-bg-main/35 p-4">
                    <div className="flex items-center gap-2 text-void-text-muted">
                      <Users className="h-4 w-4" />
                      <span className="text-xs uppercase tracking-[0.18em]">Members</span>
                    </div>
                    <p className="mt-3 text-2xl font-semibold text-void-text">{preview.member_count}</p>
                  </div>

                  <div className="rounded-2xl border border-void-bg-hover bg-void-bg-main/35 p-4">
                    <div className="flex items-center gap-2 text-void-text-muted">
                      <Lock className="h-4 w-4" />
                      <span className="text-xs uppercase tracking-[0.18em]">History</span>
                    </div>
                    <p className="mt-3 text-sm font-medium text-void-text">New messages only</p>
                  </div>

                  <div className="rounded-2xl border border-void-bg-hover bg-void-bg-main/35 p-4">
                    <div className="flex items-center gap-2 text-void-text-muted">
                      <CheckCircle2 className="h-4 w-4" />
                      <span className="text-xs uppercase tracking-[0.18em]">Expires</span>
                    </div>
                    <p className="mt-3 text-sm font-medium text-void-text">{formatExpiry(preview.expires_at)}</p>
                  </div>
                </div>
              </>
            )}

            <div className="flex flex-col gap-3 sm:flex-row">
              {!user && (
                <button
                  type="button"
                  onClick={handleLogin}
                  className="inline-flex w-full items-center justify-center rounded-2xl bg-void-accent px-5 py-3 text-sm font-semibold text-white transition-colors hover:brightness-110 sm:w-auto"
                >
                  Log In To Continue
                </button>
              )}

              {user && canRequestJoin && (
                <button
                  type="button"
                  onClick={handleRequestJoin}
                  disabled={requesting}
                  className="inline-flex w-full items-center justify-center rounded-2xl bg-void-accent px-5 py-3 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-60 sm:w-auto"
                >
                  {requesting
                    ? 'Sending Request...'
                    : status === 'none'
                      ? 'Request Join'
                      : 'Request Again'}
                </button>
              )}

              {user && status === 'pending' && (
                <button
                  type="button"
                  disabled
                  className="inline-flex w-full items-center justify-center rounded-2xl bg-void-bg-hover px-5 py-3 text-sm font-semibold text-void-text-muted sm:w-auto"
                >
                  Request Pending
                </button>
              )}

              {user && status === 'member' && (
                <button
                  type="button"
                  onClick={handleOpenGroup}
                  className="inline-flex w-full items-center justify-center rounded-2xl bg-void-accent px-5 py-3 text-sm font-semibold text-white transition-colors hover:brightness-110 sm:w-auto"
                >
                  Open Group
                </button>
              )}

              <button
                type="button"
                onClick={() => navigate('/chats')}
                className="inline-flex w-full items-center justify-center rounded-2xl border border-void-bg-hover px-5 py-3 text-sm font-semibold text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text sm:w-auto"
              >
                Back To Chats
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
