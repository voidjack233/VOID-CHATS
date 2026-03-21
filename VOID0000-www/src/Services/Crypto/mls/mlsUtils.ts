import type { Conversation } from '../../Chat/chatService';

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function normalizeConversationKeyId(conversation: Conversation): string {
  return conversation.parent_conversation_id || conversation.id;
}

export function normalizePositiveVersion(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

export function createMlsError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

const ARCHIVE_KEY_SALT = new TextEncoder().encode('void-group-key-archive');

async function deriveArchiveWrappingKey(
  identityKeyBytes: Uint8Array,
  userId: string,
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    identityKeyBytes,
    'HKDF',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ARCHIVE_KEY_SALT,
      info: new TextEncoder().encode(userId),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a raw AES key before archiving to the server.
 * Output: base64( 12-byte IV || ciphertext+tag )
 */
export async function wrapArchiveKey(
  rawKeyBytes: ArrayBuffer,
  identityKeyBytes: Uint8Array,
  userId: string,
): Promise<string> {
  const wrappingKey = await deriveArchiveWrappingKey(identityKeyBytes, userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    rawKeyBytes,
  );

  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt an archived key fetched from the server.
 * Input: base64( 12-byte IV || ciphertext+tag )
 */
export async function unwrapArchiveKey(
  wrappedBase64: string,
  identityKeyBytes: Uint8Array,
  userId: string,
): Promise<ArrayBuffer> {
  const wrappingKey = await deriveArchiveWrappingKey(identityKeyBytes, userId);
  const combined = base64ToBytes(wrappedBase64);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    ciphertext,
  );
}
