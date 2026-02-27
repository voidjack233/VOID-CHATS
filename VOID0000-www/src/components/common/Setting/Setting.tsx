import { X, User, Shield, Info } from 'lucide-react';
import { useState } from 'react';
import ProfileTab from './ProfileTab';
import AccountTab from './AccountTab';
import AboutTab from './AboutTab';
import { useScrollLock } from '../../../Services/hooks/common/useScrollLock';

interface SettingsModalProps {
  onClose: () => void;
}

type SettingsTab = 'profile' | 'account' | 'about';

const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  useScrollLock(); // Lock scroll when settings modal is open
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

  const menuItems = [
    { id: 'profile' as SettingsTab, label: 'Profile', icon: <User className="w-4 h-4" /> },
    { id: 'account' as SettingsTab, label: 'Account', icon: <Shield className="w-4 h-4" /> },
    { id: 'about' as SettingsTab, label: 'About', icon: <Info className="w-4 h-4" /> },
  ];

  const renderTabContent = () => {
    switch (activeTab) {
      case 'profile':
        return <ProfileTab />;
      case 'account':
        return <AccountTab />;
      case 'about':
        return <AboutTab />;
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-gray-900 md:flex md:items-center md:justify-center md:bg-black/20 md:backdrop-blur-sm">
      <div className="h-full w-full md:h-[600px] md:max-h-[90vh] md:max-w-4xl md:mx-4 md:rounded-2xl md:shadow-2xl bg-gray-800 flex flex-col md:flex-row md:overflow-hidden">
        
        {/* Desktop Sidebar */}
        <div className="hidden md:flex md:w-64 bg-gray-900/50 border-r border-gray-700 flex-col flex-shrink-0">
          <div className="p-6 border-b border-gray-700">
            <h2 className="text-xl font-bold text-white">Settings</h2>
            <p className="text-sm text-gray-400 mt-1">Manage your account</p>
          </div>
          
          <nav className="flex-1 p-4 space-y-1">
            {menuItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                  activeTab === item.id
                    ? 'bg-blue-500 text-white'
                    : 'text-gray-300 hover:bg-gray-800/50 hover:text-white'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>

          <div className="p-4 border-t border-gray-700">
            <p className="text-xs text-gray-500">Version 1.0.0</p>
          </div>
        </div>

        {/* Mobile Header - Sticky */}
        <div className="md:hidden sticky top-0 z-10 bg-gray-800 border-b border-gray-700">
          <div className="p-4 flex items-center justify-between">
            <h2 className="text-xl font-bold text-white">Settings</h2>
            <button
              onClick={onClose}
              className="p-2 rounded-full bg-gray-900/80 hover:bg-gray-900"
            >
              <X className="w-5 h-5 text-gray-300" />
            </button>
          </div>

          {/* Mobile Tab Navigation */}
          <div className="flex border-t border-gray-700">
            {menuItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium ${
                  activeTab === item.id
                    ? 'text-blue-400 border-b-2 border-blue-400'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Desktop Header */}
          <div className="hidden md:flex p-6 border-b border-gray-700 items-center justify-between flex-shrink-0">
            <h3 className="text-lg font-semibold text-white">
              {menuItems.find(item => item.id === activeTab)?.label}
            </h3>
            <button
              onClick={onClose}
              className="p-2 rounded-full bg-gray-900/80 hover:bg-gray-900"
            >
              <X className="w-5 h-5 text-gray-300" />
            </button>
          </div>

          {/* Content - Scrollable */}
          <div className="flex-1 overflow-y-auto overscroll-contain">
            <div className="p-4 md:p-6">
              {renderTabContent()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;