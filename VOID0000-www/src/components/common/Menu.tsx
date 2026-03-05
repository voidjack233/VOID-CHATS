// src/components/common/Menu.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, X, User, Settings, LogOut } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useUser } from '../../Services/Auth/UserContext'; 

interface MenuComponentProps {
  onProfileClick?: () => void;
  onSettingsClick?: () => void;
}

const MenuComponent: React.FC<MenuComponentProps> = ({ onProfileClick, onSettingsClick }) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const navigate = useNavigate();

  //  Get the smart logout function from your Context
  const { logout } = useUser(); 

  const toggleMenu = () => setIsMenuOpen(!isMenuOpen);
  const closeMenu = () => setIsMenuOpen(false);

  const handleLogout = async () => {
    setIsMenuOpen(false); // Close dropdown
    setIsLoggingOut(true); // Start loading screen

    try {
      // Optional: Tiny delay for smooth UI
      await new Promise(resolve => setTimeout(resolve, 800));

      // Call the Context logout (cleans Gateway + LocalStorage + API)
      await logout();
      
      navigate('/auth', { replace: true });
    } catch (error) {
      console.error("Logout failed", error);
      setIsLoggingOut(false);
    }
  };

  const handleProfile = () => {
    closeMenu();
    if (onProfileClick) onProfileClick();
  };

  const handleSettings = () => {
    closeMenu();
    if (onSettingsClick) onSettingsClick();
  };

  return (
    <div className="relative">
      {/* Menu Button */}
      <button
        onClick={toggleMenu}
        className="p-2 rounded-md hover:bg-gray-700 transition-colors"
        aria-label="Menu"
        disabled={isLoggingOut}
      >
        {isMenuOpen ? <X size={24} /> : <Menu size={24} />}
      </button>

      {/* Menu Backdrop */}
      {isMenuOpen && !isLoggingOut &&
        createPortal(
          <div
            className="fixed inset-0 bg-black/20 backdrop-blur-sm z-30"
            onClick={closeMenu}
          />,
          document.body
        )}

      {/* LOGOUT LOADING OVERLAY (Safe to use now!) */}
      {isLoggingOut &&
        createPortal(
          <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-gray-900 p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4 border border-gray-800">
              <div className="relative">
                <div className="w-12 h-12 border-4 border-gray-700 rounded-full"></div>
                <div className="w-12 h-12 border-4 border-t-red-500 rounded-full animate-spin absolute top-0 left-0"></div>
              </div>
              <div className="text-center">
                <h3 className="text-xl font-bold text-white">Logging Out</h3>
                <p className="text-gray-400 text-sm mt-1">Disconnecting securely...</p>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Dropdown Menu */}
      {isMenuOpen && (
        <div className="absolute right-0 mt-2 w-56 bg-gray-800 rounded-md shadow-lg border border-gray-700 z-50">
          <div className="p-2 space-y-1">
            <button
              onClick={handleProfile}
              className="flex w-full items-center px-4 py-2 text-sm hover:bg-gray-700 rounded-md"
            >
              <User className="mr-3 h-4 w-4" />
              Profile
            </button>

            <button
              onClick={handleSettings}
              className="flex w-full items-center px-4 py-2 text-sm hover:bg-gray-700 rounded-md"
            >
              <Settings className="mr-3 h-4 w-4" />
              Settings
            </button>

            <hr className="border-gray-700" />

            <button
              onClick={handleLogout}
              className="flex w-full items-center px-4 py-2 text-sm text-red-400 hover:bg-red-400/10 rounded-md"
            >
              <LogOut className="mr-3 h-4 w-4" />
              Logout
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default MenuComponent;

// this component are no longer USE as time pass by ive already changed the homepage into chats making this menu tsx unusable