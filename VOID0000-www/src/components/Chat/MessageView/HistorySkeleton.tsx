import { memo } from 'react';
import type { Density } from '../../../Services/hooks/Settings/useTheme';
import { Skeleton } from '../../common/Skeleton';
import { HISTORY_SKELETON_ROW_HEIGHT } from './historySkeletonConstants';

const OLDER_SKELETON_BUBBLE_WIDTHS = [
  'w-[54%] sm:w-[42%]',
  'w-[72%] sm:w-[56%]',
  'w-[46%] sm:w-[36%]',
  'w-[82%] sm:w-[64%]',
  'w-[62%] sm:w-[48%]',
  'w-[38%] sm:w-[30%]',
];

const OLDER_SKELETON_META_WIDTHS = [
  'w-16',
  'w-20',
  'w-24',
  'w-14',
];

const OlderHistorySkeleton = memo(function OlderHistorySkeleton({
  density,
  rowCount,
  active = false,
  anchorEdge = 'start',
}: {
  density: Density;
  rowCount: number;
  active?: boolean;
  anchorEdge?: 'start' | 'end';
}) {
  const rows = Array.from({ length: rowCount }, (_, index) => index);
  const rowHeight = HISTORY_SKELETON_ROW_HEIGHT[density];

  return (
    <div className={`pointer-events-none flex h-full w-full flex-col overflow-hidden px-2 transition-opacity ${active ? 'opacity-100' : 'opacity-75'} ${anchorEdge === 'end' ? 'justify-end' : 'justify-start'}`}>
      {rows.map((rowIndex) => {
        const patternIndex = anchorEdge === 'end'
          ? rowCount - rowIndex - 1
          : rowIndex;
        const isOutgoing = density === 'comfortable' && patternIndex % 5 === 3;
        const contentMaxWidth = density === 'comfortable'
          ? 'max-w-[80%] md:max-w-[70%]'
          : 'max-w-[88%] md:max-w-[85%]';
        const bubbleHeight = density === 'comfortable' ? 'h-10' : 'h-8';
        const avatarSize = 'h-8 w-8';
        const bubbleWidth =
          OLDER_SKELETON_BUBBLE_WIDTHS[patternIndex % OLDER_SKELETON_BUBBLE_WIDTHS.length];
        const metaWidth =
          OLDER_SKELETON_META_WIDTHS[patternIndex % OLDER_SKELETON_META_WIDTHS.length];

        return (
          <div
            key={rowIndex}
            className={`flex w-full max-w-full shrink-0 items-center ${isOutgoing ? 'justify-end' : 'justify-start'}`}
            style={{ height: `${rowHeight}px` }}
          >
            <div className={`flex w-full ${contentMaxWidth} items-start gap-2 ${isOutgoing ? 'flex-row-reverse' : 'flex-row'}`}>
              {!isOutgoing && (
                <Skeleton className={avatarSize} rounded="full" />
              )}
              <div className={`flex min-w-0 flex-1 flex-col gap-1.5 ${isOutgoing ? 'items-end' : 'items-start'}`}>
                {!isOutgoing && (
                  <Skeleton
                    className={`h-3 ${metaWidth}`}
                  />
                )}
                <Skeleton
                  className={`${bubbleHeight} ${bubbleWidth} max-w-full`}
                  rounded="2xl"
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});

export default OlderHistorySkeleton;
