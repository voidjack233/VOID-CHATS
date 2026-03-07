import React from 'react';
import { X, AlertCircle } from 'lucide-react';
import { UserProfileErrorProps } from './types';

const UserProfileError: React.FC<UserProfileErrorProps> = ({ error, onClose }) => {
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
            <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mb-4">
              <AlertCircle className="w-8 h-8 text-red-500" />
            </div>
            <h3 className="text-xl font-semibold text-void-text mb-2">Unable to Load Profile</h3>
            <p className="text-void-text-muted text-center mb-6 max-w-md">{error}</p>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="px-6 py-2 bg-void-bg-hover hover:bg-void-bg-hover rounded-md text-sm font-medium transition-colors"
              >
                Close
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-6 py-2 bg-blue-500 hover:bg-blue-600 rounded-md text-sm font-medium transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserProfileError;