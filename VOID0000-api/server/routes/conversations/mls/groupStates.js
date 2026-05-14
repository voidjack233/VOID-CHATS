import { Router } from 'express';
import { pool } from '../../../db.js';
import { debugLog } from '../../../utils/debugLog.js';
import {
  ensureSchema,
  isEnabledFor,
  MAX_BATCH_ITEMS,
  MAX_GROUP_ID_LENGTH,
  MAX_STATE_BLOB_LENGTH,
  normalizeBatchInput,
  normalizeRequiredString,
  notEnabled,
  parsePositiveInt,
  resolveAccessibleConversationId,
  resolveCapabilities,
} from './shared.js';

const router = Router();

router.post('/group-states', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'group_state')) {
    return notEnabled(res, 'group_state');
  }

  const requesterUserId = String(req.user.id);
  const items = normalizeBatchInput(req.body);
  if (items.length === 0 || items.length > MAX_BATCH_ITEMS) {
    return res.status(400).json({ success: false, error: `Provide 1-${MAX_BATCH_ITEMS} group state items` });
  }

  let client;
  try {
    await ensureSchema();
    client = await pool.connect();
    await client.query('BEGIN');

    const upserted = [];

    for (const item of items) {
      const conversationIdentifier = normalizeRequiredString(
        item?.conversation_id ?? item?.conversationId,
        128
      );
      const groupId = normalizeRequiredString(item?.group_id ?? item?.groupId, MAX_GROUP_ID_LENGTH);
      const stateBlob = normalizeRequiredString(item?.state_blob ?? item?.stateBlob, MAX_STATE_BLOB_LENGTH);
      const epoch = parsePositiveInt(item?.epoch, -1);
      const keyVersionRaw = item?.key_version ?? item?.keyVersion;
      const keyVersion = keyVersionRaw == null ? null : parsePositiveInt(keyVersionRaw, -1);

      if (!conversationIdentifier || !groupId || !stateBlob || epoch <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Each item requires conversation_id, group_id, state_blob, and positive epoch',
        });
      }

      if (keyVersion === -1) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'key_version must be a positive integer when provided',
        });
      }

      const resolved = await resolveAccessibleConversationId(conversationIdentifier, requesterUserId, client);
      if (resolved.error === 'not_found') {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: `Conversation not found: ${conversationIdentifier}` });
      }
      if (resolved.error === 'forbidden') {
        await client.query('ROLLBACK');
        return res.status(403).json({ success: false, error: `Not a member of conversation: ${conversationIdentifier}` });
      }

      const result = await client.query(
        `INSERT INTO mls_group_states (conversation_id, user_id, group_id, epoch, key_version, state_blob, created_at, updated_at)
         VALUES ($1::UUID, $2::UUID, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (conversation_id, user_id)
         DO UPDATE SET
           group_id = EXCLUDED.group_id,
           epoch = EXCLUDED.epoch,
           key_version = COALESCE(EXCLUDED.key_version, mls_group_states.key_version),
           state_blob = EXCLUDED.state_blob,
           updated_at = NOW()
         WHERE mls_group_states.epoch IS NULL
            OR EXCLUDED.epoch >= mls_group_states.epoch
            OR (EXCLUDED.key_version IS NOT NULL
                AND EXCLUDED.key_version > COALESCE(mls_group_states.key_version, 0))
         RETURNING conversation_id::text AS conversation_id, group_id, epoch, key_version, updated_at`,
        [resolved.conversationId, requesterUserId, groupId, epoch, keyVersion, stateBlob]
      );

      if (result.rows[0]) {
        upserted.push(result.rows[0]);
        if (keyVersion) {
          await client.query(
            `INSERT INTO mls_group_state_history (
               conversation_id,
               user_id,
               group_id,
               epoch,
               key_version,
               state_blob,
               created_at,
               updated_at
             )
             VALUES ($1::UUID, $2::UUID, $3, $4, $5, $6, NOW(), NOW())
             ON CONFLICT (conversation_id, user_id, key_version)
             DO UPDATE SET
               group_id = EXCLUDED.group_id,
               epoch = EXCLUDED.epoch,
               state_blob = EXCLUDED.state_blob,
               updated_at = NOW()
             WHERE EXCLUDED.epoch >= mls_group_state_history.epoch`,
            [resolved.conversationId, requesterUserId, groupId, epoch, keyVersion, stateBlob]
          );
        }
        continue;
      }

      const existing = await client.query(
        `SELECT conversation_id::text AS conversation_id, group_id, epoch, key_version, updated_at
         FROM mls_group_states
         WHERE conversation_id = $1::UUID
           AND user_id = $2::UUID
         LIMIT 1`,
        [resolved.conversationId, requesterUserId]
      );

      if (existing.rows[0]) {
        debugLog('[MLS_GROUP_STATE] ignoring stale upload', {
          conversation_id: resolved.conversationId,
          requester_user_id: requesterUserId,
          incoming_epoch: epoch,
          stored_epoch: existing.rows[0].epoch,
        });
        upserted.push(existing.rows[0]);
      }
    }

    await client.query('COMMIT');

    return res.json({
      success: true,
      data: {
        items: upserted,
      },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('MLS group state upsert error:', err);
    return res.status(500).json({ success: false, error: 'Failed to upsert MLS group states' });
  } finally {
    client?.release();
  }
});

export default router;
