import type { Attachment } from './chatTypes';

export function parseAttachment(raw: string): Attachment {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.url === 'string') {
      return parsed as Attachment;
    }
  } catch {
    // Fall back to the raw URL format.
  }

  return { url: raw };
}

export function parseAttachments(raws?: string[]): Attachment[] {
  return (raws || []).map(parseAttachment);
}

export function serializeAttachment(attachment: Attachment): string {
  const normalizedEntries = Object.entries(attachment).filter(([, value]) => value !== undefined);
  if (normalizedEntries.length === 1 && typeof attachment.url === 'string') {
    return attachment.url;
  }

  return JSON.stringify(attachment);
}

export function serializeAttachments(attachments: Attachment[]): string[] {
  return attachments.map(serializeAttachment);
}
