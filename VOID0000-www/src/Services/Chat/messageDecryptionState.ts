type MessageDecryptionStateLike = {
  content?: string | null;
  decryption_failed?: boolean;
  is_deleted?: boolean;
  attachments?: string[] | null;
  message_type?: string | null;
  protocol?: string | null;
  encrypted_content?: string | null;
  iv?: string | null;
};

export const ENCRYPTED_PLACEHOLDER_CONTENTS = new Set([
  '[unable to decrypt]',
  '[encrypted]',
]);

export function normalizeMessageText(value?: string | null): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

function hasAttachments(attachments?: string[] | null): boolean {
  return Array.isArray(attachments) && attachments.length > 0;
}

function hasEncryptedPayloadHint(message: MessageDecryptionStateLike): boolean {
  return Boolean(message.encrypted_content) ||
    Boolean(message.iv) ||
    message.protocol === 'mls' ||
    message.protocol === 'legacy_aes';
}

export function isTransientUndecryptableMessage(
  message: MessageDecryptionStateLike,
): boolean {
  if (message.decryption_failed === true) {
    return true;
  }

  if (typeof message.content === 'string' && ENCRYPTED_PLACEHOLDER_CONTENTS.has(message.content)) {
    return true;
  }

  if (
    message.is_deleted ||
    message.message_type === 'system' ||
    hasAttachments(message.attachments)
  ) {
    return false;
  }

  return normalizeMessageText(message.content) == null && hasEncryptedPayloadHint(message);
}

export function getPersistableMessageContent(
  message: MessageDecryptionStateLike,
): string | null {
  return isTransientUndecryptableMessage(message) ? null : (message.content ?? null);
}

export function hasReadableMessageContent(
  message: Pick<MessageDecryptionStateLike, 'content'>,
): boolean {
  return normalizeMessageText(message.content) != null &&
    !ENCRYPTED_PLACEHOLDER_CONTENTS.has(message.content as string);
}
