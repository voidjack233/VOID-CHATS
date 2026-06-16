import { Check, Copy } from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MESSAGE_MENTION_PATTERN } from '../../../Services/Chat/messageMentions';
import { extractMessageTextSegments } from './messageLinks';

type FormatNode =
  | { type: 'text'; value: string }
  | { type: 'bold' | 'italic' | 'strike' | 'spoiler'; raw: string; children: FormatNode[] };

interface FormattedMessageTextProps {
  content: string;
  linkClassName: string;
  onOpenLink?: (url: string) => void;
  onSpoilerVisibilityChange?: (
    spoilerId: string,
    content: string,
    revealed: boolean,
  ) => void;
  interactiveSpoilers?: boolean;
  codeBlockVariant?: 'message' | 'composer';
  authoringMode?: boolean;
  enableMentions?: boolean;
  mentionUsernames?: string[];
}

type ContentBlock =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string; language?: string };

const SUPPORTED_CODE_FENCE_LANGUAGES = new Set([
  'bash',
  'c',
  'cpp',
  'cs',
  'css',
  'dart',
  'diff',
  'dockerfile',
  'elixir',
  'env',
  'erlang',
  'go',
  'html',
  'ini',
  'java',
  'javascript',
  'js',
  'json',
  'jsx',
  'kotlin',
  'lua',
  'makefile',
  'markdown',
  'md',
  'php',
  'plaintext',
  'py',
  'python',
  'rb',
  'rs',
  'ruby',
  'rust',
  'scala',
  'sh',
  'shell',
  'sql',
  'swift',
  'text',
  'toml',
  'ts',
  'tsx',
  'typescript',
  'txt',
  'xml',
  'yaml',
  'yml',
]);

const MARKERS: Array<{ delimiter: string; type: Exclude<FormatNode['type'], 'text'> }> = [
  { delimiter: '||', type: 'spoiler' },
  { delimiter: '**', type: 'bold' },
  { delimiter: '~~', type: 'strike' },
  { delimiter: '*', type: 'italic' },
];
function isMarkerAt(text: string, index: number, delimiter: string): boolean {
  if (!text.startsWith(delimiter, index)) {
    return false;
  }

  if (delimiter === '*') {
    return !text.startsWith('**', index);
  }

  return true;
}

function findNextMarker(text: string, fromIndex: number) {
  for (let index = fromIndex; index < text.length; index += 1) {
    for (const marker of MARKERS) {
      if (isMarkerAt(text, index, marker.delimiter)) {
        return { index, ...marker };
      }
    }
  }

  return null;
}

function findClosingMarker(text: string, delimiter: string, fromIndex: number): number {
  let searchIndex = fromIndex;

  while (searchIndex < text.length) {
    const nextIndex = text.indexOf(delimiter, searchIndex);
    if (nextIndex === -1) {
      return -1;
    }

    if (delimiter !== '*' || !text.startsWith('**', nextIndex)) {
      const inner = text.slice(fromIndex, nextIndex);
      if (inner.length > 0 && inner.trim().length > 0) {
        return nextIndex;
      }
    }

    searchIndex = nextIndex + delimiter.length;
  }

  return -1;
}

function parseFormattedNodes(text: string): FormatNode[] {
  const nodes: FormatNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const marker = findNextMarker(text, cursor);
    if (!marker) {
      nodes.push({ type: 'text', value: text.slice(cursor) });
      break;
    }

    if (marker.index > cursor) {
      nodes.push({ type: 'text', value: text.slice(cursor, marker.index) });
    }

    const contentStart = marker.index + marker.delimiter.length;
    const closingIndex = findClosingMarker(text, marker.delimiter, contentStart);

    if (closingIndex === -1) {
      nodes.push({ type: 'text', value: marker.delimiter });
      cursor = contentStart;
      continue;
    }

    const inner = text.slice(contentStart, closingIndex);
    nodes.push({
      type: marker.type,
      raw: inner,
      children: parseFormattedNodes(inner),
    });
    cursor = closingIndex + marker.delimiter.length;
  }

  if (nodes.length === 0) {
    nodes.push({ type: 'text', value: text });
  }

  return nodes;
}

function parseContentBlocks(content: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let cursor = 0;
  let textStart = 0;
  let insideSpoiler = false;

  while (cursor < content.length) {
    if (content.startsWith('||', cursor)) {
      insideSpoiler = !insideSpoiler;
      cursor += 2;
      continue;
    }

    if (!insideSpoiler && content.startsWith('```', cursor)) {
      if (cursor > textStart) {
        blocks.push({ type: 'text', value: content.slice(textStart, cursor) });
      }

      const contentStart = cursor + 3;
      const end = content.indexOf('```', contentStart);

      if (end === -1) {
        blocks.push({ type: 'text', value: content.slice(cursor) });
        cursor = content.length;
        textStart = cursor;
        break;
      }

      const rawBody = content.slice(contentStart, end);
    const firstNewlineIndex = rawBody.indexOf('\n');
    const firstLine = firstNewlineIndex === -1 ? rawBody : rawBody.slice(0, firstNewlineIndex);
    const normalizedFenceLabel = firstLine.trim().toLowerCase();
    const hasSupportedFenceLabel =
      firstNewlineIndex !== -1 &&
      normalizedFenceLabel.length > 0 &&
      SUPPORTED_CODE_FENCE_LANGUAGES.has(normalizedFenceLabel);

    const rawCode = hasSupportedFenceLabel
      ? rawBody.slice(firstNewlineIndex + 1)
      : rawBody.startsWith('\n')
        ? rawBody.slice(1)
        : rawBody;

      blocks.push({
        type: 'code',
        value: rawCode.replace(/\n$/, ''),
        language: hasSupportedFenceLabel ? firstLine.trim() : undefined,
      });

      cursor = end + 3;
      textStart = cursor;
      continue;
    }

    cursor += 1;
  }

  if (textStart < content.length) {
    blocks.push({ type: 'text', value: content.slice(textStart) });
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'text', value: content });
  }

  return blocks;
}

function SpoilerText({
  children,
  spoilerId,
  rawContent,
  onVisibilityChange,
  interactive = true,
  authoringMode = false,
  block = false,
}: {
  children: ReactNode;
  spoilerId: string;
  rawContent: string;
  onVisibilityChange?: (spoilerId: string, content: string, revealed: boolean) => void;
  interactive?: boolean;
  authoringMode?: boolean;
  block?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const revealedRef = useRef(false);
  const hiddenContentClassName = 'pointer-events-none select-none opacity-0';
  const toggleRevealed = useCallback(() => {
    const nextRevealed = !revealedRef.current;
    revealedRef.current = nextRevealed;
    setRevealed(nextRevealed);
    onVisibilityChange?.(spoilerId, rawContent, nextRevealed);
  }, [onVisibilityChange, rawContent, spoilerId]);
  const handleClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (revealed && target.closest('a, button')) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    toggleRevealed();
  }, [revealed, toggleRevealed]);
  const handleHiddenTouchStart = useCallback((event: React.TouchEvent<HTMLElement>) => {
    if (revealed) return;
    event.preventDefault();
    event.stopPropagation();
  }, [revealed]);
  const handleHiddenTouchEnd = useCallback((event: React.TouchEvent<HTMLElement>) => {
    if (revealed) return;
    event.preventDefault();
    event.stopPropagation();
    toggleRevealed();
  }, [revealed, toggleRevealed]);

  if (block) {
    if (!interactive) {
      return (
        <div
          className={`my-1 block max-w-full overflow-hidden rounded-lg ${
            authoringMode ? 'bg-black/15 text-inherit' : 'bg-black/35'
          }`}
        >
          <div className={authoringMode ? '' : hiddenContentClassName}>
            {children}
          </div>
        </div>
      );
    }

    return (
      <div
        role="button"
        tabIndex={0}
        data-allow-message-gesture="true"
        onClick={handleClick}
        onTouchStart={handleHiddenTouchStart}
        onTouchEnd={handleHiddenTouchEnd}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            toggleRevealed();
          }
        }}
        className={`my-1 block max-w-full touch-manipulation overflow-hidden rounded-lg transition-colors ${
          revealed
            ? 'bg-black/10'
            : 'bg-black/35 hover:bg-black/45'
        }`}
        aria-label={revealed ? 'Hide spoiler' : 'Reveal spoiler'}
        title={revealed ? 'Hide spoiler' : 'Reveal spoiler'}
      >
        <div className={revealed ? '' : hiddenContentClassName}>
          {children}
        </div>
      </div>
    );
  }

  if (!interactive) {
    return (
      <span
        className={`inline rounded align-baseline ${
          authoringMode
            ? 'bg-black/25 text-inherit'
            : 'bg-black/35 text-transparent select-none'
        } ${authoringMode ? '' : 'px-1 py-0.5'}`}
      >
        {children}
      </span>
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      data-allow-message-gesture="true"
      onClick={handleClick}
      onTouchStart={handleHiddenTouchStart}
      onTouchEnd={handleHiddenTouchEnd}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          toggleRevealed();
        }
      }}
      className={`inline touch-manipulation rounded px-1 py-0.5 align-baseline transition-colors ${
        revealed
          ? 'bg-black/10 text-inherit'
          : 'bg-black/35 text-transparent hover:bg-black/45'
      }`}
      aria-label={revealed ? 'Hide spoiler' : 'Reveal spoiler'}
      title={revealed ? 'Hide spoiler' : 'Reveal spoiler'}
    >
      <span className={revealed ? '' : hiddenContentClassName}>{children}</span>
    </span>
  );
}

function renderLeafText(
  value: string,
  keyPrefix: string,
  linkClassName: string,
  onOpenLink?: (url: string) => void,
  enableMentions: boolean = false,
  mentionUsernames?: string[],
  authoringMode: boolean = false,
): ReactNode[] {
  const normalizedMentionUsernames = new Set(
    (mentionUsernames || []).map((username) => username.toLowerCase()),
  );

  const renderMentionAwarePart = (part: string, partKey: string): ReactNode => {
    const shouldUseMentionHighlighting = enableMentions || normalizedMentionUsernames.size > 0;
    if (!shouldUseMentionHighlighting) {
      return <Fragment key={partKey}>{part}</Fragment>;
    }

    const nodes: ReactNode[] = [];
    let cursor = 0;

    for (const match of part.matchAll(MESSAGE_MENTION_PATTERN)) {
      const token = match[0];
      const username = match[1];
      const start = match.index ?? -1;
      if (start < 0 || !username) continue;

      const previousChar = start > 0 ? part[start - 1] : '';
      if (previousChar && /[A-Za-z0-9._-]/.test(previousChar)) {
        continue;
      }

      if (normalizedMentionUsernames.size > 0 && !normalizedMentionUsernames.has(username.toLowerCase())) {
        continue;
      }

      if (start > cursor) {
        nodes.push(part.slice(cursor, start));
      }

      nodes.push(
        <span
          key={`${partKey}-mention-${start}`}
          className={
            authoringMode
              ? 'rounded-sm bg-void-accent/14 text-current'
              : 'rounded-md bg-void-accent/14 px-1 py-[1px] font-semibold text-current'
          }
        >
          {token}
        </span>,
      );
      cursor = start + token.length;
    }

    if (nodes.length === 0) {
      return <Fragment key={partKey}>{part}</Fragment>;
    }

    if (cursor < part.length) {
      nodes.push(part.slice(cursor));
    }

    return <Fragment key={partKey}>{nodes}</Fragment>;
  };

  return extractMessageTextSegments(value).flatMap((segment, index) => {
    const segmentParts = segment.value.split('\n');

    const withLineBreaks = (renderPart: (part: string, partIndex: number) => ReactNode) =>
      segmentParts.flatMap((part, partIndex) => {
        const nodes: ReactNode[] = [renderPart(part, partIndex)];

        if (partIndex < segmentParts.length - 1) {
          nodes.push(<br key={`${keyPrefix}-break-${index}-${partIndex}`} />);
        }

        return nodes;
      });

    if (segment.type === 'text') {
      return withLineBreaks((part, partIndex) =>
        renderMentionAwarePart(part, `${keyPrefix}-text-${index}-${partIndex}`),
      );
    }

    if (!onOpenLink) {
      return withLineBreaks((part, partIndex) => (
        <span
          key={`${keyPrefix}-link-${index}-${partIndex}`}
          className={`${linkClassName} inline text-left align-baseline`}
          title={segment.url}
        >
          {part}
        </span>
      ));
    }

    return withLineBreaks((part, partIndex) => (
      <a
        key={`${keyPrefix}-link-${index}-${partIndex}`}
        href={segment.url}
        onClick={(event) => {
          event.preventDefault();
          onOpenLink(segment.url);
        }}
        className={`${linkClassName} inline cursor-pointer text-left align-baseline`}
        title={segment.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        {part}
      </a>
    ));
  });
}

function renderNodes(
  nodes: FormatNode[],
  keyPrefix: string,
  linkClassName: string,
  onOpenLink?: (url: string) => void,
  interactiveSpoilers: boolean = true,
  authoringMode: boolean = false,
  onSpoilerVisibilityChange?: (
    spoilerId: string,
    content: string,
    revealed: boolean,
  ) => void,
  renderNestedSpoilerContent?: (content: string, key: string) => ReactNode,
  enableMentions: boolean = false,
  mentionUsernames?: string[],
): ReactNode[] {
  return nodes.map((node, index) => {
    const nodeKey = `${keyPrefix}-${index}`;

    if (node.type === 'text') {
      return (
        <Fragment key={nodeKey}>
          {renderLeafText(
            node.value,
            nodeKey,
            linkClassName,
            onOpenLink,
            enableMentions,
            mentionUsernames,
            authoringMode,
          )}
        </Fragment>
      );
    }

    const children = renderNodes(
      node.children,
      `${nodeKey}-child`,
      linkClassName,
      onOpenLink,
      interactiveSpoilers,
      authoringMode,
      onSpoilerVisibilityChange,
      renderNestedSpoilerContent,
      enableMentions,
      mentionUsernames,
    );
    const delimiter = node.type === 'bold'
      ? '**'
      : node.type === 'italic'
        ? '*'
        : node.type === 'strike'
          ? '~~'
          : '||';
    const wrappedChildren = (
      <>
        {authoringMode ? (
          <span className="select-none text-current/45">{delimiter}</span>
        ) : null}
        {children}
        {authoringMode ? (
          <span className="select-none text-current/45">{delimiter}</span>
        ) : null}
      </>
    );

    if (node.type === 'bold') {
      return <strong key={nodeKey} className="font-semibold">{wrappedChildren}</strong>;
    }

    if (node.type === 'italic') {
      return <em key={nodeKey} className="italic">{wrappedChildren}</em>;
    }

    if (node.type === 'strike') {
      return <span key={nodeKey} className="line-through opacity-85">{wrappedChildren}</span>;
    }

    const shouldRenderNestedSpoilerContent =
      node.type === 'spoiler' &&
      Boolean(renderNestedSpoilerContent) &&
      node.raw.trim().startsWith('```') &&
      node.raw.trim().endsWith('```');

    return (
      <SpoilerText
        key={nodeKey}
        spoilerId={nodeKey}
        rawContent={node.raw}
        onVisibilityChange={onSpoilerVisibilityChange}
        interactive={interactiveSpoilers}
        authoringMode={authoringMode}
        block={shouldRenderNestedSpoilerContent}
      >
        {shouldRenderNestedSpoilerContent
          ? renderNestedSpoilerContent?.(node.raw, `${nodeKey}-spoiler`)
          : wrappedChildren}
      </SpoilerText>
    );
  });
}

function renderAuthoringCodeBlock(
  block: Extract<ContentBlock, { type: 'code' }>,
  key: string,
): ReactNode {
  const openingFence = `\`\`\`${block.language || ''}`;
  const codeLines = block.value.split('\n');

  return (
    <Fragment key={key}>
      <span className="select-none text-current/45">{openingFence}</span>
      <br />
      {codeLines.length > 0 && codeLines[0] !== ''
        ? codeLines.map((line, index) => (
            <Fragment key={`${key}-code-${index}`}>
              {line}
              <br />
            </Fragment>
          ))
        : null}
      <span className="select-none text-current/45">```</span>
    </Fragment>
  );
}

const FormattedMessageText = memo(function FormattedMessageText({
  content,
  linkClassName,
  onOpenLink,
  onSpoilerVisibilityChange,
  interactiveSpoilers = true,
  codeBlockVariant = 'message',
  authoringMode = false,
  enableMentions = false,
  mentionUsernames,
}: FormattedMessageTextProps) {
  const blocks = useMemo(() => parseContentBlocks(content), [content]);
  const [copiedBlockKey, setCopiedBlockKey] = useState<string | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const nestedContentClassName = codeBlockVariant === 'composer'
    ? linkClassName
    : `${linkClassName} break-all`;

  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
  }, []);

  const handleCopyCodeBlock = useCallback(async (blockKey: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedBlockKey(blockKey);

      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }

      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedBlockKey((current) => (current === blockKey ? null : current));
      }, 1800);
    } catch (error) {
      console.error('Failed to copy code block:', error);
    }
  }, []);

  const renderNestedSpoilerContent = useCallback((nestedContent: string, key: string) => (
    <FormattedMessageText
      key={key}
      content={nestedContent}
      linkClassName={nestedContentClassName}
      onOpenLink={onOpenLink}
      onSpoilerVisibilityChange={onSpoilerVisibilityChange}
      interactiveSpoilers={interactiveSpoilers}
      codeBlockVariant={codeBlockVariant}
      authoringMode={authoringMode}
      enableMentions={enableMentions}
      mentionUsernames={mentionUsernames}
    />
  ), [
    authoringMode,
    codeBlockVariant,
    enableMentions,
    interactiveSpoilers,
    mentionUsernames,
    nestedContentClassName,
    onOpenLink,
    onSpoilerVisibilityChange,
  ]);

  return (
    <>
      {blocks.map((block, blockIndex) => {
        if (block.type === 'code') {
          if (authoringMode) {
            return renderAuthoringCodeBlock(block, `block-${blockIndex}`);
          }

          const openingFence = `\`\`\`${block.language || ''}`;
          const closingFence = '```';
          const blockKey = `block-${blockIndex}`;
          const copyLabel = copiedBlockKey === blockKey ? 'Copied' : 'Copy';
          const HeaderIcon = copiedBlockKey === blockKey ? Check : Copy;

          return (
            <div
              key={blockKey}
              className={`${blockIndex > 0 ? 'mt-2' : ''} w-full min-w-0 max-w-full`}
            >
              <div
                className={
                  codeBlockVariant === 'composer'
                    ? 'w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-black/10 bg-black/15'
                    : 'w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-black/10 bg-black/20'
                }
              >
                {authoringMode ? (
                  <div className="border-b border-black/10 px-2 py-1 font-mono text-[11px] text-current/55">
                    {openingFence}
                  </div>
                ) : (
                  <div
                    data-allow-message-gesture="true"
                    className="sticky top-0 z-[1] flex items-center justify-between gap-2 border-b border-black/10 bg-inherit px-3 py-1.5"
                  >
                    <span
                      data-allow-message-gesture="true"
                      className="min-w-0 truncate font-mono text-[10px] tracking-[0.08em] text-current/60"
                    >
                      {block.language || 'code'}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleCopyCodeBlock(blockKey, block.value)}
                      className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-black/10 bg-black/10 px-2 py-1 font-medium text-current/70 transition-colors hover:bg-black/15 hover:text-current focus:outline-none focus:ring-2 focus:ring-black/15"
                      aria-label={copyLabel}
                      title={copyLabel}
                    >
                      <HeaderIcon className="h-3.5 w-3.5" />
                      <span className="text-[11px]">{copyLabel}</span>
                    </button>
                  </div>
                )}
                <pre
                  data-code-block-scroll-zone="true"
                  className={
                    codeBlockVariant === 'composer'
                      ? 'w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain px-2 py-1.5 text-[0.92em] leading-relaxed text-inherit'
                      : 'w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain px-3 py-2.5 text-[0.92em] leading-relaxed text-inherit'
                  }
                  style={{
                    WebkitOverflowScrolling: 'touch',
                  }}
                >
                  <code className="block w-max min-w-full whitespace-pre font-mono">{block.value}</code>
                </pre>
                {authoringMode ? (
                  <div className="border-t border-black/10 px-2 py-1 font-mono text-[11px] text-current/55">
                    {closingFence}
                  </div>
                ) : null}
              </div>
            </div>
          );
        }

        const nodes = parseFormattedNodes(block.value);
        return (
          <Fragment key={`block-${blockIndex}`}>
            {blocks.length > 1 && blockIndex > 0 ? <br /> : null}
            {renderNodes(
              nodes,
              `block-${blockIndex}`,
              linkClassName,
              onOpenLink,
              interactiveSpoilers,
              authoringMode,
              onSpoilerVisibilityChange,
              renderNestedSpoilerContent,
              enableMentions,
              mentionUsernames,
            )}
          </Fragment>
        );
      })}
    </>
  );
});

export default FormattedMessageText;
