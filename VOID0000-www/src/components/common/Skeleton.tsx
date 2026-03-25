// src/components/common/Skeleton.tsx
// Reusable skeleton/ghost loading primitives

import type { Density } from '../../Services/hooks/Settings/useTheme';

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

type MessageSkeletonAlignment = 'incoming' | 'outgoing';

export const MESSAGE_SKELETON_CONTENT_MAX_WIDTH: Record<Density, string> = {
  compact: 'max-w-[85%]',
  comfortable: 'max-w-[70%]',
};

export const MESSAGE_SKELETON_INCOMING_OFFSET = 'pl-10';

const MESSAGE_SKELETON_BUBBLE_WIDTHS: Record<Density, Record<MessageSkeletonAlignment, string[]>> = {
  compact: {
    incoming: [
      'w-[64%] sm:w-[70%] md:w-[74%]',
      'w-[84%] sm:w-[90%] md:w-[92%]',
      'w-[50%] sm:w-[56%] md:w-[60%]',
      'w-[74%] sm:w-[80%] md:w-[84%]',
    ],
    outgoing: [
      'w-[64%] sm:w-[70%] md:w-[74%]',
      'w-[84%] sm:w-[90%] md:w-[92%]',
      'w-[50%] sm:w-[56%] md:w-[60%]',
      'w-[74%] sm:w-[80%] md:w-[84%]',
    ],
  },
  comfortable: {
    incoming: [
      'w-[62%] sm:w-[68%] md:w-[72%]',
      'w-[82%] sm:w-[88%] md:w-[92%]',
      'w-[48%] sm:w-[54%] md:w-[58%]',
      'w-[72%] sm:w-[78%] md:w-[84%]',
    ],
    outgoing: [
      'w-[68%] sm:w-[76%] md:w-[80%]',
      'w-[82%] sm:w-[88%] md:w-[92%]',
      'w-[54%] sm:w-[60%] md:w-[64%]',
      'w-[74%] sm:w-[82%] md:w-[86%]',
    ],
  },
};

export const getMessageSkeletonBubbleWidth = (
  density: Density,
  alignment: MessageSkeletonAlignment,
  index = 0,
) => {
  const widths = MESSAGE_SKELETON_BUBBLE_WIDTHS[density][alignment];
  return widths[((index % widths.length) + widths.length) % widths.length];
};

interface ChatMessageSkeletonRowProps {
  density?: Density;
  alignment?: MessageSkeletonAlignment;
  showAvatar?: boolean;
  showMeta?: boolean;
  bubbleWidth?: string;
  bubbleHeight?: string;
  metaWidth?: string;
  className?: string;
}

export const ChatMessageSkeletonRow = ({
  density = 'compact',
  alignment = 'incoming',
  showAvatar = alignment === 'incoming',
  showMeta = true,
  bubbleWidth,
  bubbleHeight = 'h-10',
  metaWidth = 'w-24',
  className = '',
}: ChatMessageSkeletonRowProps) => {
  const isRightAligned = density === 'comfortable' && alignment === 'outgoing';
  const rowIndent = !isRightAligned && !showAvatar ? MESSAGE_SKELETON_INCOMING_OFFSET : '';
  const contentMaxWidth = MESSAGE_SKELETON_CONTENT_MAX_WIDTH[density];
  const resolvedBubbleWidth = bubbleWidth || getMessageSkeletonBubbleWidth(density, alignment);

  return (
    <div className={`flex w-full max-w-full ${isRightAligned ? 'justify-end' : 'justify-start'} ${rowIndent} ${className}`}>
      <div className={`flex w-full max-w-full items-start gap-2 ${isRightAligned ? 'flex-row-reverse' : 'flex-row'}`}>
        {showAvatar && !isRightAligned && (
          <Skeleton className="mt-1 h-8 w-8 shrink-0" rounded="full" />
        )}

        <div className={`flex min-w-0 w-full flex-col gap-1.5 ${contentMaxWidth} ${isRightAligned ? 'items-end' : 'items-start'}`}>
          {showMeta && <Skeleton className={`h-3 ${metaWidth}`} />}
          <Skeleton className={`${bubbleHeight} ${resolvedBubbleWidth} max-w-full`} rounded="2xl" />
        </div>
      </div>
    </div>
  );
};

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
  <ChatMessageSkeletonRow
    density={isRight ? 'comfortable' : 'compact'}
    alignment={isRight ? 'outgoing' : 'incoming'}
    showAvatar={showAvatar}
    bubbleWidth={width}
  />
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
    return (
      <div className="flex-1 overflow-hidden px-2 py-4">
        <div className="space-y-1.5">
          <ChatMessageSkeletonRow
            density="comfortable"
            alignment="incoming"
            showAvatar
            showMeta
            metaWidth="w-24"
            bubbleWidth={getMessageSkeletonBubbleWidth('comfortable', 'incoming', 1)}
            bubbleHeight="h-10"
          />
          <ChatMessageSkeletonRow
            density="comfortable"
            alignment="incoming"
            showAvatar={false}
            showMeta={false}
            bubbleWidth={getMessageSkeletonBubbleWidth('comfortable', 'incoming', 0)}
            bubbleHeight="h-8"
          />
          <ChatMessageSkeletonRow
            density="comfortable"
            alignment="outgoing"
            showAvatar={false}
            showMeta
            metaWidth="w-20"
            bubbleWidth={getMessageSkeletonBubbleWidth('comfortable', 'outgoing', 1)}
            bubbleHeight="h-10"
            className="pt-5"
          />
          <ChatMessageSkeletonRow
            density="comfortable"
            alignment="outgoing"
            showAvatar={false}
            showMeta={false}
            bubbleWidth={getMessageSkeletonBubbleWidth('comfortable', 'outgoing', 0)}
            bubbleHeight="h-8"
          />
          <ChatMessageSkeletonRow
            density="comfortable"
            alignment="incoming"
            showAvatar
            showMeta
            metaWidth="w-28"
            bubbleWidth={getMessageSkeletonBubbleWidth('comfortable', 'incoming', 3)}
            bubbleHeight="h-12"
            className="pt-5"
          />
          <ChatMessageSkeletonRow
            density="comfortable"
            alignment="incoming"
            showAvatar={false}
            showMeta={false}
            bubbleWidth={getMessageSkeletonBubbleWidth('comfortable', 'incoming', 1)}
            bubbleHeight="h-9"
          />
          <ChatMessageSkeletonRow
            density="comfortable"
            alignment="incoming"
            showAvatar={false}
            showMeta={false}
            bubbleWidth={getMessageSkeletonBubbleWidth('comfortable', 'incoming', 2)}
            bubbleHeight="h-7"
          />
          <ChatMessageSkeletonRow
            density="comfortable"
            alignment="outgoing"
            showAvatar={false}
            showMeta
            metaWidth="w-16"
            bubbleWidth={getMessageSkeletonBubbleWidth('comfortable', 'outgoing', 3)}
            bubbleHeight="h-9"
            className="pt-5"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden px-2 py-4">
      <div className="space-y-1.5">
        <ChatMessageSkeletonRow
          density="compact"
          alignment="incoming"
          showAvatar
          showMeta
          metaWidth="w-20"
          bubbleWidth={getMessageSkeletonBubbleWidth('compact', 'incoming', 1)}
          bubbleHeight="h-9"
        />
        <ChatMessageSkeletonRow
          density="compact"
          alignment="incoming"
          showAvatar={false}
          showMeta={false}
          bubbleWidth={getMessageSkeletonBubbleWidth('compact', 'incoming', 0)}
          bubbleHeight="h-7"
        />
        <ChatMessageSkeletonRow
          density="compact"
          alignment="incoming"
          showAvatar
          showMeta
          metaWidth="w-16"
          bubbleWidth={getMessageSkeletonBubbleWidth('compact', 'incoming', 3)}
          bubbleHeight="h-11"
          className="pt-4"
        />
        <ChatMessageSkeletonRow
          density="compact"
          alignment="incoming"
          showAvatar
          showMeta
          metaWidth="w-24"
          bubbleWidth={getMessageSkeletonBubbleWidth('compact', 'incoming', 2)}
          bubbleHeight="h-8"
          className="pt-4"
        />
        <ChatMessageSkeletonRow
          density="compact"
          alignment="incoming"
          showAvatar={false}
          showMeta={false}
          bubbleWidth={getMessageSkeletonBubbleWidth('compact', 'incoming', 1)}
          bubbleHeight="h-9"
        />
        <ChatMessageSkeletonRow
          density="compact"
          alignment="incoming"
          showAvatar={false}
          showMeta={false}
          bubbleWidth={getMessageSkeletonBubbleWidth('compact', 'incoming', 2)}
          bubbleHeight="h-7"
        />
        <ChatMessageSkeletonRow
          density="compact"
          alignment="incoming"
          showAvatar
          showMeta
          metaWidth="w-20"
          bubbleWidth={getMessageSkeletonBubbleWidth('compact', 'incoming', 0)}
          bubbleHeight="h-10"
          className="pt-4"
        />
      </div>
    </div>
  );
};

/** Skeleton for the full conversation pane while a route is opening */
export const ConversationPaneSkeleton = ({
  showMobileBack = false,
  density = 'compact',
}: {
  showMobileBack?: boolean;
  density?: Density;
}) => (
  <div className="flex flex-1 min-h-0">
    <div className="flex min-w-0 flex-1 flex-col">
      <nav className="h-16 border-b border-void-bg-hover flex items-center justify-between px-4 shrink-0 shadow-sm">
        <div className="flex items-center min-w-0 flex-1">
          {showMobileBack && (
            <Skeleton className="mr-3 h-7 w-7 md:hidden" rounded="lg" />
          )}
          <Skeleton className="h-9 w-9 shrink-0" rounded="full" />
          <div className="ml-3 min-w-0 flex-1">
            <Skeleton className="h-5 w-32 max-w-[70%]" />
            <Skeleton className="mt-2 h-3 w-24 max-w-[50%]" />
          </div>
        </div>
        <Skeleton className="ml-2 h-8 w-8 shrink-0" rounded="lg" />
      </nav>

      <div className="flex-1 min-h-0">
        <MessageViewSkeleton density={density} />
      </div>

      <div className="border-t border-void-bg-hover px-4 py-3 shrink-0 bg-void-bg-sec">
        <div className="flex items-end gap-3">
          <Skeleton className="h-11 flex-1" rounded="2xl" />
          <Skeleton className="h-11 w-11" rounded="xl" />
        </div>
      </div>
    </div>
  </div>
);

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
