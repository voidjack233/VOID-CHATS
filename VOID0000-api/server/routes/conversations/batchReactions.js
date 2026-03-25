// server/routes/conversations/batchReactions.js

import { Router } from 'express';
import { pool } from '../../db.js';
import scylla, { cassandra } from '../../scylla.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { resolveMessageStorageConversation } from '../../utils/messageConversation.js';

const router = Router({ mergeParams: true });

function normalizeKeyVersion(value, fallback = 1) {
  const parsed = parseInt(String(value ?? fallback), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function getConversationKeyState(conversation, userId) {
  if (!conversation || conversation.type === 'dm') {
    return {
      currentKeyVersion: 1,
      historyStartVersion: 1,
      joinedAt: null,
      role: null,
    };
  }

  const keyConversationId = conversation.parent_conversation_id || conversation.id;
  const result = await pool.query(
    `SELECT c.current_key_version, cm.history_start_version, cm.joined_at, cm.role
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE c.id = $1 AND cm.user_id = $2
     LIMIT 1`,
    [keyConversationId, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return {
    currentKeyVersion: normalizeKeyVersion(result.rows[0].current_key_version, 1),
    historyStartVersion: normalizeKeyVersion(result.rows[0].history_start_version, 1),
    joinedAt: result.rows[0].joined_at ? new Date(result.rows[0].joined_at).toISOString() : null,
    role: result.rows[0].role || null,
  };
}

function canAccessMessageForHistory(message, keyState) {
  if (!keyState) return false;

  if (normalizeKeyVersion(message.key_version, 1) < keyState.historyStartVersion) {
    return false;
  }

  if (keyState.role === 'owner') {
    return true;
  }

  if (!keyState.joinedAt || !message.created_at) {
    return true;
  }

  const joinedAt = Date.parse(keyState.joinedAt);
  const createdAt = Date.parse(message.created_at);

  if (Number.isNaN(joinedAt) || Number.isNaN(createdAt)) {
    return true;
  }

  return createdAt >= joinedAt;
}

async function resolveConversationContexts(conversationIdentifier) {
  const conversation = await findConversationByIdentifier(conversationIdentifier);
  if (!conversation) {
    return null;
  }

  const storageConversation = await resolveMessageStorageConversation(conversation);

  return {
    conversation,
    conversationId: conversation.id,
    conversationPublicId: conversation.public_id ? String(conversation.public_id) : null,
    storageConversationId: storageConversation?.id || conversation.id,
  };
}

// GET /api/conversations/:conversationId/reactions?message_ids=id1,id2,id3
router.get('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier } = req.params;
  const { message_ids } = req.query;

  if (!message_ids) {
    return res.status(400).json({ error: 'message_ids query param required' });
  }

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const {
      conversation,
      conversationId,
      conversationPublicId,
      storageConversationId,
    } = resolvedConversation;

    const memberCheck = await pool.query(
      `SELECT role FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    const ids = String(message_ids).split(',').filter(Boolean).slice(0, 100);

    if (ids.length === 0) {
      return res.json({ success: true, reactions: {} });
    }

    const convUuid = cassandra.types.Uuid.fromString(storageConversationId);
    const userUuid = cassandra.types.Uuid.fromString(userId);

    let msgUuids = ids
      .map((id) => {
        try {
          return cassandra.types.TimeUuid.fromString(id);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (msgUuids.length === 0) {
      return res.json({
        success: true,
        conversation_id: conversationId,
        conversation_public_id: conversationPublicId,
        reactions: {},
      });
    }

    if (conversation.type !== 'dm') {
      const keyState = await getConversationKeyState(conversation, userId);
      if (!keyState) {
        return res.status(403).json({ error: 'Missing group key membership state' });
      }

      const visibilityResult = await scylla.execute(
        `SELECT message_id, key_version, created_at
         FROM messages
         WHERE conversation_id = ? AND message_id IN ?`,
        [convUuid, msgUuids],
        { prepare: true }
      ).catch(() => ({ rows: [] }));

      const visibleMessageIdSet = new Set(
        visibilityResult.rows
          .map((row) => ({
            message_id: row.message_id.toString(),
            key_version: row.key_version,
            created_at: row.created_at?.toISOString() || null,
          }))
          .filter((message) => canAccessMessageForHistory(message, keyState))
          .map((message) => message.message_id)
      );

      msgUuids = msgUuids.filter((uuid) => visibleMessageIdSet.has(uuid.toString()));

      if (msgUuids.length === 0) {
        return res.json({
          success: true,
          conversation_id: conversationId,
          conversation_public_id: conversationPublicId,
          reactions: {},
        });
      }
    }

    const [countsResult, meResult] = await Promise.all([
      scylla.execute(
        `SELECT message_id, emoji, count FROM reaction_counts
         WHERE conversation_id = ? AND message_id IN ?`,
        [convUuid, msgUuids],
        { prepare: true }
      ).catch(() => ({ rows: [] })),
      scylla.execute(
        `SELECT message_id, emoji FROM user_reactions
         WHERE conversation_id = ? AND user_id = ? AND message_id IN ?`,
        [convUuid, userUuid, msgUuids],
        { prepare: true }
      ).catch(() => ({ rows: [] })),
    ]);

    const meSet = new Set();
    for (const row of meResult.rows) {
      meSet.add(`${row.message_id.toString()}:${row.emoji}`);
    }

    const reactions = {};
    for (const row of countsResult.rows) {
      const msgId = row.message_id.toString();
      const emoji = row.emoji;
      const count = row.count.toNumber ? row.count.toNumber() : Number(row.count);

      if (count <= 0) continue;

      if (!reactions[msgId]) reactions[msgId] = {};
      reactions[msgId][emoji] = {
        count,
        me: meSet.has(`${msgId}:${emoji}`),
      };
    }

    res.json({
      success: true,
      conversation_id: conversationId,
      conversation_public_id: conversationPublicId,
      reactions,
    });
  } catch (err) {
    console.error('Batch reactions error:', err);
    res.status(500).json({ error: 'Failed to fetch reactions' });
  }
});

export default router;
