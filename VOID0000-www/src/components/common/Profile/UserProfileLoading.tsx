import React from 'react';
import { UserProfileCardSkeleton } from '../Skeleton';

const UserProfileLoading: React.FC = () => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg bg-void-bg-sec rounded-2xl shadow-2xl border border-void-border p-8">
        <UserProfileCardSkeleton />
      </div>
    </div>
  );
};

export default UserProfileLoading;