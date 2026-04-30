import { Router } from 'express';
import { pool } from '../../../db.js';
import { mlsGroupKeyArchiveLimiter } from '../../../middleware/rate_limit.js';
import {
  ensureSchema,
  MAX_BATCH_ITEMS,
  MAX_PACKAGE_DATA_LENGTH,
  normalizeBatchInput,
  normalizeOptionalString,
  normalizeRequiredString,
  parsePositiveInt,
  resolveAccessibleConversationId,
  resolveCapabilities,
  notEnabled,
} from './shared.js';

const router = Router();

router.post('/group-key-archive', mlsGroupKeyArchiveLimiter, async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!capabilities.supported) {
    return notEnabled(res, 'group_state');
  }

  const requesterUserId = String(req.user.id);
  const items = normalizeBatchInput(req.body).slice(0, MAX_BATCH_ITEMS);

  if (items.length === 0) {
    return res.json({ success: true, data: { items: [] } });
  }

  let client;
  try {
    await ensureSchema();
    client = await pool.connect();
    await client.query('BEGIN');

    const upserted = [];
    for (const item of items) {
      const conversationIdentifier = normalizeOptionalString(
        item.conversation_id ?? item.conversationId,
        64
      );
      const keyVersion = parsePositiveInt(item.key_version ?? item.keyVersion, null);
      const keyData = normalizeRequiredString(item.key_data ?? item.keyData, MAX_PACKAGE_DATA_LENGTH);
      const replaceExisting =
        item.replace_existing === true ||
        item.replaceExisting === true ||
        req.body?.replace_existing === true ||
        req.body?.replaceExisting === true;

      if (!conversationIdentifier || !keyVersion || !keyData) continue;

      const resolved = await resolveAccessibleConversationId(conversationIdentifier, requesterUserId, client);
      if (resolved.error) continue;

      const result = replaceExisting
        ? await client.query(
            `INSERT INTO mls_group_key_archive (conversation_id, key_version, user_id, key_data, created_at)
             VALUES ($1::UUID, $2, $3::UUID, $4, NOW())
             ON CONFLICT (conversation_id, key_version, user_id) DO UPDATE SET
               key_data = EXCLUDED.key_data,
               created_at = NOW()
             RETURNING conversation_id::text AS conversation_id, key_version`,
            [resolved.conversationId, keyVersion, requesterUserId, keyData]
          )
        : await client.query(
            `INSERT INTO mls_group_key_archive (conversation_id, key_version, user_id, key_data, created_at)
             VALUES ($1::UUID, $2, $3::UUID, $4, NOW())
             ON CONFLICT (conversation_id, key_version, user_id) DO NOTHING
             RETURNING conversation_id::text AS conversation_id, key_version`,
            [resolved.conversationId, keyVersion, requesterUserId, keyData]
          );

      if (result.rows[0]) {
        upserted.push(result.rows[0]);
      }
    }

    await client.query('COMMIT');
    return res.json({ success: true, data: { items: upserted } });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('MLS group key archive error:', err);
    return res.status(500).json({ success: false, error: 'Failed to archive group keys' });
  } finally {
    client?.release();
  }
});

export default router;
