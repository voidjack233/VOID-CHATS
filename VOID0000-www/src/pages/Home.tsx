import { useState } from 'react'; 
import { useNavigate } from 'react-router-dom';
import { User, Settings, LogOut, Users, MessageCircle } from 'lucide-react';
import { useAuth } from '../Services/hooks/Auth/useAuth';
import { useFriendRequests } from '../Services/hooks/Friends/useFriendRequests';
import MenuComponent from '../components/common/Menu';
import UserProfileModal from '../components/common/Profile/UserProfileModal';
import SettingsModal from '../components/common/Settings/SettingsModal';
import FriendsModal from '../components/common/Friends/FriendsModal';

const Dashboard = () => {
  const { loading, user } = useAuth();
  const { incoming, unreadCount } = useFriendRequests(); 
  const navigate = useNavigate();
  
  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showFriends, setShowFriends] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen bg-void-bg-main flex items-center justify-center">
        <div className="text-void-text text-lg">Verifying your session...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-void-bg-main text-void-text">
      {showProfile && user?.profile_id && (
        <UserProfileModal profileId={user.profile_id} onClose={() => setShowProfile(false)} />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showFriends && <FriendsModal onClose={() => setShowFriends(false)} />}

      <nav className="bg-void-bg-sec/80 backdrop-blur-md border-b border-void-border sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
              Secure Dashboard
            </h1>
            
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowFriends(true)}
                className="p-2 rounded-lg hover:bg-void-bg-hover transition-colors relative"
                title="Friends"
              >
                <Users className="w-5 h-5 text-void-text-muted" />
                
                {incoming.length > 0 && unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-red-500 rounded-full text-xs text-white flex items-center justify-center font-medium animate-pulse">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>

              <MenuComponent
                onProfileClick={() => setShowProfile(true)}
                onSettingsClick={() => setShowSettings(true)}
              />
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent mb-4">
            Welcome to Your Dashboard
          </h1>
          <p className="text-void-text-muted max-w-2xl mx-auto">
            KASANE TETOOOO
          </p>
        </div>

        {/* Chat Button */}
        <div className="mb-8">
          <button
            onClick={() => navigate('/chats')}
            className="w-full bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 p-6 rounded-xl border border-indigo-400/20 transition-all hover:shadow-xl hover:shadow-indigo-500/10 group"
          >
            <div className="flex items-center justify-center gap-4">
              <div className="h-12 w-12 bg-white/10 rounded-lg flex items-center justify-center group-hover:scale-110 transition-transform">
                <MessageCircle className="w-6 h-6" />
              </div>
              <div className="text-left">
                <h3 className="text-lg font-semibold">Messages</h3>
                <p className="text-indigo-200 text-sm">Chat with friends · End-to-end encrypted</p>
              </div>
            </div>
          </button>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {[
            { icon: <User />, title: "Profile", desc: "Manage your personal information" },
            { icon: <Settings />, title: "Security", desc: "Update password and 2FA settings" },
            { icon: <LogOut />, title: "Sessions", desc: "View active login sessions" }
          ].map((item, index) => (
            <div 
              key={index} 
              className="bg-void-bg-sec/50 p-6 rounded-lg border border-void-border hover:border-blue-500 transition-all hover:shadow-lg"
            >
              <div className="h-12 w-12 bg-blue-500/10 rounded-lg flex items-center justify-center mx-auto mb-4">
                {item.icon}
              </div>
              <h3 className="text-lg font-semibold">{item.title}</h3>
              <p className="text-void-text-muted text-sm mt-2">
                {item.desc}
              </p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
