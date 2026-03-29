import { pool } from '../db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNOWFLAKE_RE = /^\d+$/;

export function isUuid(value) {
  return UUID_RE.test(String(value || ''));
}

export function isSnowflakeId(value) {
  return SNOWFLAKE_RE.test(String(value || ''));
}

export async function findConversationByIdentifier(identifier, db = pool) {
  const value = String(identifier || '').trim();
  if (!value) return null;

  let result;

  if (isUuid(value)) {
    result = await db.query(
      `SELECT id, public_id, type, owner_id, parent_conversation_id, current_key_version, permissions
       FROM conversations
       WHERE id = $1
       LIMIT 1`,
      [value]
    );
  } else if (isSnowflakeId(value)) {
    result = await db.query(
      `SELECT id, public_id, type, owner_id, parent_conversation_id, current_key_version, permissions
       FROM conversations
       WHERE public_id = $1
       LIMIT 1`,
      [value]
    );
  } else {
    return null;
  }

  return result.rows[0] || null;
}

export async function resolveConversationId(identifier, db = pool) {
  const row = await findConversationByIdentifier(identifier, db);
  return row?.id || null;
}

export async function requireConversationId(identifier, db = pool) {
  const id = await resolveConversationId(identifier, db);
  if (!id) {
    const error = new Error('Conversation not found');
    error.statusCode = 404;
    throw error;
  }
  return id;
}
