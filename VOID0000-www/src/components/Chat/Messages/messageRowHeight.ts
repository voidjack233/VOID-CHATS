import { parseAttachments } from '../../../Services/Chat/messageAttachments';
import type { Message } from '../../../Services/Chat/chatTypes';
import type { Density } from '../../../Services/hooks/Settings/useTheme';
import { estimateAttachmentLayoutHeight } from '../Attachments/messageAttachmentLayout';

const ESTIMATED_MESSAGE_ROW_HEIGHT: Record<Density, number> = {
  compact: 56,
  comfortable: 76,
};

export function estimateMessageRowHeight(message: Message, density: Density): number {
  if (message.message_type === 'system') {
    return density === 'comfortable' ? 44 : 36;
  }

  const baseHeight = ESTIMATED_MESSAGE_ROW_HEIGHT[density];
  const content = typeof message.content === 'string' ? message.content : '';
  const hasTextBubble = Boolean(
    message.is_deleted ||
    (content && content !== '[encrypted]') ||
    (message.attachments?.length ?? 0) === 0,
  );
  const approxCharsPerLine = density === 'comfortable' ? 44 : 52;
  const approxLines = hasTextBubble
    ? Math.max(1, Math.ceil(content.length / approxCharsPerLine))
    : 0;
  const lineHeight = density === 'comfortable' ? 22 : 19;
  const textHeight = Math.min(720, approxLines * lineHeight);
  const attachmentHeight = estimateAttachmentLayoutHeight(parseAttachments(message.attachments));
  const replyHeight = message.reply_to ? (density === 'comfortable' ? 64 : 54) : 0;
  const forwardedHeight = message.forwarded ? 24 : 0;
  const reactionHeight = message.reactions && Object.keys(message.reactions).length > 0 ? 30 : 0;
  const linkPreviewHeight = message.link_preview
    ? (message.link_preview.image ? 240 : 112)
    : 0;

  return Math.max(
    baseHeight,
    baseHeight +
      textHeight +
      attachmentHeight +
      replyHeight +
      forwardedHeight +
      reactionHeight +
      linkPreviewHeight,
  );
}

export function estimateHistoryLogicalRowHeight(
  messages: Message[],
  density: Density,
): number {
  const baseline = ESTIMATED_MESSAGE_ROW_HEIGHT[density];
  if (messages.length === 0) {
    return baseline;
  }

  const sample = messages.slice(-40);
  const estimatedTotal = sample.reduce((total, message) => (
    total + estimateMessageRowHeight(message, density)
  ), 0);

  return Math.round(Math.max(baseline, estimatedTotal / sample.length));
}
