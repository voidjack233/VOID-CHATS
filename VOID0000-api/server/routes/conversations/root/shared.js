import { pool } from '../../../db.js';
import { EVENTS } from '../../../gateway/protocol.js';
import { sendLiveEventToUser } from '../../../gateway/client.js';
import { BUCKET, GROUP_AVATAR_BUCKET } from '../../../minio.js';
import { resolveUserAvatarUrl } from '../../../utils/avatarFallback.js';
import { resolvePermissions } from '../../../utils/groupPermissions.js';

export const MAX_ICON_PAYLOAD_SIZE = 10 * 1024 * 1024;
export const MAX_ICON_DIMENSION = 4096;
export const ALLOWED_ICON_MIME_PREFIXES = [
  'data:image/jpeg',
  'data:image/jpg',
  'data:image/png',
  'data:image/gif',
  'data:image/webp',
];

const ICON_MAGIC_BYTES = {
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
  gif: [0x47, 0x49, 0x46],
  webp: [0x52, 0x49, 0x46, 0x46],
};

const baseUrl = process.env.CDN_URL || 'https://cdn.void0000.online';

export const buildObjectUrl = (bucket, filename) => (
  filename ? `${baseUrl}/${bucket}/${filename}` : null
);

export const buildAvatarUrl = (filename) => (
  filename ? `${baseUrl}/${BUCKET}/${filename}` : null
);

export const resolveGroupIconBucket = (filename) => (
  filename?.startsWith('groups/')
    ? BUCKET
    : GROUP_AVATAR_BUCKET
);

export const buildGroupIconUrl = (filename) => (
  filename ? buildObjectUrl(resolveGroupIconBucket(filename), filename) : null
);

export const isValidImage = (buffer) => {
  if (buffer.length < 4) return false;

  return Object.values(ICON_MAGIC_BYTES).some((magic) =>
    magic.every((byte, index) => buffer[index] === byte)
  );
};

export async function getConversationMemberIds(conversationId) {
  const result = await pool.query(
    `SELECT user_id
     FROM conversation_members
     WHERE conversation_id = $1`,
    [conversationId]
  );

  return result.rows.map(({ user_id }) => user_id);
}

export async function getConversationMemberRole(conversationId, userId) {
  const result = await pool.query(
    `SELECT role
     FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );

  return result.rows[0]?.role || null;
}

export async function broadcastConversationUpdate(conversationId, conversation) {
  const memberIds = await getConversationMemberIds(conversationId);
  const payload = { conversation };

  memberIds.forEach((userId) => {
    sendLiveEventToUser(userId, EVENTS.CONVERSATION_UPDATE, payload);
  });
}

export function normalizeConversationRow(conv) {
  return {
    ...conv,
    public_id: conv.public_id ? String(conv.public_id) : null,
    parent_public_id: conv.parent_public_id ? String(conv.parent_public_id) : null,
    current_key_version: conv.current_key_version != null ? parseInt(conv.current_key_version, 10) : null,
    first_message_at: conv.first_message_at ? new Date(conv.first_message_at).toISOString() : null,
    member_count: conv.member_count != null ? parseInt(conv.member_count, 10) : 0,
    unread_count: conv.unread_count != null ? parseInt(conv.unread_count, 10) : 0,
    slowmode_seconds: conv.slowmode_seconds != null ? parseInt(conv.slowmode_seconds, 10) : 0,
    is_age_restricted: !!conv.is_age_restricted,
    last_message_id: conv.last_message_id ? String(conv.last_message_id) : null,
    last_message_sender_id: conv.last_message_sender_id ? String(conv.last_message_sender_id) : null,
    last_message_preview: typeof conv.last_message_preview === 'string' ? conv.last_message_preview : null,
    icon_url: buildGroupIconUrl(conv.icon_filename),
    permissions: conv.type === 'group' ? resolvePermissions(conv.permissions) : undefined,
    dm_avatar_url: resolveUserAvatarUrl(conv.dm_avatar, {
      displayName: conv.dm_display_name,
      username: conv.dm_username,
    }),
  };
}
