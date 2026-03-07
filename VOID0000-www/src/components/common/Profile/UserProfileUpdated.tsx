import React, { useEffect } from 'react';
import { CheckCircle, X } from 'lucide-react';

interface UserProfileUpdatedProps {
  onClose: () => void;
  autoCloseDelay?: number; // Optional delay in ms
}

const UserProfileUpdated: React.FC<UserProfileUpdatedProps> = ({ 
  onClose, 
  autoCloseDelay = 2000 // Default 2 seconds
}) => {
  
  // Auto-close effect
  useEffect(() => {
    if (autoCloseDelay > 0) {
      const timer = setTimeout(() => {
        onClose();
      }, autoCloseDelay);
      return () => clearTimeout(timer);
    }
  }, [onClose, autoCloseDelay]);

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-void-bg-secondary/95 backdrop-blur-sm rounded-2xl animate-in fade-in duration-300">

      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-gray-900/80 hover:bg-gray-900 transition-colors"
      >
        <X className="w-5 h-5 text-void-text" />
      </button>

      <div className="flex flex-col items-center p-8 text-center">
        <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mb-4 animate-bounce">
          <CheckCircle className="w-10 h-10 text-green-500" />
        </div>

        <h3 className="text-xl font-bold text-void-text mb-2">Profile Updated!</h3>
        <p className="text-void-text-muted">Your changes have been saved successfully.</p>

        <button
          onClick={onClose}
          className="mt-6 px-6 py-2 bg-void-bg-hover hover:bg-void-bg-hover text-void-text rounded-lg transition-colors text-sm font-medium"
        >
          Return to Profile
        </button>
      </div>
    </div>
  );
};

export default UserProfileUpdated;