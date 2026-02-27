import React from 'react';
import { UserProfileStatusProps } from './types';

const UserProfileStatus: React.FC<UserProfileStatusProps> = ({ created_at }) => {
  return (
    <div className="mt-4 pt-4 border-t border-gray-700/50">
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">
        Member Since
      </p>
      <p className="text-sm text-gray-300">
        {new Date(created_at).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })}
      </p>
    </div>
  );
};

export default UserProfileStatus;