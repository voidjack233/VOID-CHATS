// src/Services/Crypto/messageEncryption.ts

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

/**
 * Decrypt an encrypted message with AES-256-GCM
 * Returns the plaintext string
 */
export async function decryptMessage(
  encrypted_content: string,
  iv: string,
  key: CryptoKey
): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToArrayBuffer(iv) },
    key,
    base64ToArrayBuffer(encrypted_content)
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

// ============== Batch Operations ==============

/**
 * Decrypt an array of messages
 * Returns messages with plaintext content added
 */
export async function decryptMessages(
  messages: Array<{
    encrypted_content: string | null;
    iv: string | null;
    is_deleted: boolean;
    [key: string]: any;
  }>,
  key: CryptoKey
): Promise<Array<{ content: string; [key: string]: any }>> {
  const results = await Promise.all(
    messages.map(async (msg) => {
      if (msg.is_deleted || !msg.encrypted_content || !msg.iv) {
        return { ...msg, content: msg.is_deleted ? '[deleted]' : '[encrypted]' };
      }

      try {
        const content = await decryptMessage(msg.encrypted_content, msg.iv, key);
        return { ...msg, content };
      } catch (err) {
        console.warn('Failed to decrypt message:', msg.message_id, err);
        return { ...msg, content: '[unable to decrypt]' };
      }
    })
  );

  return results;
}

// ============== Utility ==============

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    // FIX: Add 'as number' to satisfy TypeScript's noUncheckedIndexedAccess rule
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}