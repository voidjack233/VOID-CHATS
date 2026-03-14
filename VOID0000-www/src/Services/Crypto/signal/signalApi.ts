import { fetchWithAuth } from '../../Auth/authServiceApi';
import type {
  SignalServerCapabilities,
  SignalServerDeviceRecord,
} from './signalTypes';

const SIGNAL_API_PREFIX = '/api/conversations/signal';

interface SignalApiEnvelope<T> {
  success?: boolean;
  error?: string;
  message?: string;
  data?: T;
  capabilities?: T;
  bundle?: T;
  device?: T;
}

export interface RegisterSignalDevicePayload {
  device_id: string;
  registration_id: number;
  identity_key: string;
  signed_prekey: {
    key_id: number;
    public_key: string;
    signature: string;
  };
}

export interface UploadOneTimePreKeysPayload {
  device_id: string;
  prekeys: Array<{
    key_id: number;
    public_key: string;
  }>;
}

export interface SignalPreKeyBundle {
  user_id: string;
  device_id: string;
  registration_id: number;
  identity_key: string;
  signed_prekey: {
    key_id: number;
    public_key: string;
    signature: string;
  };
  one_time_prekey?: {
    key_id: number;
    public_key: string;
  } | null;
}

export interface SignalDeviceEnvelopePayload {
  recipient_user_id: string;
  recipient_device_id: string;
  type: 'prekey' | 'signal' | 'sender_key';
  ciphertext: string;
}

export interface SignalDeviceInboxItem {
  id: string;
  sender_user_id: string;
  sender_device_id: string;
  recipient_device_id: string;
  type: 'prekey' | 'signal' | 'sender_key';
  ciphertext: string;
  created_at: string;
}

interface SignalDeviceListPayload {
  devices?: SignalServerDeviceRecord[];
}

function normalizeCapabilityBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function pickCapability(raw: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    if (key in raw) {
      return normalizeCapabilityBoolean(raw[key]);
    }
  }
  return false;
}

function normalizeCapabilities(raw: unknown): SignalServerCapabilities {
  if (!raw || typeof raw !== 'object') {
    return {
      supported: false,
      deviceRegistry: false,
      prekeyBundles: false,
      deviceMessageFanout: false,
      groupSenderKeys: false,
      membershipRotationHooks: false,
      reason: 'invalid_capabilities_payload',
    };
  }

  const source = raw as Record<string, unknown>;
  const supported = pickCapability(source, ['supported', 'signal_supported', 'signal_enabled']);
  const deviceRegistry = pickCapability(source, ['device_registry', 'deviceRegistry']);
  const prekeyBundles = pickCapability(source, ['prekey_bundles', 'prekeyBundles']);
  const deviceMessageFanout = pickCapability(source, ['device_message_fanout', 'deviceMessageFanout']);
  const groupSenderKeys = pickCapability(source, ['group_sender_keys', 'groupSenderKeys']);
  const membershipRotationHooks = pickCapability(source, ['membership_rotation_hooks', 'membershipRotationHooks']);

  return {
    supported,
    deviceRegistry,
    prekeyBundles,
    deviceMessageFanout,
    groupSenderKeys,
    membershipRotationHooks,
  };
}

async function parseJsonSafe(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toApiError(payload: Record<string, unknown> | null, fallback: string): Error {
  const message = typeof payload?.error === 'string'
    ? payload.error
    : typeof payload?.message === 'string'
      ? payload.message
      : fallback;
  return new Error(message);
}

async function requireSuccess<T>(response: Response, fallbackError: string): Promise<SignalApiEnvelope<T>> {
  const payload = (await parseJsonSafe(response)) as SignalApiEnvelope<T> | null;
  if (!response.ok || payload?.success === false) {
    throw toApiError(payload as Record<string, unknown> | null, fallbackError);
  }
  return payload || {};
}

export async function fetchSignalCapabilities(): Promise<SignalServerCapabilities> {
  const response = await fetchWithAuth(`${SIGNAL_API_PREFIX}/capabilities`, { cache: 'no-store' });

  if (response.status === 404) {
    return {
      supported: false,
      deviceRegistry: false,
      prekeyBundles: false,
      deviceMessageFanout: false,
      groupSenderKeys: false,
      membershipRotationHooks: false,
      reason: 'capabilities_endpoint_not_found',
    };
  }

  if (!response.ok) {
    return {
      supported: false,
      deviceRegistry: false,
      prekeyBundles: false,
      deviceMessageFanout: false,
      groupSenderKeys: false,
      membershipRotationHooks: false,
      reason: `capabilities_http_${response.status}`,
    };
  }

  const payload = await parseJsonSafe(response);
  if (!payload) {
    return {
      supported: false,
      deviceRegistry: false,
      prekeyBundles: false,
      deviceMessageFanout: false,
      groupSenderKeys: false,
      membershipRotationHooks: false,
      reason: 'capabilities_payload_empty',
    };
  }

  const candidate = (payload.capabilities || payload.data || payload) as unknown;
  const normalized = normalizeCapabilities(candidate);
  if (!normalized.supported && !normalized.reason) {
    normalized.reason = 'capabilities_signal_not_enabled';
  }
  return normalized;
}

export async function registerSignalDevice(payload: RegisterSignalDevicePayload): Promise<void> {
  const response = await fetchWithAuth(`${SIGNAL_API_PREFIX}/devices`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  await requireSuccess<void>(response, 'Failed to register signal device');
}

export async function listSignalDevicesForUser(userId: string): Promise<SignalServerDeviceRecord[]> {
  const response = await fetchWithAuth(`${SIGNAL_API_PREFIX}/devices/${encodeURIComponent(userId)}`, {
    cache: 'no-store',
  });

  const payload = await requireSuccess<SignalDeviceListPayload>(
    response,
    'Failed to fetch signal devices'
  );
  const data = payload.data || {};
  return data.devices || [];
}

export async function uploadOneTimePreKeys(payload: UploadOneTimePreKeysPayload): Promise<void> {
  const response = await fetchWithAuth(`${SIGNAL_API_PREFIX}/prekeys`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  await requireSuccess<void>(response, 'Failed to upload one-time prekeys');
}

export async function getSignalPreKeyBundle(
  userId: string,
  deviceId: string
): Promise<SignalPreKeyBundle> {
  const response = await fetchWithAuth(
    `${SIGNAL_API_PREFIX}/prekeys/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}`
  );

  const payload = await requireSuccess<SignalPreKeyBundle>(response, 'Failed to fetch signal prekey bundle');
  const bundle = payload.bundle || payload.data;
  if (!bundle) {
    throw new Error('Signal prekey bundle payload is empty');
  }

  return bundle;
}

export async function sendSignalDeviceEnvelopes(
  conversationId: string,
  envelopes: SignalDeviceEnvelopePayload[],
  options?: { sender_device_id?: string }
): Promise<void> {
  const response = await fetchWithAuth(`${SIGNAL_API_PREFIX}/messages/${conversationId}`, {
    method: 'POST',
    body: JSON.stringify({
      envelopes,
      ...(options?.sender_device_id ? { sender_device_id: options.sender_device_id } : {}),
    }),
  });

  await requireSuccess<void>(response, 'Failed to send signal device envelopes');
}

export async function fetchSignalDeviceInbox(
  deviceId: string,
  options?: { cursor?: string; limit?: number }
): Promise<{ items: SignalDeviceInboxItem[]; next_cursor?: string | null }> {
  const params = new URLSearchParams();
  params.set('device_id', deviceId);
  if (options?.cursor) params.set('cursor', options.cursor);
  if (typeof options?.limit === 'number' && options.limit > 0) {
    params.set('limit', String(options.limit));
  }

  const response = await fetchWithAuth(`${SIGNAL_API_PREFIX}/messages/inbox?${params.toString()}`);
  const payload = await requireSuccess<{
    items?: SignalDeviceInboxItem[];
    next_cursor?: string | null;
  }>(response, 'Failed to fetch signal device inbox');

  const data = payload.data || {};
  return {
    items: data.items || [],
    next_cursor: data.next_cursor ?? null,
  };
}
