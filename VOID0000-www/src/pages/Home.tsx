import { useState } from 'react'; 
import { User, Settings, LogOut, Users } from 'lucide-react';
import { useAuth } from '../Services/hooks/Auth/useAuth';
import { useFriendRequests } from '../Services/hooks/Friends/useFriendRequests';
import MenuComponent from '../components/common/Menu';
import UserProfile from '../components/common/Profile/userProfile';
import UseSetting from '../components/common/Setting/Setting';
import FriendsModal from '../components/common/Friends/FriendsModal';

const Dashboard = () => {
  const { loading, user } = useAuth();
  // Get unreadCount to control the badge
  const { incoming, unreadCount } = useFriendRequests(); 
  
  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showFriends, setShowFriends] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white text-lg">Verifying your session...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {showProfile && user?.profile_id && (
        <UserProfile profileId={user.profile_id} onClose={() => setShowProfile(false)} />
      )}
      {showSettings && <UseSetting onClose={() => setShowSettings(false)} />}
      {showFriends && <FriendsModal onClose={() => setShowFriends(false)} />}

      <nav className="bg-gray-800/80 backdrop-blur-md border-b border-gray-700 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
              Secure Dashboard
            </h1>
            
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setShowFriends(true);
                  // 🛑 MOVED: markAsSeen() is removed from here
                }}
                className="p-2 rounded-lg hover:bg-gray-700 transition-colors relative"
                title="Friends"
              >
                <Users className="w-5 h-5 text-gray-300" />
                
                {/* Red Dot: Only shows if you have requests older than last view */}
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
          <p className="text-gray-300 max-w-2xl mx-auto">
            KASANE TETOOOO
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {[
            { icon: <User />, title: "Profile", desc: "Manage your personal information" },
            { icon: <Settings />, title: "Security", desc: "Update password and 2FA settings" },
            { icon: <LogOut />, title: "Sessions", desc: "View active login sessions" }
          ].map((item, index) => (
            <div 
              key={index} 
              className="bg-gray-800/50 p-6 rounded-lg border border-gray-700 hover:border-blue-500 transition-all hover:shadow-lg"
            >
              <div className="h-12 w-12 bg-blue-500/10 rounded-lg flex items-center justify-center mx-auto mb-4">
                {item.icon}
              </div>
              <h3 className="text-lg font-semibold">{item.title}</h3>
              <p className="text-gray-400 text-sm mt-2">
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