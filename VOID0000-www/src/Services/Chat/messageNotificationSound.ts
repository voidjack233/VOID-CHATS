const INCOMING_MESSAGE_SOUND_SRC = '/sounds/notification.mp3';
const PLAY_COOLDOWN_MS = 350;
const DEFAULT_VOLUME = 0.7;
const MESSAGE_NOTIFICATIONS_ENABLED_KEY = 'void_message_notifications_enabled';

let incomingMessageAudio: HTMLAudioElement | null = null;
let unlockInstalled = false;
let soundReady = false;
let lastPlayAt = 0;

function canUseAudio() {
  return typeof window !== 'undefined' && typeof Audio !== 'undefined';
}

export function areMessageNotificationsEnabled() {
  if (typeof window === 'undefined') return true;

  try {
    return window.localStorage.getItem(MESSAGE_NOTIFICATIONS_ENABLED_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setMessageNotificationsEnabled(enabled: boolean) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(MESSAGE_NOTIFICATIONS_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch {
    // Non-critical; fall back to current-session behavior only.
  }
}

function getIncomingMessageAudio() {
  if (!canUseAudio()) return null;

  if (!incomingMessageAudio) {
    incomingMessageAudio = new Audio(INCOMING_MESSAGE_SOUND_SRC);
    incomingMessageAudio.preload = 'auto';
    incomingMessageAudio.volume = DEFAULT_VOLUME;
  }

  return incomingMessageAudio;
}

export function primeIncomingMessageSound() {
  if (!canUseAudio() || unlockInstalled) return;
  unlockInstalled = true;

  const cleanup = () => {
    window.removeEventListener('pointerdown', unlockSound);
    window.removeEventListener('keydown', unlockSound);
    window.removeEventListener('touchstart', unlockSound);
  };

  const unlockSound = () => {
    const audio = getIncomingMessageAudio();
    cleanup();

    soundReady = true;
    if (audio) {
      audio.load();
    }
  };

  window.addEventListener('pointerdown', unlockSound, { passive: true });
  window.addEventListener('keydown', unlockSound);
  window.addEventListener('touchstart', unlockSound, { passive: true });
}

export async function testIncomingMessageSound() {
  const audio = getIncomingMessageAudio();
  if (!audio) return false;

  try {
    audio.muted = false;
    audio.currentTime = 0;
    await audio.play();
    soundReady = true;
    lastPlayAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

export async function playIncomingMessageSound() {
  if (!areMessageNotificationsEnabled()) return false;
  if (!soundReady) return false;

  const audio = getIncomingMessageAudio();
  if (!audio) return false;

  const now = Date.now();
  if (now - lastPlayAt < PLAY_COOLDOWN_MS) return false;

  try {
    audio.muted = false;
    audio.currentTime = 0;
    await audio.play();
    lastPlayAt = now;
    return true;
  } catch {
    // If the browser blocks playback again, stay quiet instead of throwing.
    return false;
  }
}
