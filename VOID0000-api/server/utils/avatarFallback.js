const CDN_BASE = process.env.CDN_URL || 'https://cdn.void0000.online';

export function resolveUserAvatarUrl(avatarFilename) {
  return avatarFilename
    ? `${CDN_BASE}/avatars/${avatarFilename}`
    : null;
}
