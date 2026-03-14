import { signalStore } from './signalStore';

const LIBSIGNAL_PREFIX = 'libsignal:';

function toArrayBuffer(value: ArrayBuffer | ArrayBufferLike | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
  }

  const view = new Uint8Array(value);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

function uint8ToBase64(data: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < data.length; index += 1) {
    binary += String.fromCharCode(data[index] || 0);
  }
  return btoa(binary);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return uint8ToBase64(new Uint8Array(buffer));
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return toArrayBuffer(bytes);
}

function binaryStringToArrayBuffer(value: string): ArrayBuffer {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return toArrayBuffer(bytes);
}

function normalizeIdentityIdentifier(identifier: string): string {
  // libsignal may pass "name.deviceId" when persisting identity state.
  // We only strip a trailing numeric segment, preserving any dots in the name.
  const match = identifier.match(/^(.*)\.(\d+)$/);
  if (!match || typeof match[1] !== 'string' || match[1].length === 0) {
    return identifier;
  }
  return match[1];
}

function keyIdentityPair(userId: string) {
  return `${LIBSIGNAL_PREFIX}identity_pair:${userId}`;
}

function keyRegistrationId(userId: string) {
  return `${LIBSIGNAL_PREFIX}registration_id:${userId}`;
}

function keyTrustedIdentity(userId: string, identifier: string) {
  return `${LIBSIGNAL_PREFIX}trusted_identity:${userId}:${identifier}`;
}

function keyTrustedIdentityConflict(userId: string, identifier: string) {
  return `${LIBSIGNAL_PREFIX}trusted_identity_conflict:${userId}:${identifier}`;
}

function keyPreKey(userId: string, keyId: number) {
  return `${LIBSIGNAL_PREFIX}prekey:${userId}:${keyId}`;
}

function keySignedPreKey(userId: string, keyId: number) {
  return `${LIBSIGNAL_PREFIX}signed_prekey:${userId}:${keyId}`;
}

function keySession(userId: string, identifier: string) {
  return `${LIBSIGNAL_PREFIX}session:${userId}:${identifier}`;
}

function keyBootstrapState(userId: string) {
  return `${LIBSIGNAL_PREFIX}bootstrap:${userId}`;
}

interface KeyPairRow {
  public_key: string;
  private_key: string;
}

type StoredSessionFormat = 'json' | 'base64';

export interface LibSignalBootstrapState {
  userId: string;
  registrationId: number;
  localLibsignalDeviceId?: number;
  signedPreKeyId: number;
  signedPreKeyPublicKey: string;
  signedPreKeySignature: string;
  signedPreKeyUpdatedAt?: string;
  nextSignedPreKeyId?: number;
  registrationUploaded: boolean;
  nextPreKeyId: number;
  preKeys: Array<{
    keyId: number;
    publicKey: string;
    uploaded: boolean;
  }>;
  createdAt: string;
  updatedAt: string;
}

export class LibSignalProtocolStore {
  readonly Direction = {
    SENDING: 1,
    RECEIVING: 2,
  };

  constructor(private readonly userId: string) {}

  async getIdentityKeyPair(): Promise<{ pubKey: ArrayBuffer; privKey: ArrayBuffer } | undefined> {
    const row = await signalStore.getRawMeta<KeyPairRow>(keyIdentityPair(this.userId));
    if (!row || typeof row.public_key !== 'string' || typeof row.private_key !== 'string') {
      return undefined;
    }

    return {
      pubKey: base64ToArrayBuffer(row.public_key),
      privKey: base64ToArrayBuffer(row.private_key),
    };
  }

  async putIdentityKeyPair(pair: { pubKey: ArrayBuffer; privKey: ArrayBuffer }): Promise<void> {
    await signalStore.putRawMeta(keyIdentityPair(this.userId), {
      public_key: arrayBufferToBase64(pair.pubKey),
      private_key: arrayBufferToBase64(pair.privKey),
      updatedAt: new Date().toISOString(),
    });
  }

  async getLocalRegistrationId(): Promise<number> {
    const row = await signalStore.getRawMeta<{ registration_id?: number }>(keyRegistrationId(this.userId));
    return Number.isInteger(row?.registration_id) ? Number(row?.registration_id) : 0;
  }

  async putLocalRegistrationId(registrationId: number): Promise<void> {
    await signalStore.putRawMeta(keyRegistrationId(this.userId), {
      registration_id: registrationId,
      updatedAt: new Date().toISOString(),
    });
  }

  async isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer | ArrayBufferLike | ArrayBufferView
  ): Promise<boolean> {
    const normalized = normalizeIdentityIdentifier(identifier);
    const row = await signalStore.getRawMeta<{ identity_key?: string }>(
      keyTrustedIdentity(this.userId, normalized)
    );
    if (!row?.identity_key) {
      return true;
    }
    return row.identity_key === arrayBufferToBase64(toArrayBuffer(identityKey));
  }

  async loadIdentityKey(identifier: string): Promise<ArrayBuffer | undefined> {
    const normalized = normalizeIdentityIdentifier(identifier);
    const row = await signalStore.getRawMeta<{ identity_key?: string }>(
      keyTrustedIdentity(this.userId, normalized)
    );
    if (!row?.identity_key) {
      return undefined;
    }
    return base64ToArrayBuffer(row.identity_key);
  }

  async saveIdentity(
    identifier: string,
    identityKey: ArrayBuffer | ArrayBufferLike | ArrayBufferView
  ): Promise<boolean> {
    const normalized = normalizeIdentityIdentifier(identifier);
    const existing = await signalStore.getRawMeta<{ identity_key?: string }>(
      keyTrustedIdentity(this.userId, normalized)
    );
    const nextKey = arrayBufferToBase64(toArrayBuffer(identityKey));

    if (existing?.identity_key) {
      if (existing.identity_key === nextKey) {
        return false;
      }

      // Keep the originally trusted key pinned. Identity replacement is a
      // security-sensitive event and must be handled explicitly by UX/recovery.
      await signalStore.putRawMeta(keyTrustedIdentityConflict(this.userId, normalized), {
        existing_identity_key: existing.identity_key,
        attempted_identity_key: nextKey,
        identifier: normalized,
        detectedAt: new Date().toISOString(),
      });
      return true;
    }

    await signalStore.putRawMeta(keyTrustedIdentity(this.userId, normalized), {
      identity_key: nextKey,
      updatedAt: new Date().toISOString(),
    });
    await signalStore.deleteRawMeta(keyTrustedIdentityConflict(this.userId, normalized));
    return false;
  }

  async loadPreKey(keyId: number): Promise<{ pubKey: ArrayBuffer; privKey: ArrayBuffer } | undefined> {
    const row = await signalStore.getRawMeta<KeyPairRow>(keyPreKey(this.userId, keyId));
    if (!row || typeof row.public_key !== 'string' || typeof row.private_key !== 'string') {
      return undefined;
    }
    return {
      pubKey: base64ToArrayBuffer(row.public_key),
      privKey: base64ToArrayBuffer(row.private_key),
    };
  }

  async storePreKey(keyId: number, keyPair: { pubKey: ArrayBuffer; privKey: ArrayBuffer }): Promise<void> {
    await signalStore.putRawMeta(keyPreKey(this.userId, keyId), {
      public_key: arrayBufferToBase64(keyPair.pubKey),
      private_key: arrayBufferToBase64(keyPair.privKey),
      updatedAt: new Date().toISOString(),
    });
  }

  async removePreKey(keyId: number): Promise<void> {
    await signalStore.deleteRawMeta(keyPreKey(this.userId, keyId));
  }

  async loadSignedPreKey(keyId: number): Promise<{ pubKey: ArrayBuffer; privKey: ArrayBuffer } | undefined> {
    const row = await signalStore.getRawMeta<KeyPairRow>(keySignedPreKey(this.userId, keyId));
    if (!row || typeof row.public_key !== 'string' || typeof row.private_key !== 'string') {
      return undefined;
    }
    return {
      pubKey: base64ToArrayBuffer(row.public_key),
      privKey: base64ToArrayBuffer(row.private_key),
    };
  }

  async storeSignedPreKey(
    keyId: number,
    keyPair: { pubKey: ArrayBuffer; privKey: ArrayBuffer }
  ): Promise<void> {
    await signalStore.putRawMeta(keySignedPreKey(this.userId, keyId), {
      public_key: arrayBufferToBase64(keyPair.pubKey),
      private_key: arrayBufferToBase64(keyPair.privKey),
      updatedAt: new Date().toISOString(),
    });
  }

  async removeSignedPreKey(keyId: number): Promise<void> {
    await signalStore.deleteRawMeta(keySignedPreKey(this.userId, keyId));
  }

  async loadSession(identifier: string): Promise<string | ArrayBuffer | undefined> {
    const row = await signalStore.getRawMeta<{
      session?: string;
      session_format?: StoredSessionFormat;
    }>(
      keySession(this.userId, identifier)
    );
    if (!row?.session) {
      return undefined;
    }
    if (row.session_format === 'json') {
      return row.session;
    }
    return base64ToArrayBuffer(row.session);
  }

  async storeSession(
    identifier: string,
    record: string | ArrayBuffer | ArrayBufferLike | ArrayBufferView
  ): Promise<void> {
    if (typeof record === 'string') {
      await signalStore.putRawMeta(keySession(this.userId, identifier), {
        session: record,
        session_format: 'json' satisfies StoredSessionFormat,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    await signalStore.putRawMeta(keySession(this.userId, identifier), {
      session: arrayBufferToBase64(toArrayBuffer(record)),
      session_format: 'base64' satisfies StoredSessionFormat,
      updatedAt: new Date().toISOString(),
    });
  }

  async removeSession(identifier: string): Promise<void> {
    await signalStore.deleteRawMeta(keySession(this.userId, identifier));
  }

  async removeAllSessions(identifierPrefix: string): Promise<void> {
    const prefix = keySession(this.userId, identifierPrefix);
    const rows = await signalStore.listRawMetaByPrefix<{ id?: string }>(prefix);
    await Promise.all(
      rows
        .map((row) => (typeof row.id === 'string' ? row.id : null))
        .filter((id): id is string => Boolean(id))
        .map((id) => signalStore.deleteRawMeta(id))
    );
  }

  async getBootstrapState(): Promise<LibSignalBootstrapState | null> {
    return signalStore.getRawMeta<LibSignalBootstrapState>(keyBootstrapState(this.userId));
  }

  async putBootstrapState(state: LibSignalBootstrapState): Promise<void> {
    await signalStore.putRawMeta(keyBootstrapState(this.userId), state as unknown as Record<string, unknown>);
  }

  async clearUserData(): Promise<void> {
    const rows = await signalStore.listRawMetaByPrefix<{ id?: string }>(
      `${LIBSIGNAL_PREFIX}`
    );
    const targetIds = rows
      .map((row) => (typeof row.id === 'string' ? row.id : null))
      .filter((id): id is string => typeof id === 'string' && id.includes(`:${this.userId}`));
    await Promise.all(targetIds.map((id) => signalStore.deleteRawMeta(id)));
  }
}

let libsignalLoadPromise: Promise<any> | null = null;

function patchLibsignalBundleSource(source: string): string {
  return source
    .replace(
      /^\s*import\s+LongRq\s+from\s+['"]long['"]\s*;?\s*\n?/,
      'var LongRq = (globalThis.dcodeIO && globalThis.dcodeIO.Long) || undefined;\n'
    )
    .replace(
      /var ENVIRONMENT_IS_NODE = typeof process === 'object' && typeof require === 'function';/,
      'var ENVIRONMENT_IS_NODE = false;'
    )
    .replace(
      /typeof require === 'function' && typeof module === "object" && module && module\["exports"\]/g,
      'false'
    )
    .replace(
      /typeof require === "function" && typeof module === "object" && module && module\["exports"\]/g,
      'false'
    )
    .replace(
      /var ProtoBuf = require\('protobufjs'\)/g,
      'var ProtoBuf = (globalThis.dcodeIO && globalThis.dcodeIO.ProtoBuf) || globalThis.ProtoBuf'
    )
    .replace(
      /var ByteBuffer = require\('mocha-bytebuffer'\)/g,
      'var ByteBuffer = (globalThis.dcodeIO && globalThis.dcodeIO.ByteBuffer) || globalThis.ByteBuffer'
    )
    .replace(/\}\)\(this,\s*function\(/g, '})(globalThis, function(')
    .replace(/\}\)\(this\);/g, '})(globalThis);');
}

async function loadPatchedLibsignalRuntimeBundle(): Promise<void> {
  const rawModule = await import('libsignal-protocol/dist/libsignal-protocol.js?raw');
  const rawSource = rawModule.default;
  if (typeof rawSource !== 'string' || rawSource.length === 0) {
    throw new Error('Failed to load libsignal bundle source');
  }

  const patchedSource = `${patchLibsignalBundleSource(rawSource)}\n//# sourceURL=void-libsignal-patched.js`;

  await new Promise<void>((resolve, reject) => {
    const blob = new Blob([patchedSource], { type: 'text/javascript' });
    const scriptUrl = URL.createObjectURL(blob);
    const script = document.createElement('script');

    script.async = true;
    script.src = scriptUrl;
    script.onload = () => {
      script.remove();
      URL.revokeObjectURL(scriptUrl);
      resolve();
    };
    script.onerror = () => {
      script.remove();
      URL.revokeObjectURL(scriptUrl);
      reject(new Error('Failed to execute patched libsignal bundle'));
    };

    document.head.appendChild(script);
  });
}

export async function getLibsignalRuntime(): Promise<any> {
  if (typeof window === 'undefined') {
    throw new Error('libsignal runtime is only available in browser context');
  }

  if (
    window.libsignal &&
    window.libsignal.KeyHelper &&
    typeof window.libsignal.KeyHelper.generateIdentityKeyPair === 'function'
  ) {
    return window.libsignal;
  }

  if (!libsignalLoadPromise) {
    libsignalLoadPromise = loadPatchedLibsignalRuntimeBundle()
      .then(() => {
        const runtime = window.libsignal;
        if (
          !runtime ||
          !runtime.KeyHelper ||
          typeof runtime.KeyHelper.generateIdentityKeyPair !== 'function'
        ) {
          throw new Error('libsignal runtime failed to initialize KeyHelper');
        }
        return runtime;
      })
      .catch((err) => {
        libsignalLoadPromise = null;
        throw err;
      });
  }

  return libsignalLoadPromise;
}

export function deriveLibsignalDeviceId(deviceId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < deviceId.length; index += 1) {
    hash ^= deviceId.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  const normalized = hash >>> 0;
  return (normalized % 16380) + 1;
}

export function libsignalBodyToArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    return toArrayBuffer(value);
  }

  if (ArrayBuffer.isView(value)) {
    return toArrayBuffer(value);
  }

  if (typeof value === 'string') {
    return binaryStringToArrayBuffer(value);
  }

  throw new Error('Unsupported libsignal ciphertext body type');
}
