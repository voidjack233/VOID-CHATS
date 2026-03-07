// server/routes/conversations/index.js
import { Router } from 'express';
import { pool } from '../../db.js';
import { authenticateUser } from '../../middleware/jwt.js';
import dmRouter from './dm.js';
import membersRouter from './members.js';
import messagesRouter from './messages.js';
import reactionsRouter from './reactions.js';
import batchReactionsRouter from './batchReactions.js';
import keysRouter from './keys.js';
import attachmentsRouter from './attachments.js';

const router = Router();

// Sub-routes
router.use('/dm', authenticateUser, dmRouter);
router.use('/:conversationId/members', authenticateUser, membersRouter);
router.use('/:conversationId/messages', authenticateUser, messagesRouter);
router.use('/:conversationId/messages/:messageId/reactions', authenticateUser, reactionsRouter);
router.use('/:conversationId/reactions', authenticateUser, batchReactionsRouter);
router.use('/:conversationId/attachments', authenticateUser, attachmentsRouter);
router.use('/keys', authenticateUser, keysRouter);

// GET /api/conversations — list user's conversations
router.get('/', authenticateUser, async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT 
        c.id, c.type, c.name, c.icon_filename, c.owner_id, c.created_at, c.updated_at,
        cm.role, cm.last_read_message_id,
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
            SELECT up.display_name FROM conversation_members cm2
            JOIN users u ON u.id = cm2.user_id
            JOIN user_profiles up ON up.id = u.profile_id
            WHERE cm2.conversation_id = c.id AND cm2.user_id != $1
            LIMIT 1
          )
          ELSE NULL
        END AS dm_display_name,
        (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE cm.user_id = $1
       ORDER BY c.updated_at DESC`,
      [userId]
    );

    const baseUrl = process.env.CDN_URL || 'https://cdn.void0000.online';

    const conversations = result.rows.map((conv) => ({
      ...conv,
      dm_avatar_url: conv.dm_avatar
        ? `${baseUrl}/avatars/${conv.dm_avatar}`
        : conv.dm_username
          ? `https://api.dicebear.com/7.x/avataaars/svg?seed=${conv.dm_username}`
          : null,
      member_count: parseInt(conv.member_count),
    }));

    res.json({ success: true, conversations });
  } catch (err) {
    console.error('Conversations GET error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// POST /api/conversations — create group or channel
router.post('/', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { type, name, members } = req.body;

  if (!type || !['group', 'channel'].includes(type)) {
    return res.status(400).json({ error: 'Type must be "group" or "channel"' });
  }

  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    return res.status(400).json({ error: 'Name is required (max 100 characters)' });
  }

  if (!Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'At least one member required' });
  }

  // Max 50 members on creation
  if (members.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 members on creation' });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Create conversation
    const convResult = await client.query(
      `INSERT INTO conversations (type, name, owner_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [type, name.trim(), userId]
    );

    const conversation = convResult.rows[0];

    // Add owner as member
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [conversation.id, userId]
    );

    // Add other members (verify they exist and are friends)
    const uniqueMembers = [...new Set(members.filter((id) => id !== userId))];

    for (const memberId of uniqueMembers) {
      // Verify friendship
      const friendCheck = await client.query(
        `SELECT id FROM friendships
         WHERE ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
           AND status = 'accepted'`,
        [userId, memberId]
      );

      if (friendCheck.rows.length > 0) {
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT DO NOTHING`,
          [conversation.id, memberId]
        );
      }
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      conversation,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Conversation create error:', err);
    res.status(500).json({ error: 'Failed to create conversation' });
  } finally {
    if (client) client.release();
  }
});

// GET /api/conversations/:id — get conversation details
router.get('/:conversationId', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    // Verify membership
    const memberCheck = await pool.query(
      `SELECT role FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    const result = await pool.query(
      `SELECT c.*,
        json_agg(json_build_object(
          'user_id', cm.user_id,
          'role', cm.role,
          'nickname', cm.nickname,
          'joined_at', cm.joined_at,
          'username', u.username,
          'display_name', up.display_name,
          'avatar_filename', up.avatar_filename,
          'profile_id', u.profile_id
        )) AS members
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       JOIN users u ON u.id = cm.user_id
       JOIN user_profiles up ON up.id = u.profile_id
       WHERE c.id = $1
       GROUP BY c.id`,
      [conversationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conversation = result.rows[0];
    const baseUrl = process.env.CDN_URL || 'https://cdn.void0000.online';

    conversation.members = conversation.members.map((m) => ({
      ...m,
      avatar_url: m.avatar_filename
        ? `${baseUrl}/avatars/${m.avatar_filename}`
        : `https://api.dicebear.com/7.x/avataaars/svg?seed=${m.username}`,
    }));

    res.json({ success: true, conversation });
  } catch (err) {
    console.error('Conversation GET error:', err);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// PUT /api/conversations/:id — update conversation
router.put('/:conversationId', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { name } = req.body;

  try {
    // Check if owner or admin
    const memberCheck = await pool.query(
      `SELECT role FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member' });
    }

    if (!['owner', 'admin'].includes(memberCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Only owner or admin can update' });
    }

    const result = await pool.query(
      `UPDATE conversations
       SET name = COALESCE($1, name), updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [name?.trim() || null, conversationId]
    );

    res.json({ success: true, conversation: result.rows[0] });
  } catch (err) {
    console.error('Conversation PUT error:', err);
    res.status(500).json({ error: 'Failed to update conversation' });
  }
});

// DELETE /api/conversations/:id — delete conversation (owner only)
router.delete('/:conversationId', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const memberCheck = await pool.query(
      `SELECT role FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0 || memberCheck.rows[0].role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can delete this conversation' });
    }

    await pool.query('DELETE FROM conversations WHERE id = $1', [conversationId]);

    res.json({ success: true, message: 'Conversation deleted' });
  } catch (err) {
    console.error('Conversation DELETE error:', err);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

export default router;