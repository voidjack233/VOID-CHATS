import { Router } from 'express';
import { pool } from '../../db.js';

export function createPendingSelfLeavesRouter({ database = pool } = {}) {
  const router = Router();

  router.get('/self-leaves/pending', async (req, res) => {
    try {
      const result = await database.query(
        `SELECT rotations.operation_id::text AS operation_id,
              rotations.conversation_id::text AS conversation_id,
              conversations.public_id::text AS conversation_public_id,
              rotations.target_user_ids[1]::text AS target_user_id,
              COALESCE(NULLIF(profiles.display_name, ''), users.username, 'A member') AS target_label,
              rotations.reserved_key_version AS pending_key_version,
              conversations.current_key_version
       FROM conversation_membership_rotations rotations
       JOIN conversations
         ON conversations.id = rotations.conversation_id
       JOIN conversation_members membership
         ON membership.conversation_id = rotations.conversation_id
        AND membership.user_id = $1::UUID
       LEFT JOIN users
         ON users.id = rotations.target_user_ids[1]
       LEFT JOIN user_profiles profiles
         ON profiles.id = users.profile_id
       WHERE rotations.kind = 'self_leave'
         AND rotations.status = 'pending'
       ORDER BY rotations.created_at ASC`,
        [req.user.id],
      );

      return res.json({ success: true, rotations: result.rows });
    } catch (err) {
      console.error('Pending self-leave list error:', err);
      return res.status(500).json({ error: 'Failed to load pending self-leaves' });
    }
  });

  return router;
}

export default createPendingSelfLeavesRouter();
