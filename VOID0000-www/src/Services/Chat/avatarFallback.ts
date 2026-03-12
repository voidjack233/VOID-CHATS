export function getAvatarInitial(displayName?: string | null, username?: string | null) {
  const source = String(displayName || username || '').trim();
  return source ? source.charAt(0).toUpperCase() : '#';
}

export function isGeneratedFallbackAvatarUrl(avatarUrl?: string | null) {
  return typeof avatarUrl === 'string' && avatarUrl.startsWith('data:image/svg+xml');
}

export function resolveAvatarUrl(
  avatarUrl?: string | null,
  _options: {
    displayName?: string | null;
    username?: string | null;
    seed?: string | null;
  } = {}
) {
  if (!avatarUrl || isGeneratedFallbackAvatarUrl(avatarUrl)) {
    return null;
  }

  return avatarUrl;
}
