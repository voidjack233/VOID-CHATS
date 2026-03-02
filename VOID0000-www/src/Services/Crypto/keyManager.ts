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

// ============== Binary Utilities ==============

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return btoa(String.fromCharCode(...bytes));
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ============== Core Key Operations ==============

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );
}

async function exportKey(key: CryptoKey, isPublic: boolean): Promise<string> {
  const format = isPublic ? 'spki' : 'pkcs8';
  const exported = await crypto.subtle.exportKey(format, key);
  return arrayBufferToBase64(exported);
}

async function importPublicKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(base64Key),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

async function importPrivateKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    base64ToArrayBuffer(base64Key),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );
}

// ============== Key Fingerprint ==============

async function generateKeyFingerprint(publicKeyBase64: string): Promise<string> {
  const keyData = base64ToArrayBuffer(publicKeyBase64);
  const hash = await crypto.subtle.digest('SHA-256', keyData);
  return arrayBufferToBase64(hash).substring(0, 32);
}

// ============== Password-Based Key Encryption (for backup) ==============

const PBKDF2_ITERATIONS = 600000;

async function deriveKeyFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptPrivateKeyWithPassword(
  privateKeyBase64: string,
  password: string
): Promise<{ encrypted: string; iv: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await deriveKeyFromPassword(password, salt);

  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    wrappingKey,
    encoder.encode(privateKeyBase64)
  );

  return {
    encrypted: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
    salt: arrayBufferToBase64(salt.buffer as ArrayBuffer),
  };
}

async function decryptPrivateKeyWithPassword(
  encryptedBase64: string,
  ivBase64: string,
  saltBase64: string,
  password: string
): Promise<string> {
  const salt = new Uint8Array(base64ToArrayBuffer(saltBase64));
  const iv = base64ToArrayBuffer(ivBase64);
  const wrappingKey = await deriveKeyFromPassword(password, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    base64ToArrayBuffer(encryptedBase64)
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

async function derivePublicKeyFromPrivate(privateKeyBase64: string): Promise<string> {
  const privateKey = await importPrivateKey(privateKeyBase64);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  delete jwk.d;
  jwk.key_ops = [];

  const publicKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );

  const exported = await crypto.subtle.exportKey('spki', publicKey);
  return arrayBufferToBase64(exported);
}

// ============== Key Initialization ==============

interface KeyCallbacks {
  uploadPublicKey: (publicKey: string, keyId: string) => Promise<void>;
  backupToServer: (data: { encrypted_private_key: string; iv: string; salt: string; key_id: string }) => Promise<void>;
  fetchBackup: () => Promise<{ encrypted_private_key: string; iv: string; salt: string; key_id: string } | null>;
}

async function initializeKeys(
  userId: string,
  password: string | null,
  callbacks: KeyCallbacks
): Promise<{ publicKey: string; privateKey: CryptoKey }> {

  // === Path 1: Local keys exist ===
  const stored = await dbGet(`keypair:${userId}`);
  if (stored) {
    const privateKey = await importPrivateKey(stored.privateKey);
    console.log('🔑 Using existing local keys');

    // FIX: Ensure public key is on the server (handles truncate/reset scenarios)
    callbacks.uploadPublicKey(stored.publicKey, stored.keyId).catch((err) => {
      console.warn('🔑 Public key re-sync failed (non-critical):', err);
    });

    // Ensure backup exists (non-blocking)
    if (password) {
      ensureBackup(stored.privateKey, stored.keyId, password, callbacks).catch(() => {});
    }

    return { publicKey: stored.publicKey, privateKey };
  }

  // No local keys — check server for backup
  let backup: any = null;
  try {
    backup = await callbacks.fetchBackup();
  } catch {
    // Treat network error as no backup
  }

  // === Path 2: Backup exists + password → restore ===
  if (backup && password) {
    try {
      console.log('🔑 Restoring keys from server backup...');
      const privateKeyBase64 = await decryptPrivateKeyWithPassword(
        backup.encrypted_private_key,
        backup.iv,
        backup.salt,
        password
      );

      const publicKeyBase64 = await derivePublicKeyFromPrivate(privateKeyBase64);
      const keyId = await generateKeyFingerprint(publicKeyBase64);

      await dbPut({
        id: `keypair:${userId}`,
        publicKey: publicKeyBase64,
        privateKey: privateKeyBase64,
        keyId,
        createdAt: Date.now(),
      });

      await callbacks.uploadPublicKey(publicKeyBase64, keyId);
      return { publicKey: publicKeyBase64, privateKey: await importPrivateKey(privateKeyBase64) };
    } catch (err) {
      console.error('🔑 Backup restore failed:', err);
      throw new Error('KEY_RESTORE_FAILED');
    }
  }

  // === Path 3: Backup exists but no password → must re-login ===
  if (backup && !password) {
    throw new Error('KEY_NEEDS_PASSWORD');
  }

  // === Path 4: No backup + has password → brand new user ===
  if (!backup && password) {
    console.log('🔑 First time setup — generating fresh keypair...');
    const keyPair = await generateKeyPair();
    const publicKeyBase64 = await exportKey(keyPair.publicKey, true);
    const privateKeyBase64 = await exportKey(keyPair.privateKey, false);
    const keyId = await generateKeyFingerprint(publicKeyBase64);

    await dbPut({
      id: `keypair:${userId}`,
      publicKey: publicKeyBase64,
      privateKey: privateKeyBase64,
      keyId,
      createdAt: Date.now(),
    });

    await callbacks.uploadPublicKey(publicKeyBase64, keyId);

    try {
      const backupData = await encryptPrivateKeyWithPassword(privateKeyBase64, password);
      await callbacks.backupToServer({
        encrypted_private_key: backupData.encrypted,
        iv: backupData.iv,
        salt: backupData.salt,
        key_id: keyId,
      });
    } catch (err) {
      console.warn('🔑 Key backup failed:', err);
    }

    return { publicKey: publicKeyBase64, privateKey: keyPair.privateKey };
  }

  throw new Error('KEY_NEEDS_PASSWORD');
}

async function ensureBackup(
  privateKeyBase64: string,
  keyId: string,
  password: string,
  callbacks: KeyCallbacks
): Promise<void> {
  try {
    const existing = await callbacks.fetchBackup();
    if (!existing) {
      const backup = await encryptPrivateKeyWithPassword(privateKeyBase64, password);
      await callbacks.backupToServer({
        encrypted_private_key: backup.encrypted,
        iv: backup.iv,
        salt: backup.salt,
        key_id: keyId,
      });
      console.log('🔑 Backup created for existing keys');
    }
  } catch {
    // Non-critical
  }
}

// ============== Shared Secrets ==============

async function deriveSharedKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

async function getSharedSecret(userId: string, peerId: string, peerPubKeyBase64: string): Promise<CryptoKey> {
  const cacheKey = `shared:${userId}:${peerId}`;
  const cached = await dbGet(cacheKey);

  if (cached) {
    return crypto.subtle.importKey(
      'raw',
      base64ToArrayBuffer(cached.sharedKey),
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  const stored = await dbGet(`keypair:${userId}`);
  if (!stored) throw new Error('Identity keys missing');

  const priv = await importPrivateKey(stored.privateKey);
  const pub = await importPublicKey(peerPubKeyBase64);
  const sharedKey = await deriveSharedKey(priv, pub);

  const exportedShared = await crypto.subtle.exportKey('raw', sharedKey);
  await dbPut({
    id: cacheKey,
    sharedKey: arrayBufferToBase64(exportedShared),
    peerId,
    createdAt: Date.now(),
  });

  return sharedKey;
}

// ============== Group Key Distribution ==============

async function encryptGroupKeyForUser(groupKey: CryptoKey, sharedKey: CryptoKey) {
  const raw = await crypto.subtle.exportKey('raw', groupKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    sharedKey,
    raw
  );

  return {
    encrypted: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
  };
}

async function decryptGroupKey(encryptedKey: string, iv: string, sharedKey: CryptoKey): Promise<CryptoKey> {
  const dec = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToArrayBuffer(iv) },
    sharedKey,
    base64ToArrayBuffer(encryptedKey)
  );

  return crypto.subtle.importKey('raw', dec, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

// ============== Cleanup ==============

async function clearAllKeys(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(KEY_STORE, 'readwrite');
    tx.objectStore(KEY_STORE).clear();
    tx.oncomplete = () => resolve();
  });
}

export const keyManager = {
  initializeKeys,
  getSharedSecret,
  encryptGroupKeyForUser,
  decryptGroupKey,
  clearAllKeys,
  importPublicKey,
  generateKeyFingerprint,
  storeGroupKey: async (id: string, v: number, key: CryptoKey) => {
    const raw = await crypto.subtle.exportKey('raw', key);
    await dbPut({ id: `group:${id}:${v}`, key: arrayBufferToBase64(raw), version: v });
  },
  getGroupKey: async (id: string, v: number) => {
    const stored = await dbGet(`group:${id}:${v}`);
    return stored
      ? crypto.subtle.importKey('raw', base64ToArrayBuffer(stored.key), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
      : null;
  },
};