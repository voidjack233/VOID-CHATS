import { fetchWithAuth } from '../Auth/authServiceApi';
import type { LinkPreviewMetadata } from './chatTypes';

const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;

function splitTrailingPunctuation(value: string) {
  let core = value;

  while (core.length > 0) {
    const lastChar = core.slice(-1);
    if (/[.,!?;:]/.test(lastChar)) {
      core = core.slice(0, -1);
      continue;
    }

    if (/[)\]}]/.test(lastChar)) {
      const opener = lastChar === ')' ? '(' : lastChar === ']' ? '[' : '{';
      const openerCount = core.split(opener).length - 1;
      const closerCount = core.split(lastChar).length - 1;
      if (closerCount > openerCount) {
        core = core.slice(0, -1);
        continue;
      }
    }

    break;
  }

  return core;
}

function normalizePreviewUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function getFirstPreviewableUrl(text: string): string | null {
  if (!text || text.includes('```')) {
    return null;
  }

  for (const match of text.matchAll(URL_REGEX)) {
    const rawValue = match[0];
    if (!rawValue) continue;

    const normalized = normalizePreviewUrl(splitTrailingPunctuation(rawValue));
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeLinkPreview(value: unknown): LinkPreviewMetadata | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const url = typeof candidate.url === 'string' ? normalizePreviewUrl(candidate.url) : null;
  if (!url) {
    return null;
  }

  const preview: LinkPreviewMetadata = {
    url,
    title: typeof candidate.title === 'string' ? candidate.title : null,
    description: typeof candidate.description === 'string' ? candidate.description : null,
    image: typeof candidate.image === 'string' ? normalizePreviewUrl(candidate.image) : null,
    site_name: typeof candidate.site_name === 'string' ? candidate.site_name : null,
    favicon: typeof candidate.favicon === 'string' ? normalizePreviewUrl(candidate.favicon) : null,
  };

  return preview.title || preview.description || preview.image ? preview : null;
}

export async function fetchLinkPreview(
  url: string,
  signal?: AbortSignal,
): Promise<LinkPreviewMetadata | null> {
  const normalizedUrl = normalizePreviewUrl(url);
  if (!normalizedUrl) {
    return null;
  }

  const response = await fetchWithAuth(
    `/api/link-preview?url=${encodeURIComponent(normalizedUrl)}`,
    { signal },
  );
  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.success) {
    return null;
  }

  return normalizeLinkPreview(data.preview);
}
