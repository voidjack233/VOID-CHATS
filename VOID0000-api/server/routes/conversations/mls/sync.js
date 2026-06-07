import { Router } from 'express';
import { pool } from '../../../db.js';
import { mlsSyncLimiter } from '../../../middleware/rate_limit.js';
import {
  DEFAULT_SYNC_LIMIT,
  ensureSchema,
  isEnabledFor,
  MAX_SYNC_LIMIT,
  parsePositiveInt,
  resolveCapabilities,
} from './shared.js';

const router = Router();

router.post('/sync', mlsSyncLimiter, async (req, res) => {
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
  const includeArchivedKeys =
    req.body?.include_archived_keys !== false &&
    req.body?.includeArchivedKeys !== false;

  try {
    await ensureSchema();

    const [keyPackagesResult, groupStatesResult, welcomesResult, commitsResult, archivedKeysResult] = await Promise.all([
      isEnabledFor(capabilities, 'key_packages')
        ? pool.query(
            `SELECT user_id::text AS user_id,
                    package_ref,
                    package_data,
                    published_at,
                    claimable_at,
                    consumed_at
             FROM mls_key_packages
             WHERE user_id = $1::UUID
             ORDER BY created_at DESC
             LIMIT $2`,
            [requesterUserId, limit]
          )
        : Promise.resolve({ rows: [] }),
      isEnabledFor(capabilities, 'group_state') && includeArchivedKeys
        ? pool.query(
            `WITH member_conversations AS (
               SELECT cm.conversation_id,
                      COALESCE(cm.joined_key_version, 1) AS joined_key_version
               FROM conversation_members cm
               WHERE cm.user_id = $1::UUID
             ),
             candidate_states AS (
               SELECT COALESCE(conversations.parent_conversation_id, conversations.id)::text AS conversation_id,
                      gs.user_id,
                      gs.group_id,
                      gs.epoch,
                      gs.key_version,
                      gs.state_blob,
                      gs.updated_at
               FROM mls_group_states gs
               JOIN conversations
                 ON conversations.id = gs.conversation_id
               JOIN member_conversations mc
                 ON mc.conversation_id = COALESCE(conversations.parent_conversation_id, conversations.id)
               WHERE (
                   gs.user_id = $1::UUID
                   OR conversations.type != 'dm'
                 )
                 AND COALESCE(gs.key_version, gs.epoch) >= mc.joined_key_version
                 AND (
                   conversations.type = 'dm'
                   OR COALESCE(gs.key_version, gs.epoch) <= COALESCE(conversations.current_key_version, 1)
                 )

               UNION ALL

               SELECT COALESCE(conversations.parent_conversation_id, conversations.id)::text AS conversation_id,
                      history.user_id,
                      history.group_id,
                      history.epoch,
                      history.key_version,
                      history.state_blob,
                      history.updated_at
               FROM mls_group_state_history history
               JOIN conversations
                 ON conversations.id = history.conversation_id
               JOIN member_conversations mc
                 ON mc.conversation_id = COALESCE(conversations.parent_conversation_id, conversations.id)
               WHERE (
                   history.user_id = $1::UUID
                   OR conversations.type != 'dm'
                 )
                 AND history.key_version >= mc.joined_key_version
                 AND (
                   conversations.type = 'dm'
                   OR history.key_version <= COALESCE(conversations.current_key_version, 1)
                 )
             ),
             deduped_states AS (
               SELECT DISTINCT ON (conversation_id, COALESCE(key_version, epoch))
                      conversation_id,
                      group_id,
                      epoch,
                      key_version,
                      state_blob,
                      updated_at
               FROM candidate_states
               ORDER BY conversation_id,
                        COALESCE(key_version, epoch),
                        (user_id = $1::UUID) DESC,
                        updated_at DESC
             )
             SELECT conversation_id,
                    group_id,
                    epoch,
                    key_version,
                    state_blob,
                    updated_at
             FROM deduped_states
             ORDER BY COALESCE(key_version, epoch) ASC, updated_at ASC
             LIMIT $2`,
            [requesterUserId, limit]
          )
        : Promise.resolve({ rows: [] }),
      isEnabledFor(capabilities, 'welcome_inbox')
        ? pool.query(
            `SELECT user_id,
                    welcome_ref,
                    payload,
                    conversation_id,
                    received_at,
                    key_version,
                    joined_key_version_floor
             FROM (
               SELECT DISTINCT ON (
                        welcomes.conversation_id,
                        COALESCE(welcomes.key_version, conversations.current_key_version, cm.joined_key_version, 1)
                      )
                      welcomes.user_id::text AS user_id,
                      welcomes.welcome_ref,
                      welcomes.payload,
                      welcomes.conversation_id::text AS conversation_id,
                      welcomes.received_at,
                      COALESCE(welcomes.key_version, conversations.current_key_version, cm.joined_key_version, 1) AS key_version,
                      COALESCE(cm.joined_key_version, 1) AS joined_key_version_floor
               FROM mls_welcome_messages AS welcomes
               JOIN conversation_members cm
                 ON cm.conversation_id = welcomes.conversation_id
                AND cm.user_id = welcomes.user_id
               JOIN conversations
                 ON conversations.id = welcomes.conversation_id
               WHERE welcomes.user_id = $1::UUID
                 AND welcomes.consumed_at IS NULL
                 AND welcomes.conversation_id IS NOT NULL
                 AND (
                   conversations.type = 'dm'
                   OR (
                     welcomes.key_version IS NOT NULL
                     AND welcomes.key_version >= COALESCE(cm.joined_key_version, 1)
                     AND welcomes.key_version <= COALESCE(conversations.current_key_version, 1)
                   )
                 )
               ORDER BY welcomes.conversation_id,
                        COALESCE(welcomes.key_version, conversations.current_key_version, cm.joined_key_version, 1),
                        welcomes.received_at DESC
             ) AS deliverable_welcomes
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
             JOIN conversations
               ON conversations.id = commits.conversation_id
             JOIN conversation_members cm
               ON cm.conversation_id = commits.conversation_id
             LEFT JOIN mls_commit_receipts receipts
               ON receipts.conversation_id = commits.conversation_id
              AND receipts.commit_ref = commits.commit_ref
              AND receipts.user_id = $1::UUID
             WHERE cm.user_id = $1::UUID
               AND receipts.commit_ref IS NULL
               AND (
                 commits.epoch IS NULL
                 OR commits.epoch >= GREATEST(COALESCE(cm.joined_key_version, 1) - 1, 1)
               )
               AND (
                 conversations.type = 'dm'
                 OR (
                   commits.epoch IS NOT NULL
                   AND commits.epoch < COALESCE(conversations.current_key_version, 1)
                 )
               )
               AND (
                 conversations.type = 'dm'
                 OR NOT EXISTS (
                   SELECT 1
                   FROM conversation_membership_rotations rotations
                   WHERE rotations.conversation_id = conversations.id
                     AND rotations.status = 'pending'
                     AND (rotations.expires_at IS NULL OR rotations.expires_at > NOW())
                 )
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
