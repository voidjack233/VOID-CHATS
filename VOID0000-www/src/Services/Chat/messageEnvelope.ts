import type { Message } from './chatTypes';
import { parseAttachments, serializeAttachments } from './messageAttachments';

const MESSAGE_ENVELOPE_MARKER = 'void_message_envelope';
const MESSAGE_ENVELOPE_VERSION = 1;

interface MessageEnvelope {
  __void_envelope: typeof MESSAGE_ENVELOPE_MARKER;
  version: typeof MESSAGE_ENVELOPE_VERSION;
  text?: string;
  attachments?: ReturnType<typeof parseAttachments>;
}

function parseEnvelope(value: string): MessageEnvelope | null {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.__void_envelope === MESSAGE_ENVELOPE_MARKER &&
      parsed.version === MESSAGE_ENVELOPE_VERSION
    ) {
      return parsed as MessageEnvelope;
    }
  } catch {
    // Plaintext messages are not JSON envelopes.
  }

  return null;
}

function normalizeEnvelopeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > 0 ? value : undefined;
}

export function buildEncryptedMessagePayload(
  text: string,
  secureAttachments?: string[],
): string {
  if (!secureAttachments || secureAttachments.length === 0) {
    return text;
  }

  return JSON.stringify({
    __void_envelope: MESSAGE_ENVELOPE_MARKER,
    version: MESSAGE_ENVELOPE_VERSION,
    text,
    attachments: parseAttachments(secureAttachments),
  } satisfies MessageEnvelope);
}

export function resolveDecryptedMessagePayload(
  decryptedContent: string,
  fallbackAttachments?: string[],
): Pick<Message, 'content' | 'attachments'> {
  const envelope = parseEnvelope(decryptedContent);
  if (!envelope) {
    return {
      content: decryptedContent,
      attachments: fallbackAttachments,
    };
  }

  return {
    content: normalizeEnvelopeText(envelope.text),
    attachments: serializeAttachments(envelope.attachments || []),
  };
}

export function applyEncryptedMessageEnvelope<T extends Pick<Message, 'content' | 'attachments'>>(
  message: T,
): T {
  if (typeof message.content !== 'string') {
    return message;
  }

  return {
    ...message,
    ...resolveDecryptedMessagePayload(message.content, message.attachments),
  };
}
