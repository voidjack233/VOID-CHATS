import { fetchWithAuth } from '../Auth/authServiceApi';

const PUSH_WORKER_PATH = '/push-sw.js';
const PUSH_WORKER_SCOPE = '/';
const PUSH_READY_TIMEOUT_MS = 8000;
const PUSH_PROMPT_DISMISSED_UNTIL_KEY = 'void_push_prompt_dismissed_until';
const PUSH_PROMPT_NEVER_KEY = 'void_push_prompt_never';
const PUSH_PROMPT_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

let vapidKeyPromise: Promise<{ configured: boolean; publicKey: string | null }> | null = null;

class BrowserPushError extends Error {
  detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'BrowserPushError';
    this.detail = detail;
  }
}

export type BrowserPushPermission = NotificationPermission | 'unsupported';

export interface BrowserPushStatus {
  supported: boolean;
  configured: boolean;
  permission: BrowserPushPermission;
  subscribed: boolean;
  reason?: string;
}

function readLocalStorageNumber(key: string) {
  try {
    return Number(window.localStorage.getItem(key) || '0');
  } catch {
    return 0;
  }
}

function writeLocalStorageValue(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Best effort only. The settings page still works without this.
  }
}

function isBrowserPushSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    window.isSecureContext
  );
}

function unsupportedReason() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'Browser push is not available here.';
  }
  if (!window.isSecureContext) {
    return 'Browser push requires HTTPS or localhost.';
  }
  if (!('serviceWorker' in navigator)) {
    return 'This browser does not support service workers.';
  }
  if (!('PushManager' in window) || !('Notification' in window)) {
    return 'This browser does not support Web Push.';
  }
  return 'Browser push is not supported on this device.';
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = `${base64String}${padding}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

async function getVapidPublicKey() {
  if (vapidKeyPromise) {
    return vapidKeyPromise;
  }

  vapidKeyPromise = (async () => {
    const response = await fetchWithAuth('/api/notifications/vapid-public-key');
    const data = await response.json();

    return {
      configured: Boolean(data.configured && data.publicKey),
      publicKey: typeof data.publicKey === 'string' ? data.publicKey : null,
    };
  })();

  try {
    return await vapidKeyPromise;
  } catch (error) {
    vapidKeyPromise = null;
    throw error;
  }
}

function waitForActivePushWorker() {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error('Browser push worker is still starting. Try again in a moment.'));
      }, PUSH_READY_TIMEOUT_MS);
    }),
  ]);
}

async function getPushRegistration() {
  const existing = await navigator.serviceWorker.getRegistration(PUSH_WORKER_SCOPE);
  const registration = existing || await navigator.serviceWorker.register(PUSH_WORKER_PATH, {
    scope: PUSH_WORKER_SCOPE,
    updateViaCache: 'none',
  });

  await registration.update().catch(() => undefined);

  if (registration.active) {
    return registration;
  }

  await waitForActivePushWorker();
  const activeRegistration = await navigator.serviceWorker.getRegistration(PUSH_WORKER_SCOPE);

  if (!activeRegistration?.active) {
    throw new Error('Browser push worker is still starting. Try again in a moment.');
  }

  return activeRegistration;
}

async function subscribeWithActiveRegistration(publicKey: string) {
  const registration = await getPushRegistration();
  const existingSubscription = await registration.pushManager.getSubscription();
  if (existingSubscription) {
    return existingSubscription;
  }

  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
}

function isRecoverablePushRegistrationError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('no active service worker') ||
    message.includes('registration failed') ||
    message.includes('push service error')
  );
}

function explainSubscribeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('push service error')) {
    return new BrowserPushError(
      'Browser permission is allowed, but the browser push provider rejected registration.',
      [
        `Browser error: ${errorName}: ${message}`,
        `Permission: ${Notification.permission}`,
        `Secure context: ${String(window.isSecureContext)}`,
        `Browser: ${navigator.userAgent}`,
        'This usually means the browser mode/provider cannot use Web Push right now, such as Tor/private hardened mode, blocked Google/Mozilla push service, or stale browser push state.',
      ].join('\n')
    );
  }

  return new BrowserPushError(message || 'Browser push registration failed.', `${errorName}: ${message}`);
}

export async function getBrowserPushStatus(): Promise<BrowserPushStatus> {
  if (!isBrowserPushSupported()) {
    return {
      supported: false,
      configured: false,
      permission: 'unsupported',
      subscribed: false,
      reason: unsupportedReason(),
    };
  }

  const [{ configured }, registration] = await Promise.all([
    getVapidPublicKey().catch(() => ({ configured: false, publicKey: null })),
    navigator.serviceWorker.getRegistration(PUSH_WORKER_SCOPE),
  ]);
  const subscription = await registration?.pushManager.getSubscription();

  return {
    supported: true,
    configured,
    permission: Notification.permission,
    subscribed: Boolean(subscription),
    reason: configured ? undefined : 'Server VAPID keys are not configured yet.',
  };
}

export async function subscribeToBrowserPush() {
  if (!isBrowserPushSupported()) {
    throw new Error(unsupportedReason());
  }

  const { configured, publicKey } = await getVapidPublicKey();
  if (!configured || !publicKey) {
    throw new Error('Server VAPID keys are not configured yet.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Browser notification permission is blocked.'
      : 'Browser notification permission was not granted.');
  }

  let subscription: PushSubscription;
  try {
    subscription = await subscribeWithActiveRegistration(publicKey);
  } catch (error) {
    if (!isRecoverablePushRegistrationError(error)) {
      throw explainSubscribeError(error);
    }

    const staleRegistration = await navigator.serviceWorker.getRegistration(PUSH_WORKER_SCOPE);
    await staleRegistration?.unregister().catch(() => false);
    subscription = await subscribeWithActiveRegistration(publicKey).catch((retryError) => {
      throw explainSubscribeError(retryError);
    });
  }

  const response = await fetchWithAuth('/api/notifications/subscribe', {
    method: 'POST',
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || 'Failed to save push subscription.');
  }

  return subscription;
}

export function dismissBrowserPushSoftPrompt(durationMs = PUSH_PROMPT_SNOOZE_MS) {
  if (typeof window === 'undefined') return;
  writeLocalStorageValue(PUSH_PROMPT_DISMISSED_UNTIL_KEY, String(Date.now() + durationMs));
}

export function permanentlyDismissBrowserPushSoftPrompt() {
  if (typeof window === 'undefined') return;
  writeLocalStorageValue(PUSH_PROMPT_NEVER_KEY, 'true');
}

export function shouldShowBrowserPushSoftPrompt(status: BrowserPushStatus | null) {
  if (!status?.supported || !status.configured || status.subscribed) {
    return false;
  }

  if (status.permission !== 'default') {
    return false;
  }

  try {
    if (window.localStorage.getItem(PUSH_PROMPT_NEVER_KEY) === 'true') {
      return false;
    }
  } catch {
    return false;
  }

  return readLocalStorageNumber(PUSH_PROMPT_DISMISSED_UNTIL_KEY) <= Date.now();
}

export async function unsubscribeFromBrowserPush() {
  if (!isBrowserPushSupported()) {
    return;
  }

  const registration = await navigator.serviceWorker.getRegistration(PUSH_WORKER_SCOPE);
  const subscription = await registration?.pushManager.getSubscription();
  const endpoint = subscription?.endpoint || null;

  if (subscription) {
    await subscription.unsubscribe().catch(() => false);
  }

  await fetchWithAuth('/api/notifications/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint }),
  });
}

export async function sendBrowserPushTest() {
  const response = await fetchWithAuth('/api/notifications/test', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.error || 'Failed to send test push.');
  }

  return data;
}
