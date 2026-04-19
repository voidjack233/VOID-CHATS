// server/routes/conversations/reactions.js
import { Router } from 'express';
import { pool } from '../../db.js';
import scylla, { cassandra } from '../../scylla.js';
import { queueReactionEventToUser } from '../../gateway/client.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { reactionEventId } from '../../utils/eventIdentity.js';
import { resolveMessageStorageConversation } from '../../utils/messageConversation.js';

const router = Router({ mergeParams: true });
const MAX_UNIQUE_REACTIONS_PER_MESSAGE = 10;
const MAX_REACTION_EMOJI_GRAPHEMES = 1;
const MAX_REACTION_EMOJI_LENGTH = 64;

async function verifyMembership(conversationId, userId) {
  const result = await pool.query(
    `SELECT role FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  return result.rows[0] || null;
}

async function getConversationMembers(conversationId) {
  const result = await pool.query(
    `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
    [conversationId]
  );
  return result.rows.map((r) => r.user_id);
}

function conversationPublicId(conversation) {
  return conversation?.public_id ? String(conversation.public_id) : null;
}

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
    'SELECT c.current_key_version, cm.history_start_version, cm.joined_at, cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE c.id = $1 AND cm.user_id = $2 LIMIT 1',
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

function normalizeReactionCount(value) {
  if (value && typeof value.toNumber === 'function') {
    return value.toNumber();
  }

  return Number(value || 0);
}

function getEmojiGraphemeCount(value) {
  if (!value) return 0;

  if (typeof Intl?.Segmenter === 'function') {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
    ).length;
  }

  return Array.from(value).length;
}

function normalizeReactionEmoji(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > MAX_REACTION_EMOJI_LENGTH) {
    return null;
  }

  if (getEmojiGraphemeCount(normalized) > MAX_REACTION_EMOJI_GRAPHEMES) {
    return null;
  }

  return normalized;
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
    conversationPublic: conversationPublicId(conversation),
    storageConversationId: storageConversation?.id || conversation.id,
  };
}

// PUT /:emoji — toggle reaction
router.put('/:emoji', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;
  const emoji = normalizeReactionEmoji(decodeURIComponent(req.params.emoji));

  if (!emoji) {
    return res.status(400).json({ error: 'Invalid emoji' });
  }

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const {
      conversation,
      conversationId,
      conversationPublic,
      storageConversationId,
    } = resolvedConversation;
    const member = await verifyMembership(conversationId, userId);
    if (!member) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    const convUuid = cassandra.types.Uuid.fromString(storageConversationId);
    const msgUuid = cassandra.types.TimeUuid.fromString(messageId);
    const userUuid = cassandra.types.Uuid.fromString(userId);

    const keyState = await getConversationKeyState(conversation, userId);
    if (!keyState) {
      return res.status(403).json({ error: 'Missing group key membership state' });
    }

    if (conversation.type !== 'dm') {
      const visibilityResult = await scylla.execute(
        'SELECT message_id, key_version, created_at FROM messages WHERE conversation_id = ? AND message_id = ?',
        [convUuid, msgUuid],
        { prepare: true }
      );

      if (visibilityResult.rows.length === 0) {
        return res.status(404).json({ error: 'Message not found' });
      }

      const row = visibilityResult.rows[0];
      const historyProbe = {
        key_version: row.key_version,
        created_at: row.created_at?.toISOString() || null,
      };

      if (!canAccessMessageForHistory(historyProbe, keyState)) {
        return res.status(404).json({ error: 'Message not found' });
      }
    }

    const existing = await scylla.execute(
      `SELECT user_id FROM message_reactions
       WHERE conversation_id = ? AND message_id = ? AND emoji = ? AND user_id = ?`,
      [convUuid, msgUuid, emoji, userUuid],
      { prepare: true }
    );

    let action;

    if (existing.rows.length > 0) {
      await Promise.all([
        scylla.execute(
          `DELETE FROM message_reactions
           WHERE conversation_id = ? AND message_id = ? AND emoji = ? AND user_id = ?`,
          [convUuid, msgUuid, emoji, userUuid],
          { prepare: true }
        ),
        scylla.execute(
          `UPDATE reaction_counts SET count = count - 1
           WHERE conversation_id = ? AND message_id = ? AND emoji = ?`,
          [convUuid, msgUuid, emoji],
          { prepare: true }
        ),
        scylla.execute(
          `DELETE FROM user_reactions
           WHERE conversation_id = ? AND user_id = ? AND message_id = ? AND emoji = ?`,
          [convUuid, userUuid, msgUuid, emoji],
          { prepare: true }
        ),
      ]);
      action = 'remove';
    } else {
      const reactionCounts = await scylla.execute(
        `SELECT emoji, count FROM reaction_counts
         WHERE conversation_id = ? AND message_id = ?`,
        [convUuid, msgUuid],
        { prepare: true }
      );

      const activeReactionEmojis = reactionCounts.rows
        .filter((row) => normalizeReactionCount(row.count) > 0)
        .map((row) => row.emoji);

      if (
        !activeReactionEmojis.includes(emoji) &&
        activeReactionEmojis.length >= MAX_UNIQUE_REACTIONS_PER_MESSAGE
      ) {
        return res.status(409).json({
          error: `Maximum of ${MAX_UNIQUE_REACTIONS_PER_MESSAGE} reactions per message`,
          code: 'REACTION_LIMIT_REACHED',
        });
      }

      await Promise.all([
        scylla.execute(
          `INSERT INTO message_reactions (conversation_id, message_id, emoji, user_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [convUuid, msgUuid, emoji, userUuid, new Date()],
          { prepare: true }
        ),
        scylla.execute(
          `UPDATE reaction_counts SET count = count + 1
           WHERE conversation_id = ? AND message_id = ? AND emoji = ?`,
          [convUuid, msgUuid, emoji],
          { prepare: true }
        ),
        scylla.execute(
          `INSERT INTO user_reactions (conversation_id, user_id, message_id, emoji)
           VALUES (?, ?, ?, ?)`,
          [convUuid, userUuid, msgUuid, emoji],
          { prepare: true }
        ),
      ]);
      action = 'add';
    }

    const payload = {
      event_id: reactionEventId({
        conversationId,
        messageId,
        emoji,
        userId,
        action,
      }),
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageId,
      emoji,
      user_id: userId,
      action,
    };

    const members = await getConversationMembers(conversationId);
    members.forEach((memberId) => {
      if (memberId !== userId) {
        queueReactionEventToUser(memberId, payload);
      }
    });

    res.json({ success: true, ...payload });
  } catch (err) {
    console.error('Reaction toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle reaction' });
  }
});

export default router;
