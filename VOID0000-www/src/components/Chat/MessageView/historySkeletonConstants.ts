import { MESSAGE_PAGE_SIZE } from '../../../Services/Chat/chatConstants';
import type { Density } from '../../../Services/hooks/Settings/useTheme';

export const HISTORY_SKELETON_ROW_HEIGHT: Record<Density, number> = {
  compact: 75,
  comfortable: 98,
};

export const HISTORY_PAGE_PLACEHOLDER_HEIGHT: Record<Density, number> = {
  compact: MESSAGE_PAGE_SIZE * HISTORY_SKELETON_ROW_HEIGHT.compact,
  comfortable: MESSAGE_PAGE_SIZE * HISTORY_SKELETON_ROW_HEIGHT.comfortable,
};
