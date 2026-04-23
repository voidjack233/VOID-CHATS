import type {
  ForwardedMessageMetadata,
  Message,
  MessageMentionMetadata,
} from './chatTypes';
import { parseAttachments, serializeAttachments } from './messageAttachments';

const MESSAGE_ENVELOPE_MARKER = 'void_message_envelope';
const MESSAGE_ENVELOPE_VERSION = 1;

interface MessageEnvelope {
  __void_envelope: typeof MESSAGE_ENVELOPE_MARKER;
  version: typeof MESSAGE_ENVELOPE_VERSION;
  text?: string;
  attachments?: ReturnType<typeof parseAttachments>;
  forwarded?: ForwardedMessageMetadata;
  mentions?: MessageMentionMetadata[];
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

function normalizeForwardedMetadata(value: unknown): ForwardedMessageMetadata | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const normalized: ForwardedMessageMetadata = {};

  if (typeof candidate.original_message_id === 'string' && candidate.original_message_id.length > 0) {
    normalized.original_message_id = candidate.original_message_id;
  }

  if (typeof candidate.original_sender_id === 'string' && candidate.original_sender_id.length > 0) {
    normalized.original_sender_id = candidate.original_sender_id;
  }

  if (typeof candidate.original_sender_name === 'string' && candidate.original_sender_name.length > 0) {
    normalized.original_sender_name = candidate.original_sender_name;
  }

  if (
    typeof candidate.original_conversation_id === 'string' &&
    candidate.original_conversation_id.length > 0
  ) {
    normalized.original_conversation_id = candidate.original_conversation_id;
  }

  if (
    typeof candidate.original_conversation_name === 'string' &&
    candidate.original_conversation_name.length > 0
  ) {
    normalized.original_conversation_name = candidate.original_conversation_name;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeMentionMetadata(value: unknown): MessageMentionMetadata[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const mentions = new Map<string, MessageMentionMetadata>();

  value.forEach((entry) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }

    const candidate = entry as Record<string, unknown>;
    const userId = typeof candidate.user_id === 'string' ? candidate.user_id.trim() : '';
    const username = typeof candidate.username === 'string' ? candidate.username.trim() : '';
    if (!userId || !username) {
      return;
    }

    mentions.set(userId, {
      user_id: userId,
      username,
    });
  });

  return mentions.size > 0 ? Array.from(mentions.values()) : undefined;
}

export function buildEncryptedMessagePayload(
  text: string,
  secureAttachments?: string[],
  options?: {
    forwarded?: ForwardedMessageMetadata | null;
    mentions?: MessageMentionMetadata[] | null;
  },
): string {
  const forwarded = normalizeForwardedMetadata(options?.forwarded);
  const mentions = normalizeMentionMetadata(options?.mentions);

  if ((!secureAttachments || secureAttachments.length === 0) && !forwarded && !mentions) {
    return text;
  }

  return JSON.stringify({
    __void_envelope: MESSAGE_ENVELOPE_MARKER,
    version: MESSAGE_ENVELOPE_VERSION,
    text,
    attachments: parseAttachments(secureAttachments),
    forwarded,
    mentions,
  } satisfies MessageEnvelope);
}

export function resolveDecryptedMessagePayload(
  decryptedContent: string,
  fallbackAttachments?: string[],
): Pick<Message, 'content' | 'attachments' | 'forwarded' | 'mentions'> {
  const envelope = parseEnvelope(decryptedContent);
  if (!envelope) {
    return {
      content: decryptedContent,
      attachments: fallbackAttachments,
      forwarded: undefined,
      mentions: undefined,
    };
  }

  return {
    content: normalizeEnvelopeText(envelope.text),
    attachments: serializeAttachments(envelope.attachments || []),
    forwarded: normalizeForwardedMetadata(envelope.forwarded),
    mentions: normalizeMentionMetadata(envelope.mentions),
  };
}

export function applyEncryptedMessageEnvelope<
  T extends Pick<Message, 'content' | 'attachments' | 'forwarded' | 'mentions'>
>(
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
