import { pool } from '../db.js';

export async function resolveMessageStorageConversation(conversation, db = pool) {
  if (!conversation || conversation.type !== 'group') {
    return conversation;
  }

  const result = await db.query(
    `SELECT id, public_id, type, owner_id, parent_conversation_id, current_key_version, slowmode_seconds
     FROM conversations
     WHERE parent_conversation_id = $1
       AND type = 'channel'
     ORDER BY
       CASE WHEN LOWER(name) = 'general' THEN 0 ELSE 1 END,
       created_at ASC
     LIMIT 1`,
    [conversation.id]
  );

  return result.rows[0] || conversation;
}
