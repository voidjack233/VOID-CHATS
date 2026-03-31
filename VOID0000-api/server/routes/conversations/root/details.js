import { Router } from 'express';
import { pool } from '../../../db.js';
import { findConversationByIdentifier } from '../../../utils/conversationIdentity.js';
import { resolveUserAvatarUrl } from '../../../utils/avatarFallback.js';
import { getConversationMemberRole, normalizeConversationRow } from './shared.js';

const router = Router();

router.get('/:conversationId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const resolvedConversation = await findConversationByIdentifier(conversationId);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const memberRole = await getConversationMemberRole(resolvedConversation.id, userId);
    if (!memberRole) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    const result = await pool.query(
      `SELECT c.*, parent.public_id AS parent_public_id,
              (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count,
              json_agg(json_build_object(
                'user_id', cm.user_id,
                'role', cm.role,
                'nickname', cm.nickname,
                'joined_at', cm.joined_at,
                'joined_key_version', cm.joined_key_version,
                'history_start_version', cm.history_start_version,
                'username', u.username,
                'display_name', up.display_name,
                'avatar_filename', up.avatar_filename,
                'profile_id', u.profile_id
              )) AS members
       FROM conversations c
       LEFT JOIN conversations parent ON parent.id = c.parent_conversation_id
       JOIN conversation_members cm ON cm.conversation_id = c.id
       JOIN users u ON u.id = cm.user_id
       JOIN user_profiles up ON up.id = u.profile_id
       WHERE c.id = $1
       GROUP BY c.id, parent.public_id`,
      [resolvedConversation.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conversation = normalizeConversationRow(result.rows[0]);

    conversation.members = conversation.members.map((member) => ({
      ...member,
      joined_key_version: member.joined_key_version != null ? parseInt(member.joined_key_version, 10) : null,
      history_start_version: member.history_start_version != null ? parseInt(member.history_start_version, 10) : null,
      avatar_url: resolveUserAvatarUrl(member.avatar_filename),
    }));

    if (conversation.type === 'dm') {
      const peer = conversation.members.find((member) => member.user_id !== userId) || null;
      conversation.dm_user_id = peer?.user_id || null;
      conversation.dm_username = peer?.username || null;
      conversation.dm_display_name =
        peer?.nickname ||
        peer?.display_name ||
        peer?.username ||
        null;
      conversation.dm_avatar_url = peer?.avatar_url || null;
    }

    conversation.channels = [];

    res.json({ success: true, conversation });
  } catch (err) {
    console.error('Conversation GET error:', err);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

export default router;
