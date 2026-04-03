import type { ReactNode } from 'react';
import type { ScrollSeekPlaceholderProps } from 'react-virtuoso';
import type { Density } from '../../../Services/hooks/Settings/useTheme';
import {
  ChatMessageSkeletonRow,
  getMessageSkeletonBubbleWidth,
} from '../../common/Skeleton';

export function createScrollSeekPlaceholderRenderer(density: Density) {
  return ({ height, index }: ScrollSeekPlaceholderProps): ReactNode => {
    const alignment = density === 'comfortable' && index % 4 === 1 ? 'outgoing' : 'incoming';
    const startsGroup = index % 3 !== 1;
    const bubbleHeight =
      index % 5 === 2
        ? 'h-12'
        : index % 2 === 0
          ? 'h-10'
          : 'h-8';

    return (
      <div style={{ height }} className="overflow-hidden px-2">
        <div className="flex h-full items-center">
          <div className="w-full">
            <ChatMessageSkeletonRow
              density={density}
              alignment={alignment}
              showAvatar={alignment === 'incoming' && startsGroup}
              showMeta={startsGroup}
              metaWidth={alignment === 'outgoing' ? 'w-20' : index % 4 === 0 ? 'w-24' : 'w-16'}
              bubbleWidth={getMessageSkeletonBubbleWidth(density, alignment, index)}
              bubbleHeight={bubbleHeight}
            />
          </div>
        </div>
      </div>
    );
  };
}

export function createPaginationSkeletonRenderer(density: Density) {
  return (position: 'top' | 'bottom'): ReactNode => {
    const isBottom = position === 'bottom';
    const alignment = density === 'comfortable' && isBottom ? 'outgoing' : 'incoming';

    return (
      <div className={`pointer-events-none px-4 ${isBottom ? 'pb-3 pt-2' : 'pb-2 pt-3'}`}>
        <div className={`flex ${alignment === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
          <div className="w-full max-w-[min(100%,42rem)] rounded-2xl bg-void-bg-main/70 px-2 py-3 opacity-95 backdrop-blur-sm">
            <ChatMessageSkeletonRow
              density={density}
              alignment={alignment}
              showAvatar={alignment === 'incoming'}
              showMeta
              metaWidth={alignment === 'outgoing' ? 'w-20' : 'w-24'}
              bubbleWidth={getMessageSkeletonBubbleWidth(density, alignment, isBottom ? 1 : 3)}
              bubbleHeight={isBottom ? 'h-9' : 'h-10'}
            />
          </div>
        </div>
      </div>
    );
  };
}

export function createNewerLoadingPlaceholderRenderer(density: Density) {
  return (placeholderIndex: number): ReactNode => {
    const alignment = density === 'comfortable' && placeholderIndex % 4 === 1 ? 'outgoing' : 'incoming';
    const bubbleHeight =
      placeholderIndex % 5 === 2
        ? 'h-12'
        : placeholderIndex % 2 === 0
          ? 'h-10'
          : 'h-8';

    return (
      <div className="pointer-events-none px-4 py-1.5">
        <div className={`flex ${alignment === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
          <div className="w-full max-w-[min(100%,42rem)] rounded-2xl bg-void-bg-main/55 px-2 py-2 opacity-85 backdrop-blur-sm">
            <ChatMessageSkeletonRow
              density={density}
              alignment={alignment}
              showAvatar={alignment === 'incoming'}
              showMeta={placeholderIndex % 4 !== 3}
              metaWidth={alignment === 'outgoing' ? 'w-20' : placeholderIndex % 3 === 0 ? 'w-24' : 'w-16'}
              bubbleWidth={getMessageSkeletonBubbleWidth(density, alignment, placeholderIndex + 1)}
              bubbleHeight={bubbleHeight}
            />
          </div>
        </div>
      </div>
    );
  };
}

export function createOlderLoadingPlaceholderRenderer(density: Density) {
  return (placeholderIndex: number): ReactNode => {
    const alignment = density === 'comfortable' && placeholderIndex % 4 === 2 ? 'outgoing' : 'incoming';
    const bubbleHeight =
      placeholderIndex % 5 === 1
        ? 'h-12'
        : placeholderIndex % 2 === 0
          ? 'h-10'
          : 'h-8';

    return (
      <div className="pointer-events-none px-4 py-1.5">
        <div className={`flex ${alignment === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
          <div className="w-full max-w-[min(100%,42rem)] rounded-2xl bg-void-bg-main/55 px-2 py-2 opacity-85 backdrop-blur-sm">
            <ChatMessageSkeletonRow
              density={density}
              alignment={alignment}
              showAvatar={alignment === 'incoming'}
              showMeta={placeholderIndex % 4 !== 0}
              metaWidth={alignment === 'outgoing' ? 'w-20' : placeholderIndex % 3 === 0 ? 'w-24' : 'w-16'}
              bubbleWidth={getMessageSkeletonBubbleWidth(density, alignment, placeholderIndex + 2)}
              bubbleHeight={bubbleHeight}
            />
          </div>
        </div>
      </div>
    );
  };
}
