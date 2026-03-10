import { Router } from 'express';
import { pool } from '../../db.js';
import {
  getGroupCategories,
  getGroupMemberRole,
  normalizeCategory,
  resolveGroupConversation,
} from '../../utils/conversationCategories.js';

const router = Router({ mergeParams: true });

router.get('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const groupConversation = await resolveGroupConversation(conversationId);
    if (!groupConversation) {
      return res.status(404).json({ error: 'Group conversation not found' });
    }

    const role = await getGroupMemberRole(pool, groupConversation.id, userId);
    if (!role) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const categories = await getGroupCategories(pool, groupConversation.id);
    res.json({ success: true, categories });
  } catch (err) {
    console.error('Conversation categories GET error:', err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { name } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    return res.status(400).json({ error: 'Name is required (max 100 characters)' });
  }

  try {
    const groupConversation = await resolveGroupConversation(conversationId);
    if (!groupConversation) {
      return res.status(404).json({ error: 'Group conversation not found' });
    }

    const role = await getGroupMemberRole(pool, groupConversation.id, userId);
    if (!role) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    if (!['owner', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'Only owner or admin can create categories' });
    }

    const trimmedName = name.trim();
    const existing = await pool.query(
      `SELECT id
       FROM conversation_categories
       WHERE group_conversation_id = $1
         AND LOWER(name) = LOWER($2)
       LIMIT 1`,
      [groupConversation.id, trimmedName]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'A category with that name already exists in this group' });
    }

    const positionResult = await pool.query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next_position
       FROM conversation_categories
       WHERE group_conversation_id = $1`,
      [groupConversation.id]
    );

    const nextPosition = Number(positionResult.rows[0]?.next_position || 1);
    const insertResult = await pool.query(
      `INSERT INTO conversation_categories (group_conversation_id, name, position, is_default)
       VALUES ($1, $2, $3, FALSE)
       RETURNING id, group_conversation_id, name, position, is_default, created_at, updated_at`,
      [groupConversation.id, trimmedName, nextPosition]
    );

    res.status(201).json({
      success: true,
      category: normalizeCategory(insertResult.rows[0]),
    });
  } catch (err) {
    console.error('Conversation categories POST error:', err);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

export default router;
