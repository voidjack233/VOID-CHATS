import type { Attachment } from '../Chat/chatTypes';
import { encode } from 'blurhash';
import { fetchWithAuth } from '../Auth/authServiceApi';
import { API_URL } from '../config';

interface EncryptedAttachment extends Attachment {
  encrypted: true;
  iv: string;
  key: string;
  mime: string;
  name?: string;
  size?: number;
}

const decryptedUrlCache = new Map<string, Promise<string>>();
const resolvedUrlCache = new Map<string, string>();
const resolvedUrlExpiryTimers = new Map<string, number>();
const encryptedBlobDownloadPromises = new Map<string, {
  controller: AbortController;
  generation: number;
  promise: Promise<Blob>;
  token: symbol;
}>();
const BASE64_CHUNK_SIZE = 0x8000;
const BLURHASH_MAX_DIMENSION = 32;
const BLURHASH_COMPONENT_X = 4;
const BLURHASH_COMPONENT_Y = 4;
const DECRYPTED_ATTACHMENT_URL_TTL_MS = 60_000;
const ENCRYPTED_ATTACHMENT_BLOB_TTL_MS = 5 * 60_000;
const MAX_ENCRYPTED_ATTACHMENT_CACHE_BYTES = 50 * 1024 * 1024;
const LEGACY_ATTACHMENT_BUCKET_PATH = '/chat-attachments/';
let attachmentCacheGeneration = 0;

interface EncryptedBlobCacheEntry {
  blob: Blob;
  lastAccessedAt: number;
  size: number;
}

class EncryptedBlobCache {
  private entries = new Map<string, EncryptedBlobCacheEntry>();
  private totalSize = 0;

  get(cacheKey: string): Blob | null {
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.lastAccessedAt > ENCRYPTED_ATTACHMENT_BLOB_TTL_MS) {
      this.delete(cacheKey);
      return null;
    }

    entry.lastAccessedAt = Date.now();
    return entry.blob;
  }

  set(cacheKey: string, blob: Blob): void {
    if (blob.size > MAX_ENCRYPTED_ATTACHMENT_CACHE_BYTES) {
      return;
    }

    this.delete(cacheKey);
    this.pruneExpired();

    while (
      this.totalSize + blob.size > MAX_ENCRYPTED_ATTACHMENT_CACHE_BYTES &&
      this.entries.size > 0
    ) {
      this.evictLeastRecentlyUsed();
    }

    this.entries.set(cacheKey, {
      blob,
      lastAccessedAt: Date.now(),
      size: blob.size,
    });
    this.totalSize += blob.size;
  }

  clear(): void {
    this.entries.clear();
    this.totalSize = 0;
  }

  private delete(cacheKey: string): void {
    const existing = this.entries.get(cacheKey);
    if (!existing) {
      return;
    }

    this.entries.delete(cacheKey);
    this.totalSize = Math.max(0, this.totalSize - existing.size);
  }

  private pruneExpired(): void {
    const now = Date.now();
    Array.from(this.entries.entries()).forEach(([cacheKey, entry]) => {
      if (now - entry.lastAccessedAt > ENCRYPTED_ATTACHMENT_BLOB_TTL_MS) {
        this.delete(cacheKey);
      }
    });
  }

  private evictLeastRecentlyUsed(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Number.POSITIVE_INFINITY;

    this.entries.forEach((entry, cacheKey) => {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestAccess = entry.lastAccessedAt;
        oldestKey = cacheKey;
      }
    });

    if (oldestKey) {
      this.delete(oldestKey);
    }
  }
}

const encryptedBlobCache = new EncryptedBlobCache();

interface AttachmentResolveOptions {
  conversationId?: string | null;
}

interface ImageAttachmentPreviewData {
  blurhash?: string;
  width?: number;
  height?: number;
}

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

function getAttachmentCacheKey(attachment: EncryptedAttachment): string {
  return [
    attachment.url,
    attachment.iv,
    attachment.key,
    attachment.mime,
  ].join('::');
}

function getLegacyAttachmentObjectKey(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin);
    const markerIndex = parsed.pathname.indexOf(LEGACY_ATTACHMENT_BUCKET_PATH);
    if (markerIndex === -1) {
      return null;
    }

    const objectKey = parsed.pathname.slice(markerIndex + LEGACY_ATTACHMENT_BUCKET_PATH.length);
    if (!objectKey || objectKey.includes('/')) {
      return null;
    }

    return decodeURIComponent(objectKey);
  } catch {
    return null;
  }
}

function resolveAttachmentDownloadUrl(url: string, options?: AttachmentResolveOptions): string {
  const legacyObjectKey = options?.conversationId
    ? getLegacyAttachmentObjectKey(url)
    : null;

  if (legacyObjectKey) {
    return `/api/conversations/${encodeURIComponent(options!.conversationId!)}/attachments/legacy/${encodeURIComponent(legacyObjectKey)}`;
  }

  return url;
}

function shouldUseAuthenticatedFetch(url: string): boolean {
  if (url.startsWith('/api/')) {
    return true;
  }

  try {
    const parsed = new URL(url, window.location.origin);
    const apiBase = API_URL ? new URL(API_URL, window.location.origin) : null;

    if (parsed.pathname.startsWith('/api/') && parsed.origin === window.location.origin) {
      return true;
    }

    return Boolean(apiBase && parsed.origin === apiBase.origin && parsed.pathname.startsWith('/api/'));
  } catch {
    return false;
  }
}

function clearResolvedUrlExpiry(cacheKey: string): void {
  const existingTimer = resolvedUrlExpiryTimers.get(cacheKey);
  if (existingTimer != null) {
    window.clearTimeout(existingTimer);
    resolvedUrlExpiryTimers.delete(cacheKey);
  }
}

function revokeResolvedUrl(cacheKey: string): void {
  clearResolvedUrlExpiry(cacheKey);

  const objectUrl = resolvedUrlCache.get(cacheKey);
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    resolvedUrlCache.delete(cacheKey);
  }

  decryptedUrlCache.delete(cacheKey);
}

function touchResolvedUrl(cacheKey: string): void {
  if (!resolvedUrlCache.has(cacheKey)) {
    return;
  }

  clearResolvedUrlExpiry(cacheKey);
  const timer = window.setTimeout(() => {
    revokeResolvedUrl(cacheKey);
  }, DECRYPTED_ATTACHMENT_URL_TTL_MS);
  resolvedUrlExpiryTimers.set(cacheKey, timer);
}

function getBlurhashDimensions(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    return { width: BLURHASH_MAX_DIMENSION, height: BLURHASH_MAX_DIMENSION };
  }

  if (width >= height) {
    return {
      width: BLURHASH_MAX_DIMENSION,
      height: Math.max(1, Math.round((height / width) * BLURHASH_MAX_DIMENSION)),
    };
  }

  return {
    width: Math.max(1, Math.round((width / height) * BLURHASH_MAX_DIMENSION)),
    height: BLURHASH_MAX_DIMENSION,
  };
}

async function extractImageAttachmentPreviewData(file: File): Promise<ImageAttachmentPreviewData> {
  if (!file.type.startsWith('image/')) {
    return {};
  }

  let objectUrl: string | null = null;

  try {
    objectUrl = URL.createObjectURL(file);
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('IMAGE_LOAD_FAILED'));
      img.src = objectUrl as string;
    });

    const width = image.naturalWidth > 0 ? image.naturalWidth : undefined;
    const height = image.naturalHeight > 0 ? image.naturalHeight : undefined;

    let blurhash: string | undefined;
    try {
      const targetDimensions = getBlurhashDimensions(image.naturalWidth, image.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = targetDimensions.width;
      canvas.height = targetDimensions.height;

      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context) {
        context.drawImage(image, 0, 0, targetDimensions.width, targetDimensions.height);
        const imageData = context.getImageData(0, 0, targetDimensions.width, targetDimensions.height);
        blurhash = encode(
          imageData.data,
          targetDimensions.width,
          targetDimensions.height,
          BLURHASH_COMPONENT_X,
          BLURHASH_COMPONENT_Y,
        );
      }
    } catch (error) {
      console.warn('Failed to generate blurhash for attachment:', error);
    }

    return { blurhash, width, height };
  } catch (error) {
    console.warn('Failed to inspect image attachment:', error);
    return {};
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
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
  const previewData = await extractImageAttachmentPreviewData(file);
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
      blurhash: previewData.blurhash,
      width: previewData.width,
      height: previewData.height,
    },
  };
}

async function downloadAttachmentBlob(url: string): Promise<Blob> {
  const cachedBlob = encryptedBlobCache.get(url);
  if (cachedBlob) {
    return cachedBlob;
  }

  const generation = attachmentCacheGeneration;
  const existingDownload = encryptedBlobDownloadPromises.get(url);
  if (existingDownload?.generation === generation) {
    return existingDownload.promise;
  }

  const controller = new AbortController();
  const token = Symbol(url);
  const trackedPromise = (async () => {
    const requestOptions: RequestInit = {
      cache: 'force-cache',
      signal: controller.signal,
    };
    const response = shouldUseAuthenticatedFetch(url)
      ? await fetchWithAuth(url, requestOptions)
      : await fetch(url, requestOptions);

    if (!response.ok) {
      throw new Error(`Attachment download failed with status ${response.status}`);
    }

    const blob = await response.blob();
    if (generation !== attachmentCacheGeneration) {
      throw new Error('Attachment request invalidated');
    }

    encryptedBlobCache.set(url, blob);
    return blob;
  })().finally(() => {
    if (encryptedBlobDownloadPromises.get(url)?.token === token) {
      encryptedBlobDownloadPromises.delete(url);
    }
  });

  encryptedBlobDownloadPromises.set(url, {
    controller,
    generation,
    promise: trackedPromise,
    token,
  });
  return trackedPromise;
}

async function decryptAttachmentToBlob(
  attachment: EncryptedAttachment,
  options?: AttachmentResolveOptions,
): Promise<Blob> {
  const generation = attachmentCacheGeneration;
  const downloadUrl = resolveAttachmentDownloadUrl(attachment.url, options);
  const encryptedBlob = await downloadAttachmentBlob(downloadUrl);
  if (generation !== attachmentCacheGeneration) {
    throw new Error('Attachment request invalidated');
  }

  const encryptedData = await encryptedBlob.arrayBuffer();
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
  if (generation !== attachmentCacheGeneration) {
    throw new Error('Attachment request invalidated');
  }

  return new Blob([decrypted], {
    type: attachment.mime || 'application/octet-stream',
  });
}

export async function resolveAttachmentBlob(
  attachment: Attachment,
  options?: AttachmentResolveOptions,
): Promise<Blob> {
  if (isEncryptedAttachment(attachment)) {
    return decryptAttachmentToBlob(attachment, options);
  }

  const downloadUrl = resolveAttachmentDownloadUrl(attachment.url, options);
  return downloadAttachmentBlob(downloadUrl);
}

export async function resolveAttachmentObjectUrl(
  attachment: Attachment,
  options?: AttachmentResolveOptions,
): Promise<string> {
  if (!isEncryptedAttachment(attachment)) {
    return attachment.url;
  }

  const cacheKey = getAttachmentCacheKey(attachment);
  const resolvedUrl = resolvedUrlCache.get(cacheKey);
  if (resolvedUrl) {
    touchResolvedUrl(cacheKey);
    return resolvedUrl;
  }

  if (!decryptedUrlCache.has(cacheKey)) {
    const generation = attachmentCacheGeneration;
    const pendingUrl: Promise<string> = decryptAttachmentToBlob(attachment, options)
      .then((blob) => {
        if (
          generation !== attachmentCacheGeneration ||
          decryptedUrlCache.get(cacheKey) !== pendingUrl
        ) {
          throw new Error('Attachment request invalidated');
        }

        const objectUrl = URL.createObjectURL(blob);
        if (generation !== attachmentCacheGeneration) {
          URL.revokeObjectURL(objectUrl);
          throw new Error('Attachment request invalidated');
        }

        resolvedUrlCache.set(cacheKey, objectUrl);
        touchResolvedUrl(cacheKey);
        return objectUrl;
      })
      .catch((error) => {
        if (decryptedUrlCache.get(cacheKey) === pendingUrl) {
          revokeResolvedUrl(cacheKey);
        }
        throw error;
      });

    decryptedUrlCache.set(cacheKey, pendingUrl);
  }

  return decryptedUrlCache.get(cacheKey) as Promise<string>;
}

export function getCachedAttachmentObjectUrl(attachment: Attachment): string | null {
  if (!isEncryptedAttachment(attachment)) {
    return attachment.url;
  }

  const cacheKey = getAttachmentCacheKey(attachment);
  const cachedUrl = resolvedUrlCache.get(cacheKey) || null;
  if (cachedUrl) {
    touchResolvedUrl(cacheKey);
  }
  return cachedUrl;
}

export function clearDecryptedAttachmentObjectUrlCache(): void {
  clearAttachmentCaches();
}

export function clearAttachmentCaches(): void {
  attachmentCacheGeneration += 1;
  encryptedBlobDownloadPromises.forEach(({ controller }) => controller.abort());
  encryptedBlobDownloadPromises.clear();
  encryptedBlobCache.clear();

  resolvedUrlExpiryTimers.forEach((timerId) => window.clearTimeout(timerId));
  resolvedUrlExpiryTimers.clear();
  resolvedUrlCache.forEach((objectUrl) => URL.revokeObjectURL(objectUrl));
  resolvedUrlCache.clear();
  decryptedUrlCache.clear();
}
