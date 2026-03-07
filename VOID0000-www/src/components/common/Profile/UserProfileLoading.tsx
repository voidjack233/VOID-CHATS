import React from 'react';
import { Loader2 } from 'lucide-react';

const UserProfileLoading: React.FC = () => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl mx-4">
        <div className="bg-void-bg-secondary rounded-2xl p-8 shadow-2xl">
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="w-12 h-12 text-blue-500 animate-spin mb-4" />
            <p className="text-void-text text-lg font-medium">Loading profile...</p>
            <p className="text-void-text-muted text-sm mt-2">Please wait a moment</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserProfileLoading;