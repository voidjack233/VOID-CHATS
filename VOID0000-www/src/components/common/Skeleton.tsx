// src/components/common/Skeleton.tsx
// Reusable skeleton/ghost loading primitives

interface SkeletonProps {
  className?: string;
  rounded?: 'full' | 'lg' | 'md' | 'sm' | 'xl' | '2xl' | 'none';
}

/** Single skeleton bar/shape — size & shape controlled via className */
export const Skeleton = ({ className = '', rounded = 'md' }: SkeletonProps) => (
  <div
    className={`skeleton-shimmer shrink-0 rounded-${rounded} ${className}`}
  />
);

/** Skeleton shaped like a conversation list item — adapts to density */
export const ConversationItemSkeleton = ({ density = 'compact' }: { density?: 'compact' | 'comfortable' }) => {
  if (density === 'comfortable') {
    return (
      <div className="flex items-center gap-3 px-2.5 py-2.5">
        <Skeleton className="w-10 h-10" rounded="full" />
        <div className="flex-1 min-w-0 space-y-2">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-3 w-2/5" />
        </div>
      </div>
    );
  }
  // compact — tight, single line, smaller avatar
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <Skeleton className="w-7 h-7" rounded="full" />
      <Skeleton className="h-3 w-3/5" />
    </div>
  );
};

/** Skeleton shaped like a message bubble (left-aligned) */
export const MessageSkeleton = ({ isRight = false, showAvatar = true, width = 'w-48' }: {
  isRight?: boolean;
  showAvatar?: boolean;
  width?: string;
}) => (
  <div className={`flex ${isRight ? 'flex-row-reverse' : 'flex-row'} items-start gap-2 mb-4`}>
    {showAvatar && <Skeleton className="w-8 h-8 mt-1" rounded="full" />}
    <div className={`space-y-1.5 ${isRight ? 'items-end' : 'items-start'} flex flex-col`}>
      <Skeleton className="h-3 w-20" />
      <Skeleton className={`h-10 ${width}`} rounded="2xl" />
    </div>
  </div>
);

/** Skeleton shaped like a friend request card */
export const FriendRequestSkeleton = () => (
  <div className="flex items-center gap-3 p-3 rounded-xl bg-void-bg-hover/30">
    <Skeleton className="w-10 h-10" rounded="full" />
    <div className="flex-1 space-y-1.5">
      <Skeleton className="h-3.5 w-28" />
      <Skeleton className="h-2.5 w-20" />
    </div>
    <div className="flex gap-2">
      <Skeleton className="w-16 h-8" rounded="lg" />
      <Skeleton className="w-16 h-8" rounded="lg" />
    </div>
  </div>
);

/** Skeleton shaped like a session card */
export const SessionCardSkeleton = () => (
  <div className="p-4 rounded-xl border border-void-border bg-gray-900">
    <div className="flex items-start gap-3">
      <Skeleton className="w-9 h-9" rounded="lg" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-2.5 w-44" />
      </div>
      <Skeleton className="w-16 h-7" rounded="lg" />
    </div>
  </div>
);

/** Skeleton shaped like the profile settings form */
export const ProfileFormSkeleton = () => (
  <div className="space-y-6">
    {/* Avatar section */}
    <div>
      <Skeleton className="h-3 w-24 mb-3" />
      <div className="flex items-center gap-4">
        <Skeleton className="w-20 h-20" rounded="full" />
        <div className="space-y-2">
          <Skeleton className="h-8 w-28" rounded="lg" />
          <Skeleton className="h-2.5 w-40" />
        </div>
      </div>
    </div>
    {/* Display name */}
    <div className="border-t border-void-border pt-4">
      <Skeleton className="h-3 w-28 mb-3" />
      <Skeleton className="h-11 w-full" rounded="lg" />
      <Skeleton className="h-2.5 w-56 mt-1.5" />
    </div>
    {/* Bio */}
    <div className="border-t border-void-border pt-4">
      <Skeleton className="h-3 w-20 mb-3" />
      <Skeleton className="h-20 w-full" rounded="lg" />
      <Skeleton className="h-2.5 w-12 mt-1.5" />
    </div>
    {/* Save button */}
    <div className="border-t border-void-border pt-4">
      <Skeleton className="h-10 w-32" rounded="lg" />
    </div>
  </div>
);

/** Skeleton for a user profile card modal */
export const UserProfileCardSkeleton = () => (
  <div className="space-y-5">
    {/* Header: Avatar + Name */}
    <div className="flex items-center gap-5">
      <Skeleton className="w-[88px] h-[88px]" rounded="full" />
      <div className="space-y-2">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-3.5 w-24" />
      </div>
    </div>
    {/* Bio lines */}
    <div className="space-y-2 pt-2">
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-3 w-2/3" />
    </div>
    {/* Status badge */}
    <Skeleton className="h-8 w-28" rounded="full" />
  </div>
);

/** Skeleton for auth form */
export const AuthFormSkeleton = () => (
  <div className="flex flex-col items-center gap-6 w-full max-w-sm">
    <Skeleton className="w-16 h-16" rounded="2xl" />
    <Skeleton className="h-5 w-32" />
    <div className="w-full space-y-3">
      <Skeleton className="h-11 w-full" rounded="lg" />
      <Skeleton className="h-11 w-full" rounded="lg" />
    </div>
    <Skeleton className="h-10 w-full" rounded="lg" />
    <Skeleton className="h-3 w-48" />
  </div>
);

/** Density-aware message view skeleton — mirrors the actual chat layout */
export const MessageViewSkeleton = ({ density = 'compact' }: { density?: 'compact' | 'comfortable' }) => {
  if (density === 'comfortable') {
    // Mix of left (other) and right (own) bubbles matching comfortable layout
    return (
      <div className="flex-1 p-4 space-y-5 overflow-hidden">
        {/* Other person, group start */}
        <div className="flex flex-row items-start gap-2">
          <Skeleton className="w-8 h-8 shrink-0 mt-1" rounded="full" />
          <div className="flex flex-col items-start space-y-1.5 max-w-[70%]">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-10 w-52" rounded="2xl" />
          </div>
        </div>
        {/* Other person, consecutive */}
        <div className="flex flex-row items-center gap-2 mt-1.5 ml-10">
          <Skeleton className="h-8 w-40" rounded="2xl" />
        </div>
        {/* Own message, right-aligned */}
        <div className="flex flex-row-reverse items-start gap-2 mt-5">
          <div className="flex flex-col items-end space-y-1.5 max-w-[70%]">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-10 w-44" rounded="2xl" />
          </div>
        </div>
        {/* Other person */}
        <div className="flex flex-row items-start gap-2 mt-5">
          <Skeleton className="w-8 h-8 shrink-0 mt-1" rounded="full" />
          <div className="flex flex-col items-start space-y-1.5 max-w-[70%]">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-12 w-64" rounded="2xl" />
          </div>
        </div>
        {/* Own message */}
        <div className="flex flex-row-reverse items-start gap-2 mt-5">
          <div className="flex flex-col items-end space-y-1.5 max-w-[70%]">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-8 w-36" rounded="2xl" />
          </div>
        </div>
        {/* Own consecutive */}
        <div className="flex flex-row-reverse items-center gap-2 mt-1.5">
          <Skeleton className="h-7 w-52" rounded="2xl" />
        </div>
      </div>
    );
  }

  // compact — left-aligned with avatar on group start
  return (
    <div className="flex-1 p-4 overflow-hidden">
      {/* Group 1 */}
      <div className="flex items-start gap-2 mt-3">
        <Skeleton className="w-8 h-8 shrink-0 mt-1" rounded="full" />
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-48" rounded="2xl" />
        </div>
      </div>
      <div className="flex items-center gap-2 mt-0.5 ml-10">
        <Skeleton className="h-6 w-36" rounded="2xl" />
      </div>
      {/* Group 2 */}
      <div className="flex items-start gap-2 mt-3">
        <Skeleton className="w-8 h-8 shrink-0 mt-1" rounded="full" />
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-10 w-64" rounded="2xl" />
        </div>
      </div>
      {/* Group 3 */}
      <div className="flex items-start gap-2 mt-3">
        <Skeleton className="w-8 h-8 shrink-0 mt-1" rounded="full" />
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-40" rounded="2xl" />
        </div>
      </div>
      <div className="flex items-center gap-2 mt-0.5 ml-10">
        <Skeleton className="h-8 w-56" rounded="2xl" />
      </div>
      <div className="flex items-center gap-2 mt-0.5 ml-10">
        <Skeleton className="h-6 w-32" rounded="2xl" />
      </div>
      {/* Group 4 */}
      <div className="flex items-start gap-2 mt-3">
        <Skeleton className="w-8 h-8 shrink-0 mt-1" rounded="full" />
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-18" />
          <Skeleton className="h-9 w-44" rounded="2xl" />
        </div>
      </div>
    </div>
  );
};

/** Skeleton for the friend-select list in group create modal */
export const FriendSelectSkeleton = () => (
  <div className="space-y-1">
    {[...Array(4)].map((_, i) => (
      <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
        <Skeleton className="w-8 h-8" rounded="full" />
        <Skeleton className="h-3.5 w-3/5" />
      </div>
    ))}
  </div>
);

/** Skeleton for the appearance tab preferences */
export const AppearanceTabSkeleton = () => (
  <div className="space-y-8 pb-24">
    <div>
      <Skeleton className="h-5 w-32 mb-2" />
      <Skeleton className="h-3.5 w-56 mb-6" />
    </div>
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {[...Array(5)].map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" rounded="xl" />
      ))}
    </div>
    <div className="space-y-4">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="flex items-center justify-between">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-16" rounded="lg" />
        </div>
      ))}
    </div>
  </div>
);

export default Skeleton;
