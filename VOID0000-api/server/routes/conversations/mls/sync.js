import { Router } from 'express';
import { pool } from '../../../db.js';
import {
  DEFAULT_SYNC_LIMIT,
  ensureSchema,
  isEnabledFor,
  MAX_SYNC_LIMIT,
  parsePositiveInt,
  resolveCapabilities,
} from './shared.js';

const router = Router();

router.post('/sync', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!capabilities.supported) {
    return res.json({
      success: true,
      data: {
        key_packages: [],
        group_states: [],
        welcomes: [],
        commits: [],
      },
    });
  }

  const requesterUserId = String(req.user.id);
  const limit = parsePositiveInt(req.body?.limit ?? req.query?.limit, DEFAULT_SYNC_LIMIT, MAX_SYNC_LIMIT);

  try {
    await ensureSchema();

    const [keyPackagesResult, groupStatesResult, welcomesResult, commitsResult, archivedKeysResult] = await Promise.all([
      isEnabledFor(capabilities, 'key_packages')
        ? pool.query(
            `SELECT user_id::text AS user_id,
                    package_ref,
                    package_data,
                    published_at,
                    consumed_at
             FROM mls_key_packages
             WHERE user_id = $1::UUID
             ORDER BY created_at DESC
             LIMIT $2`,
            [requesterUserId, limit]
          )
        : Promise.resolve({ rows: [] }),
      isEnabledFor(capabilities, 'group_state')
        ? pool.query(
            `SELECT COALESCE(conversations.parent_conversation_id, conversations.id)::text AS conversation_id,
                    gs.group_id,
                    gs.epoch,
                    gs.key_version,
                    gs.state_blob,
                    gs.updated_at
             FROM mls_group_states gs
             JOIN conversations
               ON conversations.id = gs.conversation_id
             JOIN conversation_members cm
               ON cm.conversation_id = COALESCE(conversations.parent_conversation_id, conversations.id)
             LEFT JOIN mls_group_states own_gs
               ON own_gs.conversation_id = gs.conversation_id
              AND own_gs.user_id = $1::UUID
             WHERE cm.user_id = $1::UUID
               AND (
                 gs.user_id = $1::UUID
                 OR (
                   conversations.type != 'dm'
                   AND (
                     own_gs.conversation_id IS NULL
                     OR COALESCE(gs.key_version, gs.epoch) > COALESCE(own_gs.key_version, own_gs.epoch)
                   )
                 )
               )
               AND COALESCE(gs.key_version, gs.epoch) >= COALESCE(cm.joined_key_version, 1)
             ORDER BY gs.updated_at DESC
             LIMIT $2`,
            [requesterUserId, limit]
          )
        : Promise.resolve({ rows: [] }),
      isEnabledFor(capabilities, 'welcome_inbox')
        ? pool.query(
            `SELECT welcomes.user_id::text AS user_id,
                    welcomes.welcome_ref,
                    welcomes.payload,
                    welcomes.conversation_id::text AS conversation_id,
                    welcomes.received_at,
                    COALESCE(cm.joined_key_version, 1) AS joined_key_version_floor
             FROM mls_welcome_messages AS welcomes
             JOIN conversation_members cm
               ON cm.conversation_id = welcomes.conversation_id
              AND cm.user_id = welcomes.user_id
             WHERE welcomes.user_id = $1::UUID
               AND welcomes.consumed_at IS NULL
               AND welcomes.conversation_id IS NOT NULL
             ORDER BY received_at ASC
             LIMIT $2`,
            [requesterUserId, limit]
          )
        : Promise.resolve({ rows: [] }),
      isEnabledFor(capabilities, 'commit_fanout')
        ? pool.query(
            `SELECT commits.conversation_id::text AS conversation_id,
                    commits.commit_ref,
                    commits.payload,
                    commits.epoch,
                    commits.received_at
             FROM mls_commit_messages AS commits
             JOIN conversation_members cm
               ON cm.conversation_id = commits.conversation_id
             WHERE cm.user_id = $1::UUID
               AND commits.applied_at IS NULL
               AND (
                 commits.epoch IS NULL
                 OR commits.epoch >= GREATEST(COALESCE(cm.joined_key_version, 1) - 1, 1)
               )
             ORDER BY commits.received_at ASC
             LIMIT $2`,
            [requesterUserId, limit]
          )
        : Promise.resolve({ rows: [] }),
      isEnabledFor(capabilities, 'group_state')
        ? pool.query(
            `SELECT ka.conversation_id::text AS conversation_id,
                    ka.key_version,
                    ka.key_data
             FROM mls_group_key_archive ka
             JOIN conversation_members cm
               ON cm.conversation_id = ka.conversation_id
             WHERE cm.user_id = $1::UUID
               AND ka.user_id = $1::UUID
               AND ka.key_version >= COALESCE(cm.joined_key_version, 1)
             ORDER BY ka.conversation_id, ka.key_version ASC
             LIMIT $2`,
            [requesterUserId, limit * 10]
          )
        : Promise.resolve({ rows: [] }),
    ]);

    return res.json({
      success: true,
      data: {
        key_packages: keyPackagesResult.rows,
        group_states: groupStatesResult.rows,
        welcomes: welcomesResult.rows,
        commits: commitsResult.rows,
        archived_keys: archivedKeysResult.rows,
      },
    });
  } catch (err) {
    console.error('MLS sync error:', err);
    return res.status(500).json({ success: false, error: 'Failed to sync MLS state' });
  }
});

export default router;
