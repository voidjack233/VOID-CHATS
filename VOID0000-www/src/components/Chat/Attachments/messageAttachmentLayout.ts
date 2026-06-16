import type { Attachment } from '../../../Services/Chat/chatTypes';

export const SINGLE_ATTACHMENT_MAX_LANDSCAPE_WIDTH = 550;
export const SINGLE_ATTACHMENT_MAX_PORTRAIT_WIDTH = 320;
export const SINGLE_ATTACHMENT_MAX_SQUARE_WIDTH = 440;
export const SINGLE_ATTACHMENT_MAX_HEIGHT = 520;
export const SINGLE_ATTACHMENT_MIN_WIDTH = 160;
export const SINGLE_ATTACHMENT_FALLBACK_WIDTH = 360;
export const SINGLE_ATTACHMENT_FALLBACK_ASPECT_RATIO = 4 / 3;
export const MULTI_ATTACHMENT_MAX_WIDTH = 440;

const LANDSCAPE_ATTACHMENT_RATIO_THRESHOLD = 1.2;
const PORTRAIT_ATTACHMENT_RATIO_THRESHOLD = 0.9;
const ATTACHMENT_GRID_GAP = 4;
const ATTACHMENT_SECTION_PADDING = 4;
const ATTACHMENT_STACK_GAP = 8;
const AUDIO_ATTACHMENT_HEIGHT = 114;
const FILE_ATTACHMENT_HEIGHT = 68;

const AUDIO_EXTENSIONS = new Set([
  'aac',
  'flac',
  'm4a',
  'mp3',
  'oga',
  'ogg',
  'opus',
  'wav',
  'weba',
  'webm',
]);

export interface SingleAttachmentPresentation {
  width: number;
  height: number;
  aspectRatio: string;
}

const getAttachmentPathname = (attachment: Pick<Attachment, 'url'>): string => {
  try {
    return new URL(attachment.url, 'https://attachment.invalid').pathname.toLowerCase();
  } catch {
    return attachment.url.toLowerCase();
  }
};

const getAttachmentExtension = (attachment: Pick<Attachment, 'url' | 'name'>): string | null => {
  const source = attachment.name?.trim() || getAttachmentPathname(attachment);
  const cleanSource = source.split('?')[0]?.split('#')[0] || source;
  const extension = cleanSource.split('.').pop()?.toLowerCase();
  return extension && extension !== cleanSource.toLowerCase() ? extension : null;
};

export function looksLikeImageAttachment(attachment: Attachment): boolean {
  if (attachment.mime?.startsWith('image/')) {
    return true;
  }

  if (attachment.blurhash || attachment.width || attachment.height) {
    return true;
  }

  return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(getAttachmentPathname(attachment));
}

export function isAudioAttachmentLayout(attachment: Attachment): boolean {
  if (attachment.mime?.startsWith('audio/')) {
    return true;
  }

  const extension = getAttachmentExtension(attachment);
  return Boolean(extension && AUDIO_EXTENSIONS.has(extension));
}

export function getSingleAttachmentPresentation(
  attachment: Pick<Attachment, 'width' | 'height'>,
): SingleAttachmentPresentation | null {
  const width = attachment.width;
  const height = attachment.height;

  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  const aspectRatio = width / height;
  const maxWidth = aspectRatio >= LANDSCAPE_ATTACHMENT_RATIO_THRESHOLD
    ? SINGLE_ATTACHMENT_MAX_LANDSCAPE_WIDTH
    : aspectRatio <= PORTRAIT_ATTACHMENT_RATIO_THRESHOLD
      ? SINGLE_ATTACHMENT_MAX_PORTRAIT_WIDTH
      : SINGLE_ATTACHMENT_MAX_SQUARE_WIDTH;
  const fitScale = Math.min(
    maxWidth / width,
    SINGLE_ATTACHMENT_MAX_HEIGHT / height,
  );
  const naturalScale = Math.min(1, fitScale);
  const minimumWidthScale = Math.min(SINGLE_ATTACHMENT_MIN_WIDTH / width, fitScale);
  const displayScale = Math.max(naturalScale, minimumWidthScale);
  const displayWidth = Math.round(width * displayScale);
  const displayHeight = displayWidth / aspectRatio;

  return {
    width: displayWidth,
    height: displayHeight,
    aspectRatio: `${width} / ${height}`,
  };
}

export function getSingleAttachmentReservedPresentation(
  attachment: Pick<Attachment, 'width' | 'height'>,
): SingleAttachmentPresentation {
  return getSingleAttachmentPresentation(attachment) || {
    width: SINGLE_ATTACHMENT_FALLBACK_WIDTH,
    height: SINGLE_ATTACHMENT_FALLBACK_WIDTH / SINGLE_ATTACHMENT_FALLBACK_ASPECT_RATIO,
    aspectRatio: '4 / 3',
  };
}

export function estimateAttachmentLayoutHeight(attachments: Attachment[]): number {
  if (attachments.length === 0) {
    return 0;
  }

  const imageAttachments = attachments.filter(looksLikeImageAttachment);
  const audioAttachments = attachments.filter(
    (attachment) => !looksLikeImageAttachment(attachment) && isAudioAttachmentLayout(attachment),
  );
  const fileAttachments = attachments.filter(
    (attachment) => !looksLikeImageAttachment(attachment) && !isAudioAttachmentLayout(attachment),
  );

  let totalHeight = 0;
  let hasSection = false;

  if (imageAttachments.length === 1) {
    totalHeight += getSingleAttachmentReservedPresentation(imageAttachments[0]!).height;
    hasSection = true;
  } else if (imageAttachments.length === 2) {
    totalHeight += (MULTI_ATTACHMENT_MAX_WIDTH - ATTACHMENT_GRID_GAP) / 2;
    hasSection = true;
  } else if (imageAttachments.length >= 3) {
    const heroHeight = MULTI_ATTACHMENT_MAX_WIDTH * (9 / 16);
    const tileHeight = (MULTI_ATTACHMENT_MAX_WIDTH - ATTACHMENT_GRID_GAP) / 2;
    totalHeight += heroHeight + ATTACHMENT_GRID_GAP + tileHeight;
    hasSection = true;
  }

  if (audioAttachments.length > 0) {
    totalHeight +=
      (hasSection ? ATTACHMENT_STACK_GAP : ATTACHMENT_SECTION_PADDING) +
      (audioAttachments.length * AUDIO_ATTACHMENT_HEIGHT) +
      (Math.max(0, audioAttachments.length - 1) * ATTACHMENT_STACK_GAP);
    hasSection = true;
  }

  if (fileAttachments.length > 0) {
    totalHeight +=
      (hasSection ? ATTACHMENT_STACK_GAP : ATTACHMENT_SECTION_PADDING) +
      (fileAttachments.length * FILE_ATTACHMENT_HEIGHT) +
      (Math.max(0, fileAttachments.length - 1) * ATTACHMENT_STACK_GAP);
  }

  return totalHeight + (imageAttachments.length > 0 ? ATTACHMENT_SECTION_PADDING : 0);
}
