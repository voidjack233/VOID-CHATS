import { Fragment, memo, useMemo } from 'react';
import type { ReactNode } from 'react';

type PreviewSegment =
  | { type: 'text'; value: string }
  | { type: 'spoiler' };

const SPOILER_PLACEHOLDER_WEIGHT = 8;
const SPOILER_CHIP_WIDTH_CLASS = 'w-[5.5ch]';
const BOLD_PATTERN = /\*\*([\s\S]*?)\*\*/g;
const ITALIC_PATTERN = /\*([\s\S]*?)\*/g;
const STRIKE_PATTERN = /~~([\s\S]*?)~~/g;

function stripInlineFormatting(text: string): string {
  return text
    .replace(BOLD_PATTERN, '$1')
    .replace(ITALIC_PATTERN, '$1')
    .replace(STRIKE_PATTERN, '$1')
    .replace(/\s+/g, ' ');
}

function tokenizePreviewSegments(content: string): PreviewSegment[] {
  const segments: PreviewSegment[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const nextSpoiler = content.indexOf('||', cursor);
    const nextCodeFence = content.indexOf('```', cursor);
    const nextIndexCandidates = [nextSpoiler, nextCodeFence].filter((value) => value !== -1);
    const nextIndex = nextIndexCandidates.length > 0 ? Math.min(...nextIndexCandidates) : -1;

    if (nextIndex === -1) {
      const trailing = stripInlineFormatting(content.slice(cursor)).trim();
      if (trailing) {
        segments.push({ type: 'text', value: trailing });
      }
      break;
    }

    if (nextIndex > cursor) {
      const leading = stripInlineFormatting(content.slice(cursor, nextIndex)).trim();
      if (leading) {
        segments.push({ type: 'text', value: leading });
      }
    }

    if (nextIndex === nextCodeFence) {
      const fenceEnd = content.indexOf('```', nextIndex + 3);
      if (fenceEnd === -1) {
        const remainder = stripInlineFormatting(content.slice(nextIndex)).trim();
        if (remainder) {
          segments.push({ type: 'text', value: remainder });
        }
        break;
      }

      segments.push({ type: 'text', value: '[code block]' });
      cursor = fenceEnd + 3;
      continue;
    }

    const spoilerEnd = content.indexOf('||', nextIndex + 2);
    if (spoilerEnd === -1) {
      const remainder = stripInlineFormatting(content.slice(nextIndex)).trim();
      if (remainder) {
        segments.push({ type: 'text', value: remainder });
      }
      break;
    }

    segments.push({ type: 'spoiler' });
    cursor = spoilerEnd + 2;
  }

  return segments;
}

function clipPreviewSegments(segments: PreviewSegment[], maxLength: number): Array<PreviewSegment | { type: 'ellipsis' }> {
  const clipped: Array<PreviewSegment | { type: 'ellipsis' }> = [];
  let remaining = maxLength;

  for (const segment of segments) {
    if (remaining <= 0) {
      clipped.push({ type: 'ellipsis' });
      break;
    }

    if (segment.type === 'spoiler') {
      clipped.push(segment);
      remaining -= SPOILER_PLACEHOLDER_WEIGHT;
      continue;
    }

    if (segment.value.length <= remaining) {
      clipped.push(segment);
      remaining -= segment.value.length;
      continue;
    }

    clipped.push({
      type: 'text',
      value: segment.value.slice(0, Math.max(0, remaining)),
    });
    clipped.push({ type: 'ellipsis' });
    break;
  }

  return clipped;
}

interface MessagePreviewTextProps {
  content?: string | null;
  maxLength?: number;
  fallback?: string;
}

const MessagePreviewText = memo(function MessagePreviewText({
  content,
  maxLength = 60,
  fallback = 'Message unavailable',
}: MessagePreviewTextProps) {
  const clippedSegments = useMemo(() => {
    if (typeof content !== 'string' || content.trim().length === 0) {
      return null;
    }

    const segments = tokenizePreviewSegments(content);
    if (segments.length === 0) {
      return null;
    }

    return clipPreviewSegments(segments, maxLength);
  }, [content, maxLength]);

  if (!clippedSegments) {
    return <>{fallback}</>;
  }

  return (
    <>
      {clippedSegments.map((segment, index): ReactNode => {
        if (segment.type === 'ellipsis') {
          return <Fragment key={`ellipsis-${index}`}>...</Fragment>;
        }

        if (segment.type === 'spoiler') {
          return (
            <span
              key={`spoiler-${index}`}
              aria-label="spoiler"
              className={`mx-0.5 inline-block h-[0.95em] ${SPOILER_CHIP_WIDTH_CLASS} rounded bg-current/30 align-[-0.08em]`}
            />
          );
        }

        return <Fragment key={`text-${index}`}>{segment.value}</Fragment>;
      })}
    </>
  );
});

export default MessagePreviewText;
