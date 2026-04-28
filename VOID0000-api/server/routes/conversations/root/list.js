import { Router } from 'express';
import { pool } from '../../../db.js';
import {
  canAccessMessageForHistory,
  cassandra,
  getConversationKeyState,
  scylla,
} from '../messages/shared.js';
import { normalizeConversationRow } from './shared.js';

const router = Router();
const PREVIEW_SCAN_LIMIT = 25;

function buildLastMessagePreview(messageRow, currentUserId) {
  if (!messageRow) return null;

  if (messageRow.is_deleted) {
    return 'Message deleted';
  }

  if (
    messageRow.message_type === 'system' &&
    typeof messageRow.encrypted_content === 'string' &&
    messageRow.encrypted_content.trim().length > 0
  ) {
    return messageRow.encrypted_content.trim();
  }

  const attachmentCount = Array.isArray(messageRow.attachments)
    ? messageRow.attachments.length
    : 0;
  const isSender = messageRow.sender_id?.toString() === currentUserId;

  if (attachmentCount > 0) {
    if (isSender) {
      return attachmentCount > 1 ? `You sent ${attachmentCount} attachments` : 'You sent an attachment';
    }
    return attachmentCount > 1 ? `Sent ${attachmentCount} attachments` : 'Sent an attachment';
  }

  return 'Encrypted message';
}

async function hydrateConversationPreview(row, userId) {
  const storageConversationId = row.storage_conversation_id || row.id;
  if (!storageConversationId) {
    return {
      ...row,
      last_message_id: null,
      last_message_sender_id: null,
      last_message_preview: null,
    };
  }

  try {
    const result = await scylla.execute(
      `SELECT message_id, sender_id, encrypted_content, message_type, attachments, is_deleted, created_at, key_version
       FROM messages
       WHERE conversation_id = ?
       ORDER BY message_id DESC
       LIMIT ?`,
      [cassandra.types.Uuid.fromString(String(storageConversationId)), PREVIEW_SCAN_LIMIT],
      { prepare: true }
    );

    let latestVisible = result.rows[0] || null;

    if (row.type !== 'dm') {
      const keyState = await getConversationKeyState(row, userId);
      if (!keyState) {
        latestVisible = null;
      } else {
        latestVisible = (result.rows || []).find((messageRow) =>
          canAccessMessageForHistory(
            {
              key_version: messageRow.key_version,
              created_at: messageRow.created_at?.toISOString() || null,
            },
            keyState
          )
        ) || null;
      }
    }

    return {
      ...row,
      last_message_id: latestVisible?.message_id?.toString() || null,
      last_message_sender_id: latestVisible?.sender_id?.toString() || null,
      last_message_preview: buildLastMessagePreview(latestVisible, userId),
    };
  } catch (err) {
    console.warn('[CONVERSATIONS_LIST] failed to hydrate preview', {
      conversation_id: row.id,
      storage_conversation_id: storageConversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ...row,
      last_message_id: null,
      last_message_sender_id: null,
      last_message_preview: null,
    };
  }
}

export async function getUserConversations(userId) {
  const result = await pool.query(
    `SELECT
         c.id,
         c.public_id,
         c.type,
         c.name,
         c.topic,
         c.slowmode_seconds,
         c.is_age_restricted,
         c.icon_filename,
         c.owner_id,
         c.parent_conversation_id,
         c.current_key_version,
         c.first_message_at,
         c.category_id,
         c.permissions,
         parent.public_id AS parent_public_id,
         c.created_at,
         c.updated_at,
         cm.role,
         cm.last_read_message_id,
         COALESCE(cm.unread_count, 0) AS unread_count,
         cm.muted_until,
         COALESCE(storage.storage_conversation_id, c.id) AS storage_conversation_id,
         CASE
           WHEN c.type = 'dm' THEN (
             SELECT u.username FROM conversation_members cm2
             JOIN users u ON u.id = cm2.user_id
             WHERE cm2.conversation_id = c.id AND cm2.user_id != $1
             LIMIT 1
           )
           ELSE NULL
         END AS dm_username,
         CASE
           WHEN c.type = 'dm' THEN (
             SELECT up.avatar_filename FROM conversation_members cm2
             JOIN users u ON u.id = cm2.user_id
             JOIN user_profiles up ON up.id = u.profile_id
             WHERE cm2.conversation_id = c.id AND cm2.user_id != $1
             LIMIT 1
           )
           ELSE NULL
         END AS dm_avatar,
         CASE
           WHEN c.type = 'dm' THEN (
             SELECT COALESCE(cm2.nickname, up.display_name, u.username) FROM conversation_members cm2
             JOIN users u ON u.id = cm2.user_id
             JOIN user_profiles up ON up.id = u.profile_id
             WHERE cm2.conversation_id = c.id AND cm2.user_id != $1
             LIMIT 1
           )
           ELSE NULL
         END AS dm_display_name,
         (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count
       FROM conversations c
       LEFT JOIN conversations parent ON parent.id = c.parent_conversation_id
       LEFT JOIN LATERAL (
         SELECT child.id AS storage_conversation_id
         FROM conversations child
         WHERE child.parent_conversation_id = c.id
           AND child.type = 'channel'
         ORDER BY
           CASE WHEN LOWER(child.name) = 'general' THEN 0 ELSE 1 END,
           child.created_at ASC
         LIMIT 1
       ) storage ON TRUE
       JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE cm.user_id = $1
         AND c.type != 'channel'
         AND (
           c.type != 'dm'
           OR (
             (c.first_message_at IS NOT NULL OR c.owner_id = $1)
             AND cm.is_hidden = FALSE
           )
         )
       ORDER BY c.updated_at DESC`,
    [userId]
  );

  return Promise.all(
    result.rows.map(async (row) => {
      const hydrated = await hydrateConversationPreview(row, userId);
      const { storage_conversation_id, ...conversationRow } = hydrated;
      return normalizeConversationRow(conversationRow);
    })
  );
}

router.get('/', async (req, res) => {
  const userId = req.user.id;

  try {
    const conversations = await getUserConversations(userId);
    res.json({ success: true, conversations });
  } catch (err) {
    console.error('Conversations GET error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

export default router;
