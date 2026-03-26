import type { Attachment } from '../Chat/chatTypes';

interface EncryptedAttachment extends Attachment {
  encrypted: true;
  iv: string;
  key: string;
  mime: string;
  name?: string;
  size?: number;
}

const decryptedUrlCache = new Map<string, Promise<string>>();
const BASE64_CHUNK_SIZE = 0x8000;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }

  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function isEncryptedAttachment(attachment: Attachment): attachment is EncryptedAttachment {
  return (
    attachment.encrypted === true &&
    typeof attachment.iv === 'string' &&
    attachment.iv.length > 0 &&
    typeof attachment.key === 'string' &&
    attachment.key.length > 0 &&
    typeof attachment.mime === 'string' &&
    attachment.mime.length > 0
  );
}

export async function encryptAttachmentFile(file: File): Promise<{
  encryptedData: string;
  attachment: EncryptedAttachment;
}> {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const fileData = await file.arrayBuffer();
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, fileData);
  const rawKey = await crypto.subtle.exportKey('raw', key);

  return {
    encryptedData: arrayBufferToBase64(encrypted),
    attachment: {
      url: '',
      encrypted: true,
      iv: arrayBufferToBase64(iv.buffer),
      key: arrayBufferToBase64(rawKey),
      mime: file.type || 'application/octet-stream',
      name: file.name || undefined,
      size: file.size,
    },
  };
}

async function decryptAttachmentToBlob(attachment: EncryptedAttachment): Promise<Blob> {
  const response = await fetch(attachment.url, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Attachment download failed with status ${response.status}`);
  }

  const encryptedData = await response.arrayBuffer();
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToUint8Array(attachment.key),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToUint8Array(attachment.iv) },
    key,
    encryptedData,
  );

  return new Blob([decrypted], {
    type: attachment.mime || 'application/octet-stream',
  });
}

export async function resolveAttachmentObjectUrl(attachment: Attachment): Promise<string> {
  if (!isEncryptedAttachment(attachment)) {
    return attachment.url;
  }

  const cacheKey = [
    attachment.url,
    attachment.iv,
    attachment.key,
    attachment.mime,
  ].join('::');

  if (!decryptedUrlCache.has(cacheKey)) {
    decryptedUrlCache.set(
      cacheKey,
      decryptAttachmentToBlob(attachment).then((blob) => URL.createObjectURL(blob)),
    );
  }

  return decryptedUrlCache.get(cacheKey) as Promise<string>;
}
