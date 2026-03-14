import type { Conversation } from '../../Chat/chatService';
import { keyManager } from '../keyManager';
import { signalStore } from './signalStore';
import {
  fetchSignalCapabilities,
  fetchSignalDeviceInbox,
  getSignalPreKeyBundle,
  listSignalDevicesForUser,
  registerSignalDevice,
  sendSignalDeviceEnvelopes,
  uploadOneTimePreKeys,
  type SignalDeviceEnvelopePayload,
  type SignalDeviceInboxItem,
  type SignalPreKeyBundle,
} from './signalApi';
import type {
  SignalBootstrapResult,
  SignalConversationBootstrapInput,
  SignalDeviceIdentityRecord,
  SignalDmMessagePayload,
  SignalDmMessageEnvelopeEntry,
  SignalDmSessionRecord,
  SignalEncryptedEnvelopePayload,
  SignalGroupSenderKeyPayload,
  SignalLocalBootstrapMaterial,
  SignalPreparedConversationMessage,
  SignalServerCapabilities,
} from './signalTypes';

const INITIAL_PREKEY_BATCH_SIZE = 24;
const PREKEY_REPLENISH_THRESHOLD = 8;
const SIGNAL_PROTOCOL_MARKER = 'void-signal-v1';
const SIGNAL_DM_MESSAGE_KIND = 'dm_message';
const MAX_ENVELOPE_BATCH = 200;
const INBOX_PAGE_LIMIT = 100;
const MAX_INBOX_PAGES_PER_SYNC = 4;
const INBOX_SYNC_MIN_INTERVAL_MS = 15000;
const DEVICE_DIRECTORY_CACHE_MS = 10000;
const DEVICE_REGISTRATION_RECHECK_MS = 60000;
const MAX_SKIPPED_MESSAGE_KEYS = 256;
const MAX_SKIP_AHEAD = 256;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const MISSING_DM_REQUIREMENTS = [
  'server_device_registry',
  'prekey_bundle_endpoint',
  'device_targeted_message_fanout',
];

const MISSING_GROUP_REQUIREMENTS = [
  ...MISSING_DM_REQUIREMENTS,
  'member_device_directory',
  'group_sender_key_distribution',
  'membership_change_sender_key_rotation',
];

function generateRegistrationId(): number {
  const bytes = crypto.getRandomValues(new Uint16Array(1));
  const first = bytes[0] ?? 1;
  // Keep the value inside the traditional Signal registration-id range.
  return (first % 16380) + 1;
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

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return toArrayBuffer(bytes);
}

function isValidCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function concatBuffers(...buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    out.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return out.buffer;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function resolveGroupConversationId(input: SignalConversationBootstrapInput): string {
  const { conversation } = input;
  return conversation.parent_conversation_id || conversation.id;
}

function resolveConversationKeyId(conversation: Conversation): string {
  return conversation.parent_conversation_id || conversation.id;
}

function collectDmMissingRequirements(capabilities: SignalServerCapabilities): string[] {
  const missing: string[] = [];
  if (!capabilities.deviceRegistry) missing.push('server_device_registry');
  if (!capabilities.prekeyBundles) missing.push('prekey_bundle_endpoint');
  if (!capabilities.deviceMessageFanout) missing.push('device_targeted_message_fanout');
  return missing;
}

function collectGroupMissingRequirements(capabilities: SignalServerCapabilities): string[] {
  const missing = collectDmMissingRequirements(capabilities);
  if (!capabilities.groupSenderKeys) missing.push('group_sender_key_distribution');
  if (!capabilities.membershipRotationHooks) missing.push('membership_change_sender_key_rotation');
  // Member device directory can be part of either registry or dedicated endpoint.
  if (!capabilities.deviceRegistry) missing.push('member_device_directory');
  return Array.from(new Set(missing));
}

function hasStructuredBootstrapMaterial(
  value: SignalLocalBootstrapMaterial | null
): value is SignalLocalBootstrapMaterial {
  if (!value) return false;

  return Boolean(
    value.identityKey &&
    typeof value.identityKey.publicKey === 'string' &&
    typeof value.identityKey.privateKey === 'string' &&
    value.signedPreKey &&
    Number.isInteger(value.signedPreKey.keyId) &&
    typeof value.signedPreKey.publicKey === 'string' &&
    typeof value.signedPreKey.privateKey === 'string' &&
    Array.isArray(value.oneTimePreKeys) &&
    value.oneTimePreKeys.every((preKey) =>
      Number.isInteger(preKey.keyId) &&
      typeof preKey.publicKey === 'string' &&
      typeof preKey.privateKey === 'string'
    )
  );
}

function parseEncryptedEnvelopePayload(value: string): SignalEncryptedEnvelopePayload | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.protocol !== SIGNAL_PROTOCOL_MARKER ||
      parsed.version !== 1 ||
      (parsed.mode !== 'prekey' && parsed.mode !== 'signal') ||
      typeof parsed.iv !== 'string' ||
      typeof parsed.ciphertext !== 'string'
    ) {
      return null;
    }

    const payload: SignalEncryptedEnvelopePayload = {
      protocol: SIGNAL_PROTOCOL_MARKER,
      version: 1,
      mode: parsed.mode,
      iv: parsed.iv,
      ciphertext: parsed.ciphertext,
    };

    if (parsed.mode === 'signal' && isValidCounter(parsed.counter)) {
      payload.counter = parsed.counter;
    }

    if (isValidCounter(parsed.previous_counter) || parsed.previous_counter === 0) {
      payload.previous_counter = Number(parsed.previous_counter);
    }

    if (typeof parsed.ratchet_public_key === 'string') {
      payload.ratchet_public_key = parsed.ratchet_public_key;
    }

    if (parsed.mode === 'prekey') {
      if (isValidCounter(parsed.signed_prekey_id)) {
        payload.signed_prekey_id = parsed.signed_prekey_id;
      }
      if (isValidCounter(parsed.one_time_prekey_id)) {
        payload.one_time_prekey_id = parsed.one_time_prekey_id;
      } else if (parsed.one_time_prekey_id === null) {
        payload.one_time_prekey_id = null;
      }
      if (typeof parsed.ephemeral_public_key === 'string') {
        payload.ephemeral_public_key = parsed.ephemeral_public_key;
      }
      if (typeof parsed.sender_identity_key === 'string') {
        payload.sender_identity_key = parsed.sender_identity_key;
      }
    }

    return payload;
  } catch {
    return null;
  }
}

function parseGroupSenderKeyPayload(value: string): SignalGroupSenderKeyPayload | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.kind !== 'group_sender_key' ||
      typeof parsed.conversation_id !== 'string' ||
      !isValidCounter(parsed.key_version) ||
      typeof parsed.group_key !== 'string' ||
      typeof parsed.sent_at !== 'string'
    ) {
      return null;
    }

    return {
      kind: 'group_sender_key',
      conversation_id: parsed.conversation_id,
      key_version: parsed.key_version,
      group_key: parsed.group_key,
      sent_at: parsed.sent_at,
    };
  } catch {
    return null;
  }
}

function parseDmMessagePayload(value: string): SignalDmMessagePayload | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.protocol !== SIGNAL_PROTOCOL_MARKER ||
      parsed.kind !== SIGNAL_DM_MESSAGE_KIND ||
      parsed.version !== 1 ||
      typeof parsed.sender_user_id !== 'string' ||
      typeof parsed.sender_device_id !== 'string' ||
      typeof parsed.sent_at !== 'string' ||
      !Array.isArray(parsed.envelopes)
    ) {
      return null;
    }

    const envelopes: SignalDmMessageEnvelopeEntry[] = [];
    for (const rawEnvelope of parsed.envelopes) {
      if (!rawEnvelope || typeof rawEnvelope !== 'object') {
        continue;
      }

      const envelope = rawEnvelope as Record<string, unknown>;
      if (
        typeof envelope.recipient_user_id !== 'string' ||
        typeof envelope.recipient_device_id !== 'string' ||
        (envelope.type !== 'prekey' && envelope.type !== 'signal') ||
        typeof envelope.payload !== 'object' ||
        envelope.payload == null
      ) {
        continue;
      }

      const parsedPayload = parseEncryptedEnvelopePayload(JSON.stringify(envelope.payload));
      if (!parsedPayload) {
        continue;
      }

      envelopes.push({
        recipient_user_id: envelope.recipient_user_id,
        recipient_device_id: envelope.recipient_device_id,
        type: envelope.type,
        payload: parsedPayload,
      });
    }

    if (envelopes.length === 0) {
      return null;
    }

    let fallback: SignalDmMessagePayload['fallback'] = undefined;
    if (parsed.fallback && typeof parsed.fallback === 'object') {
      const fb = parsed.fallback as Record<string, unknown>;
      if (typeof fb.encrypted_content === 'string' && typeof fb.iv === 'string') {
        fallback = { encrypted_content: fb.encrypted_content, iv: fb.iv };
      }
    }

    return {
      protocol: SIGNAL_PROTOCOL_MARKER,
      kind: SIGNAL_DM_MESSAGE_KIND,
      version: 1,
      sender_user_id: parsed.sender_user_id,
      sender_device_id: parsed.sender_device_id,
      sent_at: parsed.sent_at,
      envelopes,
      fallback,
    };
  } catch {
    return null;
  }
}

type SignalSkippedMessageKey = {
  counter: number;
  ratchetPublicKey: string;
  messageKey: string;
};

function parseSkippedMessageKeys(serialized: string | null | undefined): SignalSkippedMessageKey[] {
  if (!serialized) return [];
  try {
    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) =>
        entry &&
        typeof entry.counter === 'number' &&
        Number.isInteger(entry.counter) &&
        entry.counter > 0 &&
        typeof entry.ratchetPublicKey === 'string' &&
        typeof entry.messageKey === 'string'
      )
      .map((entry) => ({
        counter: entry.counter,
        ratchetPublicKey: entry.ratchetPublicKey,
        messageKey: entry.messageKey,
      }));
  } catch {
    return [];
  }
}

function serializeSkippedMessageKeys(entries: SignalSkippedMessageKey[]): string | null {
  if (entries.length === 0) return null;
  return JSON.stringify(entries.slice(-MAX_SKIPPED_MESSAGE_KEYS));
}

async function exportEcIdentityKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const exportedPublic = await crypto.subtle.exportKey('spki', pair.publicKey);
  const exportedPrivate = await crypto.subtle.exportKey('pkcs8', pair.privateKey);

  return {
    publicKey: arrayBufferToBase64(exportedPublic),
    privateKey: arrayBufferToBase64(exportedPrivate),
  };
}

async function exportEcdhKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const exportedPublic = await crypto.subtle.exportKey('spki', pair.publicKey);
  const exportedPrivate = await crypto.subtle.exportKey('pkcs8', pair.privateKey);

  return {
    publicKey: arrayBufferToBase64(exportedPublic),
    privateKey: arrayBufferToBase64(exportedPrivate),
  };
}

async function importEcdhPublicKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(base64Key),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

async function importEcdhPrivateKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    base64ToArrayBuffer(base64Key),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
}

async function importEcdsaPublicKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(base64Key),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
}

async function importEcdsaPrivateKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    base64ToArrayBuffer(base64Key),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  );
}

async function signSignedPreKey(identityPrivateKey: string, signedPreKeyPublicKey: string): Promise<string> {
  const key = await importEcdsaPrivateKey(identityPrivateKey);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    base64ToArrayBuffer(signedPreKeyPublicKey)
  );
  return arrayBufferToBase64(signature);
}

async function verifySignedPreKeySignature(
  identityPublicKey: string,
  signedPreKeyPublicKey: string,
  signature: string
): Promise<boolean> {
  const key = await importEcdsaPublicKey(identityPublicKey);
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    base64ToArrayBuffer(signature),
    base64ToArrayBuffer(signedPreKeyPublicKey)
  );
}

async function deriveEcdhBits(privateKeyBase64: string, publicKeyBase64: string): Promise<ArrayBuffer> {
  const privateKey = await importEcdhPrivateKey(privateKeyBase64);
  const publicKey = await importEcdhPublicKey(publicKeyBase64);

  return crypto.subtle.deriveBits(
    {
      name: 'ECDH',
      public: publicKey,
    },
    privateKey,
    256
  );
}

async function deriveHkdfBits(ikm: ArrayBuffer, salt: ArrayBuffer, info: string, bits: number): Promise<ArrayBuffer> {
  const material = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: toArrayBuffer(textEncoder.encode(info)),
    },
    material,
    bits
  );
}

async function deriveRootAndChainKeys(
  rootKeyBase64: string | null | undefined,
  dhOutput: ArrayBuffer
): Promise<{ rootKey: string; chainKey: string }> {
  const salt = rootKeyBase64
    ? base64ToArrayBuffer(rootKeyBase64)
    : new ArrayBuffer(32);
  const output = new Uint8Array(
    await deriveHkdfBits(dhOutput, salt, `${SIGNAL_PROTOCOL_MARKER}:root-chain`, 512)
  );

  return {
    rootKey: uint8ToBase64(output.slice(0, 32)),
    chainKey: uint8ToBase64(output.slice(32, 64)),
  };
}

async function hmacSha256Base64(
  keyBase64: string,
  payload: ArrayBuffer | ArrayBufferLike | ArrayBufferView
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToArrayBuffer(keyBase64),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, toArrayBuffer(payload));
  return arrayBufferToBase64(signature);
}

async function deriveMessageKeyFromChain(chainKeyBase64: string): Promise<{ nextChainKey: string; messageKey: string }> {
  const messageKey = await hmacSha256Base64(chainKeyBase64, new Uint8Array([0x01]));
  const nextChainKey = await hmacSha256Base64(chainKeyBase64, new Uint8Array([0x02]));
  return { nextChainKey, messageKey };
}

async function deriveMessageKeyBase64(sessionKeyBase64: string, counter: number): Promise<string> {
  const seed = concatBuffers(
    base64ToArrayBuffer(sessionKeyBase64),
    toArrayBuffer(textEncoder.encode(`${SIGNAL_PROTOCOL_MARKER}:msg:${counter}`))
  );
  const digest = await crypto.subtle.digest('SHA-256', seed);
  return arrayBufferToBase64(digest);
}

async function importAesKeyFromBase64(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    base64ToArrayBuffer(base64Key),
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

async function encryptWithAesKeyBase64(
  keyBase64: string,
  plaintext: string
): Promise<{ iv: string; ciphertext: string }> {
  const key = await importAesKeyFromBase64(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    toArrayBuffer(textEncoder.encode(plaintext))
  );

  return {
    iv: uint8ToBase64(iv),
    ciphertext: arrayBufferToBase64(encrypted),
  };
}

async function decryptWithAesKeyBase64(
  keyBase64: string,
  ivBase64: string,
  ciphertextBase64: string
): Promise<string> {
  const key = await importAesKeyFromBase64(keyBase64);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToArrayBuffer(ivBase64),
    },
    key,
    base64ToArrayBuffer(ciphertextBase64)
  );

  return textDecoder.decode(decrypted);
}

async function createBootstrapMaterial(userId: string): Promise<SignalLocalBootstrapMaterial> {
  const now = new Date().toISOString();
  const identityKey = await exportEcIdentityKeyPair();
  const signedPreKeyPair = await exportEcdhKeyPair();
  const oneTimePreKeys: SignalLocalBootstrapMaterial['oneTimePreKeys'] = [];

  for (let index = 0; index < INITIAL_PREKEY_BATCH_SIZE; index += 1) {
    const keyPair = await exportEcdhKeyPair();
    oneTimePreKeys.push({
      keyId: index + 1,
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      uploaded: false,
      usedAt: null,
    });
  }

  return {
    userId,
    identityKey,
    signedPreKey: {
      keyId: 1,
      publicKey: signedPreKeyPair.publicKey,
      privateKey: signedPreKeyPair.privateKey,
      signature: await signSignedPreKey(identityKey.privateKey, signedPreKeyPair.publicKey),
    },
    oneTimePreKeys,
    nextPreKeyId: INITIAL_PREKEY_BATCH_SIZE + 1,
    registrationUploaded: false,
    createdAt: now,
    updatedAt: now,
  };
}

class SignalService {
  private identityLocks = new Map<string, Promise<SignalDeviceIdentityRecord>>();
  private deviceBootstrapLocks = new Map<string, Promise<void>>();
  private dmProbeLocks = new Map<string, Promise<void>>();
  private inboxSyncLocks = new Map<string, Promise<void>>();
  private inboxSyncLastRunAt = new Map<string, number>();
  private bootstrapRegistrationCheckAt = new Map<string, number>();
  private deviceDirectoryCache = new Map<
    string,
    {
      fetchedAt: number;
      devices: Awaited<ReturnType<typeof listSignalDevicesForUser>>;
    }
  >();
  private groupSenderKeyLocks = new Map<string, Promise<void>>();
  private serverCapabilitiesPromise: Promise<SignalServerCapabilities> | null = null;

  isEnabled() {
    return true;
  }

  private async getServerCapabilities(): Promise<SignalServerCapabilities> {
    if (!this.serverCapabilitiesPromise) {
      this.serverCapabilitiesPromise = fetchSignalCapabilities()
        .catch((err) => {
          console.warn('Failed to fetch Signal server capabilities:', err);
          return {
            supported: false,
            deviceRegistry: false,
            prekeyBundles: false,
            deviceMessageFanout: false,
            groupSenderKeys: false,
            membershipRotationHooks: false,
            reason: 'capabilities_fetch_failed',
          } satisfies SignalServerCapabilities;
        });
    }

    return this.serverCapabilitiesPromise;
  }

  private async getKnownDevicesForUser(
    userId: string,
    options?: { force?: boolean }
  ): Promise<Awaited<ReturnType<typeof listSignalDevicesForUser>>> {
    const now = Date.now();
    const cached = this.deviceDirectoryCache.get(userId);
    if (
      !options?.force &&
      cached &&
      now - cached.fetchedAt < DEVICE_DIRECTORY_CACHE_MS
    ) {
      return cached.devices;
    }

    const devices = await listSignalDevicesForUser(userId);
    this.deviceDirectoryCache.set(userId, { fetchedAt: now, devices });
    return devices;
  }

  private async getOrCreateBootstrapMaterial(userId: string): Promise<SignalLocalBootstrapMaterial> {
    const existing = await signalStore.getBootstrapMaterial(userId);
    if (hasStructuredBootstrapMaterial(existing)) {
      return existing;
    }

    const generated = await createBootstrapMaterial(userId);
    await signalStore.putBootstrapMaterial(generated);
    return generated;
  }

  async ensureLocalDeviceIdentity(userId: string): Promise<SignalDeviceIdentityRecord | null> {
    if (!this.isEnabled()) return null;

    const existing = await signalStore.getDeviceIdentity(userId);
    if (existing) return existing;

    const lock = this.identityLocks.get(userId);
    if (lock) return lock;

    const identityPromise = (async () => {
      const now = new Date().toISOString();
      const nextIdentity: SignalDeviceIdentityRecord = {
        userId,
        deviceId: crypto.randomUUID(),
        registrationId: generateRegistrationId(),
        createdAt: now,
        updatedAt: now,
      };
      await signalStore.putDeviceIdentity(nextIdentity);
      return nextIdentity;
    })();

    this.identityLocks.set(userId, identityPromise);

    try {
      return await identityPromise;
    } finally {
      this.identityLocks.delete(userId);
    }
  }

  private async ensureServerBootstrap(
    userId: string,
    localIdentity: SignalDeviceIdentityRecord,
    capabilities: SignalServerCapabilities
  ): Promise<void> {
    if (!capabilities.supported || !capabilities.deviceRegistry || !capabilities.prekeyBundles) {
      return;
    }

    const lock = this.deviceBootstrapLocks.get(userId);
    if (lock) {
      await lock;
      return;
    }

    const bootstrapPromise = (async () => {
      try {
        let bootstrapMaterial = await this.getOrCreateBootstrapMaterial(userId);
        let didChange = false;

        // Self-heal for fresh server state (e.g., DB reset): local bootstrap may say
        // "already uploaded" while server has no record for this device.
        const lastCheck = this.bootstrapRegistrationCheckAt.get(userId) || 0;
        const shouldRecheckRegistration =
          !bootstrapMaterial.registrationUploaded ||
          Date.now() - lastCheck >= DEVICE_REGISTRATION_RECHECK_MS;

        if (shouldRecheckRegistration) {
          try {
            const serverDevices = await this.getKnownDevicesForUser(userId, { force: true });
            this.bootstrapRegistrationCheckAt.set(userId, Date.now());

            const isRegisteredOnServer = serverDevices.some(
              (device) => String(device.device_id) === String(localIdentity.deviceId)
            );

            if (!isRegisteredOnServer) {
              bootstrapMaterial.registrationUploaded = false;
              // Only re-upload prekeys that haven't been consumed yet.
              // Consumed prekeys must never be re-uploaded — the server would
              // resurrect them, causing X3DH mismatches and decrypt failures.
              bootstrapMaterial.oneTimePreKeys = bootstrapMaterial.oneTimePreKeys.map((preKey) => ({
                ...preKey,
                uploaded: preKey.usedAt ? true : false,
              }));
              didChange = true;
            }
          } catch (err) {
            console.warn('Signal bootstrap: failed to verify existing server device registration', err);
          }
        }

        if (!bootstrapMaterial.registrationUploaded) {
          try {
            await registerSignalDevice({
              device_id: localIdentity.deviceId,
              registration_id: localIdentity.registrationId,
              identity_key: bootstrapMaterial.identityKey.publicKey,
              signed_prekey: {
                key_id: bootstrapMaterial.signedPreKey.keyId,
                public_key: bootstrapMaterial.signedPreKey.publicKey,
                signature: bootstrapMaterial.signedPreKey.signature,
              },
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err || '');
            if (!message.includes('signature is invalid')) {
              throw err;
            }

            // If legacy/local-stale bootstrap data is invalid for current checks,
            // regenerate it once and retry registration.
            bootstrapMaterial = await createBootstrapMaterial(userId);
            await signalStore.putBootstrapMaterial(bootstrapMaterial);

            await registerSignalDevice({
              device_id: localIdentity.deviceId,
              registration_id: localIdentity.registrationId,
              identity_key: bootstrapMaterial.identityKey.publicKey,
              signed_prekey: {
                key_id: bootstrapMaterial.signedPreKey.keyId,
                public_key: bootstrapMaterial.signedPreKey.publicKey,
                signature: bootstrapMaterial.signedPreKey.signature,
              },
            });
          }

          bootstrapMaterial.registrationUploaded = true;
          this.deviceDirectoryCache.delete(userId);
          didChange = true;
        }

        const pendingPreKeys = bootstrapMaterial.oneTimePreKeys.filter((preKey) => !preKey.uploaded);
        if (pendingPreKeys.length > 0) {
          await uploadOneTimePreKeys({
            device_id: localIdentity.deviceId,
            prekeys: pendingPreKeys.map((preKey) => ({
              key_id: preKey.keyId,
              public_key: preKey.publicKey,
            })),
          });

          bootstrapMaterial.oneTimePreKeys = bootstrapMaterial.oneTimePreKeys.map((preKey) =>
            pendingPreKeys.some((pending) => pending.keyId === preKey.keyId)
              ? { ...preKey, uploaded: true }
              : preKey
          );
          didChange = true;
        }

        // Replenish prekeys when available pool drops below threshold.
        const availablePreKeys = bootstrapMaterial.oneTimePreKeys.filter(
          (preKey) => preKey.uploaded && !preKey.usedAt
        );
        if (availablePreKeys.length < PREKEY_REPLENISH_THRESHOLD) {
          const newBatchSize = INITIAL_PREKEY_BATCH_SIZE - availablePreKeys.length;
          let nextId = bootstrapMaterial.nextPreKeyId || (INITIAL_PREKEY_BATCH_SIZE + 1);
          const freshPreKeys: SignalLocalBootstrapMaterial['oneTimePreKeys'] = [];

          for (let i = 0; i < newBatchSize; i += 1) {
            const keyPair = await exportEcdhKeyPair();
            freshPreKeys.push({
              keyId: nextId,
              publicKey: keyPair.publicKey,
              privateKey: keyPair.privateKey,
              uploaded: false,
              usedAt: null,
            });
            nextId += 1;
          }

          if (freshPreKeys.length > 0) {
            await uploadOneTimePreKeys({
              device_id: localIdentity.deviceId,
              prekeys: freshPreKeys.map((preKey) => ({
                key_id: preKey.keyId,
                public_key: preKey.publicKey,
              })),
            });

            bootstrapMaterial.oneTimePreKeys = [
              ...bootstrapMaterial.oneTimePreKeys,
              ...freshPreKeys.map((preKey) => ({ ...preKey, uploaded: true })),
            ];
            bootstrapMaterial.nextPreKeyId = nextId;
            didChange = true;
          }
        }

        if (didChange) {
          bootstrapMaterial.updatedAt = new Date().toISOString();
          await signalStore.putBootstrapMaterial(bootstrapMaterial);
        }
      } catch (err) {
        console.warn('Signal device bootstrap failed:', err);
      }
    })();

    this.deviceBootstrapLocks.set(userId, bootstrapPromise);

    try {
      await bootstrapPromise;
    } finally {
      this.deviceBootstrapLocks.delete(userId);
    }
  }

  private async probeDmPeersForBootstrap(userId: string, peerUserId: string): Promise<void> {
    const lockKey = `${userId}:${peerUserId}`;
    const lock = this.dmProbeLocks.get(lockKey);
    if (lock) {
      await lock;
      return;
    }

    const probePromise = (async () => {
      try {
        const peerDevices = await this.getKnownDevicesForUser(peerUserId);
        if (peerDevices.length === 0) return;

        const now = new Date().toISOString();

        for (const peerDevice of peerDevices) {
          const existing = await signalStore.getDmSession(
            userId,
            peerUserId,
            peerDevice.device_id
          );
          if (existing) continue;

          // Session slot discovered; a prekey envelope will establish it on demand.
          await signalStore.upsertDmSession({
            userId,
            peerUserId,
            peerDeviceId: peerDevice.device_id,
            lastEstablishedAt: now,
            sessionVersion: 0,
            sessionKey: null,
            sendCounter: 0,
            receiveCounter: 0,
          });
        }
      } catch (err) {
        console.warn('Signal DM device probe failed:', err);
      }
    })();

    this.dmProbeLocks.set(lockKey, probePromise);
    try {
      await probePromise;
    } finally {
      this.dmProbeLocks.delete(lockKey);
    }
  }

  private async createPreKeyEnvelope(
    userId: string,
    peerUserId: string,
    peerDeviceId: string,
    plaintext: string
  ): Promise<{
    payload: SignalEncryptedEnvelopePayload;
    session: SignalDmSessionRecord;
  }> {
    const bootstrapMaterial = await this.getOrCreateBootstrapMaterial(userId);
    const bundle: SignalPreKeyBundle = await getSignalPreKeyBundle(peerUserId, peerDeviceId);
    const isValidSignature = await verifySignedPreKeySignature(
      bundle.identity_key,
      bundle.signed_prekey.public_key,
      bundle.signed_prekey.signature
    );
    if (!isValidSignature) {
      throw new Error('Invalid signed prekey signature from peer device');
    }

    const ephemeral = await exportEcdhKeyPair();
    const sharedParts: ArrayBuffer[] = [
      // X3DH-style DH1: IK_a x SPK_b
      await deriveEcdhBits(bootstrapMaterial.identityKey.privateKey, bundle.signed_prekey.public_key),
      // X3DH-style DH2: EK_a x IK_b
      await deriveEcdhBits(ephemeral.privateKey, bundle.identity_key),
      // X3DH-style DH3: EK_a x SPK_b
      await deriveEcdhBits(ephemeral.privateKey, bundle.signed_prekey.public_key),
    ];

    if (bundle.one_time_prekey?.public_key) {
      // X3DH-style DH4: EK_a x OPK_b
      sharedParts.push(await deriveEcdhBits(ephemeral.privateKey, bundle.one_time_prekey.public_key));
    }

    const initialSecret = concatBuffers(...sharedParts);
    const { rootKey, chainKey } = await deriveRootAndChainKeys(null, initialSecret);
    const { nextChainKey, messageKey } = await deriveMessageKeyFromChain(chainKey);
    const encrypted = await encryptWithAesKeyBase64(messageKey, plaintext);
    const now = new Date().toISOString();

    return {
      payload: {
        protocol: SIGNAL_PROTOCOL_MARKER,
        version: 1,
        mode: 'prekey',
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        counter: 1,
        previous_counter: 0,
        ratchet_public_key: ephemeral.publicKey,
        sender_identity_key: bootstrapMaterial.identityKey.publicKey,
        ephemeral_public_key: ephemeral.publicKey,
        signed_prekey_id: bundle.signed_prekey.key_id,
        one_time_prekey_id: bundle.one_time_prekey?.key_id ?? null,
      },
      session: {
        userId,
        peerUserId,
        peerDeviceId,
        lastEstablishedAt: now,
        sessionVersion: 2,
        sessionKey: null,
        rootKey,
        sendChainKey: nextChainKey,
        receiveChainKey: null,
        localRatchetPublicKey: ephemeral.publicKey,
        localRatchetPrivateKey: ephemeral.privateKey,
        remoteRatchetPublicKey: bundle.signed_prekey.public_key,
        previousChainLength: 0,
        pendingRatchet: false,
        skippedMessageKeys: null,
        sendCounter: 1,
        receiveCounter: 0,
      },
    };
  }

  private async validateSenderDeviceIdentity(
    senderUserId: string,
    senderDeviceId: string,
    senderIdentityKey: string
  ): Promise<boolean> {
    try {
      const devices = await this.getKnownDevicesForUser(senderUserId);
      const senderDevice = devices.find(
        (device) => String(device.device_id) === String(senderDeviceId)
      );
      if (!senderDevice || typeof senderDevice.identity_key !== 'string') {
        return false;
      }

      if (senderDevice.identity_key !== senderIdentityKey) {
        return false;
      }

      if (
        typeof senderDevice.signed_prekey_public_key === 'string' &&
        senderDevice.signed_prekey_public_key.length > 0 &&
        typeof senderDevice.signed_prekey_signature === 'string' &&
        senderDevice.signed_prekey_signature.length > 0
      ) {
        return verifySignedPreKeySignature(
          senderDevice.identity_key,
          senderDevice.signed_prekey_public_key,
          senderDevice.signed_prekey_signature
        );
      }

      return true;
    } catch (err) {
      console.warn('Signal sender identity validation failed:', err);
      // Avoid transient network issues turning into permanent message loss.
      return true;
    }
  }

  private async createSignalEnvelope(
    existingSession: SignalDmSessionRecord,
    plaintext: string
  ): Promise<{
    payload: SignalEncryptedEnvelopePayload;
    nextSession: SignalDmSessionRecord;
  }> {
    // Legacy fallback for pre-ratchet sessions.
    if (!existingSession.rootKey || !existingSession.remoteRatchetPublicKey) {
      if (!existingSession.sessionKey) {
        throw new Error('Signal session key is missing');
      }
      const nextCounter = (existingSession.sendCounter || 0) + 1;
      const messageKey = await deriveMessageKeyBase64(existingSession.sessionKey, nextCounter);
      const encrypted = await encryptWithAesKeyBase64(messageKey, plaintext);
      return {
        payload: {
          protocol: SIGNAL_PROTOCOL_MARKER,
          version: 1,
          mode: 'signal',
          iv: encrypted.iv,
          ciphertext: encrypted.ciphertext,
          counter: nextCounter,
        },
        nextSession: {
          ...existingSession,
          sessionVersion: Math.max(1, existingSession.sessionVersion),
          sendCounter: nextCounter,
        },
      };
    }

    const nextSession: SignalDmSessionRecord = {
      ...existingSession,
      sessionVersion: Math.max(2, existingSession.sessionVersion),
      skippedMessageKeys: existingSession.skippedMessageKeys || null,
    };
    let nextRatchetPublic: string | undefined;
    let previousCounter = nextSession.previousChainLength || 0;

    if (
      nextSession.pendingRatchet ||
      !nextSession.sendChainKey ||
      !nextSession.localRatchetPrivateKey ||
      !nextSession.localRatchetPublicKey
    ) {
      if (!nextSession.remoteRatchetPublicKey) {
        throw new Error('Missing remote ratchet public key');
      }
      const freshRatchet = await exportEcdhKeyPair();
      const dhOutput = await deriveEcdhBits(
        freshRatchet.privateKey,
        nextSession.remoteRatchetPublicKey
      );
      const { rootKey, chainKey } = await deriveRootAndChainKeys(nextSession.rootKey, dhOutput);

      previousCounter = nextSession.sendCounter || 0;
      nextSession.rootKey = rootKey;
      nextSession.sendChainKey = chainKey;
      nextSession.localRatchetPublicKey = freshRatchet.publicKey;
      nextSession.localRatchetPrivateKey = freshRatchet.privateKey;
      nextSession.previousChainLength = previousCounter;
      nextSession.sendCounter = 0;
      nextSession.pendingRatchet = false;
      nextRatchetPublic = freshRatchet.publicKey;
    }

    if (!nextSession.sendChainKey) {
      throw new Error('Missing sending chain key');
    }

    const { nextChainKey, messageKey } = await deriveMessageKeyFromChain(nextSession.sendChainKey);
    const nextCounter = (nextSession.sendCounter || 0) + 1;
    const encrypted = await encryptWithAesKeyBase64(messageKey, plaintext);
    nextSession.sendChainKey = nextChainKey;
    nextSession.sendCounter = nextCounter;

    return {
      payload: {
        protocol: SIGNAL_PROTOCOL_MARKER,
        version: 1,
        mode: 'signal',
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        counter: nextCounter,
        previous_counter: previousCounter,
        ...(nextRatchetPublic ? { ratchet_public_key: nextRatchetPublic } : {}),
      },
      nextSession,
    };
  }

  private async createSelfDevicePreKeyEnvelope(
    userId: string,
    selfDeviceId: string,
    plaintext: string
  ): Promise<{
    payload: SignalEncryptedEnvelopePayload;
    session: SignalDmSessionRecord;
  }> {
    // For self-device envelopes we derive the session locally from our own
    // bootstrap material instead of fetching (and consuming) a prekey bundle
    // from the server.  This avoids burning our own one-time prekeys.
    const bootstrapMaterial = await this.getOrCreateBootstrapMaterial(userId);
    const ephemeral = await exportEcdhKeyPair();

    // Symmetric X3DH with ourselves: IK × SPK + EK × IK + EK × SPK
    const sharedParts: ArrayBuffer[] = [
      await deriveEcdhBits(bootstrapMaterial.identityKey.privateKey, bootstrapMaterial.signedPreKey.publicKey),
      await deriveEcdhBits(ephemeral.privateKey, bootstrapMaterial.identityKey.publicKey),
      await deriveEcdhBits(ephemeral.privateKey, bootstrapMaterial.signedPreKey.publicKey),
    ];

    const initialSecret = concatBuffers(...sharedParts);
    const { rootKey, chainKey } = await deriveRootAndChainKeys(null, initialSecret);
    const { nextChainKey, messageKey } = await deriveMessageKeyFromChain(chainKey);
    const encrypted = await encryptWithAesKeyBase64(messageKey, plaintext);
    const now = new Date().toISOString();

    return {
      payload: {
        protocol: SIGNAL_PROTOCOL_MARKER,
        version: 1,
        mode: 'prekey',
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        counter: 1,
        previous_counter: 0,
        ratchet_public_key: ephemeral.publicKey,
        sender_identity_key: bootstrapMaterial.identityKey.publicKey,
        ephemeral_public_key: ephemeral.publicKey,
        signed_prekey_id: bootstrapMaterial.signedPreKey.keyId,
        one_time_prekey_id: null,
      },
      session: {
        userId,
        peerUserId: userId,
        peerDeviceId: selfDeviceId,
        lastEstablishedAt: now,
        sessionVersion: 2,
        sessionKey: null,
        rootKey,
        sendChainKey: nextChainKey,
        receiveChainKey: null,
        localRatchetPublicKey: ephemeral.publicKey,
        localRatchetPrivateKey: ephemeral.privateKey,
        remoteRatchetPublicKey: bootstrapMaterial.signedPreKey.publicKey,
        previousChainLength: 0,
        pendingRatchet: false,
        skippedMessageKeys: null,
        sendCounter: 1,
        receiveCounter: 0,
      },
    };
  }

  private async buildEncryptedPayloadForDevice(
    userId: string,
    peerUserId: string,
    peerDeviceId: string,
    plaintext: string
  ): Promise<{ type: 'prekey' | 'signal'; payload: SignalEncryptedEnvelopePayload } | null> {
    const existingSession = await signalStore.getDmSession(userId, peerUserId, peerDeviceId);

    try {
      let payload: SignalEncryptedEnvelopePayload;
      let type: 'prekey' | 'signal';

      if (
        existingSession?.sessionVersion &&
        existingSession.sessionVersion > 0 &&
        (existingSession.rootKey || existingSession.sessionKey)
      ) {
        const signalEnvelope = await this.createSignalEnvelope(existingSession, plaintext);
        payload = signalEnvelope.payload;
        type = 'signal';
        await signalStore.upsertDmSession(signalEnvelope.nextSession);
      } else if (String(peerUserId) === String(userId)) {
        // Self-device: derive session locally without consuming server prekeys.
        const selfEnvelope = await this.createSelfDevicePreKeyEnvelope(userId, peerDeviceId, plaintext);
        payload = selfEnvelope.payload;
        type = 'prekey';
        await signalStore.upsertDmSession(selfEnvelope.session);
      } else {
        const preKeyEnvelope = await this.createPreKeyEnvelope(userId, peerUserId, peerDeviceId, plaintext);
        payload = preKeyEnvelope.payload;
        type = 'prekey';
        await signalStore.upsertDmSession(preKeyEnvelope.session);
      }

      return { type, payload };
    } catch (err) {
      console.warn('Failed to build signal envelope for device', {
        peerUserId,
        peerDeviceId,
        error: err,
      });
      return null;
    }
  }

  private async buildEncryptedSenderKeyEnvelope(
    userId: string,
    peerUserId: string,
    peerDeviceId: string,
    plaintext: string
  ): Promise<SignalDeviceEnvelopePayload | null> {
    const encryptedEnvelope = await this.buildEncryptedPayloadForDevice(
      userId,
      peerUserId,
      peerDeviceId,
      plaintext
    );
    if (!encryptedEnvelope) return null;

    return {
      recipient_user_id: peerUserId,
      recipient_device_id: peerDeviceId,
      type: 'sender_key',
      ciphertext: JSON.stringify(encryptedEnvelope.payload),
    };
  }

  private async decryptPreKeyEnvelope(
    userId: string,
    senderUserId: string,
    senderDeviceId: string,
    payload: SignalEncryptedEnvelopePayload
  ): Promise<string> {
    if (
      !payload.ephemeral_public_key ||
      !payload.sender_identity_key ||
      !isValidCounter(payload.signed_prekey_id)
    ) {
      throw new Error('Invalid prekey payload');
    }

    const bootstrapMaterial = await this.getOrCreateBootstrapMaterial(userId);
    if (bootstrapMaterial.signedPreKey.keyId !== payload.signed_prekey_id) {
      throw new Error('Unknown signed prekey id');
    }
    const senderIdentityValid = await this.validateSenderDeviceIdentity(
      senderUserId,
      senderDeviceId,
      payload.sender_identity_key
    );
    if (!senderIdentityValid) {
      throw new Error('Sender identity key does not match registered device');
    }

    const sharedParts: ArrayBuffer[] = [
      // X3DH-style DH1: SPK_b x IK_a
      await deriveEcdhBits(
        bootstrapMaterial.signedPreKey.privateKey,
        payload.sender_identity_key
      ),
      // X3DH-style DH2: IK_b x EK_a
      await deriveEcdhBits(
        bootstrapMaterial.identityKey.privateKey,
        payload.ephemeral_public_key
      ),
      // X3DH-style DH3: SPK_b x EK_a
      await deriveEcdhBits(
        bootstrapMaterial.signedPreKey.privateKey,
        payload.ephemeral_public_key
      ),
    ];

    let didUpdateBootstrapMaterial = false;
    if (isValidCounter(payload.one_time_prekey_id)) {
      const oneTimePreKey = bootstrapMaterial.oneTimePreKeys.find(
        (preKey) => preKey.keyId === payload.one_time_prekey_id
      );
      if (!oneTimePreKey) {
        throw new Error('Unknown one-time prekey id');
      }

      sharedParts.push(await deriveEcdhBits(oneTimePreKey.privateKey, payload.ephemeral_public_key));

      if (!oneTimePreKey.usedAt) {
        oneTimePreKey.usedAt = new Date().toISOString();
        didUpdateBootstrapMaterial = true;
      }
    }

    const initialSecret = concatBuffers(...sharedParts);
    const { rootKey, chainKey } = await deriveRootAndChainKeys(null, initialSecret);

    const targetCounter = isValidCounter(payload.counter) ? payload.counter : 1;
    if (targetCounter > MAX_SKIP_AHEAD) {
      throw new Error('Prekey counter exceeds supported window');
    }

    const skipped: SignalSkippedMessageKey[] = [];
    let receiveChainKey = chainKey;
    let messageKey: string | null = null;
    for (let counter = 1; counter <= targetCounter; counter += 1) {
      const step = await deriveMessageKeyFromChain(receiveChainKey);
      receiveChainKey = step.nextChainKey;
      if (counter === targetCounter) {
        messageKey = step.messageKey;
      } else {
        skipped.push({
          counter,
          ratchetPublicKey: payload.ratchet_public_key || payload.ephemeral_public_key,
          messageKey: step.messageKey,
        });
      }
    }

    if (!messageKey) {
      throw new Error('Unable to derive prekey message key');
    }

    const plaintext = await decryptWithAesKeyBase64(messageKey, payload.iv, payload.ciphertext);

    await signalStore.upsertDmSession({
      userId,
      peerUserId: senderUserId,
      peerDeviceId: senderDeviceId,
      lastEstablishedAt: new Date().toISOString(),
      sessionVersion: 2,
      sessionKey: null,
      rootKey,
      sendChainKey: null,
      receiveChainKey,
      localRatchetPublicKey: bootstrapMaterial.signedPreKey.publicKey,
      localRatchetPrivateKey: bootstrapMaterial.signedPreKey.privateKey,
      remoteRatchetPublicKey: payload.ratchet_public_key || payload.ephemeral_public_key,
      previousChainLength: isValidCounter(payload.previous_counter) || payload.previous_counter === 0
        ? Number(payload.previous_counter)
        : 0,
      pendingRatchet: true,
      skippedMessageKeys: serializeSkippedMessageKeys(skipped),
      sendCounter: 0,
      receiveCounter: targetCounter,
    });

    if (didUpdateBootstrapMaterial) {
      bootstrapMaterial.updatedAt = new Date().toISOString();
      await signalStore.putBootstrapMaterial(bootstrapMaterial);
    }

    return plaintext;
  }

  private async decryptSignalEnvelope(
    userId: string,
    senderUserId: string,
    senderDeviceId: string,
    payload: SignalEncryptedEnvelopePayload
  ): Promise<string> {
    if (!isValidCounter(payload.counter)) {
      throw new Error('Invalid signal counter');
    }

    const existingSession = await signalStore.getDmSession(userId, senderUserId, senderDeviceId);
    if (!existingSession || existingSession.sessionVersion <= 0) {
      throw new Error('Signal session is missing');
    }

    // Legacy fallback for pre-ratchet sessions.
    if (!existingSession.rootKey || !existingSession.receiveChainKey || !existingSession.remoteRatchetPublicKey) {
      if (!existingSession.sessionKey) {
        throw new Error('Signal session is missing');
      }
      const legacyKey = await deriveMessageKeyBase64(existingSession.sessionKey, payload.counter);
      const legacyPlaintext = await decryptWithAesKeyBase64(legacyKey, payload.iv, payload.ciphertext);
      await signalStore.upsertDmSession({
        ...existingSession,
        receiveCounter: Math.max(existingSession.receiveCounter || 0, payload.counter),
        sessionVersion: Math.max(1, existingSession.sessionVersion),
      });
      return legacyPlaintext;
    }

    const nextSession: SignalDmSessionRecord = {
      ...existingSession,
      sessionVersion: Math.max(2, existingSession.sessionVersion),
      skippedMessageKeys: existingSession.skippedMessageKeys || null,
      pendingRatchet: Boolean(existingSession.pendingRatchet),
    };
    let skipped = parseSkippedMessageKeys(nextSession.skippedMessageKeys);

    const incomingRatchetPublic = payload.ratchet_public_key || null;
    const remoteChanged =
      typeof incomingRatchetPublic === 'string' &&
      incomingRatchetPublic.length > 0 &&
      incomingRatchetPublic !== nextSession.remoteRatchetPublicKey;

    if (remoteChanged) {
      if (!nextSession.localRatchetPrivateKey) {
        throw new Error('Missing local ratchet private key');
      }
      if (!nextSession.remoteRatchetPublicKey) {
        throw new Error('Missing previous remote ratchet public key');
      }
      const previousRemoteRatchetPublic = nextSession.remoteRatchetPublicKey;

      const previousCounter = isValidCounter(payload.previous_counter) || payload.previous_counter === 0
        ? Number(payload.previous_counter)
        : (nextSession.receiveCounter || 0);
      if (previousCounter < (nextSession.receiveCounter || 0)) {
        throw new Error('Invalid previous counter in ratchet step');
      }
      if (previousCounter - (nextSession.receiveCounter || 0) > MAX_SKIP_AHEAD) {
        throw new Error('Too many skipped messages in previous chain');
      }

      // Store skipped keys from the previous receiving chain up to previous_counter.
      while ((nextSession.receiveCounter || 0) < previousCounter) {
        if (!nextSession.receiveChainKey) {
          throw new Error('Missing receive chain key');
        }
        const step = await deriveMessageKeyFromChain(nextSession.receiveChainKey);
        nextSession.receiveChainKey = step.nextChainKey;
        nextSession.receiveCounter = (nextSession.receiveCounter || 0) + 1;
        skipped.push({
          counter: nextSession.receiveCounter,
          ratchetPublicKey: previousRemoteRatchetPublic,
          messageKey: step.messageKey,
        });
      }

      const dhOutput = await deriveEcdhBits(
        nextSession.localRatchetPrivateKey,
        incomingRatchetPublic
      );
      const { rootKey, chainKey } = await deriveRootAndChainKeys(nextSession.rootKey, dhOutput);
      nextSession.rootKey = rootKey;
      nextSession.receiveChainKey = chainKey;
      nextSession.remoteRatchetPublicKey = incomingRatchetPublic;
      nextSession.receiveCounter = 0;
      nextSession.pendingRatchet = true;
    }

    const activeRatchetPublic = nextSession.remoteRatchetPublicKey;
    if (!activeRatchetPublic || !nextSession.receiveChainKey) {
      throw new Error('Missing active receive ratchet state');
    }

    // Try skipped-message cache first.
    const skippedIndex = skipped.findIndex(
      (entry) =>
        entry.counter === payload.counter &&
        entry.ratchetPublicKey === activeRatchetPublic
    );

    let messageKey: string | null = null;
    if (skippedIndex >= 0) {
      const entry = skipped.splice(skippedIndex, 1)[0];
      if (!entry) {
        throw new Error('Missing skipped message key entry');
      }
      messageKey = entry.messageKey;
    } else {
      const currentCounter = nextSession.receiveCounter || 0;
      if (payload.counter <= currentCounter) {
        throw new Error('Received duplicate or old message without skipped key');
      }
      if (payload.counter - currentCounter > MAX_SKIP_AHEAD) {
        throw new Error('Message counter skip too large');
      }

      while ((nextSession.receiveCounter || 0) < payload.counter) {
        if (!nextSession.receiveChainKey) {
          throw new Error('Missing receive chain key');
        }
        const step = await deriveMessageKeyFromChain(nextSession.receiveChainKey);
        nextSession.receiveChainKey = step.nextChainKey;
        nextSession.receiveCounter = (nextSession.receiveCounter || 0) + 1;

        if ((nextSession.receiveCounter || 0) === payload.counter) {
          messageKey = step.messageKey;
        } else {
          skipped.push({
            counter: nextSession.receiveCounter || 0,
            ratchetPublicKey: activeRatchetPublic,
            messageKey: step.messageKey,
          });
        }
      }
    }

    if (!messageKey) {
      throw new Error('Failed to derive message key');
    }

    const plaintext = await decryptWithAesKeyBase64(messageKey, payload.iv, payload.ciphertext);
    nextSession.skippedMessageKeys = serializeSkippedMessageKeys(skipped);
    await signalStore.upsertDmSession(nextSession);

    return plaintext;
  }

  private async applyGroupSenderKeyPayload(
    payload: SignalGroupSenderKeyPayload,
    senderDeviceId: string
  ): Promise<void> {
    const rawKey = base64ToArrayBuffer(payload.group_key);
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    await keyManager.storeGroupKey(payload.conversation_id, payload.key_version, cryptoKey);
    await signalStore.putGroupSenderKey({
      conversationId: payload.conversation_id,
      senderDeviceId,
      senderKeyVersion: payload.key_version,
      lastRotatedAt: payload.sent_at,
    });
  }

  private async processDeviceInboxItem(
    userId: string,
    item: SignalDeviceInboxItem
  ): Promise<void> {
    const payload = parseEncryptedEnvelopePayload(item.ciphertext);
    if (!payload) return;

    let plaintext: string | null = null;
    if (payload.mode === 'prekey') {
      plaintext = await this.decryptPreKeyEnvelope(
        userId,
        item.sender_user_id,
        item.sender_device_id,
        payload
      );
    } else if (payload.mode === 'signal') {
      plaintext = await this.decryptSignalEnvelope(
        userId,
        item.sender_user_id,
        item.sender_device_id,
        payload
      );
    }

    if (!plaintext) return;

    const groupSenderKeyPayload = parseGroupSenderKeyPayload(plaintext);
    if (groupSenderKeyPayload) {
      await this.applyGroupSenderKeyPayload(groupSenderKeyPayload, item.sender_device_id);
    }
  }

  async syncDeviceInbox(userId: string): Promise<void> {
    if (!this.isEnabled()) return;
    const now = Date.now();
    const lastRun = this.inboxSyncLastRunAt.get(userId) || 0;
    if (now - lastRun < INBOX_SYNC_MIN_INTERVAL_MS) {
      return;
    }
    this.inboxSyncLastRunAt.set(userId, now);

    const lock = this.inboxSyncLocks.get(userId);
    if (lock) {
      await lock;
      return;
    }

    const syncPromise = (async () => {
      const localIdentity = await this.ensureLocalDeviceIdentity(userId);
      if (!localIdentity) return;

      const capabilities = await this.getServerCapabilities();
      if (!capabilities.supported || !capabilities.deviceMessageFanout) return;

      await this.ensureServerBootstrap(userId, localIdentity, capabilities);

      let cursor = await signalStore.getInboxCursor(userId, localIdentity.deviceId);
      for (let page = 0; page < MAX_INBOX_PAGES_PER_SYNC; page += 1) {
        const inbox = await fetchSignalDeviceInbox(localIdentity.deviceId, {
          cursor: cursor || undefined,
          limit: INBOX_PAGE_LIMIT,
        });

        if (inbox.items.length === 0) {
          break;
        }

        for (const item of inbox.items) {
          try {
            await this.processDeviceInboxItem(userId, item);
          } catch (err) {
            console.warn('Signal inbox item processing failed:', err);
          }
        }

        const lastItem = inbox.items[inbox.items.length - 1];
        if (lastItem?.id) {
          cursor = lastItem.id;
          await signalStore.putInboxCursor(userId, localIdentity.deviceId, cursor);
        }

        if (!inbox.next_cursor) {
          break;
        }

        cursor = inbox.next_cursor;
      }
    })().catch((err) => {
      console.warn('Signal inbox sync failed:', err);
    });

    this.inboxSyncLocks.set(userId, syncPromise);
    try {
      await syncPromise;
    } finally {
      this.inboxSyncLocks.delete(userId);
    }
  }

  isSignalMessageType(messageType: string | null | undefined): boolean {
    return messageType === 'signal_text';
  }

  /**
   * Pre-warm Signal bootstrap for a DM conversation.
   * Call when a DM opens so that device registration, capability checks,
   * and peer device lookups are cached before the first send.
   */
  async preWarmForDm(userId: string, peerUserId: string): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      const localIdentity = await this.ensureLocalDeviceIdentity(userId);
      if (!localIdentity) return;

      const capabilities = await this.getServerCapabilities();
      if (!capabilities.supported || collectDmMissingRequirements(capabilities).length > 0) {
        return;
      }

      await this.ensureServerBootstrap(userId, localIdentity, capabilities);
      // Pre-cache peer device directory (fire-and-forget)
      void this.getKnownDevicesForUser(peerUserId);
    } catch {
      // Pre-warm is best-effort; failures are not critical
    }
  }

  async prepareDmConversationMessage(input: {
    userId: string;
    peerUserId: string;
    plaintext: string;
    legacyFallback?: { encrypted_content: string; iv: string };
  }): Promise<SignalPreparedConversationMessage | null> {
    if (!this.isEnabled()) return null;

    const localIdentity = await this.ensureLocalDeviceIdentity(input.userId);
    if (!localIdentity) return null;

    const capabilities = await this.getServerCapabilities();
    if (!capabilities.supported || collectDmMissingRequirements(capabilities).length > 0) {
      return null;
    }

    await this.ensureServerBootstrap(input.userId, localIdentity, capabilities);
    // Keep send-path latency low; background sync is handled by polling too.
    void this.syncDeviceInbox(input.userId);

    const targets: Array<{ userId: string; deviceId: string }> = [];
    const targetSet = new Set<string>();

    const pushDevice = (userId: string, deviceId: string) => {
      const key = `${userId}:${deviceId}`;
      if (targetSet.has(key)) return;
      targetSet.add(key);
      targets.push({ userId, deviceId });
    };

    const [peerDevicesResult, ownDevicesResult] = await Promise.allSettled([
      this.getKnownDevicesForUser(input.peerUserId),
      this.getKnownDevicesForUser(input.userId),
    ]);

    if (peerDevicesResult.status === 'fulfilled') {
      peerDevicesResult.value.forEach((device) => {
        if (device.device_id) {
          pushDevice(input.peerUserId, device.device_id);
        }
      });
    } else {
      console.warn('Signal DM peer device lookup failed:', peerDevicesResult.reason);
      return null;
    }

    // If peer has no active Signal devices, fall back to legacy for this message.
    if (!targets.some((target) => String(target.userId) === String(input.peerUserId))) {
      return null;
    }

    // Include other sender devices so history works everywhere.
    // Skip the current sending device — it already has the plaintext.
    if (ownDevicesResult.status === 'fulfilled') {
      ownDevicesResult.value.forEach((device) => {
        if (device.device_id && String(device.device_id) !== String(localIdentity.deviceId)) {
          pushDevice(input.userId, device.device_id);
        }
      });
    }

    if (targets.length === 0) {
      return null;
    }

    const envelopeResults = await Promise.all(
      targets.map(async (target) => {
        const encrypted = await this.buildEncryptedPayloadForDevice(
          input.userId,
          target.userId,
          target.deviceId,
          input.plaintext
        );
        if (!encrypted) return null;

        return {
          recipient_user_id: target.userId,
          recipient_device_id: target.deviceId,
          type: encrypted.type,
          payload: encrypted.payload,
        } satisfies SignalDmMessageEnvelopeEntry;
      })
    );

    const envelopes = envelopeResults.filter(
      (entry): entry is SignalDmMessageEnvelopeEntry => entry !== null
    );

    if (envelopes.length === 0) {
      return null;
    }

    // Never send a Signal DM payload unless at least one peer-device envelope exists.
    // Otherwise receiver gets a signal_text message with no decryptable envelope.
    const hasPeerEnvelope = envelopes.some(
      (entry) => String(entry.recipient_user_id) === String(input.peerUserId)
    );
    if (!hasPeerEnvelope) {
      return null;
    }

    const payload: SignalDmMessagePayload = {
      protocol: SIGNAL_PROTOCOL_MARKER,
      kind: SIGNAL_DM_MESSAGE_KIND,
      version: 1,
      sender_user_id: input.userId,
      sender_device_id: localIdentity.deviceId,
      sent_at: new Date().toISOString(),
      envelopes,
      fallback: input.legacyFallback || undefined,
    };

    return {
      encrypted_content: JSON.stringify(payload),
      iv: SIGNAL_PROTOCOL_MARKER,
      key_version: 1,
      message_type: 'signal_text',
    };
  }

  async decryptDmConversationMessage(input: {
    userId: string;
    message: {
      encrypted_content?: string | null;
      message_type?: string | null;
      sender_id?: string;
    };
    fallbackKey?: CryptoKey;
  }): Promise<string> {
    if (
      !this.isSignalMessageType(input.message.message_type || null) ||
      typeof input.message.encrypted_content !== 'string' ||
      input.message.encrypted_content.length === 0
    ) {
      throw new Error('Not a signal dm message');
    }

    const payload = parseDmMessagePayload(input.message.encrypted_content);
    if (!payload) {
      throw new Error('Invalid signal dm payload');
    }

    // Try Signal decryption first, fall back to legacy ECDH if it fails
    try {
      const localIdentity = await this.ensureLocalDeviceIdentity(input.userId);
      if (!localIdentity) {
        throw new Error('Missing local signal identity');
      }

      const targetEnvelope = payload.envelopes.find(
        (envelope) =>
          String(envelope.recipient_user_id) === String(input.userId) &&
          String(envelope.recipient_device_id) === String(localIdentity.deviceId)
      );

      if (!targetEnvelope) {
        throw new Error('Signal envelope for this device is missing');
      }

      if (targetEnvelope.type === 'prekey') {
        return await this.decryptPreKeyEnvelope(
          input.userId,
          payload.sender_user_id,
          payload.sender_device_id,
          targetEnvelope.payload
        );
      }

      return await this.decryptSignalEnvelope(
        input.userId,
        payload.sender_user_id,
        payload.sender_device_id,
        targetEnvelope.payload
      );
    } catch (signalError) {
      // If we have a legacy fallback embedded in the payload, try that
      if (payload.fallback && input.fallbackKey) {
        try {
          const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: base64ToArrayBuffer(payload.fallback.iv) },
            input.fallbackKey,
            base64ToArrayBuffer(payload.fallback.encrypted_content)
          );
          return textDecoder.decode(decrypted);
        } catch (legacyError) {
          console.warn('Signal legacy fallback decryption also failed:', legacyError);
        }
      }
      throw signalError;
    }
  }

  async distributeGroupSenderKey(input: {
    userId: string;
    conversation: Conversation;
    memberUserIds: string[];
    keyVersion: number;
    groupKey: CryptoKey;
  }): Promise<void> {
    if (!this.isEnabled()) return;

    const conversationId = resolveConversationKeyId(input.conversation);
    const lockKey = `${input.userId}:${conversationId}:${input.keyVersion}`;
    const existingLock = this.groupSenderKeyLocks.get(lockKey);
    if (existingLock) {
      await existingLock;
      return;
    }

    const lock = (async () => {
      const capabilities = await this.getServerCapabilities();
      if (
        !capabilities.supported ||
        !capabilities.deviceRegistry ||
        !capabilities.prekeyBundles ||
        !capabilities.deviceMessageFanout ||
        !capabilities.groupSenderKeys
      ) {
        return;
      }

      const localIdentity = await this.ensureLocalDeviceIdentity(input.userId);
      if (!localIdentity) return;

      await this.ensureServerBootstrap(input.userId, localIdentity, capabilities);
      await this.syncDeviceInbox(input.userId);

      const exportedGroupKey = await crypto.subtle.exportKey('raw', input.groupKey);
      const plaintextPayload: SignalGroupSenderKeyPayload = {
        kind: 'group_sender_key',
        conversation_id: conversationId,
        key_version: input.keyVersion,
        group_key: arrayBufferToBase64(exportedGroupKey),
        sent_at: new Date().toISOString(),
      };
      const plaintext = JSON.stringify(plaintextPayload);

      const targetUserIds = Array.from(new Set(input.memberUserIds.filter(Boolean)));
      const envelopes: SignalDeviceEnvelopePayload[] = [];

      for (const targetUserId of targetUserIds) {
        let devices: Awaited<ReturnType<typeof listSignalDevicesForUser>> = [];
        try {
          devices = await listSignalDevicesForUser(targetUserId);
        } catch (err) {
          console.warn('Signal device lookup failed for member', { targetUserId, err });
          continue;
        }

        for (const device of devices) {
          if (
            String(targetUserId) === String(input.userId) &&
            String(device.device_id) === String(localIdentity.deviceId)
          ) {
            continue;
          }

          const envelope = await this.buildEncryptedSenderKeyEnvelope(
            input.userId,
            targetUserId,
            device.device_id,
            plaintext
          );

          if (envelope) {
            envelopes.push(envelope);
          }
        }
      }

      if (envelopes.length === 0) {
        await signalStore.putGroupSenderKey({
          conversationId,
          senderDeviceId: localIdentity.deviceId,
          senderKeyVersion: input.keyVersion,
          lastRotatedAt: plaintextPayload.sent_at,
        });
        return;
      }

      for (const batch of chunkArray(envelopes, MAX_ENVELOPE_BATCH)) {
        await sendSignalDeviceEnvelopes(conversationId, batch, {
          sender_device_id: localIdentity.deviceId,
        });
      }

      await signalStore.putGroupSenderKey({
        conversationId,
        senderDeviceId: localIdentity.deviceId,
        senderKeyVersion: input.keyVersion,
        lastRotatedAt: plaintextPayload.sent_at,
      });
    })().catch((err) => {
      console.warn('Signal sender-key distribution failed:', err);
    });

    this.groupSenderKeyLocks.set(lockKey, lock);
    try {
      await lock;
    } finally {
      this.groupSenderKeyLocks.delete(lockKey);
    }
  }

  async bootstrapConversation(
    input: SignalConversationBootstrapInput
  ): Promise<SignalBootstrapResult> {
    const localIdentity = await this.ensureLocalDeviceIdentity(input.userId);
    if (!localIdentity) {
      return {
        enabled: true,
        ready: false,
        mode: 'legacy',
        reason: 'missing_local_signal_identity',
      };
    }

    const serverCapabilities = await this.getServerCapabilities();
    if (!serverCapabilities.supported) {
      return {
        enabled: true,
        ready: false,
        mode: 'legacy',
        reason: serverCapabilities.reason || 'signal_server_not_supported',
        deviceId: localIdentity.deviceId,
        missingServerRequirements: input.conversation.type === 'dm'
          ? MISSING_DM_REQUIREMENTS
          : MISSING_GROUP_REQUIREMENTS,
      };
    }

    await this.ensureServerBootstrap(input.userId, localIdentity, serverCapabilities);
    await this.syncDeviceInbox(input.userId);

    if (input.conversation.type === 'dm') {
      const missingRequirements = collectDmMissingRequirements(serverCapabilities);
      if (missingRequirements.length > 0) {
        return {
          enabled: true,
          ready: false,
          mode: 'legacy',
          reason: 'signal_server_missing_dm_capabilities',
          deviceId: localIdentity.deviceId,
          missingServerRequirements: missingRequirements,
        };
      }

      if (!input.peerUserId) {
        return {
          enabled: true,
          ready: false,
          mode: 'legacy',
          reason: 'missing_dm_peer',
          deviceId: localIdentity.deviceId,
          missingServerRequirements: [],
        };
      }

      await this.probeDmPeersForBootstrap(input.userId, input.peerUserId);

      const establishedSessions = await signalStore.listEstablishedDmSessions(
        input.userId,
        input.peerUserId
      );
      if (establishedSessions.length > 0) {
        return {
          enabled: true,
          ready: true,
          mode: 'signal',
          deviceId: localIdentity.deviceId,
        };
      }

      return {
        enabled: true,
        ready: false,
        mode: 'legacy',
        reason: 'missing_dm_device_sessions',
        deviceId: localIdentity.deviceId,
        missingServerRequirements: [],
      };
    }

    const missingRequirements = collectGroupMissingRequirements(serverCapabilities);
    if (missingRequirements.length > 0) {
      return {
        enabled: true,
        ready: false,
        mode: 'legacy',
        reason: 'signal_server_missing_group_capabilities',
        deviceId: localIdentity.deviceId,
        missingServerRequirements: missingRequirements,
      };
    }

    const conversationId = resolveGroupConversationId(input);
    const senderKey = await signalStore.getGroupSenderKey(conversationId, localIdentity.deviceId);
    if (senderKey) {
      return {
        enabled: true,
        ready: true,
        mode: 'signal',
        deviceId: localIdentity.deviceId,
      };
    }

    return {
      enabled: true,
      ready: false,
      mode: 'legacy',
      reason: 'missing_group_sender_key',
      deviceId: localIdentity.deviceId,
      missingServerRequirements: [],
    };
  }
}

export const signalService = new SignalService();
