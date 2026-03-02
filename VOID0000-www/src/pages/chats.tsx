import { useState } from 'react';
import { Settings, Users, Hash, MessageCircle, ArrowLeft, ShieldAlert } from 'lucide-react';
import { useAuth } from '../Services/hooks/Auth/useAuth';
import { useUserProfile } from '../Services/hooks/editProfile/userProfile';
import { useChatManager } from '../Services/hooks/Chats/useChatManager';
import UserProfile from '../components/common/Profile/userProfile';
import UseSetting from '../components/common/Setting/Setting';
import FriendsModal from '../components/common/Friends/FriendsModal';
import ConversationList from '../components/Chat/ConversationList';
import MessageView from '../components/Chat/MessageView';
import MessageInput from '../components/Chat/MessageInput';
import GroupCreateModal from '../components/Chat/GroupCreateModal';
import FriendsView from '../components/Chat/FriendsView';
import { gateway } from '../Services/Gateway/gateway';

const ChatDashboard = () => {
  const { loading, user } = useAuth();

  const { profile: myProfile } = useUserProfile(user?.profile_id || '');
  const myAvatarUrl = myProfile?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.username}`;

  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showFriends, setShowFriends] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [chatFilter, setChatFilter] = useState<'dm' | 'group'>('dm');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(true);
  
  // NEW: State for refreshing the conversation list
  const [convRefresh, setConvRefresh] = useState(0);

  const {
    members,
    activeConversation,
    encryptionKey,
    keyVersion,
    encryptionError,
    newMessage,
    editingMessage,
    replyTo,
    friends,
    setEditingMessage,
    setReplyTo,
    handleSelectConversation,
    handleMessageSent,
    handleStartDM,
    handleBackToMe,
  } = useChatManager(user);

  const getHeaderIcon = () => {
    if (!activeConversation) return null;
    switch (activeConversation.type) {
      case 'dm': return <MessageCircle className="w-5 h-5 text-gray-400 mr-2 shrink-0" />;
      case 'group': return <Users className="w-5 h-5 text-gray-400 mr-2 shrink-0" />;
      default: return <Hash className="w-5 h-5 text-gray-400 mr-2 shrink-0" />;
    }
  };

  const getHeaderName = () => {
    if (!activeConversation) return '';
    if (activeConversation.type === 'dm') {
      const nameFromConv = activeConversation.dm_display_name || activeConversation.dm_username;
      if (nameFromConv) return nameFromConv;
      const peer = Object.values(members).find((m: any) => m.user_id !== user?.id);
      if (peer) return peer.display_name || peer.username;
      return 'Unknown';
    }
    return activeConversation.name || 'Unnamed';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white text-lg font-medium">Verifying your session...</div>
      </div>
    );
  }

  const isFriendsActive = !activeConversation;

  return (
    <div className="flex h-screen bg-gray-900 text-gray-100 overflow-hidden font-sans">
      {/* Modals */}
      {showProfile && user?.profile_id && (
        <UserProfile profileId={user.profile_id} onClose={() => setShowProfile(false)} />
      )}
      {showSettings && <UseSetting onClose={() => setShowSettings(false)} />}
      {showFriends && <FriendsModal onClose={() => setShowFriends(false)} />}
      {showCreateGroup && (
        <GroupCreateModal
          onClose={() => setShowCreateGroup(false)}
          onCreated={() => setShowCreateGroup(false)}
        />
      )}

      {/* Conversation Sidebar */}
      <div className={`bg-gray-900 flex-col shrink-0 border-r border-gray-800 transition-all ${isMobileSidebarOpen ? 'flex' : 'hidden md:flex'} w-full md:w-72`}>
        <div className="h-16 flex items-center px-4 font-bold text-base border-b border-gray-800 shrink-0">
          <span className="bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">Messages</span>
        </div>

        <div className="px-3 pt-3 pb-2 shrink-0 border-b border-gray-800">
          <button
            onClick={() => {
              handleBackToMe();
              setIsMobileSidebarOpen(false);
            }}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border font-medium text-sm transition-all shadow-sm ${
              isFriendsActive
                ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-400'
                : 'bg-transparent border-transparent text-gray-400 hover:bg-gray-800/60 hover:text-gray-200'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>Friends</span>
          </button>
        </div>

        <div className="px-3 pt-3 pb-1 flex gap-1 shrink-0">
          <button onClick={() => setChatFilter('dm')} className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded-md transition-all ${chatFilter === 'dm' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-800'}`}>
            <MessageCircle className="w-3.5 h-3.5" /> DMs
          </button>
          <button onClick={() => setChatFilter('group')} className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded-md transition-all ${chatFilter === 'group' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-800'}`}>
            <Hash className="w-3.5 h-3.5" /> Groups
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          <ConversationList
            activeId={activeConversation?.id || null}
            onSelect={(conv) => {
              handleSelectConversation(conv);
              setIsMobileSidebarOpen(false);
            }}
            onCreateGroup={() => setShowCreateGroup(true)}
            filter={chatFilter}
            friends={friends}
            refreshTrigger={convRefresh} // <-- NEW: Passed state down
          />
        </div>

        {/* User Mini Profile */}
        <div className="h-[52px] bg-gray-900/90 flex items-center px-2 border-t border-gray-800 shrink-0">
          <div 
            className="flex items-center hover:bg-gray-800 p-1 rounded-md cursor-pointer flex-1 min-w-0" 
            onClick={() => setShowProfile(true)}
          >
            <div className="w-8 h-8 rounded-full mr-2 relative shrink-0">
              <img 
                src={myAvatarUrl} 
                alt="Avatar" 
                className="w-full h-full object-cover rounded-full" 
              />
            </div>
            
            <div className="text-sm font-semibold truncate flex-1">
              {user?.username || 'User'}
            </div>
          </div>
          
          <button 
            onClick={() => setShowSettings(true)} 
            className="p-1.5 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-md shrink-0 ml-1"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main Area */}
      <div className={`flex-1 flex flex-col bg-gray-800 min-w-0 ${!isMobileSidebarOpen ? 'flex' : 'hidden md:flex'}`}>
        {activeConversation ? (
          <>
            <nav className="h-16 border-b border-gray-700 flex items-center justify-between px-4 shrink-0 shadow-sm">
              <div className="flex items-center min-w-0 flex-1">
                <button onClick={() => setIsMobileSidebarOpen(true)} className="mr-3 p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded-md md:hidden shrink-0 transition-colors">
                  <ArrowLeft className="w-5 h-5" />
                </button>
                {getHeaderIcon()}
                <h1 className="text-lg font-bold truncate">{getHeaderName()}</h1>
              </div>
            </nav>

            {encryptionError ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-6 bg-gray-800/50">
                <ShieldAlert className="w-12 h-12 text-orange-400 mb-4 opacity-80" />
                <p className="text-sm font-semibold text-gray-300 mb-2">{encryptionError}</p>
                <p className="text-xs text-gray-500 mb-6 max-w-xs">
                  {encryptionError.includes('not available')
                    ? 'Your private keys are stored on the device where you first set up encryption. Use that browser to read messages.'
                    : 'The other user needs to initialize their encryption keys. Ask them to log in to secure this conversation.'}
                </p>
                <button
                  onClick={() => {
                    const current = activeConversation;
                    handleBackToMe();
                    setTimeout(() => handleSelectConversation(current), 50);
                  }}
                  className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg transition-all shadow-lg"
                >
                  Retry Connection
                </button>
              </div>
            ) : (
              <>
                <MessageView
                  conversation={activeConversation}
                  encryptionKey={encryptionKey}
                  members={members}
                  onReply={(id) => setReplyTo(id)}
                  onEdit={(msg) => setEditingMessage(msg)}
                  newMessage={newMessage}
                  userAvatar={myAvatarUrl}
                  gateway={gateway}
                />
                <MessageInput
                  conversation={activeConversation}
                  encryptionKey={encryptionKey}
                  keyVersion={keyVersion}
                  // NEW: Wrap handleMessageSent to trigger refresh
                  onMessageSent={(...args) => {
                    // @ts-ignore
                    handleMessageSent(...args);
                    setConvRefresh((n) => n + 1);
                  }}
                  editingMessage={editingMessage}
                  onCancelEdit={() => setEditingMessage(null)}
                  replyTo={replyTo}
                  onCancelReply={() => setReplyTo(null)}
                />
              </>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 bg-gray-800">
            <div className="md:hidden h-16 border-b border-gray-700 flex items-center justify-between px-4 shrink-0 shadow-sm bg-gray-800">
              <div className="flex items-center">
                <button onClick={() => setIsMobileSidebarOpen(true)} className="mr-3 p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded-md shrink-0 transition-colors">
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h1 className="text-lg font-bold">Friends</h1>
              </div>
            </div>
            <FriendsView 
              friends={friends} 
              // NEW: Wrap handleStartDM to trigger refresh
              onStartDM={(...args) => {
                // @ts-ignore
                handleStartDM(...args);
                setConvRefresh((n) => n + 1);
              }} 
              onShowFriendsModal={() => setShowFriends(true)} 
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatDashboard;