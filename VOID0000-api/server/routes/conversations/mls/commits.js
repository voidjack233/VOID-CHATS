import { Router } from 'express';
import { pool } from '../../../db.js';
import {
  ensureSchema,
  isEnabledFor,
  MAX_BATCH_ITEMS,
  MAX_EVENT_REF_LENGTH,
  MAX_MESSAGE_PAYLOAD_LENGTH,
  normalizeBatchInput,
  normalizeRequiredString,
  notEnabled,
  parsePositiveInt,
  resolveAccessibleConversationId,
  resolveCapabilities,
} from './shared.js';

const router = Router();

router.post('/commits', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'commit_fanout')) {
    return notEnabled(res, 'commit_fanout');
  }

  const requesterUserId = String(req.user.id);
  const items = normalizeBatchInput(req.body);
  if (items.length === 0 || items.length > MAX_BATCH_ITEMS) {
    return res.status(400).json({ success: false, error: `Provide 1-${MAX_BATCH_ITEMS} commit items` });
  }

  let client;
  try {
    await ensureSchema();
    client = await pool.connect();
    await client.query('BEGIN');

    const inserted = [];

    for (const item of items) {
      const conversationIdentifier = normalizeRequiredString(
        item?.conversation_id ?? item?.conversationId,
        128
      );
      const commitRef = normalizeRequiredString(item?.commit_ref ?? item?.commitRef, MAX_EVENT_REF_LENGTH);
      const payload = normalizeRequiredString(item?.payload, MAX_MESSAGE_PAYLOAD_LENGTH);
      const epochRaw = item?.epoch;
      const epoch = epochRaw == null ? null : parsePositiveInt(epochRaw, -1);

      if (!conversationIdentifier || !commitRef || !payload || epoch === -1) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Each item requires conversation_id, commit_ref, payload, and optional positive epoch',
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

      const insertResult = await client.query(
        `INSERT INTO mls_commit_messages (conversation_id, commit_ref, payload, epoch, received_at, applied_at)
         VALUES ($1::UUID, $2, $3, $4, NOW(), NULL)
         ON CONFLICT (conversation_id, commit_ref)
         DO NOTHING
         RETURNING conversation_id::text AS conversation_id,
                   commit_ref,
                   payload,
                   epoch,
                   received_at,
                   applied_at`,
        [resolved.conversationId, commitRef, payload, epoch]
      );

      if (insertResult.rows.length > 0) {
        const { payload: insertedPayload, ...insertedCommit } = insertResult.rows[0];
        inserted.push(insertedCommit);
        continue;
      }

      const existingResult = await client.query(
        `SELECT conversation_id::text AS conversation_id,
                commit_ref,
                payload,
                epoch,
                received_at,
                applied_at
         FROM mls_commit_messages
         WHERE conversation_id = $1::UUID
           AND commit_ref = $2
         LIMIT 1`,
        [resolved.conversationId, commitRef]
      );

      if (existingResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'Commit already exists but could not be reloaded' });
      }

      const existingCommit = existingResult.rows[0];
      const sameEpoch =
        (existingCommit.epoch == null && epoch == null) ||
        Number(existingCommit.epoch) === Number(epoch);

      if (existingCommit.payload !== payload || !sameEpoch) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          error: 'Commit ref already exists with different payload',
          code: 'MLS_COMMIT_IMMUTABLE',
        });
      }

      const { payload: existingPayload, ...existingCommitWithoutPayload } = existingCommit;
      inserted.push(existingCommitWithoutPayload);
    }

    await client.query('COMMIT');

    return res.json({
      success: true,
      data: {
        items: inserted,
      },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('MLS commit ingest error:', err);
    return res.status(500).json({ success: false, error: 'Failed to ingest MLS commits' });
  } finally {
    client?.release();
  }
});

router.post('/commits/:conversationId/:commitRef/apply', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'commit_fanout')) {
    return notEnabled(res, 'commit_fanout');
  }

  const userId = String(req.user.id);
  const conversationIdentifier = normalizeRequiredString(req.params.conversationId, 128);
  const commitRef = normalizeRequiredString(req.params.commitRef, MAX_EVENT_REF_LENGTH);

  if (!conversationIdentifier || !commitRef) {
    return res.status(400).json({ success: false, error: 'conversationId and commitRef are required' });
  }

  let client;
  try {
    await ensureSchema();
    client = await pool.connect();
    await client.query('BEGIN');

    const resolved = await resolveAccessibleConversationId(conversationIdentifier, userId, client);
    if (resolved.error === 'not_found') {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: `Conversation not found: ${conversationIdentifier}` });
    }
    if (resolved.error === 'forbidden') {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: `Not a member of conversation: ${conversationIdentifier}` });
    }

    const commitExists = await client.query(
      `SELECT conversation_id::text AS conversation_id,
              commit_ref,
              epoch
       FROM mls_commit_messages
       WHERE conversation_id = $1::UUID
         AND commit_ref = $2
       LIMIT 1`,
      [resolved.conversationId, commitRef]
    );

    if (commitExists.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Commit not found' });
    }

    const result = await client.query(
      `INSERT INTO mls_commit_receipts (user_id, conversation_id, commit_ref, applied_at)
       VALUES ($1::UUID, $2::UUID, $3, NOW())
       ON CONFLICT (user_id, conversation_id, commit_ref)
       DO UPDATE SET applied_at = COALESCE(mls_commit_receipts.applied_at, EXCLUDED.applied_at)
       RETURNING user_id::text AS user_id,
                 conversation_id::text AS conversation_id,
                 commit_ref,
                 applied_at`,
      [userId, resolved.conversationId, commitRef]
    );

    await client.query('COMMIT');
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('MLS commit apply error:', err);
    return res.status(500).json({ success: false, error: 'Failed to apply MLS commit' });
  } finally {
    client?.release();
  }
});

export default router;
