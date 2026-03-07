import React from 'react';
import { UserProfileStatusProps } from './types';

const UserProfileStatus: React.FC<UserProfileStatusProps> = ({ created_at }) => {
  return (
    <div className="mt-4 pt-4 border-t border-void-border/50">
      <p className="text-[11px] font-semibold text-void-text-muted uppercase tracking-wide mb-1">
        Member Since
      </p>
      <p className="text-sm text-void-text">
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