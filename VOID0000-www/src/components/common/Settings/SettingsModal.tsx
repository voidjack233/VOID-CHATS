// src/components/common/Settings/SettingsModal.tsx
import { X, User, Shield, Info, Palette, BellRing, AlertTriangle, ChevronRight, ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import ProfileTab from './ProfileTab';
import AccountTab from './AccountTab';
import AboutTab from './AboutTab';
import AppearanceTab from './AppearanceTab';
import NotificationsTab from './NotificationsTab';
import { useScrollLock } from '../../../Services/hooks/common/useScrollLock';
import { useTheme } from '../../../Services/hooks/Settings/useTheme';

interface SettingsModalProps {
  onClose: () => void;
}

type SettingsTab = 'profile' | 'account' | 'about' | 'appearance' | 'notifications';

const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  useScrollLock(); // Lock scroll when settings modal is open
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');
  const [mobileView, setMobileView] = useState<'menu' | 'detail'>('menu');
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const { hasChanges, revertChanges } = useTheme();

  const handleClose = () => {
    if (hasChanges) {
      setShowUnsavedDialog(true);
    } else {
      onClose();
    }
  };

  const handleDiscardAndClose = () => {
    revertChanges();
    setShowUnsavedDialog(false);
    onClose();
  };

  const menuItems = [
    { id: 'profile' as SettingsTab, label: 'Profile', icon: <User className="w-4 h-4" /> },
    { id: 'account' as SettingsTab, label: 'Account', icon: <Shield className="w-4 h-4" /> },
    { id: 'appearance' as SettingsTab, label: 'Appearance', icon: <Palette className="w-4 h-4" /> },
    { id: 'notifications' as SettingsTab, label: 'Notifications', icon: <BellRing className="w-4 h-4" /> },
    { id: 'about' as SettingsTab, label: 'About', icon: <Info className="w-4 h-4" /> },
  ];

  useEffect(() => {
    const syncMobileView = () => {
      if (window.innerWidth >= 768) {
        setMobileView('detail');
      } else {
        setMobileView('menu');
      }
    };

    syncMobileView();
    window.addEventListener('resize', syncMobileView);

    return () => {
      window.removeEventListener('resize', syncMobileView);
    };
  }, []);

  const openTab = (tab: SettingsTab) => {
    setActiveTab(tab);
    if (window.innerWidth < 768) {
      setMobileView('detail');
    }
  };

  const currentTabLabel = menuItems.find(item => item.id === activeTab)?.label || 'Settings';

  const renderTabContent = () => {
    switch (activeTab) {
      case 'profile':
        return <ProfileTab />;
      case 'account':
        return <AccountTab />;
      case 'appearance':
        return <AppearanceTab />;
      case 'notifications':
        return <NotificationsTab />;
      case 'about':
        return <AboutTab />;
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-void-bg-main/90 md:flex md:items-center md:justify-center md:bg-black/20 md:backdrop-blur-sm">
      <div className="h-full w-full bg-void-bg-sec flex flex-col md:mx-4 md:h-[600px] md:max-h-[90vh] md:max-w-4xl md:flex-row md:overflow-hidden md:rounded-2xl md:border md:border-white/10 md:shadow-2xl">
        
        {/* Desktop Sidebar */}
        <div className="hidden md:flex md:w-64 bg-void-bg-main/50 border-r border-void-bg-hover flex-col flex-shrink-0">
          <div className="p-6 border-b border-void-bg-hover">
            <h2 className="text-xl font-bold text-void-text">Settings</h2>
            <p className="text-sm text-void-text-muted mt-1">Manage your account</p>
          </div>
          
          <nav className="flex-1 p-4 space-y-1">
            {menuItems.map((item) => (
              <button
                key={item.id}
                onClick={() => openTab(item.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                  activeTab === item.id
                    ? 'bg-void-accent/12 text-void-accent ring-1 ring-void-accent/25'
                    : 'text-void-text-muted hover:bg-void-bg-hover hover:text-void-text'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>

          <div className="p-4 border-t border-void-bg-hover">
            <p className="text-xs text-void-text-muted">Version 1.0.0</p>
          </div>
        </div>

        {/* Mobile Header - Sticky */}
        <div className="md:hidden sticky top-0 z-10 bg-void-bg-sec border-b border-void-bg-hover">
          <div className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              {mobileView === 'detail' ? (
                <button
                  onClick={() => setMobileView('menu')}
                  className="p-2 rounded-full bg-void-bg-main/80 hover:bg-void-bg-main"
                  aria-label="Back to settings"
                >
                  <ArrowLeft className="w-5 h-5 text-void-text-muted" />
                </button>
              ) : null}
              <div className="min-w-0">
                <h2 className="text-xl font-bold text-void-text truncate">
                  {mobileView === 'menu' ? 'Settings' : currentTabLabel}
                </h2>
                {mobileView === 'menu' ? (
                  <p className="text-xs text-void-text-muted mt-0.5">Manage your account</p>
                ) : null}
              </div>
            </div>
            <button
              onClick={handleClose}
              className="p-2 rounded-full bg-void-bg-main/80 hover:bg-void-bg-main"
            >
              <X className="w-5 h-5 text-void-text-muted" />
            </button>
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
          {/* Desktop Header */}
          <div className="hidden md:flex p-6 border-b border-void-bg-hover items-center justify-between flex-shrink-0">
            <h3 className="text-lg font-semibold text-void-text">
              {menuItems.find(item => item.id === activeTab)?.label}
            </h3>
            <button
              onClick={handleClose}
              className="p-2 rounded-full bg-void-bg-main/80 hover:bg-void-bg-main"
            >
              <X className="w-5 h-5 text-void-text-muted" />
            </button>
          </div>

          {/* Content - Scrollable */}
          <div className="flex-1 overflow-y-auto overscroll-contain">
            <div className="p-4 md:p-6">
              <div className="md:hidden">
                {mobileView === 'menu' ? (
                  <div className="space-y-2">
                    {menuItems.map((item) => {
                      return (
                        <button
                          key={item.id}
                          onClick={() => openTab(item.id)}
                          className="w-full flex items-center justify-between gap-3 rounded-2xl border border-void-bg-hover bg-void-bg-main/35 px-4 py-4 text-left text-void-text-muted transition-all hover:border-void-bg-hover/80 hover:bg-void-bg-hover/60 hover:text-void-text"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="shrink-0 text-void-text-muted">
                              {item.icon}
                            </div>
                            <div className="min-w-0">
                              <div className="font-medium truncate">{item.label}</div>
                            </div>
                          </div>
                          <ChevronRight className="h-4 w-4 shrink-0 text-void-text-muted" />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  renderTabContent()
                )}
              </div>

              <div className="hidden md:block">
                {renderTabContent()}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Unsaved Changes Dialog */}
      {showUnsavedDialog && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center">
          <div className="bg-void-bg-sec border border-void-bg-hover rounded-xl shadow-2xl p-6 max-w-sm mx-4">
            <div className="flex items-center gap-3 mb-3">
              <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0" />
              <h3 className="text-lg font-semibold text-void-text">Unsaved Changes</h3>
            </div>
            <p className="text-sm text-void-text-muted mb-6">
              You have unsaved changes. Are you sure you want to leave without saving?
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowUnsavedDialog(false)}
                className="px-4 py-2 text-sm font-medium text-void-text bg-void-bg-hover hover:bg-void-bg-hover/80 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDiscardAndClose}
                className="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
              >
                Discard Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsModal;
