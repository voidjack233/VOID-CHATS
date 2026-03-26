// src/Services/Crypto/messageEncryption.ts
import { cryptoWorker } from './cryptoWorkerManager';

type DecryptableMessage = {
  encrypted_content: string | null;
  iv: string | null;
  is_deleted: boolean;
  [key: string]: any;
};

type MessageKeyResolver<T extends DecryptableMessage> = (message: T) => Promise<CryptoKey>;

// ============== Encrypt ==============

/**
 * Encrypt a plaintext message with AES-256-GCM
 * Returns { encrypted_content, iv } ready to send to server
 */
export async function encryptMessage(
  plaintext: string,
  key: CryptoKey
): Promise<{ encrypted_content: string; iv: string }> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  // Generate random 12-byte IV (96 bits, recommended for AES-GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  return {
    encrypted_content: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv.buffer), // FIX: Pass the underlying ArrayBuffer
  };
}

// ============== Decrypt ==============

export async function decryptMessage(
  encrypted_content: string,
  iv: string,
  key: CryptoKey
): Promise<string> {
  // Offloaded to the Web Worker to prevent UI freezing
  return cryptoWorker.decryptAsync(encrypted_content, iv, key);
}

// ============== Batch Operations ==============

export async function decryptMessages(
  messages: DecryptableMessage[],
  keyOrResolver: CryptoKey | MessageKeyResolver<DecryptableMessage>
): Promise<Array<{ content: string; [key: string]: any }>> {
  const results = await Promise.all(
    messages.map(async (msg) => {
      if (msg.message_type === 'system' && !msg.iv && msg.encrypted_content) {
        return { ...msg, content: msg.encrypted_content };
      }

      if (msg.is_deleted || !msg.encrypted_content || !msg.iv) {
        return { ...msg, content: msg.is_deleted ? '[deleted]' : '[encrypted]' };
      }

      try {
        const key = typeof keyOrResolver === 'function'
          ? await keyOrResolver(msg)
          : keyOrResolver;

        // Offloaded to the Web Worker
        const content = await cryptoWorker.decryptAsync(msg.encrypted_content, msg.iv, key);
        return { ...msg, content };
      } catch (err) {
        // Log locally for debugging, but return a placeholder so the UI doesn't crash
        console.warn('Decryption failed for message:', msg.message_id);
        return { ...msg, content: '[unable to decrypt]', decryption_failed: true };
      }
    })
  );

  return results;
}

// ============== Utility ==============

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  // Optimization: Spread operator with String.fromCharCode is natively optimized in V8
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}
