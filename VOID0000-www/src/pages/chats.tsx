import { useState } from 'react'; 
import { User, Settings, Users, Hash, Bell, Pin, Search, Send, Plus } from 'lucide-react';
import { useAuth } from '../Services/hooks/Auth/useAuth';
import { useFriendRequests } from '../Services/hooks/Friends/useFriendRequests';
import MenuComponent from '../components/common/Menu';
import UserProfile from '../components/common/Profile/userProfile';
import UseSetting from '../components/common/Setting/Setting';
import FriendsModal from '../components/common/Friends/FriendsModal';

const ChatDashboard = () => {
  const { loading, user } = useAuth();
  // Get unreadCount to control the badge
  const { incoming, unreadCount } = useFriendRequests(); 
  
  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showFriends, setShowFriends] = useState(false);

  // Mock data for the chat interface
  const channels = ['general', 'kasane-teto-fanclub', 'memes', 'development'];
  const [activeChannel, setActiveChannel] = useState('general');

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white text-lg">Verifying your session...</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-900 text-gray-100 overflow-hidden font-sans">
      {/* Modals */}
      {showProfile && user?.profile_id && (
        <UserProfile profileId={user.profile_id} onClose={() => setShowProfile(false)} />
      )}
      {showSettings && <UseSetting onClose={() => setShowSettings(false)} />}
      {showFriends && <FriendsModal onClose={() => setShowFriends(false)} />}

      {/* 1. Far Left: Server / App Icon Sidebar */}
      <div className="w-[72px] bg-gray-950 flex flex-col items-center py-3 space-y-4 shrink-0 overflow-y-auto">
        <div className="w-12 h-12 bg-blue-500 rounded-2xl flex items-center justify-center cursor-pointer hover:rounded-xl transition-all duration-200">
          <span className="text-white font-bold text-xl">D</span>
        </div>
        <div className="w-8 h-1 bg-gray-800 rounded-full" />
        {/* Mock Server Icons */}
        {[1, 2, 3].map((server) => (
          <div key={server} className="w-12 h-12 bg-gray-800 rounded-[24px] hover:rounded-[16px] hover:bg-indigo-500 transition-all duration-200 cursor-pointer flex items-center justify-center">
            <span className="font-medium">S{server}</span>
          </div>
        ))}
      </div>

      {/* 2. Inner Left: Channel Sidebar */}
      <div className="w-60 bg-gray-900 flex flex-col shrink-0 border-r border-gray-800">
        {/* Server Header */}
        <div className="h-16 flex items-center px-4 font-bold text-base shadow-sm border-b border-gray-800 hover:bg-gray-800/50 cursor-pointer transition-colors">
          Secure Server
        </div>
        
        {/* Channel List */}
        <div className="flex-1 overflow-y-auto py-4 px-2 space-y-1">
          <p className="px-2 text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Text Channels</p>
          {channels.map((channel) => (
            <button
              key={channel}
              onClick={() => setActiveChannel(channel)}
              className={`w-full flex items-center px-2 py-1.5 rounded-md transition-colors ${
                activeChannel === channel 
                  ? 'bg-gray-700/60 text-white' 
                  : 'text-gray-400 hover:bg-gray-800/60 hover:text-gray-200'
              }`}
            >
              <Hash className="w-5 h-5 mr-1.5 opacity-70" />
              <span className="truncate">{channel}</span>
            </button>
          ))}
        </div>

        {/* User Mini Profile (Bottom of Channel Sidebar) */}
        <div className="h-[52px] bg-gray-900/90 flex items-center px-2 border-t border-gray-800">
          <div 
            className="flex items-center hover:bg-gray-800 p-1 rounded-md cursor-pointer flex-1"
            onClick={() => setShowProfile(true)}
          >
            <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center mr-2 relative">
              <User className="w-5 h-5 text-white" />
              <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-gray-900 rounded-full"></div>
            </div>
            <div className="text-sm font-semibold truncate flex-1">
              {user?.username || 'KASANE TETOOOO'}
            </div>
          </div>
          <button onClick={() => setShowSettings(true)} className="p-1.5 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-md">
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* 3. Main Chat Area */}
      <div className="flex-1 flex flex-col bg-gray-800 min-w-0">
        
        {/* Chat Header (Adapted from your original nav) */}
        <nav className="h-16 border-b border-gray-700 flex items-center justify-between px-4 shrink-0 shadow-sm">
          <div className="flex items-center min-w-0">
            <Hash className="w-6 h-6 text-gray-400 mr-2" />
            <h1 className="text-lg font-bold truncate">
              {activeChannel}
            </h1>
          </div>
          
          {/* Right Header Menu Elements */}
          <div className="flex items-center gap-4 text-gray-400">
            <Bell className="w-5 h-5 hover:text-gray-200 cursor-pointer hidden sm:block" />
            <Pin className="w-5 h-5 hover:text-gray-200 cursor-pointer hidden sm:block" />
            
            {/* Friends Button with your custom logic */}
            <button
              onClick={() => setShowFriends(true)}
              className="relative p-1 hover:text-gray-200 transition-colors"
              title="Friends"
            >
              <Users className="w-5 h-5" />
              {incoming.length > 0 && unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] bg-red-500 rounded-full text-[10px] text-white flex items-center justify-center font-bold animate-pulse border-2 border-gray-800">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            {/* Search Bar Placeholder */}
            <div className="hidden md:flex items-center bg-gray-900 rounded-md px-2 py-1">
              <input type="text" placeholder="Search" className="bg-transparent text-sm w-32 focus:outline-none text-gray-200" />
              <Search className="w-4 h-4 text-gray-400" />
            </div>

            {/* Original Menu Component */}
            <MenuComponent
              onProfileClick={() => setShowProfile(true)}
              onSettingsClick={() => setShowSettings(true)}
            />
          </div>
        </nav>

        {/* Chat Messages Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {/* Welcome Message */}
          <div className="mt-8 mb-4">
            <div className="w-16 h-16 bg-gray-700 rounded-full flex items-center justify-center mb-4">
              <Hash className="w-10 h-10 text-white" />
            </div>
            <h1 className="text-3xl font-bold mb-2">Welcome to #{activeChannel}!</h1>
            <p className="text-gray-400">This is the start of the #{activeChannel} channel.</p>
          </div>

          {/* Dummy Message */}
          <div className="flex hover:bg-gray-700/30 p-2 -mx-2 rounded-md transition-colors">
            <div className="w-10 h-10 rounded-full bg-blue-500 flex-shrink-0 mr-4" />
            <div>
              <div className="flex items-baseline">
                <span className="font-semibold mr-2 text-indigo-400">System</span>
                <span className="text-xs text-gray-400">Today at 12:00 PM</span>
              </div>
              <p className="text-gray-300 mt-1">
                Your dashboard has been successfully converted into a chat interface! Try clicking around the UI elements.
              </p>
            </div>
          </div>
        </div>

        {/* Message Input Area */}
        <div className="p-4 shrink-0">
          <div className="bg-gray-700 rounded-lg flex items-center px-4 py-2.5">
            <button className="text-gray-400 hover:text-gray-200 mr-4 bg-gray-600 rounded-full p-1">
              <Plus className="w-5 h-5" />
            </button>
            <input 
              type="text" 
              placeholder={`Message #${activeChannel}`} 
              className="flex-1 bg-transparent border-none focus:outline-none text-gray-100 placeholder-gray-400"
            />
            <button className="text-gray-400 hover:text-indigo-400 ml-4">
              <Send className="w-5 h-5" />
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

export default ChatDashboard;