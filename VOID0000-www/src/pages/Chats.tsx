// src/pages/Chats.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Settings, Users, MessageCircle, ArrowLeft, ShieldAlert, SlidersHorizontal, KeyRound } from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import ConversationSettings from '../components/Chat/ConversationSettings';
import { useAuth } from '../Services/hooks/Auth/useAuth';
import { useProfileRecord } from '../Services/hooks/profile/useProfileRecord';
import { useChatManager } from '../Services/hooks/Chats/useChatManager';
import { useFriends } from '../Services/hooks/Friends/useFriends';
import UserProfileModal from '../components/common/Profile/UserProfileModal';
import SettingsModal from '../components/common/Settings/SettingsModal';
import ConversationList from '../components/Chat/ConversationList';
import MessageView from '../components/Chat/MessageViewV2';
import MessageInput from '../components/Chat/MessageInput';
import ForwardMessageModal from '../components/Chat/ForwardMessageModal';
import GroupCreateModal from '../components/Chat/groups/GroupCreateModal';
import FriendsView from '../components/common/Friends/FriendsView';
import { gateway } from '../Services/Gateway/gateway';
import { Message, Conversation, forwardMessageToConversation } from '../Services/Chat/chatService';
import { matchesConversationIdentifier } from '../Services/Chat/utils/conversationUtils';
import { useUser } from '../Services/Auth/UserContext';
import UserAvatar from '../components/common/UserAvatar';
import { ConversationPaneSkeleton } from '../components/common/Skeleton';
import { useConnectionStatus } from '../Services/hooks/common/useConnectionStatus';
import { useServiceHealth } from '../Services/hooks/common/useServiceHealth';
import PushNotificationPrompt from '../components/common/Notifications/PushNotificationPrompt';

const normalizeText = (value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

const ChatDashboard = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    dmConversationId,
    groupConversationId,
  } = useParams<{
    dmConversationId?: string;
    groupConversationId?: string;
  }>();
  const { loading, user } = useAuth();
  const {
    keyStatusLoading,
    mlsRecoveryGate,
    isLoggingOut,
    retryMlsRecoveryWithPassword,
    retryMlsRecoveryWithRecoveryKey,
    continueWithoutLocalSecureHistory,
    logout,
  } = useUser();

  const { profile: myProfile } = useProfileRecord(user?.profile_id || '');
  const { isOnline, showReconnectBanner } = useConnectionStatus();
  const serviceHealth = useServiceHealth();
  const serviceIssue = serviceHealth.issues[0] || null;

  // Independently detect bootstrap stalls (API down before the gateway ever
  // connects). The gateway stall timer in useConnectionStatus only fires once
  // gatewayState === 'reconnecting', which never happens if /api/me or the key
  // backup fetch hang. This timer covers that earlier failure path.
  const [bootstrapStalled, setBootstrapStalled] = useState(false);
  const bootstrapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const isBootstrapping = (loading || keyStatusLoading) && !isLoggingOut;
    if (isBootstrapping) {
      if (!bootstrapTimerRef.current) {
        bootstrapTimerRef.current = setTimeout(() => setBootstrapStalled(true), 8000);
      }
    } else {
      if (bootstrapTimerRef.current) {
        clearTimeout(bootstrapTimerRef.current);
        bootstrapTimerRef.current = null;
      }
      setBootstrapStalled(false);
    }
  }, [loading, keyStatusLoading, isLoggingOut]);

  // Friends from the shared FriendsProvider — single source of truth
  const { friends } = useFriends();

  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [chatFilter, setChatFilter] = useState<'dm' | 'group'>('dm');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(true);
  const [mobileSidebarMode, setMobileSidebarMode] = useState<'messages' | 'friends'>('messages');
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  const [chatViewportHeight, setChatViewportHeight] = useState<number | null>(() =>
    typeof window !== 'undefined'
      ? window.visualViewport?.height ?? window.innerHeight
      : null
  );
  const [convRefresh, setConvRefresh] = useState(0);
  const [lastSentConversationId, setLastSentConversationId] = useState<string | null>(null);
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const sendNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showConvSettings, setShowConvSettings] = useState(false);
  const [forwardingMessage, setForwardingMessage] = useState<Message | null>(null);
  const [mlsRecoveryKey, setMlsRecoveryKey] = useState('');
  const [mlsRecoveryError, setMlsRecoveryError] = useState('');
  const [isSubmittingMlsRecoveryKey, setIsSubmittingMlsRecoveryKey] = useState(false);
  const memberDisplayCacheRef = useRef<Record<string, any>>({});

  const {
    members,
    activeConversation,
    activeGroup,
    encryptionKey,
    keyVersion,
    encryptionError,
    conversationSecurityState,
    typingUsers,
    messageEvents,
    editingMessage,
    replyTo,
    messageUpdate,
    messageDelete,
    setEditingMessage,
    setReplyTo,
    setMessageUpdate,
    patchConversationInState,
    handleMessageSent,
    handleStartDM,
    handleBackToMe,
    handleEncryptionKeyResolved,
    openConversationByIdentifier,
    openGroupByIdentifier,
  } = useChatManager(user);

  const showSendNotice = useCallback((message: string | null) => {
    if (sendNoticeTimerRef.current) {
      clearTimeout(sendNoticeTimerRef.current);
      sendNoticeTimerRef.current = null;
    }

    setSendNotice(message);

    if (message) {
      sendNoticeTimerRef.current = setTimeout(() => {
        setSendNotice(null);
        sendNoticeTimerRef.current = null;
      }, 4500);
    }
  }, []);

  useEffect(() => () => {
    if (sendNoticeTimerRef.current) {
      clearTimeout(sendNoticeTimerRef.current);
    }
  }, []);

  useEffect(() => {
    showSendNotice(null);
  }, [activeConversation?.id, showSendNotice]);

  const getRouteId = (conversation?: { public_id?: string | null }) => conversation?.public_id || null;

  const getDmRoute = (conversation?: { public_id?: string | null }) => {
    const routeId = getRouteId(conversation);
    return routeId ? `/chats/@me/${routeId}` : '/chats';
  };

  const getGroupRoute = (group?: { public_id?: string | null }) => {
    const groupRouteId = getRouteId(group);
    if (!groupRouteId) return '/chats';
    return `/chats/${groupRouteId}`;
  };

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setIsMobileSidebarOpen(true);
      return;
    }

    const hasConversationRoute = Boolean(dmConversationId || groupConversationId);
    setIsMobileSidebarOpen(!hasConversationRoute);
  }, [isMobile, dmConversationId, groupConversationId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const syncViewportHeight = () => {
      setChatViewportHeight(window.visualViewport?.height ?? window.innerHeight);
    };

    syncViewportHeight();
    window.addEventListener('resize', syncViewportHeight);
    window.visualViewport?.addEventListener('resize', syncViewportHeight);

    return () => {
      window.removeEventListener('resize', syncViewportHeight);
      window.visualViewport?.removeEventListener('resize', syncViewportHeight);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const syncRouteState = async () => {
      if (loading || !user?.id) return;

      try {
        if (dmConversationId) {
          const dmAlreadyHydrated =
            !activeGroup &&
            activeConversation?.type === 'dm' &&
            matchesConversationIdentifier(activeConversation, dmConversationId);
          if (dmAlreadyHydrated) {
            return;
          }

          const conversation = await openConversationByIdentifier(dmConversationId);
          if (!cancelled && conversation?.type !== 'dm') {
            handleBackToMe();
            navigate('/chats', { replace: true });
          }
          return;
        }

        if (groupConversationId) {
          const groupMatchesRoute = matchesConversationIdentifier(activeGroup, groupConversationId);
          if (groupMatchesRoute && activeConversation?.type === 'group') {
            return;
          }

          const result = await openGroupByIdentifier(groupConversationId, null);
          if (cancelled) return;

          const normalizedRoute = getGroupRoute(result.group);
          if (normalizedRoute !== '/chats' && normalizedRoute !== location.pathname) {
            navigate(normalizedRoute, { replace: true });
          }
          return;
        }

        handleBackToMe();
      } catch (err) {
        if (cancelled) return;
        const reason = err instanceof Error ? err.message : String(err || '');
        if (!reason.includes('Not a member of this conversation')) {
          console.error('Failed to sync chat route:', err);
        }
        handleBackToMe();
        navigate('/chats', { replace: true });
      }
    };

    void syncRouteState();
    return () => {
      cancelled = true;
    };
  }, [
    activeConversation?.id,
    activeConversation?.public_id,
    activeConversation?.type,
    activeGroup?.id,
    activeGroup?.public_id,
    loading,
    user?.id,
    dmConversationId,
    groupConversationId,
    location.pathname,
    navigate,
  ]);

  useEffect(() => {
    Object.entries(members).forEach(([userId, member]) => {
      if (!member) return;
      memberDisplayCacheRef.current[userId] = {
        ...(memberDisplayCacheRef.current[userId] || {}),
        ...member,
      };
    });
  }, [members]);

  useEffect(() => {
    setMlsRecoveryKey('');
    setMlsRecoveryError('');
    setIsSubmittingMlsRecoveryKey(false);
  }, [mlsRecoveryGate.active, mlsRecoveryGate.reason]);

  const messageDisplayMembers = useMemo(
    () => ({
      ...memberDisplayCacheRef.current,
      ...members,
    }),
    [members, activeConversation?.id]
  );

  const handleReply = useCallback((message: Message) => {
    setReplyTo(message);
  }, [setReplyTo]);

  const handleEdit = useCallback((message: Message) => {
    setEditingMessage(message);
  }, [setEditingMessage]);

  const getMessageSenderDisplayName = useCallback((message: Message) => {
    if (message.sender_id === user?.id) {
      return myProfile?.display_name || user?.username || 'You';
    }

    const member = messageDisplayMembers[message.sender_id];
    if (member) {
      return member.nickname || member.display_name || member.username || 'Unknown';
    }

    const friend = friends.find((entry) => entry.id === message.sender_id);
    return friend?.display_name || friend?.username || 'Unknown';
  }, [friends, messageDisplayMembers, myProfile?.display_name, user?.id, user?.username]);

  const handleForward = useCallback((message: Message) => {
    setForwardingMessage(message);
  }, []);

  const handleEditComplete = useCallback((messageId: string, updates: {
    content: string;
    mentions?: Message['mentions'];
    forwarded?: Message['forwarded'];
    link_preview?: Message['link_preview'];
    message_type?: string | null;
  }) => {
    setMessageUpdate({
      message_id: messageId,
      content: updates.content,
      is_edited: true,
      edited_at: new Date().toISOString(),
      mentions: updates.mentions,
      forwarded: updates.forwarded,
      link_preview: updates.link_preview,
      message_type: updates.message_type ?? undefined,
    });
  }, [setMessageUpdate]);

  const displayConversation = activeGroup || activeConversation;
  const isPendingDmRoute = Boolean(dmConversationId) && (
    activeGroup !== null ||
    activeConversation?.type !== 'dm' ||
    !matchesConversationIdentifier(activeConversation, dmConversationId)
  );
  const isPendingGroupRoute = Boolean(groupConversationId) && (
    activeConversation?.type !== 'group' ||
    !matchesConversationIdentifier(activeConversation, groupConversationId) ||
    !matchesConversationIdentifier(activeGroup, groupConversationId)
  );
  const isConversationRoutePending = !loading && Boolean(user?.id) && (isPendingDmRoute || isPendingGroupRoute);
  const showConversationRoutePendingSkeleton = isConversationRoutePending && !activeConversation;
  const showConversationRoutePendingOverlay = isConversationRoutePending && !!activeConversation;
  const typingParticipants = useMemo(() => {
    if (!activeConversation) return [];

    return Object.entries(typingUsers)
      .filter(([typingUserId]) => typingUserId !== user?.id)
      .sort(([, a], [, b]) => b - a)
      .map(([typingUserId]) => {
        const member = messageDisplayMembers[typingUserId] || members[typingUserId];
        return {
          userId: typingUserId,
          displayName: member?.nickname || member?.display_name || member?.username || 'Someone',
          username: member?.username || null,
          avatarUrl: member?.avatar_url || null,
        };
      });
  }, [activeConversation?.id, members, messageDisplayMembers, typingUsers, user?.id]);
  const dmPeerUserId = displayConversation?.type === 'dm' ? normalizeText(displayConversation.dm_user_id) : null;
  const dmPeerUsername = displayConversation?.type === 'dm' ? normalizeText(displayConversation.dm_username) : null;
  const dmPeer = displayConversation?.type === 'dm'
    ? Object.values(members).find(
        (member: { user_id: string; display_name?: string | null; username?: string; avatar_url?: string | null }) =>
          member.user_id !== user?.id && (
            (dmPeerUserId ? member.user_id === dmPeerUserId : false) ||
            (dmPeerUsername ? normalizeText(member.username) === dmPeerUsername : false)
          )
      ) || (!dmPeerUserId && !dmPeerUsername
        ? Object.values(members).find(
            (member: { user_id: string; display_name?: string | null; username?: string; avatar_url?: string | null }) => member.user_id !== user?.id
          ) || null
        : null)
    : null;
  const dmFriend = displayConversation?.type === 'dm'
    ? friends.find((friend) =>
        (dmPeerUserId ? friend.id === dmPeerUserId : false) ||
        (dmPeerUsername ? normalizeText(friend.username) === dmPeerUsername : false)
      ) || null
    : null;
  const resolvedDmDisplayName =
    dmPeer?.nickname ||
    displayConversation?.dm_display_name ||
    dmPeer?.display_name ||
    dmFriend?.display_name ||
    dmPeer?.username ||
    dmFriend?.username ||
    displayConversation?.dm_username ||
    null;
  const resolvedDmUsername = dmPeer?.username || dmFriend?.username || displayConversation?.dm_username || null;
  const resolvedDmAvatarUrl = dmPeer?.avatar_url || dmFriend?.avatar_url || displayConversation?.dm_avatar_url || null;
  const resolvedGroupName = displayConversation?.type === 'group'
    ? displayConversation.name || 'Unnamed'
    : '';
  const resolvedGroupIconUrl = displayConversation?.type === 'group'
    ? displayConversation.icon_url || null
    : null;

  const getHeaderIcon = () => {
    if (!displayConversation) return null;
    switch (displayConversation.type) {
      case 'dm':
        return (
          <UserAvatar
            src={resolvedDmAvatarUrl}
            displayName={resolvedDmDisplayName}
            username={resolvedDmUsername}
            className="w-8 h-8 rounded-full mr-3 shrink-0"
            fallbackClassName="text-sm"
          />
        );
      case 'group':
        return resolvedGroupIconUrl ? (
          <img
            src={resolvedGroupIconUrl}
            alt=""
            className="mr-3 h-8 w-8 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-void-accent/15 text-xs font-semibold text-void-accent">
            {resolvedGroupName.trim().charAt(0).toUpperCase() || '#'}
          </div>
        );
      default:
        return <Users className="w-5 h-5 text-void-text-muted mr-2 shrink-0" />;
    }
  };

  const getHeaderName = () => {
    if (!displayConversation) return '';
    if (displayConversation.type === 'dm') {
      const nameFromConv = resolvedDmDisplayName || resolvedDmUsername;
      if (nameFromConv) return nameFromConv;
      return 'Unknown';
    }
    return displayConversation.name || 'Unnamed';
  };

  const getHeaderSubtitle = () => {
    if (displayConversation?.type === 'dm') {
      return resolvedDmUsername ? `@${resolvedDmUsername}` : '';
    }
    return '';
  };

  const getEncryptionHint = (error: string) => {
    if (conversationSecurityState?.detail) {
      return conversationSecurityState.detail;
    }

    if (error.includes('no usable secure device keys')) {
      return 'The server does not currently have a published MLS key package for this person, so a new secure DM cannot start yet.';
    }

    if (error.includes('secure recipient details')) {
      return 'This DM is still loading the recipient identity needed for secure bootstrap. Open the conversation again once it finishes loading.';
    }

    if (
      error.includes('private keys') ||
      error.includes('not available')
    ) {
      return 'Your private keys are stored on the device where you first set up encryption. Use that browser to read messages.';
    }

    if (error.includes('distribution')) {
      return 'This account does not have a usable group key yet. Ask the group owner to resend key distribution for your account.';
    }

    if (error.includes('preparing secure chat')) {
      return 'Secure chat is still preparing for this conversation. Retry in a moment.';
    }

    return 'Secure chat is not ready for this conversation yet. Retry in a moment.';
  };

  const getSecurityBannerClasses = () => {
    if (conversationSecurityState?.status === 'recovering') {
      return {
        container: 'border-blue-400/25 bg-blue-500/10',
        icon: 'text-blue-300',
      };
    }

    if (
      conversationSecurityState?.reason === 'conversation_state_missing' ||
      conversationSecurityState?.reason === 'account_restore_required'
    ) {
      return {
        container: 'border-red-400/25 bg-red-500/10',
        icon: 'text-red-300',
      };
    }

    return {
      container: 'border-orange-400/25 bg-orange-500/10',
      icon: 'text-orange-300',
    };
  };

  const getMlsRecoveryGateCopy = () => {
    switch (mlsRecoveryGate.reason) {
      case 'recovery_key_required':
        return {
          title: 'Secure chat recovery needs your recovery key',
          body:
            'Your account has secure chat history to restore. Enter the recovery key you saved for this account to unlock encrypted chat in this browser.',
        };
      case 'password_required':
        return {
          title: 'Legacy secure chat recovery needs your password',
          body:
            'This account only has the older password-wrapped chat backup. Enter your current account password below, then set up a recovery key in Account settings after recovery finishes.',
        };
      case 'restore_failed':
        return {
          title: 'Secure chat recovery did not complete',
          body:
            'The previous MLS restore attempt did not unlock the secure backup cleanly. Try your current account password again below. If that still fails, use another signed-in browser session that can still read your chats before continuing here.',
        };
      case 'local_state_lost':
        return {
          title: 'Secure chat state was lost',
          body:
            'Re-signing in may recover your conversations. If you continue anyway, some conversations and message history may stay unreadable on this browser.',
        };
      default:
        return {
          title: 'Secure chat recovery is incomplete',
          body:
            'The server reported MLS recovery data for this account, but this browser still has no usable conversation state. Sign out and log in again with your password so account recovery can retry.',
        };
    }
  };

  if (loading || keyStatusLoading || isLoggingOut) {
    // If the gateway/API is unreachable during startup, surface the reconnect
    // UX instead of the indefinite "Preparing..." spinner.
    // showReconnectBanner covers: offline immediately, or gateway stalled 8s+.
    // bootstrapStalled covers: /api/me or key-fetch hung before gateway starts.
    if (!isLoggingOut && (showReconnectBanner || bootstrapStalled)) {
      return (
        <div className="min-h-screen bg-void-bg-main flex items-center justify-center px-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/8 bg-white/4 p-6 text-center">
            <div className="mx-auto mb-4 h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/55" />
            <p className="text-sm font-medium text-void-text">
              {isOnline ? 'Reconnecting to server\u2026' : 'You\u2019re offline'}
            </p>
            <p className="mt-1.5 text-xs text-void-text-muted">
              {isOnline
                ? 'The server is not responding yet. Retrying\u2026'
                : 'Check your connection. The app will resume automatically.'}
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-void-bg-main flex items-center justify-center">
        <div className="text-void-text text-lg font-medium">
          {isLoggingOut ? 'Signing you out...' : 'Preparing...'}
        </div>
      </div>
    );
  }

  if (mlsRecoveryGate.active) {
    const gateCopy = getMlsRecoveryGateCopy();
    const canRetryWithRecoveryKey = mlsRecoveryGate.reason === 'recovery_key_required';
    const canRetryWithPassword =
      mlsRecoveryGate.reason === 'password_required' || mlsRecoveryGate.reason === 'restore_failed';
    const shouldSignInAgain = mlsRecoveryGate.reason === 'local_state_lost';
    return (
      <div className="min-h-screen bg-void-bg-main text-void-text flex items-center justify-center p-6">
        <div className="w-full max-w-xl bg-void-bg-sec border border-void-border rounded-2xl shadow-2xl p-8 space-y-6">
          <div className="space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
              <ShieldAlert className="w-6 h-6 text-amber-400" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold">{gateCopy.title}</h1>
              <p className="text-sm text-void-text-muted mt-2">
                {gateCopy.body}
              </p>
            </div>
          </div>

          {(canRetryWithRecoveryKey || canRetryWithPassword) && (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-void-text">
                  {canRetryWithRecoveryKey ? 'Recovery Key' : 'Account Password'}
                </span>
                <input
                  type={canRetryWithRecoveryKey ? 'text' : 'password'}
                  value={mlsRecoveryKey}
                  onChange={(e) => {
                    setMlsRecoveryKey(e.target.value);
                    if (mlsRecoveryError) setMlsRecoveryError('');
                  }}
                  placeholder={canRetryWithRecoveryKey ? 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX' : 'Enter your password'}
                  autoComplete={canRetryWithRecoveryKey ? 'off' : 'current-password'}
                  className="w-full rounded-xl border border-void-border bg-gray-900 px-4 py-3 text-sm text-void-text placeholder-void-text-muted focus:outline-none focus:border-blue-500"
                  disabled={isSubmittingMlsRecoveryKey}
                />
              </label>

              {mlsRecoveryError && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3">
                  <p className="text-sm text-red-400">{mlsRecoveryError}</p>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            {canRetryWithRecoveryKey && (
              <button
                type="button"
                onClick={async () => {
                  if (!mlsRecoveryKey.trim()) {
                    setMlsRecoveryError('Enter your recovery key to continue secure chat recovery.');
                    return;
                  }

                  setIsSubmittingMlsRecoveryKey(true);
                  setMlsRecoveryError('');

                  try {
                    await retryMlsRecoveryWithRecoveryKey(mlsRecoveryKey);
                  } catch (err) {
                    if (
                      err instanceof Error &&
                      ['INVALID_RECOVERY_KEY', 'RECOVERY_NOT_CONFIGURED', 'RECOVERY_KEY_MISMATCH'].includes(err.message)
                    ) {
                      setMlsRecoveryError('That recovery key could not unlock this chat backup. Check the key and try again.');
                    } else {
                      setMlsRecoveryError('Secure chat recovery could not continue yet. Try again.');
                    }
                  } finally {
                    setIsSubmittingMlsRecoveryKey(false);
                  }
                }}
                disabled={isSubmittingMlsRecoveryKey}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 text-white px-4 py-3 font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <KeyRound className="w-4 h-4" />
                {isSubmittingMlsRecoveryKey ? 'Trying recovery key...' : 'Continue with Recovery Key'}
              </button>
            )}
            {canRetryWithPassword && (
              <button
                type="button"
                onClick={async () => {
                  if (!mlsRecoveryKey.trim()) {
                    setMlsRecoveryError('Enter your account password to continue secure chat recovery.');
                    return;
                  }

                  setIsSubmittingMlsRecoveryKey(true);
                  setMlsRecoveryError('');

                  try {
                    await retryMlsRecoveryWithPassword(mlsRecoveryKey);
                  } catch (err) {
                    if (err instanceof Error && err.message === 'INVALID_ACCOUNT_PASSWORD') {
                      setMlsRecoveryError('That password could not unlock your secure chat backup. Try your current password again.');
                    } else if (err instanceof Error && err.message === 'PASSWORD_REQUIRED') {
                      setMlsRecoveryError('Enter your account password to continue secure chat recovery.');
                    } else {
                      setMlsRecoveryError('Secure chat recovery could not continue yet. Try again.');
                    }
                  } finally {
                    setIsSubmittingMlsRecoveryKey(false);
                  }
                }}
                disabled={isSubmittingMlsRecoveryKey}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 text-white px-4 py-3 font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <KeyRound className="w-4 h-4" />
                {isSubmittingMlsRecoveryKey ? 'Trying password...' : 'Continue with Password'}
              </button>
            )}
            <button
              type="button"
              onClick={async () => {
                await logout();
                navigate('/auth', { replace: true });
              }}
              disabled={isSubmittingMlsRecoveryKey}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-void-border bg-gray-900 text-void-text px-4 py-3 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {shouldSignInAgain ? 'Sign In Again' : 'Sign Out'}
            </button>
            {shouldSignInAgain && (
              <button
                type="button"
                onClick={() => {
                  continueWithoutLocalSecureHistory();
                }}
                disabled={isSubmittingMlsRecoveryKey}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-400/25 bg-amber-500/10 text-amber-100 px-4 py-3 font-medium hover:bg-amber-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Continue Anyway
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const isFriendsPaneVisible = !displayConversation;
  const isFriendsMobileActive = mobileSidebarMode === 'friends';
  const securityBannerMessage = conversationSecurityState?.message || encryptionError;
  const securityBannerClasses = getSecurityBannerClasses();

  const openFriendsPane = () => {
    handleBackToMe();
    navigate('/chats');
    if (isMobile) {
      setMobileSidebarMode('friends');
      setIsMobileSidebarOpen(true);
    }
  };

  const openMobileMessageList = () => {
    handleBackToMe();
    navigate('/chats', { replace: true });
    setMobileSidebarMode('messages');
    setIsMobileSidebarOpen(true);
  };

  const handleForwardToConversation = async (targetConversation: Conversation) => {
    if (!forwardingMessage || !user?.id || !displayConversation) {
      throw new Error('The message could not be forwarded right now.');
    }

    const forwarded = {
      original_message_id: forwardingMessage.message_id,
      original_sender_id: forwardingMessage.sender_id,
      original_sender_name: getMessageSenderDisplayName(forwardingMessage),
      original_conversation_id: displayConversation.id,
      original_conversation_name:
        displayConversation.type === 'dm'
          ? getHeaderName()
          : displayConversation.name || 'Conversation',
    };

    const forwardedMessage = await forwardMessageToConversation(
      targetConversation,
      forwardingMessage,
      {
        currentUserId: user.id,
        forwarded,
      },
    );

    if (targetConversation.id === activeConversation?.id) {
      handleMessageSent(forwardedMessage);
      setLastSentConversationId(targetConversation.id);
    }

    setConvRefresh((count) => count + 1);
    setForwardingMessage(null);
  };

  return (
    <div
      className="flex flex-col overflow-hidden bg-void-bg-main font-sans text-void-text"
      style={{
        height: chatViewportHeight ? `${chatViewportHeight}px` : '100dvh',
        maxHeight: chatViewportHeight ? `${chatViewportHeight}px` : '100dvh',
      }}
    >
      {showReconnectBanner && (
        <div className="flex shrink-0 items-center gap-2 border-b border-white/8 bg-neutral-900/95 px-4 py-2 text-xs text-white/65">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/25 border-t-white/60" />
          {isOnline
            ? 'Reconnecting\u2026'
            : 'You\u2019re offline \u2014 reconnecting when network returns'}
        </div>
      )}
      {isOnline && serviceIssue && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-400/15 bg-amber-500/10 px-4 py-2 text-xs text-amber-100/85">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-200/90" />
          <span className="min-w-0 truncate">
            {serviceIssue.message}
            {serviceHealth.issues.length > 1 ? ` +${serviceHealth.issues.length - 1} more` : ''}
          </span>
        </div>
      )}
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
      {/* Modals */}
      {showProfile && user?.profile_id && (
        <UserProfileModal profileId={user.profile_id} onClose={() => setShowProfile(false)} />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      
      {showCreateGroup && user?.id && (
        <GroupCreateModal
          onClose={() => setShowCreateGroup(false)}
          onCreated={() => {
            setShowCreateGroup(false);
            setConvRefresh((n) => n + 1);
          }}
          currentUserId={user.id}
        />
      )}
      {showConvSettings && displayConversation && user?.id && (
        <ConversationSettings
          conversation={displayConversation}
          currentUserId={user.id}
          members={Object.values(members)}
          onMessageCreated={handleMessageSent}
          onConversationUpdated={async (nextConversation) => {
            patchConversationInState(nextConversation);
            setConvRefresh((n) => n + 1);
          }}
          onMembershipChanged={() => {
            setConvRefresh((n) => n + 1);
          }}
          onClose={() => setShowConvSettings(false)}
        />
      )}
      <ForwardMessageModal
        isOpen={Boolean(forwardingMessage)}
        message={forwardingMessage}
        currentConversationId={displayConversation?.id}
        onClose={() => setForwardingMessage(null)}
        onForward={handleForwardToConversation}
      />

      {/* Conversation Sidebar */}
      <div className={`bg-void-bg-main flex-col shrink-0 border-r border-void-bg-sec transition-all ${isMobileSidebarOpen ? 'flex' : 'hidden md:flex'} w-full md:w-72`}>
        <div className="h-16 flex items-center px-4 font-bold text-base border-b border-void-bg-sec shrink-0">
          <span>Messages</span>
        </div>

        {mobileSidebarMode === 'messages' && !isFriendsPaneVisible ? (
          <PushNotificationPrompt />
        ) : null}

        <div className="px-3 pt-3 pb-2 shrink-0 border-b border-void-bg-sec md:hidden">
          <div className="grid grid-cols-3 gap-1 rounded-2xl border border-void-bg-hover bg-void-bg-sec/80 p-1 shadow-[0_14px_32px_rgba(0,0,0,0.16)]">
            <button
              onClick={openFriendsPane}
              className={`flex items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-semibold transition-all ${
                isFriendsMobileActive
                  ? 'bg-void-accent/14 text-void-accent ring-1 ring-void-accent/30'
                  : 'text-void-text-muted hover:bg-void-bg-hover/80 hover:text-void-text'
              }`}
              aria-pressed={isFriendsMobileActive}
            >
              <Users className="h-3.5 w-3.5" />
              <span>Friends</span>
            </button>
            <button
              onClick={() => {
                setMobileSidebarMode('messages');
                setChatFilter('dm');
              }}
              className={`flex items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-semibold transition-all ${
                chatFilter === 'dm' && !isFriendsMobileActive
                  ? 'bg-void-bg-hover text-void-text ring-1 ring-white/5'
                  : 'text-void-text-muted hover:bg-void-bg-hover/80 hover:text-void-text'
              }`}
              aria-pressed={chatFilter === 'dm' && !isFriendsMobileActive}
            >
              <MessageCircle className="h-3.5 w-3.5" />
              <span>DMs</span>
            </button>
            <button
              onClick={() => {
                setMobileSidebarMode('messages');
                setChatFilter('group');
              }}
              className={`flex items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-semibold transition-all ${
                chatFilter === 'group' && !isFriendsMobileActive
                  ? 'bg-void-bg-hover text-void-text ring-1 ring-white/5'
                  : 'text-void-text-muted hover:bg-void-bg-hover/80 hover:text-void-text'
              }`}
              aria-pressed={chatFilter === 'group' && !isFriendsMobileActive}
            >
              <Users className="h-3.5 w-3.5" />
              <span>Groups</span>
            </button>
          </div>
        </div>

        <div className="hidden px-3 pt-3 pb-2 md:block shrink-0 border-b border-void-bg-sec">
          <button
            onClick={openFriendsPane}
            className={`w-full flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold transition-all ${
              isFriendsPaneVisible
                ? 'bg-void-accent/12 border-void-accent/45 text-void-accent ring-1 ring-void-accent/20'
                : 'border-void-bg-hover bg-void-bg-sec/70 text-void-text-muted hover:bg-void-bg-hover/80 hover:text-void-text'
            }`}
            aria-pressed={isFriendsPaneVisible}
          >
            <Users className="h-4 w-4" />
            <span>Friends</span>
          </button>
        </div>

        <div className="hidden px-3 pt-3 pb-1 md:flex gap-1 shrink-0">
          <button
            onClick={() => setChatFilter('dm')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded-md transition-all ${
              chatFilter === 'dm'
                ? 'bg-void-bg-hover text-void-text'
                : 'text-void-text-muted hover:bg-void-bg-hover'
            }`}
            aria-pressed={chatFilter === 'dm'}
          >
            <MessageCircle className="w-3.5 h-3.5" /> DMs
          </button>
          <button
            onClick={() => setChatFilter('group')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded-md transition-all ${
              chatFilter === 'group'
                ? 'bg-void-bg-hover text-void-text'
                : 'text-void-text-muted hover:bg-void-bg-hover'
            }`}
            aria-pressed={chatFilter === 'group'}
          >
            <Users className="w-3.5 h-3.5" /> Groups
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          {isMobile && mobileSidebarMode === 'friends' ? (
            <FriendsView
              friends={friends}
              onStartDM={(...args) => {
                void handleStartDM(...args).then((routeId) => {
                  if (routeId) navigate(`/chats/@me/${routeId}`);
                  setConvRefresh((n) => n + 1);
                  setMobileSidebarMode('messages');
                  setIsMobileSidebarOpen(false);
                });
              }}
            />
          ) : (
            <ConversationList
              activeId={activeGroup?.id || activeConversation?.id || null}
              onSelect={(conv) => {
                if (conv.type === 'dm') {
                  navigate(getDmRoute(conv));
                } else {
                  navigate(getGroupRoute(conv));
                }
                setMobileSidebarMode('messages');
                setIsMobileSidebarOpen(false);
              }}
              onCreateGroup={() => setShowCreateGroup(true)}
              filter={chatFilter}
              friends={friends}
              refreshTrigger={convRefresh}
              bumpConversationId={lastSentConversationId}
              currentUserId={user?.id || null}
            />
          )}
        </div>

        {/* User Mini Profile */}
        <div className="h-[52px] bg-void-bg-main/90 flex items-center px-2 border-t border-void-bg-sec shrink-0">
          <div className="flex items-center hover:bg-void-bg-hover p-1 rounded-md cursor-pointer flex-1 min-w-0" onClick={() => setShowProfile(true)}>
            <div className="w-8 h-8 rounded-full mr-2 relative shrink-0">
              <UserAvatar
                src={myProfile?.avatar_url || null}
                displayName={myProfile?.display_name}
                username={user?.username}
                alt="Avatar"
                className="w-full h-full rounded-full"
                fallbackClassName="text-xs"
              />
            </div>
            <div className="text-sm font-semibold truncate flex-1">{myProfile?.display_name || user?.username || 'User'}</div>
          </div>
          <button onClick={() => setShowSettings(true)} className="p-1.5 text-void-text-muted hover:text-void-text hover:bg-void-bg-hover rounded-md shrink-0 ml-1">
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main Area */}
      <div className={`flex-1 flex flex-col bg-void-bg-sec min-w-0 ${!isMobileSidebarOpen ? 'flex' : 'hidden md:flex'}`}>
        {showConversationRoutePendingSkeleton ? (
          <ConversationPaneSkeleton showMobileBack density="compact" />
        ) : activeConversation ? (
          <div className="relative flex flex-1 min-h-0">
            {showConversationRoutePendingOverlay ? (
              <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center">
                <div className="inline-flex items-center gap-2 rounded-full border border-void-bg-hover bg-void-bg-sec/92 px-3 py-1.5 text-xs font-medium text-void-text shadow-sm backdrop-blur-sm">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-void-text-muted/30 border-t-void-text-muted" />
                  Syncing conversation...
                </div>
              </div>
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col">
              <nav
                data-chat-conversation-header="true"
                className="sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between border-b border-void-bg-hover bg-void-bg-sec/95 px-4 shadow-sm supports-[backdrop-filter]:backdrop-blur md:relative md:top-auto md:bg-void-bg-sec"
              >
                <div className="flex items-center min-w-0 flex-1">
                  <button
                    onClick={openMobileMessageList}
                    className="mr-3 p-1 text-void-text-muted hover:text-void-text hover:bg-void-bg-hover rounded-md md:hidden shrink-0 transition-colors"
                  >
                    <ArrowLeft className="w-5 h-5" />
                  </button>
                  {getHeaderIcon()}
                  <div className="min-w-0">
                    <h1 className="text-lg font-bold truncate">{getHeaderName()}</h1>
                    {getHeaderSubtitle() && (
                      <p className="truncate text-xs font-medium text-void-text-muted">
                        {getHeaderSubtitle()}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setShowConvSettings(true)}
                  className="p-2 rounded-lg text-void-text-muted hover:text-void-text hover:bg-void-bg-hover transition-colors shrink-0 ml-2"
                  title="Conversation settings"
                >
                  <SlidersHorizontal className="w-4 h-4" />
                </button>
              </nav>

              <>
                {securityBannerMessage && (
                  <div className={`mx-4 mt-4 rounded-2xl border px-4 py-3 ${securityBannerClasses.container}`}>
                    <div className="flex items-start gap-3">
                      <ShieldAlert className={`mt-0.5 h-5 w-5 shrink-0 ${securityBannerClasses.icon}`} />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-void-text">{securityBannerMessage}</p>
                        <p className="mt-1 text-xs text-void-text-muted">
                          {getEncryptionHint(securityBannerMessage)}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                <MessageView
                  key={activeConversation.id}
                  conversation={activeConversation}
                  encryptionKey={encryptionKey}
                  keyVersion={keyVersion}
                  encryptionError={encryptionError}
                  conversationSecurityState={conversationSecurityState}
                  sendNotice={sendNotice}
                  onSendNotice={showSendNotice}
                  members={messageDisplayMembers}
                  typingParticipants={typingParticipants}
                  onReply={handleReply}
                  onForward={handleForward}
                  onEdit={handleEdit}
                  messageEvents={messageEvents}
                  userAvatar={myProfile?.avatar_url || undefined}
                  gateway={gateway}
                  messageUpdate={messageUpdate}
                  messageDelete={messageDelete}
                />
                <MessageInput
                  currentUserId={user?.id}
                  conversation={activeConversation}
                  encryptionKey={encryptionKey}
                  keyVersion={keyVersion}
                  conversationSecurityState={conversationSecurityState}
                  onEncryptionKeyResolved={handleEncryptionKeyResolved}
                  onMessageSent={(msg) => {
                    handleMessageSent(msg);
                    if (activeConversation?.id) setLastSentConversationId(activeConversation.id);
                  }}
                  onSendError={showSendNotice}
                  editingMessage={editingMessage}
                  onCancelEdit={() => setEditingMessage(null)}
                  replyTo={replyTo}
                  onCancelReply={() => setReplyTo(null)}
                  onEditComplete={handleEditComplete}
                  members={Object.values(messageDisplayMembers)}
                />
              </>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 bg-void-bg-sec">
            <div className="sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between border-b border-void-bg-hover bg-void-bg-sec/95 px-4 shadow-sm supports-[backdrop-filter]:backdrop-blur md:hidden">
              <div className="flex items-center">
                <button
                  onClick={() => {
                    setMobileSidebarMode('messages');
                    setIsMobileSidebarOpen(true);
                  }}
                  className="mr-3 p-1 text-void-text-muted hover:text-void-text hover:bg-void-bg-hover rounded-md shrink-0 transition-colors"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h1 className="text-lg font-bold">Friends</h1>
              </div>
            </div>
            
            <FriendsView
              friends={friends}
              onStartDM={(...args) => {
                void handleStartDM(...args).then((routeId) => {
                  if (routeId) navigate(`/chats/@me/${routeId}`);
                  setConvRefresh((n) => n + 1);
                });
              }}
            />

          </div>
        )}
      </div>
      </div>
    </div>
  );
};

export default ChatDashboard;
