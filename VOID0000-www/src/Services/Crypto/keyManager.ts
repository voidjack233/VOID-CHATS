// src/Services/Crypto/keyManager.ts
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

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
const RECOVERY_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

interface RecoveryCodeFormat {
  payloadLength: number;
  totalLength: number;
  groupSizes: readonly number[];
}

// New default: 6 blocks (1..6 in UI)
const DEFAULT_RECOVERY_CODE_FORMAT: RecoveryCodeFormat = {
  payloadLength: 29,
  totalLength: 30,
  groupSizes: [5, 5, 5, 5, 5, 5] as const,
};

// Legacy activation-key format support (already-issued codes)
const LEGACY_RECOVERY_CODE_FORMAT: RecoveryCodeFormat = {
  payloadLength: 25,
  totalLength: 26,
  groupSizes: [5, 5, 5, 5, 6] as const,
};

const ACCEPTED_RECOVERY_CODE_FORMATS: readonly RecoveryCodeFormat[] = [
  DEFAULT_RECOVERY_CODE_FORMAT,
  LEGACY_RECOVERY_CODE_FORMAT,
];

type RecoverySecretKind = 'phrase' | 'activation_code';

interface ParsedRecoverySecret {
  kind: RecoverySecretKind;
  normalized: string;
}

function normalizeRecoveryPhrase(phrase: string): string {
  return phrase
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function normalizeRecoveryCode(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/O/g, '0');
}

function formatRecoveryCode(compact: string, groupSizes: readonly number[]): string {
  const groups: string[] = [];
  let offset = 0;
  for (const groupSize of groupSizes) {
    groups.push(compact.slice(offset, offset + groupSize));
    offset += groupSize;
  }
  return groups.filter(Boolean).join('-');
}

function computeRecoveryCodeChecksum(payload: string): string {
  let acc = 17;
  for (const char of payload) {
    const charIndex = RECOVERY_CODE_ALPHABET.indexOf(char);
    if (charIndex < 0) {
      throw new Error('INVALID_RECOVERY_PHRASE');
    }
    acc = (acc * 33 + charIndex) % RECOVERY_CODE_ALPHABET.length;
  }
  return RECOVERY_CODE_ALPHABET.charAt(acc);
}

function isValidRecoveryCodeForFormat(compact: string, format: RecoveryCodeFormat): boolean {
  if (compact.length !== format.totalLength) {
    return false;
  }

  const payload = compact.slice(0, format.payloadLength);
  const checksum = compact.slice(format.payloadLength);
  if (!payload || checksum.length !== 1) {
    return false;
  }

  if (!/^[0-9A-HJKMNPQRSTVWXYZ]+$/.test(payload)) {
    return false;
  }
  if (!/^[0-9A-HJKMNPQRSTVWXYZ]$/.test(checksum)) {
    return false;
  }

  return computeRecoveryCodeChecksum(payload) === checksum;
}

function isValidRecoveryCode(compact: string): boolean {
  return ACCEPTED_RECOVERY_CODE_FORMATS.some((format) =>
    isValidRecoveryCodeForFormat(compact, format)
  );
}

function parseRecoverySecret(value: string): ParsedRecoverySecret | null {
  const normalizedPhrase = normalizeRecoveryPhrase(value);
  if (validateMnemonic(normalizedPhrase, wordlist)) {
    return {
      kind: 'phrase',
      normalized: normalizedPhrase,
    };
  }

  const normalizedCode = normalizeRecoveryCode(value);
  if (isValidRecoveryCode(normalizedCode)) {
    return {
      kind: 'activation_code',
      normalized: normalizedCode,
    };
  }

  return null;
}

function generateRecoveryCode(): string {
  const random = crypto.getRandomValues(new Uint8Array(DEFAULT_RECOVERY_CODE_FORMAT.payloadLength));
  let payload = '';
  for (let index = 0; index < random.length; index += 1) {
    payload += RECOVERY_CODE_ALPHABET[random[index]! & 31];
  }
  const checksum = computeRecoveryCodeChecksum(payload);
  return formatRecoveryCode(
    `${payload}${checksum}`,
    DEFAULT_RECOVERY_CODE_FORMAT.groupSizes
  );
}

function isValidRecoveryPhrase(phrase: string): boolean {
  return parseRecoverySecret(phrase) !== null;
}

async function deriveKeyFromSecret(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
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

async function deriveKeyFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
  return deriveKeyFromSecret(`password:${password}`, salt);
}

async function deriveKeyFromRecoveryPhrase(recoveryPhrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const parsed = parseRecoverySecret(recoveryPhrase);
  if (!parsed) {
    throw new Error('INVALID_RECOVERY_PHRASE');
  }

  if (parsed.kind === 'phrase') {
    return deriveKeyFromSecret(`recovery:${parsed.normalized}`, salt);
  }

  return deriveKeyFromSecret(`recovery_code:${parsed.normalized}`, salt);
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

async function encryptPrivateKeyWithRecoveryPhrase(
  privateKeyBase64: string,
  recoveryPhrase: string
): Promise<{ encrypted: string; iv: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await deriveKeyFromRecoveryPhrase(recoveryPhrase, salt);

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

async function decryptPrivateKeyWithRecoveryPhrase(
  encryptedBase64: string,
  ivBase64: string,
  saltBase64: string,
  recoveryPhrase: string
): Promise<string> {
  const salt = new Uint8Array(base64ToArrayBuffer(saltBase64));
  const iv = base64ToArrayBuffer(ivBase64);
  const wrappingKey = await deriveKeyFromRecoveryPhrase(recoveryPhrase, salt);

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
  fetchBackup: () => Promise<KeyBackupRecord | null>;
}

interface KeyBackupRecord {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
  recovery_encrypted_private_key?: string | null;
  recovery_iv?: string | null;
  recovery_salt?: string | null;
  recovery_key_id?: string | null;
}

interface PasswordWrappedKeyBackup {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
}

async function createPasswordWrappedBackup(
  privateKeyBase64: string,
  password: string,
  keyId: string
): Promise<PasswordWrappedKeyBackup> {
  const backupData = await encryptPrivateKeyWithPassword(privateKeyBase64, password);
  return {
    encrypted_private_key: backupData.encrypted,
    iv: backupData.iv,
    salt: backupData.salt,
    key_id: keyId,
  };
}

async function createRecoveryWrappedBackup(
  privateKeyBase64: string,
  recoveryPhrase: string,
  keyId: string
): Promise<PasswordWrappedKeyBackup> {
  const backupData = await encryptPrivateKeyWithRecoveryPhrase(privateKeyBase64, recoveryPhrase);
  return {
    encrypted_private_key: backupData.encrypted,
    iv: backupData.iv,
    salt: backupData.salt,
    key_id: keyId,
  };
}

async function initializeKeys(
  userId: string,
  password: string | null,
  callbacks: KeyCallbacks
): Promise<{ publicKey: string; privateKey: CryptoKey }> {

  // === Path 1: Local keys exist ===
  const stored = await dbGet(`keypair:${userId}`);
  if (stored) {
    // When password is available, verify local keys match the server backup.
    // If they diverge (e.g. this device generated fresh keys before a backup
    // existed on the server), prefer the backup — it is the canonical keypair.
    if (password) {
      try {
        const backup = await callbacks.fetchBackup();
        if (backup?.key_id && backup.key_id !== stored.keyId) {
          console.warn('🔑 Local key does not match server backup — restoring canonical keypair');
          const privateKeyBase64 = await decryptPrivateKeyWithPassword(
            backup.encrypted_private_key,
            backup.iv,
            backup.salt,
            password
          );

          const publicKeyBase64 = await derivePublicKeyFromPrivate(privateKeyBase64);
          const keyId = await generateKeyFingerprint(publicKeyBase64);

          // Clear all cached shared secrets and group keys — they were
          // derived with the wrong identity keypair.
          await clearAllKeys();

          await dbPut({
            id: `keypair:${userId}`,
            publicKey: publicKeyBase64,
            privateKey: privateKeyBase64,
            keyId,
            createdAt: Date.now(),
          });

          await callbacks.uploadPublicKey(publicKeyBase64, keyId);
          return { publicKey: publicKeyBase64, privateKey: await importPrivateKey(privateKeyBase64) };
        }
      } catch (err) {
        console.warn('🔑 Key verification check failed (non-critical):', err);
      }
    }

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
    let needsRefresh = !existing;

    // If a backup exists but its key_id differs from the local key, the backup
    // is authoritative (canonical keypair).  Do NOT overwrite it — initializeKeys
    // should have already restored from it when the password was available.
    if (existing?.key_id && existing.key_id !== keyId) {
      console.warn('🔑 Backup key_id differs from local — skipping to avoid overwriting canonical key');
      return;
    }

    if (
      existing &&
      (!existing.encrypted_private_key || !existing.iv || !existing.salt)
    ) {
      needsRefresh = true;
    }

    if (existing && !needsRefresh) {
      try {
        const decryptedPrivateKey = await decryptPrivateKeyWithPassword(
          existing.encrypted_private_key,
          existing.iv,
          existing.salt,
          password
        );

        if (decryptedPrivateKey !== privateKeyBase64) {
          needsRefresh = true;
        }
      } catch {
        needsRefresh = true;
      }
    }

    if (needsRefresh) {
      await callbacks.backupToServer(
        await createPasswordWrappedBackup(privateKeyBase64, password, keyId)
      );
      console.log(existing ? '🔑 Password backup refreshed' : '🔑 Backup created for existing keys');
    }
  } catch {
    // Non-critical
  }
}

// ============== Generic Payload Encryption ==============

async function encryptDataWithPassword(
  data: unknown,
  password: string
): Promise<{ encrypted: string; iv: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await deriveKeyFromPassword(password, salt);
  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    wrappingKey,
    encoder.encode(JSON.stringify(data))
  );
  return {
    encrypted: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
    salt: arrayBufferToBase64(salt.buffer as ArrayBuffer),
  };
}

async function decryptDataWithPassword(
  encryptedBase64: string,
  ivBase64: string,
  saltBase64: string,
  password: string
): Promise<unknown> {
  const salt = new Uint8Array(base64ToArrayBuffer(saltBase64));
  const iv = base64ToArrayBuffer(ivBase64);
  const wrappingKey = await deriveKeyFromPassword(password, salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    base64ToArrayBuffer(encryptedBase64)
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
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

async function generateFreshKeys(
  userId: string,
  password: string,
  callbacks: KeyCallbacks
): Promise<{ publicKey: string; privateKey: CryptoKey }> {
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

  const backupData = await encryptPrivateKeyWithPassword(privateKeyBase64, password);
  await callbacks.backupToServer({
    encrypted_private_key: backupData.encrypted,
    iv: backupData.iv,
    salt: backupData.salt,
    key_id: keyId,
  });

  return { publicKey: publicKeyBase64, privateKey: keyPair.privateKey };
}

async function reEncryptBackup(
  userId: string,
  newPassword: string,
  callbacks: KeyCallbacks
): Promise<void> {
  await callbacks.backupToServer(await prepareBackup(userId, newPassword));
}

async function prepareBackup(
  userId: string,
  password: string
): Promise<PasswordWrappedKeyBackup> {
  const stored = await dbGet(`keypair:${userId}`);
  if (!stored?.privateKey || !stored?.keyId) {
    throw new Error('LOCAL_KEY_MISSING');
  }

  return createPasswordWrappedBackup(stored.privateKey, password, stored.keyId);
}

async function prepareRecoveryBackup(
  userId: string,
  recoveryPhrase: string
): Promise<PasswordWrappedKeyBackup> {
  const stored = await dbGet(`keypair:${userId}`);
  if (!stored?.privateKey || !stored?.keyId) {
    throw new Error('LOCAL_KEY_MISSING');
  }

  return createRecoveryWrappedBackup(stored.privateKey, recoveryPhrase, stored.keyId);
}

async function restoreFromRecoveryPhrase(
  userId: string,
  recoveryPhrase: string,
  password: string | null,
  callbacks: KeyCallbacks
): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const backup = await callbacks.fetchBackup();
  if (
    !backup?.recovery_encrypted_private_key ||
    !backup.recovery_iv ||
    !backup.recovery_salt
  ) {
    throw new Error('RECOVERY_NOT_CONFIGURED');
  }

  const privateKeyBase64 = await decryptPrivateKeyWithRecoveryPhrase(
    backup.recovery_encrypted_private_key,
    backup.recovery_iv,
    backup.recovery_salt,
    recoveryPhrase
  );

  const publicKeyBase64 = await derivePublicKeyFromPrivate(privateKeyBase64);
  const keyId = await generateKeyFingerprint(publicKeyBase64);
  const expectedKeyId = backup.recovery_key_id || backup.key_id || null;

  if (expectedKeyId && expectedKeyId !== keyId) {
    throw new Error('RECOVERY_KEY_MISMATCH');
  }

  await dbPut({
    id: `keypair:${userId}`,
    publicKey: publicKeyBase64,
    privateKey: privateKeyBase64,
    keyId,
    createdAt: Date.now(),
  });

  await callbacks.uploadPublicKey(publicKeyBase64, keyId);

  if (password) {
    await callbacks.backupToServer(await createPasswordWrappedBackup(privateKeyBase64, password, keyId));
  }

  return { publicKey: publicKeyBase64, privateKey: await importPrivateKey(privateKeyBase64) };
}

async function getIdentityKeyBytes(userId: string): Promise<Uint8Array | null> {
  const stored = await dbGet(`keypair:${userId}`);
  if (!stored?.privateKey) return null;
  return new Uint8Array(base64ToArrayBuffer(stored.privateKey));
}

export const keyManager = {
  initializeKeys,
  getIdentityKeyBytes,
  generateRecoveryPhrase: () => generateRecoveryCode(),
  validateRecoveryPhrase: isValidRecoveryPhrase,
  generateFreshKeys,
  prepareBackup,
  prepareRecoveryBackup,
  reEncryptBackup,
  restoreFromRecoveryPhrase,
  clearAllKeys,
  generateKeyFingerprint,
  encryptDataWithPassword,
  decryptDataWithPassword,
  exportGroupKeys: async (): Promise<Array<{ id: string; version: number; key: string }>> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, 'readonly');
      const request = tx.objectStore(KEY_STORE).getAll();
      request.onsuccess = () => {
        const all = (request.result ?? []) as Array<{ id: string; key: string; version: number }>;
        resolve(all.filter((r) => r.id?.startsWith('group:')));
      };
      request.onerror = () => reject(request.error);
    });
  },
  importGroupKeys: async (keys: Array<{ id: string; version: number; key: string }>): Promise<void> => {
    for (const entry of keys) {
      await dbPut(entry);
    }
  },
  storeGroupKey: async (id: string, v: number, key: CryptoKey) => {
    const raw = await crypto.subtle.exportKey('raw', key);
    await dbPut({ id: `group:${id}:${v}`, key: arrayBufferToBase64(raw), version: v });
  },
  deleteGroupKey: async (id: string, v: number): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, 'readwrite');
      tx.objectStore(KEY_STORE).delete(`group:${id}:${v}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  deleteAllGroupKeys: async (id: string): Promise<number> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, 'readwrite');
      const store = tx.objectStore(KEY_STORE);
      const request = store.getAllKeys();
      let deleted = 0;

      request.onsuccess = () => {
        const prefix = `group:${id}:`;
        const keys = (request.result ?? []).filter((key): key is string =>
          typeof key === 'string' && key.startsWith(prefix)
        );
        deleted = keys.length;
        keys.forEach((key) => store.delete(key));
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  getGroupKey: async (id: string, v: number) => {
    const stored = await dbGet(`group:${id}:${v}`);
    return stored
      ? crypto.subtle.importKey('raw', base64ToArrayBuffer(stored.key), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
      : null;
  },
  /**
   * Scan IndexedDB for any key belonging to a conversation, regardless of version.
   * Returns the highest-versioned key found, or null if none exist.
   */
  findAnyGroupKey: async (id: string): Promise<{ key: CryptoKey; version: number } | null> => {
    const db = await openDB();
    const all: Array<{ id: string; key: string; version: number }> = await new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, 'readonly');
      const store = tx.objectStore(KEY_STORE);
      const request = store.getAll();
      request.onsuccess = () => resolve((request.result ?? []) as any[]);
      request.onerror = () => reject(request.error);
    });

    const prefix = `group:${id}:`;
    const matches = all
      .filter((r) => r.id?.startsWith(prefix) && r.key)
      .sort((a, b) => (b.version ?? 0) - (a.version ?? 0));

    const best = matches[0];
    if (!best) return null;
    const key = await crypto.subtle.importKey(
      'raw',
      base64ToArrayBuffer(best.key),
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    return { key, version: best.version };
  },
};
