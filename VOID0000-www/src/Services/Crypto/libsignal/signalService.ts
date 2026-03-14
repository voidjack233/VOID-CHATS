import type { Conversation } from '../../Chat/chatService';
import { keyManager } from '../keyManager';
import { signalStore } from './signalStore';
import {
  LibSignalProtocolStore,
  getLibsignalRuntime,
  libsignalBodyToArrayBuffer,
  type LibSignalBootstrapState,
} from './libsignalProtocolStore';
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
} from './signalApi';
import type {
  SignalBootstrapResult,
  SignalConversationBootstrapInput,
  SignalDeviceIdentityRecord,
  SignalDmCryptoMode,
  SignalDmMessagePayload,
  SignalDmMessageEnvelopeEntry,
  SignalEncryptedEnvelopePayload,
  SignalGroupSenderKeyPayload,
  SignalPreparedConversationMessage,
  SignalServerCapabilities,
  SignalServerDeviceRecord,
} from './signalTypes';

const INITIAL_PREKEY_BATCH_SIZE = 24;
const PREKEY_REPLENISH_THRESHOLD = 8;
const SIGNAL_PROTOCOL_MARKER = 'void-signal-v1';
const SIGNAL_DM_MESSAGE_KIND = 'dm_message';
const MAX_ENVELOPE_BATCH = 200;
const INBOX_PAGE_LIMIT = 100;
const MAX_INBOX_PAGES_PER_SYNC = 4;
const INBOX_SYNC_MIN_INTERVAL_MS = 15000;
const INBOX_SYNC_ERROR_BACKOFF_MS = 45000;
const DEVICE_DIRECTORY_CACHE_MS = 10000;
const DEVICE_REGISTRATION_RECHECK_MS = 60000;
const SIGNED_PREKEY_ROTATION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DM_CRYPTO_MODE: SignalDmCryptoMode = 'signal_locked';
const LIBSIGNAL_PAYLOAD_MARKER = 'libsignal-v1';

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

function normalizeLibsignalDeviceId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null;
  }
  if (value <= 0 || value > 2147483647) {
    return null;
  }
  return value;
}

function extractLibsignalDeviceIdFromRecord(record: unknown): number | null {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const source = record as Record<string, unknown>;
  return (
    normalizeLibsignalDeviceId(source.libsignal_device_id) ||
    normalizeLibsignalDeviceId(source.signal_device_id) ||
    normalizeLibsignalDeviceId(source.device_numeric_id) ||
    normalizeLibsignalDeviceId(source.device_number) ||
    null
  );
}

function buildLibsignalAddressName(userId: string, deviceId: string): string {
  // Bind trust/session identity to a concrete peer device.
  // This avoids cross-device identity collisions for the same account.
  return `${String(userId)}:${String(deviceId)}`;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function createSignalLockedError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = 'SIGNAL_LOCKED_SEND_BLOCKED';
  return error;
}

async function verifySignedPreKeySignature(
  identityKeyBase64: string,
  signedPreKeyPublicKeyBase64: string,
  signatureBase64: string,
  libsignalRuntime?: any
): Promise<boolean | null> {
  const identityKey = base64ToArrayBuffer(identityKeyBase64);
  const signedPreKeyPublicKey = base64ToArrayBuffer(signedPreKeyPublicKeyBase64);
  const signature = base64ToArrayBuffer(signatureBase64);

  const runtime =
    libsignalRuntime ||
    (typeof window !== 'undefined' ? (window as unknown as { libsignal?: any }).libsignal : null);

  if (runtime?.Curve?.async?.verifySignature) {
    try {
      const verified = await runtime.Curve.async.verifySignature(
        identityKey,
        signedPreKeyPublicKey,
        signature
      );
      return verified !== false;
    } catch {
      // Fall through to WebCrypto verifier below.
      // Some runtimes may expose incompatible key encodings.
    }
  }

  try {
    const identityPublicKey = await crypto.subtle.importKey(
      'spki',
      identityKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );

    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      identityPublicKey,
      signature,
      signedPreKeyPublicKey
    );
  } catch {
    // This client path can only verify ECDSA/SPKI keys.
    // Legacy libsignal key formats may be unverifiable here.
    return null;
  }
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

    return {
      protocol: SIGNAL_PROTOCOL_MARKER,
      kind: SIGNAL_DM_MESSAGE_KIND,
      version: 1,
      sender_user_id: parsed.sender_user_id,
      sender_device_id: parsed.sender_device_id,
      ...(normalizeLibsignalDeviceId(parsed.sender_libsignal_device_id)
        ? { sender_libsignal_device_id: Number(parsed.sender_libsignal_device_id) }
        : {}),
      sent_at: parsed.sent_at,
      envelopes,
    };
  } catch {
    return null;
  }
}

class SignalService {
  private identityLocks = new Map<string, Promise<SignalDeviceIdentityRecord>>();
  private inboxSyncLocks = new Map<string, Promise<void>>();
  private inboxSyncLastRunAt = new Map<string, number>();
  private inboxSyncBackoffUntil = new Map<string, number>();
  private inboxSyncEndpointUnavailable = false;
  private bootstrapRegistrationCheckAt = new Map<string, number>();
  private libsignalStoreByUser = new Map<string, LibSignalProtocolStore>();
  private libsignalBootstrapLocks = new Map<string, Promise<void>>();
  private peerLibsignalDeviceIdCache = new Map<string, number>();
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

  private getLibsignalStore(userId: string): LibSignalProtocolStore {
    const existing = this.libsignalStoreByUser.get(userId);
    if (existing) {
      return existing;
    }
    const created = new LibSignalProtocolStore(userId);
    this.libsignalStoreByUser.set(userId, created);
    return created;
  }

  private createLibsignalAddress(
    libsignal: any,
    userId: string,
    deviceId: string,
    libsignalDeviceId?: number | null
  ): any {
    const numericDeviceId = normalizeLibsignalDeviceId(libsignalDeviceId);
    if (!numericDeviceId) {
      throw createSignalLockedError(`Missing libsignal numeric device id for ${userId}:${deviceId}`);
    }
    return new libsignal.SignalProtocolAddress(
      buildLibsignalAddressName(userId, deviceId),
      numericDeviceId
    );
  }

  private async persistLocalLibsignalDeviceId(
    localIdentity: SignalDeviceIdentityRecord,
    libsignalDeviceId: number
  ): Promise<void> {
    const normalized = normalizeLibsignalDeviceId(libsignalDeviceId);
    if (!normalized) return;
    if (normalizeLibsignalDeviceId(localIdentity.libsignalDeviceId) === normalized) {
      return;
    }
    localIdentity.libsignalDeviceId = normalized;
    localIdentity.updatedAt = new Date().toISOString();
    await signalStore.putDeviceIdentity(localIdentity);
  }

  private async resolvePeerLibsignalDeviceId(
    peerUserId: string,
    peerDeviceId: string,
    hintLibsignalDeviceId?: number | null
  ): Promise<number | null> {
    const hinted = normalizeLibsignalDeviceId(hintLibsignalDeviceId);
    if (hinted) {
      this.peerLibsignalDeviceIdCache.set(`${peerUserId}:${peerDeviceId}`, hinted);
      return hinted;
    }

    const cacheKey = `${peerUserId}:${peerDeviceId}`;
    const cached = normalizeLibsignalDeviceId(this.peerLibsignalDeviceIdCache.get(cacheKey));
    if (cached) {
      return cached;
    }

    const resolveFromDirectory = async (forceRefresh: boolean): Promise<number | null> => {
      try {
        const devices = await this.getKnownDevicesForUser(peerUserId, { force: forceRefresh });
        const matchedDevice = devices.find(
          (device) => String(device.device_id) === String(peerDeviceId)
        ) || null;
        const resolved = extractLibsignalDeviceIdFromRecord(matchedDevice);
        if (resolved) {
          this.peerLibsignalDeviceIdCache.set(cacheKey, resolved);
          return resolved;
        }
      } catch {
        // Best-effort lookup; fallback to next strategy.
      }
      return null;
    };

    let resolved = await resolveFromDirectory(false);
    if (!resolved) {
      resolved = await resolveFromDirectory(true);
    }
    if (resolved) {
      return resolved;
    }

    try {
      const preKeyBundle = await getSignalPreKeyBundle(peerUserId, peerDeviceId);
      const bundleDeviceId = extractLibsignalDeviceIdFromRecord(preKeyBundle);
      if (bundleDeviceId) {
        this.peerLibsignalDeviceIdCache.set(cacheKey, bundleDeviceId);
        return bundleDeviceId;
      }
    } catch {
      // Ignore; caller will raise a clear error if unresolved.
    }

    return null;
  }

  private async ensureLibsignalBootstrap(
    userId: string,
    localIdentity: SignalDeviceIdentityRecord
  ): Promise<void> {
    const lock = this.libsignalBootstrapLocks.get(userId);
    if (lock) {
      await lock;
      return;
    }

    const bootstrapPromise = (async () => {
      const libsignal = await getLibsignalRuntime();
      const protocolStore = this.getLibsignalStore(userId);
      let identityKeyPair = await protocolStore.getIdentityKeyPair();
      if (!identityKeyPair) {
        const generated = await libsignal.KeyHelper.generateIdentityKeyPair();
        identityKeyPair = {
          pubKey: toArrayBuffer(generated.pubKey),
          privKey: toArrayBuffer(generated.privKey),
        };
        await protocolStore.putIdentityKeyPair(identityKeyPair);
      }

      const storedRegistrationId = await protocolStore.getLocalRegistrationId();
      if (!storedRegistrationId || storedRegistrationId <= 0) {
        await protocolStore.putLocalRegistrationId(localIdentity.registrationId);
      }

      let state = await protocolStore.getBootstrapState();
      if (!state) {
        const signedPreKeyId = 1;
        const signedPreKey = await libsignal.KeyHelper.generateSignedPreKey(
          identityKeyPair,
          signedPreKeyId
        );
        await protocolStore.storeSignedPreKey(signedPreKeyId, {
          pubKey: toArrayBuffer(signedPreKey.keyPair.pubKey),
          privKey: toArrayBuffer(signedPreKey.keyPair.privKey),
        });

        const generatedPreKeys: LibSignalBootstrapState['preKeys'] = [];
        let nextPreKeyId = 1;
        for (let index = 0; index < INITIAL_PREKEY_BATCH_SIZE; index += 1) {
          const preKey = await libsignal.KeyHelper.generatePreKey(nextPreKeyId);
          await protocolStore.storePreKey(preKey.keyId, {
            pubKey: toArrayBuffer(preKey.keyPair.pubKey),
            privKey: toArrayBuffer(preKey.keyPair.privKey),
          });
          generatedPreKeys.push({
            keyId: preKey.keyId,
            publicKey: arrayBufferToBase64(toArrayBuffer(preKey.keyPair.pubKey)),
            uploaded: false,
          });
          nextPreKeyId += 1;
        }

        const now = new Date().toISOString();
        state = {
          userId,
          registrationId: localIdentity.registrationId,
          localLibsignalDeviceId: normalizeLibsignalDeviceId(localIdentity.libsignalDeviceId) || undefined,
          signedPreKeyId,
          signedPreKeyPublicKey: arrayBufferToBase64(toArrayBuffer(signedPreKey.keyPair.pubKey)),
          signedPreKeySignature: arrayBufferToBase64(toArrayBuffer(signedPreKey.signature)),
          signedPreKeyUpdatedAt: now,
          nextSignedPreKeyId: signedPreKeyId + 1,
          registrationUploaded: false,
          nextPreKeyId,
          preKeys: generatedPreKeys,
          createdAt: now,
          updatedAt: now,
        };
      }

      if (!isValidCounter(state.nextSignedPreKeyId)) {
        state.nextSignedPreKeyId = state.signedPreKeyId + 1;
      }
      if (typeof state.signedPreKeyUpdatedAt !== 'string' || state.signedPreKeyUpdatedAt.length === 0) {
        state.signedPreKeyUpdatedAt = state.updatedAt || state.createdAt || new Date().toISOString();
      }
      if (state.registrationId !== localIdentity.registrationId) {
        state.registrationId = localIdentity.registrationId;
        state.registrationUploaded = false;
      }

      const lastRegistrationCheck = this.bootstrapRegistrationCheckAt.get(userId) || 0;
      const shouldCheckRegistration =
        !state.registrationUploaded ||
        Date.now() - lastRegistrationCheck >= DEVICE_REGISTRATION_RECHECK_MS;
      let localServerDevice: SignalServerDeviceRecord | null = null;

      if (shouldCheckRegistration) {
        try {
          const serverDevices = await this.getKnownDevicesForUser(userId, { force: true });
          this.bootstrapRegistrationCheckAt.set(userId, Date.now());
          localServerDevice = serverDevices.find(
            (device) => String(device.device_id) === String(localIdentity.deviceId)
          ) || null;
          const isRegisteredOnServer = Boolean(localServerDevice);
          if (!isRegisteredOnServer) {
            state.registrationUploaded = false;
            await protocolStore.removeAllSessions('');
          }
          const serverLibsignalDeviceId = extractLibsignalDeviceIdFromRecord(localServerDevice);
          if (serverLibsignalDeviceId) {
            state.localLibsignalDeviceId = serverLibsignalDeviceId;
            await this.persistLocalLibsignalDeviceId(localIdentity, serverLibsignalDeviceId);
          }
        } catch (err) {
          console.warn('libsignal bootstrap registration check failed:', err);
        }
      }

      const signedPreKeyUpdatedAtMs = new Date(state.signedPreKeyUpdatedAt || state.updatedAt).getTime();
      const shouldRotateSignedPreKey =
        Number.isFinite(signedPreKeyUpdatedAtMs) &&
        Date.now() - signedPreKeyUpdatedAtMs >= SIGNED_PREKEY_ROTATION_MS;

      if (shouldRotateSignedPreKey) {
        const nextSignedPreKeyId = state.nextSignedPreKeyId || (state.signedPreKeyId + 1);
        const rotatedSignedPreKey = await libsignal.KeyHelper.generateSignedPreKey(
          identityKeyPair,
          nextSignedPreKeyId
        );
        await protocolStore.storeSignedPreKey(nextSignedPreKeyId, {
          pubKey: toArrayBuffer(rotatedSignedPreKey.keyPair.pubKey),
          privKey: toArrayBuffer(rotatedSignedPreKey.keyPair.privKey),
        });

        state.signedPreKeyId = nextSignedPreKeyId;
        state.signedPreKeyPublicKey = arrayBufferToBase64(toArrayBuffer(rotatedSignedPreKey.keyPair.pubKey));
        state.signedPreKeySignature = arrayBufferToBase64(toArrayBuffer(rotatedSignedPreKey.signature));
        state.signedPreKeyUpdatedAt = new Date().toISOString();
        state.nextSignedPreKeyId = nextSignedPreKeyId + 1;
        state.registrationUploaded = false;
      }

      if (!state.registrationUploaded) {
        const registeredDevice = await registerSignalDevice({
          device_id: localIdentity.deviceId,
          registration_id: localIdentity.registrationId,
          identity_key: arrayBufferToBase64(identityKeyPair.pubKey),
          signed_prekey: {
            key_id: state.signedPreKeyId,
            public_key: state.signedPreKeyPublicKey,
            signature: state.signedPreKeySignature,
          },
        });
        state.registrationUploaded = true;
        const registeredLibsignalDeviceId = extractLibsignalDeviceIdFromRecord(registeredDevice);
        if (registeredLibsignalDeviceId) {
          state.localLibsignalDeviceId = registeredLibsignalDeviceId;
          await this.persistLocalLibsignalDeviceId(localIdentity, registeredLibsignalDeviceId);
        }
      }

      if (!normalizeLibsignalDeviceId(state.localLibsignalDeviceId)) {
        try {
          const refreshedDevices = await this.getKnownDevicesForUser(userId, { force: true });
          const localServerDevice = refreshedDevices.find(
            (device) => String(device.device_id) === String(localIdentity.deviceId)
          ) || null;
          const refreshedLibsignalDeviceId = extractLibsignalDeviceIdFromRecord(localServerDevice);
          if (refreshedLibsignalDeviceId) {
            state.localLibsignalDeviceId = refreshedLibsignalDeviceId;
            await this.persistLocalLibsignalDeviceId(localIdentity, refreshedLibsignalDeviceId);
          }
        } catch (err) {
          console.warn('Failed to refresh local libsignal device id during bootstrap:', err);
        }
      }

      if (!normalizeLibsignalDeviceId(state.localLibsignalDeviceId)) {
        throw createSignalLockedError('Local Signal device is missing a libsignal numeric id');
      }

      // Keep bootstrap prekey metadata aligned with libsignal storage.
      // Used one-time prekeys are removed from the protocol store by libsignal.
      const reconciledPreKeys = await Promise.all(
        state.preKeys.map(async (preKey) => {
          if (!preKey.uploaded) return preKey;
          const keyPair = await protocolStore.loadPreKey(preKey.keyId);
          return keyPair ? preKey : null;
        })
      );
      state.preKeys = reconciledPreKeys.filter(
        (preKey): preKey is LibSignalBootstrapState['preKeys'][number] => preKey !== null
      );

      const pendingUpload = state.preKeys.filter((preKey) => !preKey.uploaded);
      if (pendingUpload.length > 0) {
        await uploadOneTimePreKeys({
          device_id: localIdentity.deviceId,
          prekeys: pendingUpload.map((preKey) => ({
            key_id: preKey.keyId,
            public_key: preKey.publicKey,
          })),
        });
        state.preKeys = state.preKeys.map((preKey) => ({
          ...preKey,
          uploaded: true,
        }));
      }

      const uploadedCount = state.preKeys.filter((preKey) => preKey.uploaded).length;
      if (uploadedCount < PREKEY_REPLENISH_THRESHOLD) {
        const freshPreKeys: LibSignalBootstrapState['preKeys'] = [];
        for (let index = 0; index < INITIAL_PREKEY_BATCH_SIZE; index += 1) {
          const preKey = await libsignal.KeyHelper.generatePreKey(state.nextPreKeyId);
          await protocolStore.storePreKey(preKey.keyId, {
            pubKey: toArrayBuffer(preKey.keyPair.pubKey),
            privKey: toArrayBuffer(preKey.keyPair.privKey),
          });
          freshPreKeys.push({
            keyId: preKey.keyId,
            publicKey: arrayBufferToBase64(toArrayBuffer(preKey.keyPair.pubKey)),
            uploaded: true,
          });
          state.nextPreKeyId += 1;
        }

        await uploadOneTimePreKeys({
          device_id: localIdentity.deviceId,
          prekeys: freshPreKeys.map((preKey) => ({
            key_id: preKey.keyId,
            public_key: preKey.publicKey,
          })),
        });

        state.preKeys = [
          ...state.preKeys.filter((preKey) => preKey.uploaded),
          ...freshPreKeys,
        ];
      }

      state.updatedAt = new Date().toISOString();
      await protocolStore.putBootstrapState(state);
    })().catch((err) => {
      console.warn('libsignal bootstrap failed:', err);
      throw err;
    });

    this.libsignalBootstrapLocks.set(userId, bootstrapPromise);
    try {
      await bootstrapPromise;
    } finally {
      this.libsignalBootstrapLocks.delete(userId);
    }
  }

  private async buildLibsignalEnvelopeForDevice(
    userId: string,
    peerUserId: string,
    peerDeviceId: string,
    peerLibsignalDeviceId: number | null | undefined,
    expectedPeerIdentityKey: string | null | undefined,
    plaintext: string
  ): Promise<{ type: 'prekey' | 'signal'; payload: SignalEncryptedEnvelopePayload }> {
    const localIdentity = await this.ensureLocalDeviceIdentity(userId);
    if (!localIdentity) {
      throw new Error('Missing local Signal identity');
    }

    await this.ensureLibsignalBootstrap(userId, localIdentity);
    const libsignal = await getLibsignalRuntime();
    const protocolStore = this.getLibsignalStore(userId);
    let resolvedPeerLibsignalDeviceId = normalizeLibsignalDeviceId(peerLibsignalDeviceId);
    let address = this.createLibsignalAddress(
      libsignal,
      peerUserId,
      peerDeviceId,
      resolvedPeerLibsignalDeviceId
    );
    let sessionId = String(address.toString());
    let existingSession = await protocolStore.loadSession(sessionId);

    const bootstrapSessionFromBundle = async (): Promise<void> => {
      const bundle = await getSignalPreKeyBundle(peerUserId, peerDeviceId);
      if (
        typeof bundle.identity_key !== 'string' ||
        bundle.identity_key.length === 0 ||
        typeof bundle.signed_prekey?.public_key !== 'string' ||
        bundle.signed_prekey.public_key.length === 0 ||
        typeof bundle.signed_prekey?.signature !== 'string' ||
        bundle.signed_prekey.signature.length === 0
      ) {
        throw createSignalLockedError(`Peer prekey bundle is incomplete for ${peerUserId}:${peerDeviceId}`);
      }

      if (
        typeof expectedPeerIdentityKey === 'string' &&
        expectedPeerIdentityKey.length > 0 &&
        expectedPeerIdentityKey !== bundle.identity_key
      ) {
        throw createSignalLockedError(
          `Peer identity key mismatch for ${peerUserId}:${peerDeviceId}`
        );
      }

      const hasValidSignedPreKeySignature = await verifySignedPreKeySignature(
        bundle.identity_key,
        bundle.signed_prekey.public_key,
        bundle.signed_prekey.signature,
        libsignal
      );
      if (hasValidSignedPreKeySignature === false) {
        throw createSignalLockedError(
          `Invalid signed prekey signature for ${peerUserId}:${peerDeviceId}`
        );
      }
      if (hasValidSignedPreKeySignature === null) {
        console.warn('Skipping signed prekey verification in client runtime (unsupported key format)', {
          peerUserId,
          peerDeviceId,
        });
      }

      const bundleLibsignalDeviceId = extractLibsignalDeviceIdFromRecord(bundle);
      if (
        bundleLibsignalDeviceId &&
        resolvedPeerLibsignalDeviceId &&
        bundleLibsignalDeviceId !== resolvedPeerLibsignalDeviceId
      ) {
        throw createSignalLockedError(
          `Peer libsignal device id mismatch for ${peerUserId}:${peerDeviceId}`
        );
      }
      if (bundleLibsignalDeviceId && !resolvedPeerLibsignalDeviceId) {
        resolvedPeerLibsignalDeviceId = bundleLibsignalDeviceId;
        address = this.createLibsignalAddress(
          libsignal,
          peerUserId,
          peerDeviceId,
          resolvedPeerLibsignalDeviceId
        );
        sessionId = String(address.toString());
      }

      const sessionBuilder = new libsignal.SessionBuilder(protocolStore as any, address);
      await sessionBuilder.processPreKey({
        registrationId: bundle.registration_id,
        identityKey: base64ToArrayBuffer(bundle.identity_key),
        signedPreKey: {
          keyId: bundle.signed_prekey.key_id,
          publicKey: base64ToArrayBuffer(bundle.signed_prekey.public_key),
          signature: base64ToArrayBuffer(bundle.signed_prekey.signature),
        },
        ...(bundle.one_time_prekey
          ? {
              preKey: {
                keyId: bundle.one_time_prekey.key_id,
                publicKey: base64ToArrayBuffer(bundle.one_time_prekey.public_key),
              },
            }
          : {}),
      });
    };

    if (!existingSession) {
      await bootstrapSessionFromBundle();
      existingSession = await protocolStore.loadSession(sessionId);
    }

    let sessionCipher = new libsignal.SessionCipher(protocolStore as any, address);
    let encrypted: any;
    try {
      encrypted = await sessionCipher.encrypt(toArrayBuffer(textEncoder.encode(plaintext)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || '');
      const shouldRetryWithFreshSession =
        message.includes('No record for') ||
        message.includes('No session to encrypt message for');

      if (!shouldRetryWithFreshSession) {
        throw err;
      }

      console.warn('Signal session missing while encrypting, re-establishing from prekey bundle', {
        peerUserId,
        peerDeviceId,
        address: sessionId,
      });

      await protocolStore.removeSession(sessionId);
      await bootstrapSessionFromBundle();
      sessionCipher = new libsignal.SessionCipher(protocolStore as any, address);
      encrypted = await sessionCipher.encrypt(toArrayBuffer(textEncoder.encode(plaintext)));
    }

    const bodyBuffer = libsignalBodyToArrayBuffer(encrypted.body);
    const mode = Number(encrypted.type) === 3 ? 'prekey' : 'signal';

    return {
      type: mode,
      payload: {
        protocol: SIGNAL_PROTOCOL_MARKER,
        version: 1,
        mode,
        iv: LIBSIGNAL_PAYLOAD_MARKER,
        ciphertext: arrayBufferToBase64(bodyBuffer),
      },
    };
  }

  private async decryptLibsignalEnvelope(
    userId: string,
    senderUserId: string,
    senderDeviceId: string,
    senderLibsignalDeviceId: number | null | undefined,
    payload: SignalEncryptedEnvelopePayload
  ): Promise<string> {
    const localIdentity = await this.ensureLocalDeviceIdentity(userId);
    if (!localIdentity) {
      throw new Error('Missing local Signal identity');
    }

    await this.ensureLibsignalBootstrap(userId, localIdentity);
    const libsignal = await getLibsignalRuntime();
    const protocolStore = this.getLibsignalStore(userId);
    const resolvedSenderLibsignalDeviceId = await this.resolvePeerLibsignalDeviceId(
      senderUserId,
      senderDeviceId,
      senderLibsignalDeviceId
    );
    const address = this.createLibsignalAddress(
      libsignal,
      senderUserId,
      senderDeviceId,
      resolvedSenderLibsignalDeviceId
    );
    const sessionCipher = new libsignal.SessionCipher(protocolStore as any, address);
    const encryptedBytes = base64ToArrayBuffer(payload.ciphertext);

    const plaintextBuffer = payload.mode === 'prekey'
      ? await sessionCipher.decryptPreKeyWhisperMessage(encryptedBytes)
      : await sessionCipher.decryptWhisperMessage(encryptedBytes);

    return textDecoder.decode(toArrayBuffer(plaintextBuffer));
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
    await this.ensureLibsignalBootstrap(userId, localIdentity);
  }

  private async buildEncryptedPayloadForDevice(
    userId: string,
    peerUserId: string,
    peerDeviceId: string,
    peerLibsignalDeviceId: number | null | undefined,
    expectedPeerIdentityKey: string | null | undefined,
    plaintext: string
  ): Promise<{ type: 'prekey' | 'signal'; payload: SignalEncryptedEnvelopePayload } | null> {
    try {
      return await this.buildLibsignalEnvelopeForDevice(
        userId,
        peerUserId,
        peerDeviceId,
        peerLibsignalDeviceId,
        expectedPeerIdentityKey,
        plaintext
      );
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
    peerLibsignalDeviceId: number | null | undefined,
    expectedPeerIdentityKey: string | null | undefined,
    plaintext: string
  ): Promise<SignalDeviceEnvelopePayload | null> {
    const encryptedEnvelope = await this.buildEncryptedPayloadForDevice(
      userId,
      peerUserId,
      peerDeviceId,
      peerLibsignalDeviceId,
      expectedPeerIdentityKey,
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
    senderLibsignalDeviceId: number | null | undefined,
    payload: SignalEncryptedEnvelopePayload
  ): Promise<string> {
    if (payload.iv !== LIBSIGNAL_PAYLOAD_MARKER) {
      throw new Error('Legacy prekey envelopes are not supported in signal-locked mode');
    }
    return this.decryptLibsignalEnvelope(
      userId,
      senderUserId,
      senderDeviceId,
      senderLibsignalDeviceId,
      payload
    );
  }

  private async decryptSignalEnvelope(
    userId: string,
    senderUserId: string,
    senderDeviceId: string,
    senderLibsignalDeviceId: number | null | undefined,
    payload: SignalEncryptedEnvelopePayload
  ): Promise<string> {
    if (payload.iv !== LIBSIGNAL_PAYLOAD_MARKER) {
      throw new Error('Legacy signal envelopes are not supported in signal-locked mode');
    }
    return this.decryptLibsignalEnvelope(
      userId,
      senderUserId,
      senderDeviceId,
      senderLibsignalDeviceId,
      payload
    );
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
    const senderLibsignalDeviceId = extractLibsignalDeviceIdFromRecord(item);

    let plaintext: string | null = null;
    if (payload.mode === 'prekey') {
      plaintext = await this.decryptPreKeyEnvelope(
        userId,
        item.sender_user_id,
        item.sender_device_id,
        senderLibsignalDeviceId,
        payload
      );
    } else if (payload.mode === 'signal') {
      plaintext = await this.decryptSignalEnvelope(
        userId,
        item.sender_user_id,
        item.sender_device_id,
        senderLibsignalDeviceId,
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
    if (this.inboxSyncEndpointUnavailable) return;
    const now = Date.now();
    const backoffUntil = this.inboxSyncBackoffUntil.get(userId) || 0;
    if (now < backoffUntil) {
      return;
    }
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
      this.inboxSyncBackoffUntil.delete(userId);
    })().catch((err) => {
      const errorCode = (err as { code?: string } | null)?.code;
      if (errorCode === 'SIGNAL_INBOX_ENDPOINT_NOT_FOUND') {
        this.inboxSyncEndpointUnavailable = true;
        console.warn('Signal inbox sync disabled: inbox endpoint is not available on the server');
        return;
      }
      this.inboxSyncBackoffUntil.set(userId, Date.now() + INBOX_SYNC_ERROR_BACKOFF_MS);
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

  private normalizeDmCryptoMode(_value: string | null | undefined): SignalDmCryptoMode {
    return DEFAULT_DM_CRYPTO_MODE;
  }

  async getDmCryptoMode(userId: string, peerUserId: string): Promise<SignalDmCryptoMode> {
    const stored = await signalStore.getDmCryptoMode(userId, peerUserId);
    if (stored) {
      const normalized = this.normalizeDmCryptoMode(stored);
      if (normalized !== stored) {
        await signalStore.putDmCryptoMode({
          userId,
          peerUserId,
          mode: normalized,
          updatedAt: new Date().toISOString(),
        });
      }
      return normalized;
    }

    await signalStore.putDmCryptoMode({
      userId,
      peerUserId,
      mode: DEFAULT_DM_CRYPTO_MODE,
      updatedAt: new Date().toISOString(),
    });
    return DEFAULT_DM_CRYPTO_MODE;
  }

  async setDmCryptoMode(
    userId: string,
    peerUserId: string,
    mode: SignalDmCryptoMode
  ): Promise<SignalDmCryptoMode> {
    const normalizedMode = this.normalizeDmCryptoMode(mode);
    await signalStore.putDmCryptoMode({
      userId,
      peerUserId,
      mode: normalizedMode,
      updatedAt: new Date().toISOString(),
    });
    return normalizedMode;
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

  /**
   * Bootstrap the local Signal account state without requiring a DM to be open.
   * This should be called after login so the user publishes device/prekeys early.
   */
  async bootstrapAccount(userId: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const localIdentity = await this.ensureLocalDeviceIdentity(userId);
      if (!localIdentity) return;

      const capabilities = await this.getServerCapabilities();
      if (!capabilities.supported || collectDmMissingRequirements(capabilities).length > 0) {
        return;
      }

      await this.ensureServerBootstrap(userId, localIdentity, capabilities);
      // Best-effort inbox sync to process any pending sender-key deliveries.
      void this.syncDeviceInbox(userId);
    } catch (err) {
      console.warn('Signal account bootstrap failed:', err);
    }
  }

  async prepareDmConversationMessage(input: {
    userId: string;
    peerUserId: string;
    plaintext: string;
    mode?: SignalDmCryptoMode;
  }): Promise<SignalPreparedConversationMessage> {
    if (!this.isEnabled()) {
      throw createSignalLockedError('Signal service is disabled');
    }

    // Signal-locked is the only supported DM mode.
    void this.normalizeDmCryptoMode(input.mode);

    const localIdentity = await this.ensureLocalDeviceIdentity(input.userId);
    if (!localIdentity) {
      throw createSignalLockedError('Signal device identity is missing');
    }

    const capabilities = await this.getServerCapabilities();
    if (!capabilities.supported || collectDmMissingRequirements(capabilities).length > 0) {
      throw createSignalLockedError('Signal capabilities are not available for this DM');
    }

    await this.ensureServerBootstrap(input.userId, localIdentity, capabilities);
    // Keep send-path latency low; background sync is handled by polling too.
    void this.syncDeviceInbox(input.userId);

    const resolveTargets = async (forceDirectoryRefresh: boolean): Promise<{
      targets: Array<{
        userId: string;
        deviceId: string;
        libsignalDeviceId: number | null;
        identityKey: string | null;
      }>;
      peerTargetDeviceIds: Set<string>;
    }> => {
      const targets: Array<{
        userId: string;
        deviceId: string;
        libsignalDeviceId: number | null;
        identityKey: string | null;
      }> = [];
      const targetSet = new Set<string>();
      const peerTargetDeviceIds = new Set<string>();

      const pushDevice = (
        userId: string,
        deviceId: string,
        libsignalDeviceId: number | null,
        identityKey: string | null
      ) => {
        const key = `${userId}:${deviceId}`;
        if (targetSet.has(key)) return;
        targetSet.add(key);
        targets.push({ userId, deviceId, libsignalDeviceId, identityKey });
      };

      // Always include the current sender device as a target so sent
      // messages remain decryptable after hard refresh/reload.
      pushDevice(
        input.userId,
        localIdentity.deviceId,
        normalizeLibsignalDeviceId(localIdentity.libsignalDeviceId) || null,
        null
      );

      const [peerDevicesResult, ownDevicesResult] = await Promise.allSettled([
        this.getKnownDevicesForUser(input.peerUserId, { force: forceDirectoryRefresh }),
        this.getKnownDevicesForUser(input.userId, { force: forceDirectoryRefresh }),
      ]);

      if (peerDevicesResult.status === 'fulfilled') {
        peerDevicesResult.value.forEach((device) => {
          if (device.device_id) {
            peerTargetDeviceIds.add(String(device.device_id));
            pushDevice(
              input.peerUserId,
              device.device_id,
              extractLibsignalDeviceIdFromRecord(device),
              typeof device.identity_key === 'string' ? device.identity_key : null
            );
          }
        });
      } else {
        console.warn('Signal DM peer device lookup failed:', peerDevicesResult.reason);
        throw createSignalLockedError('Failed to resolve peer Signal devices');
      }

      // Include sender devices so history works everywhere.
      if (ownDevicesResult.status === 'fulfilled') {
        ownDevicesResult.value.forEach((device) => {
          if (device.device_id) {
            pushDevice(
              input.userId,
              device.device_id,
              extractLibsignalDeviceIdFromRecord(device),
              typeof device.identity_key === 'string' ? device.identity_key : null
            );
          }
        });
      }

      return { targets, peerTargetDeviceIds };
    };

    let { targets, peerTargetDeviceIds } = await resolveTargets(false);

    // If the first lookup says "no peer device", force a fresh directory query
    // to avoid false negatives from short-lived cache staleness.
    if (!targets.some((target) => String(target.userId) === String(input.peerUserId))) {
      ({ targets, peerTargetDeviceIds } = await resolveTargets(true));
    }

    // Signal-locked DM must always have at least one peer device target.
    if (!targets.some((target) => String(target.userId) === String(input.peerUserId))) {
      throw createSignalLockedError('Peer has no active Signal devices');
    }

    if (targets.length === 0) {
      throw createSignalLockedError('No Signal device targets are available');
    }

    const envelopeResults = await Promise.all(
      targets.map(async (target) => {
        const encrypted = await this.buildEncryptedPayloadForDevice(
          input.userId,
          target.userId,
          target.deviceId,
          target.libsignalDeviceId,
          target.identityKey,
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
      throw createSignalLockedError('Failed to build Signal envelopes');
    }

    // Never send a Signal DM payload unless at least one peer-device envelope exists.
    // Otherwise receiver gets a signal_text message with no decryptable envelope.
    const hasPeerEnvelope = envelopes.some(
      (entry) => String(entry.recipient_user_id) === String(input.peerUserId)
    );
    if (!hasPeerEnvelope) {
      throw createSignalLockedError('No decryptable Signal envelope for peer device');
    }

    const coveredPeerDeviceIds = new Set<string>(
      envelopes
        .filter((entry) => String(entry.recipient_user_id) === String(input.peerUserId))
        .map((entry) => String(entry.recipient_device_id))
    );
    const missingPeerDeviceCount = Array.from(peerTargetDeviceIds).filter(
      (deviceId) => !coveredPeerDeviceIds.has(deviceId)
    ).length;
    if (missingPeerDeviceCount > 0) {
      throw createSignalLockedError(
        `Signal locked mode requires envelopes for all peer devices (${missingPeerDeviceCount} missing)`
      );
    }

    const senderLibsignalDeviceId = normalizeLibsignalDeviceId(localIdentity.libsignalDeviceId);
    if (!senderLibsignalDeviceId) {
      throw createSignalLockedError('Local Signal device is missing a libsignal numeric id');
    }

    const payload: SignalDmMessagePayload = {
      protocol: SIGNAL_PROTOCOL_MARKER,
      kind: SIGNAL_DM_MESSAGE_KIND,
      version: 1,
      sender_user_id: input.userId,
      sender_device_id: localIdentity.deviceId,
      sender_libsignal_device_id: senderLibsignalDeviceId,
      sent_at: new Date().toISOString(),
      envelopes,
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
        payload.sender_libsignal_device_id ?? null,
        targetEnvelope.payload
      );
    }

    return await this.decryptSignalEnvelope(
      input.userId,
      payload.sender_user_id,
      payload.sender_device_id,
      payload.sender_libsignal_device_id ?? null,
      targetEnvelope.payload
    );
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
            extractLibsignalDeviceIdFromRecord(device),
            typeof device.identity_key === 'string' ? device.identity_key : null,
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
        mode: 'signal_locked',
        reason: 'missing_local_signal_identity',
      };
    }

    const serverCapabilities = await this.getServerCapabilities();
    if (!serverCapabilities.supported) {
      return {
        enabled: true,
        ready: false,
        mode: 'signal_locked',
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
          mode: 'signal_locked',
          reason: 'signal_server_missing_dm_capabilities',
          deviceId: localIdentity.deviceId,
          missingServerRequirements: missingRequirements,
        };
      }

      if (!input.peerUserId) {
        return {
          enabled: true,
          ready: false,
          mode: 'signal_locked',
          reason: 'missing_dm_peer',
          deviceId: localIdentity.deviceId,
          missingServerRequirements: [],
        };
      }

      const libsignalSessionRows = await signalStore.listRawMetaByPrefix<{ id?: string }>(
        `libsignal:session:${input.userId}:${input.peerUserId}:`
      );
      if (libsignalSessionRows.length > 0) {
        return {
          enabled: true,
          ready: true,
          mode: 'signal_locked',
          deviceId: localIdentity.deviceId,
        };
      }

      return {
        enabled: true,
        ready: false,
        mode: 'signal_locked',
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
        mode: 'signal_locked',
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
        mode: 'signal_locked',
        deviceId: localIdentity.deviceId,
      };
    }

    return {
      enabled: true,
      ready: false,
      mode: 'signal_locked',
      reason: 'missing_group_sender_key',
      deviceId: localIdentity.deviceId,
      missingServerRequirements: [],
    };
  }
}

export const signalService = new SignalService();
