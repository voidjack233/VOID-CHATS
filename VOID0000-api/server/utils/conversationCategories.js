import { pool } from '../db.js';
import { findConversationByIdentifier } from './conversationIdentity.js';

export const DEFAULT_GROUP_CATEGORY_NAME = 'Text Channels';

export function normalizeCategory(category) {
  return {
    ...category,
    position: category.position != null ? Number(category.position) : 0,
    is_default: Boolean(category.is_default),
  };
}

export async function resolveGroupConversation(identifier, db = pool) {
  const resolvedConversation = await findConversationByIdentifier(identifier, db);
  if (!resolvedConversation) {
    return null;
  }

  if (resolvedConversation.type === 'group') {
    return resolvedConversation;
  }

  if (resolvedConversation.type === 'channel' && resolvedConversation.parent_conversation_id) {
    const parentConversation = await findConversationByIdentifier(resolvedConversation.parent_conversation_id, db);
    return parentConversation?.type === 'group' ? parentConversation : null;
  }

  return null;
}

export async function getGroupMemberRole(db, groupConversationId, userId) {
  const result = await db.query(
    `SELECT role
     FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [groupConversationId, userId]
  );

  return result.rows[0]?.role || null;
}

export async function ensureDefaultCategory(db, groupConversationId) {
  let categoryResult = await db.query(
    `SELECT id, group_conversation_id, name, position, is_default, created_at, updated_at
     FROM conversation_categories
     WHERE group_conversation_id = $1 AND is_default = TRUE
     ORDER BY position ASC, created_at ASC
     LIMIT 1`,
    [groupConversationId]
  );

  let category = categoryResult.rows[0];

  if (!category) {
    categoryResult = await db.query(
      `SELECT id, group_conversation_id, name, position, is_default, created_at, updated_at
       FROM conversation_categories
       WHERE group_conversation_id = $1 AND LOWER(name) = LOWER($2)
       ORDER BY position ASC, created_at ASC
       LIMIT 1`,
      [groupConversationId, DEFAULT_GROUP_CATEGORY_NAME]
    );

    if (categoryResult.rows[0]) {
      const updatedResult = await db.query(
        `UPDATE conversation_categories
         SET is_default = TRUE, updated_at = NOW()
         WHERE id = $1
         RETURNING id, group_conversation_id, name, position, is_default, created_at, updated_at`,
        [categoryResult.rows[0].id]
      );
      category = updatedResult.rows[0];
    } else {
      const insertResult = await db.query(
        `INSERT INTO conversation_categories (group_conversation_id, name, position, is_default)
         VALUES ($1, $2, 0, TRUE)
         RETURNING id, group_conversation_id, name, position, is_default, created_at, updated_at`,
        [groupConversationId, DEFAULT_GROUP_CATEGORY_NAME]
      );
      category = insertResult.rows[0];
    }
  }

  return normalizeCategory(category);
}

export async function getGroupCategories(db, groupConversationId) {
  const result = await db.query(
    `SELECT id, group_conversation_id, name, position, is_default, created_at, updated_at
     FROM conversation_categories
     WHERE group_conversation_id = $1
       AND COALESCE(is_default, FALSE) = FALSE
     ORDER BY position ASC, created_at ASC`,
    [groupConversationId]
  );

  return result.rows.map(normalizeCategory);
}

export async function resolveGroupCategory(db, groupConversationId, categoryId) {
  if (!categoryId) {
    return null;
  }

  const result = await db.query(
    `SELECT id, group_conversation_id, name, position, is_default, created_at, updated_at
     FROM conversation_categories
     WHERE id = $1
       AND group_conversation_id = $2
       AND COALESCE(is_default, FALSE) = FALSE
     LIMIT 1`,
    [categoryId, groupConversationId]
  );

  return result.rows[0] ? normalizeCategory(result.rows[0]) : null;
}
