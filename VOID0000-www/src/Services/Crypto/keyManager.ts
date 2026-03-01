// src/Services/Crypto/keyManager.ts

const DB_NAME = 'void_crypto';
const DB_VERSION = 1;
const KEY_STORE = 'keys';

// ============== IndexedDB Helpers ==============

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(id: string): Promise<any | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readonly');
    const store = tx.objectStore(KEY_STORE);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function dbPut(data: any): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readwrite');
    const store = tx.objectStore(KEY_STORE);
    store.put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============== Key Generation ==============

/**
 * Generate an X25519 keypair using Web Crypto API (ECDH with P-256 as fallback)
 * Returns { publicKey, privateKey } as CryptoKey objects
 */
async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true, // extractable
    ['deriveKey', 'deriveBits']
  );
}

/**
 * Export a CryptoKey to base64 string
 */
async function exportKey(key: CryptoKey, isPublic: boolean): Promise<string> {
  const format = isPublic ? 'spki' : 'pkcs8';
  const exported = await crypto.subtle.exportKey(format, key);
  return arrayBufferToBase64(exported);
}

/**
 * Import a public key from base64 string
 */
async function importPublicKey(base64Key: string): Promise<CryptoKey> {
  const keyData = base64ToArrayBuffer(base64Key);
  return crypto.subtle.importKey(
    'spki',
    keyData,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

/**
 * Import a private key from base64 string
 */
async function importPrivateKey(base64Key: string): Promise<CryptoKey> {
  const keyData = base64ToArrayBuffer(base64Key);
  return crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );
}

// ============== Key Derivation ==============

/**
 * Derive a shared AES-256-GCM key from own private key + peer's public key
 */
async function deriveSharedKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: 'ECDH',
      public: publicKey,
    },
    privateKey,
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt']
  );
}

// ============== Key Fingerprint ==============

/**
 * Generate a fingerprint (SHA-256 hash) of a public key
 */
async function generateKeyFingerprint(publicKeyBase64: string): Promise<string> {
  const keyData = base64ToArrayBuffer(publicKeyBase64);
  const hash = await crypto.subtle.digest('SHA-256', keyData);
  return arrayBufferToBase64(hash).substring(0, 32);
}

// ============== Symmetric Key (for groups) ==============

/**
 * Generate a random AES-256-GCM symmetric key for group encryption
 */
async function generateGroupKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Export symmetric key to base64
 */
async function exportSymmetricKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return arrayBufferToBase64(raw);
}

/**
 * Import symmetric key from base64
 */
async function importSymmetricKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToArrayBuffer(base64Key);
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a group symmetric key with a user's public key (RSA-OAEP wrapper)
 * For group key distribution, we use the shared ECDH secret as a wrapping key
 */
async function encryptGroupKeyForUser(
  groupKey: CryptoKey,
  sharedKey: CryptoKey
): Promise<{ encrypted: string; iv: string }> {
  const rawGroupKey = await crypto.subtle.exportKey('raw', groupKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, // Uint8Array is perfectly fine for the iv parameter here
    sharedKey,
    rawGroupKey
  );

  return {
    encrypted: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv.buffer), // FIX: Pass the underlying ArrayBuffer
  };
}

/**
 * Decrypt a group symmetric key using shared ECDH secret
 */
async function decryptGroupKey(
  encryptedKey: string,
  iv: string,
  sharedKey: CryptoKey
): Promise<CryptoKey> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToArrayBuffer(iv) },
    sharedKey,
    base64ToArrayBuffer(encryptedKey)
  );

  return crypto.subtle.importKey(
    'raw',
    decrypted,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// ============== Storage (IndexedDB) ==============

/**
 * Initialize or load the user's keypair
 * If no keypair exists, generates one and uploads public key to server
 */
async function initializeKeys(
  userId: string,
  uploadPublicKey: (publicKey: string, keyId: string) => Promise<void>
): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const stored = await dbGet(`keypair:${userId}`);

  if (stored) {
    const privateKey = await importPrivateKey(stored.privateKey);
    return { publicKey: stored.publicKey, privateKey };
  }

  // Generate new keypair
  const keyPair = await generateKeyPair();
  const publicKeyBase64 = await exportKey(keyPair.publicKey, true);
  const privateKeyBase64 = await exportKey(keyPair.privateKey, false);
  const keyId = await generateKeyFingerprint(publicKeyBase64);

  // Store locally
  await dbPut({
    id: `keypair:${userId}`,
    publicKey: publicKeyBase64,
    privateKey: privateKeyBase64,
    keyId,
    createdAt: Date.now(),
  });

  // Upload public key to server
  await uploadPublicKey(publicKeyBase64, keyId);

  return { publicKey: publicKeyBase64, privateKey: keyPair.privateKey };
}

/**
 * Get or derive the shared secret for a DM peer
 */
async function getSharedSecret(
  userId: string,
  peerId: string,
  peerPublicKeyBase64: string
): Promise<CryptoKey> {
  const cacheKey = `shared:${userId}:${peerId}`;
  const cached = await dbGet(cacheKey);

  if (cached) {
    return importSymmetricKey(cached.sharedKey);
  }

  // Derive shared key
  const stored = await dbGet(`keypair:${userId}`);
  if (!stored) throw new Error('No keypair found — call initializeKeys first');

  const privateKey = await importPrivateKey(stored.privateKey);
  const peerPublicKey = await importPublicKey(peerPublicKeyBase64);
  const sharedKey = await deriveSharedKey(privateKey, peerPublicKey);

  // Cache it
  const sharedKeyBase64 = await exportSymmetricKey(sharedKey);
  await dbPut({
    id: cacheKey,
    sharedKey: sharedKeyBase64,
    peerId,
    createdAt: Date.now(),
  });

  return sharedKey;
}

/**
 * Store a group key locally
 */
async function storeGroupKey(
  conversationId: string,
  version: number,
  groupKey: CryptoKey
): Promise<void> {
  const raw = await exportSymmetricKey(groupKey);
  await dbPut({
    id: `group:${conversationId}:${version}`,
    key: raw,
    version,
    createdAt: Date.now(),
  });
}

/**
 * Get a stored group key
 */
async function getGroupKey(
  conversationId: string,
  version: number
): Promise<CryptoKey | null> {
  const stored = await dbGet(`group:${conversationId}:${version}`);
  if (!stored) return null;
  return importSymmetricKey(stored.key);
}

/**
 * Clear all crypto data (on logout)
 */
async function clearAllKeys(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readwrite');
    const store = tx.objectStore(KEY_STORE);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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

export const keyManager = {
  initializeKeys,
  getSharedSecret,
  generateGroupKey,
  exportSymmetricKey,
  importSymmetricKey,
  encryptGroupKeyForUser,
  decryptGroupKey,
  storeGroupKey,
  getGroupKey,
  clearAllKeys,
  generateKeyFingerprint,
  importPublicKey,
};