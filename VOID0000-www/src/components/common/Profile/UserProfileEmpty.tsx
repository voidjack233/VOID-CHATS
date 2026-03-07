import React from 'react';
import { X, UserCircle } from 'lucide-react';
import { UserProfileEmptyProps } from './types';

const UserProfileEmpty: React.FC<UserProfileEmptyProps> = ({ onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl mx-4">
        <div className="bg-void-bg-secondary rounded-2xl p-8 shadow-2xl">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-2 rounded-full bg-gray-900/80 hover:bg-gray-900 transition-colors"
          >
            <X className="w-5 h-5 text-void-text" />
          </button>

          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-16 h-16 rounded-full bg-void-bg-hover flex items-center justify-center mb-4">
              <UserCircle className="w-8 h-8 text-void-text-muted" />
            </div>
            <h3 className="text-xl font-semibold text-void-text mb-2">Profile Not Found</h3>
            <p className="text-void-text-muted text-center mb-6">We couldn't find this profile.</p>
            <button
              onClick={onClose}
              className="px-6 py-2 bg-void-bg-hover hover:bg-void-bg-hover rounded-md text-sm font-medium transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserProfileEmpty;