export type MessageTextSegment =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; url: string };

const URL_REGEX = /https?:\/\/[^\s<>"'|]+/gi;
const TRUSTED_ROOT_HOSTS = ['void0000.online'];

const normalizeHostname = (hostname: string) => hostname.trim().toLowerCase().replace(/^www\./, '');

const matchesTrustedHost = (hostname: string, trustedHost: string) => (
  hostname === trustedHost || hostname.endsWith(`.${trustedHost}`)
);

const splitTrailingPunctuation = (value: string) => {
  let core = value;
  let trailing = '';

  while (core.length > 0) {
    const lastChar = core.slice(-1);

    if (/[.,!?;:]/.test(lastChar)) {
      trailing = lastChar + trailing;
      core = core.slice(0, -1);
      continue;
    }

    if (/[)\]}]/.test(lastChar)) {
      const opener = lastChar === ')' ? '(' : lastChar === ']' ? '[' : '{';
      const openerCount = core.split(opener).length - 1;
      const closerCount = core.split(lastChar).length - 1;

      if (closerCount > openerCount) {
        trailing = lastChar + trailing;
        core = core.slice(0, -1);
        continue;
      }
    }

    break;
  }

  return { core, trailing };
};

export const parseHttpUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const getMessageLinkHostname = (value: string) => {
  const parsed = parseHttpUrl(value);
  if (!parsed) return null;
  return normalizeHostname(parsed.hostname);
};

export const getInviteCodeFromMessageUrl = (value: string) => {
  const parsed = parseHttpUrl(value);
  if (!parsed || !isTrustedMessageUrl(value)) return null;

  const match = parsed.pathname.match(/^\/invite\/([^/?#]+)/i);
  if (!match?.[1]) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

export const isTrustedMessageUrl = (value: string) => {
  const parsed = parseHttpUrl(value);
  if (!parsed) return false;

  const hostname = normalizeHostname(parsed.hostname);
  if (TRUSTED_ROOT_HOSTS.some((trustedHost) => matchesTrustedHost(hostname, trustedHost))) {
    return true;
  }

  if (typeof window !== 'undefined') {
    const currentHost = normalizeHostname(window.location.hostname);
    if (hostname === currentHost) {
      return true;
    }
  }

  return false;
};

export const extractMessageTextSegments = (text: string): MessageTextSegment[] => {
  const segments: MessageTextSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(URL_REGEX)) {
    const rawValue = match[0];
    if (!rawValue) continue;

    const start = match.index ?? cursor;
    if (start > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, start) });
    }

    const { core, trailing } = splitTrailingPunctuation(rawValue);
    const parsed = parseHttpUrl(core);

    if (parsed) {
      segments.push({
        type: 'link',
        value: core,
        url: parsed.toString(),
      });
    } else {
      segments.push({ type: 'text', value: rawValue });
    }

    if (trailing) {
      segments.push({ type: 'text', value: trailing });
    }

    cursor = start + rawValue.length;
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', value: text });
  }

  return segments;
};

export const messageTextContainsUrl = (text: string, targetUrl: string): boolean => {
  const normalizedTargetUrl = parseHttpUrl(targetUrl)?.toString();
  if (!normalizedTargetUrl) {
    return false;
  }

  return extractMessageTextSegments(text).some((segment) => (
    segment.type === 'link' &&
    parseHttpUrl(segment.url)?.toString() === normalizedTargetUrl
  ));
};

export const isMessageUrlInsideSpoiler = (text: string, targetUrl: string): boolean => {
  if (!parseHttpUrl(targetUrl)) {
    return false;
  }

  let cursor = 0;
  while (cursor < text.length) {
    const spoilerStart = text.indexOf('||', cursor);
    if (spoilerStart === -1) {
      return false;
    }

    const contentStart = spoilerStart + 2;
    const spoilerEnd = text.indexOf('||', contentStart);
    if (spoilerEnd === -1) {
      return false;
    }

    const spoilerContent = text.slice(contentStart, spoilerEnd);
    if (messageTextContainsUrl(spoilerContent, targetUrl)) {
      return true;
    }

    cursor = spoilerEnd + 2;
  }

  return false;
};
