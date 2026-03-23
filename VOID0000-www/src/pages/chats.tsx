// src/pages/Chats.tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { Settings, Users, Hash, MessageCircle, ArrowLeft, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import ConversationSettings from '../components/Chat/ConversationSettings';
import { useAuth } from '../Services/hooks/Auth/useAuth';
import { useUserProfile } from '../Services/hooks/editProfile/userProfile';
import { useChatManager } from '../Services/hooks/Chats/useChatManager';
import { useFriends } from '../Services/hooks/Friends/useFriends';
import UserProfile from '../components/common/Profile/userProfile';
import UseSetting from '../components/common/Setting/Setting';
import RecoveryPhraseModal from '../components/common/Setting/RecoveryPhraseModal';
import ConversationList from '../components/Chat/ConversationList';
import MessageView from '../components/Chat/MessageView';
import MessageInput from '../components/Chat/MessageInput';
import CreateChannelModal from '../components/Chat/groups/CreateChannelModal';
import ChannelSettingsModal from '../components/Chat/groups/ChannelSettingsModal';
import GroupChannelsSidebar from '../components/Chat/groups/GroupChannelsSidebar';
import GroupCreateModal from '../components/Chat/groups/GroupCreateModal';
import FriendsView from '../components/common/Friends/FriendsView';
import AddFriend from '../components/common/Friends/AddFriend';
import { gateway } from '../Services/Gateway/gateway';
import { Conversation } from '../Services/Chat/chatService';
import { matchesConversationIdentifier } from '../Services/Chat/utils/conversationUtils';
import { useUser } from '../Services/Auth/UserContext';
import RecoveryLockScreen from '../components/Chat/RecoveryLockScreen';
import UserAvatar from '../components/common/UserAvatar';

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
    channelConversationId,
  } = useParams<{
    dmConversationId?: string;
    groupConversationId?: string;
    channelConversationId?: string;
  }>();
  const { loading, user } = useAuth();
  const {
    keyStatus,
    keyStatusLoading,
    mlsRecoveryGate,
    isLoggingOut,
    unlockWithRecoveryPhrase,
    logout,
  } = useUser();

  const { profile: myProfile } = useUserProfile(user?.profile_id || '');

  // Friends from the shared FriendsProvider — single source of truth
  const { friends } = useFriends();

  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showAddFriendView, setShowAddFriendView] = useState(false); // <-- New state to handle the view swap
  const [chatFilter, setChatFilter] = useState<'dm' | 'group'>('dm');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(true);
  const [convRefresh, setConvRefresh] = useState(0);
  const [lastSentConversationId, setLastSentConversationId] = useState<string | null>(null);
  const [showConvSettings, setShowConvSettings] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [createChannelInitialCategoryId, setCreateChannelInitialCategoryId] = useState<string | null>(null);
  const [channelSettingsTarget, setChannelSettingsTarget] = useState<Conversation | null>(null);
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
    newMessage,
    editingMessage,
    replyTo,
    messageUpdate,
    messageDelete,
    setEditingMessage,
    setReplyTo,
    setMessageUpdate,
    handleSelectConversation,
    handleSelectChannel,
    refreshActiveGroup,
    patchConversationInState,
    handleMessageSent,
    handleStartDM,
    handleBackToMe,
    handleEncryptionKeyResolved,
    openConversationByIdentifier,
    openGroupByIdentifier,
  } = useChatManager(user);

  const getRouteId = (conversation?: { public_id?: string | null }) => conversation?.public_id || null;

  const getDmRoute = (conversation?: { public_id?: string | null }) => {
    const routeId = getRouteId(conversation);
    return routeId ? `/chats/@me/${routeId}` : '/chats';
  };

  const getGroupRoute = (
    group?: { public_id?: string | null },
    channel?: { public_id?: string | null } | null
  ) => {
    const groupRouteId = getRouteId(group);
    if (!groupRouteId) return '/chats';

    const channelRouteId = getRouteId(channel || undefined);
    return channelRouteId
      ? `/chats/${groupRouteId}/${channelRouteId}`
      : `/chats/${groupRouteId}`;
  };

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
          const channelMatchesRoute = !channelConversationId || matchesConversationIdentifier(activeConversation, channelConversationId);
          if (groupMatchesRoute && channelMatchesRoute) {
            return;
          }

          const result = await openGroupByIdentifier(groupConversationId, channelConversationId || null);
          if (cancelled) return;

          const normalizedRoute = getGroupRoute(result.group, result.conversation.type === 'channel' ? result.conversation : null);
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
    channelConversationId,
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

  const messageDisplayMembers = useMemo(
    () => ({
      ...memberDisplayCacheRef.current,
      ...members,
    }),
    [members, activeConversation?.id]
  );

  const handleEditComplete = (messageId: string, newContent: string) => {
    setMessageUpdate({
      message_id: messageId,
      content: newContent,
      is_edited: true,
      edited_at: new Date().toISOString(),
    });
  };

  const displayConversation = activeGroup || activeConversation;
  const activeChannels = activeGroup?.channels || [];
  const typingParticipants = useMemo(() => {
    if (!activeConversation) return [];

    return Object.entries(typingUsers)
      .filter(([typingUserId]) => typingUserId !== user?.id)
      .sort(([, a], [, b]) => b - a)
      .map(([typingUserId]) => {
        const member = messageDisplayMembers[typingUserId] || members[typingUserId];
        return {
          userId: typingUserId,
          displayName: member?.display_name || member?.username || 'Someone',
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
    dmPeer?.display_name ||
    dmFriend?.display_name ||
    displayConversation?.dm_display_name ||
    dmPeer?.username ||
    dmFriend?.username ||
    displayConversation?.dm_username ||
    null;
  const resolvedDmUsername = dmPeer?.username || dmFriend?.username || displayConversation?.dm_username || null;
  const resolvedDmAvatarUrl = dmPeer?.avatar_url || dmFriend?.avatar_url || displayConversation?.dm_avatar_url || null;

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
      case 'group': return <Users className="w-5 h-5 text-void-text-muted mr-2 shrink-0" />;
      default: return <Hash className="w-5 h-5 text-void-text-muted mr-2 shrink-0" />;
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

    if (activeGroup && activeConversation?.type === 'channel') {
      return `# ${activeConversation.name || 'channel'}`;
    }
    return '';
  };

  const getEncryptionHint = (error: string) => {
    if (conversationSecurityState?.detail) {
      return conversationSecurityState.detail;
    }

    if (mlsRecoveryGate.pending) {
      return 'This device is still preparing secure chat. Messages will appear once recovery finishes.';
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
    if (mlsRecoveryGate.pending) {
      return {
        title: 'Preparing secure chat',
        body:
          'This device is still restoring MLS conversation state in the background. Chats will open automatically once secure recovery becomes usable.',
      };
    }

    switch (mlsRecoveryGate.reason) {
      case 'password_required':
        return {
          title: 'Secure chat recovery needs your password',
          body:
            'This device restored your sign-in state, but it still does not have the MLS conversation state needed to decrypt existing chats. Sign out and log in again with your account password on this device so secure chat recovery can complete. Recovery-key unlock currently restores identity only.',
        };
      case 'restore_failed':
        return {
          title: 'Secure chat recovery did not complete',
          body:
            'The server has MLS recovery data for this account, but this device could not restore it cleanly. Sign out and log in again with your latest password. If that still fails, use a device that can still read your chats before continuing here.',
        };
      default:
        return {
          title: 'Secure chat recovery is incomplete',
          body:
            'The server reported MLS recovery data for this account, but this device still has no usable conversation state. Do not continue in chat on this device yet. Sign out and log in again with your password so secure chat recovery can retry.',
        };
    }
  };

  if (loading || keyStatusLoading || isLoggingOut) {
    return (
      <div className="min-h-screen bg-void-bg-main flex items-center justify-center">
        <div className="text-void-text text-lg font-medium">
          {isLoggingOut ? 'Signing you out...' : 'Preparing your secure chat session...'}
        </div>
      </div>
    );
  }

  if (mlsRecoveryGate.pending) {
    const gateCopy = getMlsRecoveryGateCopy();
    return (
      <div className="min-h-screen bg-void-bg-main text-void-text flex items-center justify-center p-6">
        <div className="w-full max-w-xl bg-void-bg-sec border border-void-border rounded-2xl shadow-2xl p-8 space-y-6">
          <div className="space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
              <ShieldAlert className="w-6 h-6 text-blue-400" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold">{gateCopy.title}</h1>
              <p className="text-sm text-void-text-muted mt-2">
                {gateCopy.body}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 text-sm text-void-text-muted">
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <span>Continuing MLS recovery checks in the background...</span>
          </div>
        </div>
      </div>
    );
  }

  if (mlsRecoveryGate.active) {
    const gateCopy = getMlsRecoveryGateCopy();
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

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              onClick={async () => {
                await logout();
                navigate('/auth', { replace: true });
              }}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-void-border bg-gray-900 text-void-text px-4 py-3 font-medium"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (keyStatus === 'LOCKED') {
    return (
      <RecoveryLockScreen
        onRecover={unlockWithRecoveryPhrase}
        onLogout={async () => {
          await logout();
          navigate('/auth', { replace: true });
        }}
        loading={keyStatusLoading}
      />
    );
  }

  const isFriendsActive = !displayConversation;
  const securityBannerMessage = conversationSecurityState?.message || encryptionError;
  const securityBannerClasses = getSecurityBannerClasses();

  return (
    <div className="relative flex h-screen bg-void-bg-main text-void-text overflow-hidden font-sans">
      {/* Modals */}
      {showProfile && user?.profile_id && (
        <UserProfile profileId={user.profile_id} onClose={() => setShowProfile(false)} />
      )}
      {showSettings && <UseSetting onClose={() => setShowSettings(false)} />}
      {user?.id && keyStatus === 'UNINITIALIZED' && !isLoggingOut && (
        <RecoveryPhraseModal onClose={() => {}} required />
      )}
      
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
      {showCreateChannel && activeGroup && (
        <CreateChannelModal
          group={activeGroup}
          initialCategoryId={createChannelInitialCategoryId}
          onClose={() => {
            setShowCreateChannel(false);
            setCreateChannelInitialCategoryId(null);
          }}
          onCreated={async (channel) => {
            setConvRefresh((n) => n + 1);
            await refreshActiveGroup(channel.public_id || channel.id);
            const nextRoute = getGroupRoute(activeGroup, channel);
            if (nextRoute !== '/chats') {
              navigate(nextRoute);
              return;
            }
          }}
        />
      )}
      {channelSettingsTarget && activeGroup && (
        <ChannelSettingsModal
          channel={channelSettingsTarget}
          onClose={() => setChannelSettingsTarget(null)}
          onSaved={async (channel) => {
            patchConversationInState(channel);
            setChannelSettingsTarget(null);
          }}
          onDeleted={async () => {
            setConvRefresh((n) => n + 1);
            setChannelSettingsTarget(null);
            await refreshActiveGroup(null);
            const nextRoute = getGroupRoute(activeGroup);
            navigate(nextRoute === '/chats' ? '/chats' : nextRoute);
          }}
        />
      )}
      {showConvSettings && displayConversation && user?.id && (
        <ConversationSettings
          conversation={displayConversation}
          activeChannel={activeConversation?.type === 'channel' ? activeConversation : null}
          currentUserId={user.id}
          members={Object.values(members)}
          onMessageCreated={handleMessageSent}
          onConversationUpdated={async (nextConversation) => {
            patchConversationInState(nextConversation);
            setConvRefresh((n) => n + 1);
          }}
          onMembershipChanged={async () => {
            setConvRefresh((n) => n + 1);

            if (activeGroup) {
              await refreshActiveGroup(
                channelConversationId || activeConversation?.public_id || activeConversation?.id
              );
            }
          }}
          onClose={() => setShowConvSettings(false)}
        />
      )}

      {/* Conversation Sidebar */}
      <div className={`bg-void-bg-main flex-col shrink-0 border-r border-void-bg-sec transition-all ${isMobileSidebarOpen ? 'flex' : 'hidden md:flex'} w-full md:w-72`}>
        <div className="h-16 flex items-center px-4 font-bold text-base border-b border-void-bg-sec shrink-0">
          <span>Messages</span>
        </div>

        <div className="px-3 pt-3 pb-2 shrink-0 border-b border-void-bg-sec">
          <button
            onClick={() => {
              handleBackToMe();
              navigate('/chats');
              setShowAddFriendView(false); // <-- Resets to the friends list view
              setIsMobileSidebarOpen(false);
            }}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border font-medium text-sm transition-all shadow-sm ${
              isFriendsActive
                ? 'bg-void-accent/20 border-void-accent/50 text-void-accent'
                : 'bg-transparent border-transparent text-void-text-muted hover:bg-void-bg-hover hover:text-void-text'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>Friends</span>
          </button>
        </div>

        <div className="px-3 pt-3 pb-1 flex gap-1 shrink-0">
          <button 
            onClick={() => setChatFilter('dm')} 
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded-md transition-all ${
              chatFilter === 'dm' 
                ? 'bg-void-bg-hover text-void-text' 
                : 'text-void-text-muted hover:bg-void-bg-hover'
            }`}
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
          >
            <Hash className="w-3.5 h-3.5" /> Groups
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          <ConversationList
            activeId={activeGroup?.id || activeConversation?.id || null}
            onSelect={(conv) => {
              if (conv.type === 'dm') {
                navigate(getDmRoute(conv));
              } else if (conv.type === 'group') {
                navigate(getGroupRoute(conv));
              } else {
                handleSelectConversation(conv);
              }
              setIsMobileSidebarOpen(false);
            }}
            onCreateGroup={() => setShowCreateGroup(true)}
            filter={chatFilter}
            friends={friends}
            refreshTrigger={convRefresh}
            bumpConversationId={lastSentConversationId}
          />
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
        {activeConversation ? (
          <div className="flex flex-1 min-h-0">
            <div className="flex min-w-0 flex-1 flex-col">
              <nav className="h-16 border-b border-void-bg-hover flex items-center justify-between px-4 shrink-0 shadow-sm">
                <div className="flex items-center min-w-0 flex-1">
                  <button onClick={() => setIsMobileSidebarOpen(true)} className="mr-3 p-1 text-void-text-muted hover:text-void-text hover:bg-void-bg-hover rounded-md md:hidden shrink-0 transition-colors">
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
                  members={messageDisplayMembers}
                  typingParticipants={typingParticipants}
                  onReply={(msg) => setReplyTo(msg)}
                  onEdit={(msg) => setEditingMessage(msg)}
                  newMessage={newMessage}
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
                  editingMessage={editingMessage}
                  onCancelEdit={() => setEditingMessage(null)}
                  replyTo={replyTo}
                  onCancelReply={() => setReplyTo(null)}
                  onEditComplete={handleEditComplete}
                />
              </>
            </div>

            {activeGroup && (
              <GroupChannelsSidebar
                conversation={activeGroup}
                channels={activeChannels}
                activeChannelId={activeConversation.id}
                currentUserId={user?.id || ''}
                onSelectChannel={(channel) => {
                  const nextRoute = getGroupRoute(activeGroup, channel);
                  if (nextRoute !== '/chats') {
                    navigate(nextRoute);
                    return;
                  }
                  handleSelectChannel(channel);
                }}
                onOpenChannelSettings={(channel) => setChannelSettingsTarget(channel)}
                onCreateChannel={(categoryId) => {
                  setCreateChannelInitialCategoryId(categoryId || null);
                  setShowCreateChannel(true);
                }}
              />
            )}
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 bg-void-bg-sec">
            <div className="md:hidden h-16 border-b border-void-bg-hover flex items-center justify-between px-4 shrink-0 shadow-sm bg-void-bg-sec">
              <div className="flex items-center">
                <button onClick={() => setIsMobileSidebarOpen(true)} className="mr-3 p-1 text-void-text-muted hover:text-void-text hover:bg-void-bg-hover rounded-md shrink-0 transition-colors">
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h1 className="text-lg font-bold">Friends</h1>
              </div>
            </div>
            
            {/* ✨ The View Swap happens here! ✨ */}
            {showAddFriendView ? (
              <AddFriend />
            ) : (
              <FriendsView
                friends={friends}
                onStartDM={(...args) => {
                  void handleStartDM(...args).then((routeId) => {
                    if (routeId) navigate(`/chats/@me/${routeId}`);
                    setConvRefresh((n) => n + 1);
                  });
                }}
              />
            )}

          </div>
        )}
      </div>
    </div>
  );
};

export default ChatDashboard;
