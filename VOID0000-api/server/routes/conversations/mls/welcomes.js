import { Router } from 'express';
import { pool } from '../../../db.js';
import { findConversationByIdentifier } from '../../../utils/conversationIdentity.js';
import {
  ensureSchema,
  isEnabledFor,
  MAX_BATCH_ITEMS,
  MAX_EVENT_REF_LENGTH,
  MAX_MESSAGE_PAYLOAD_LENGTH,
  normalizeBatchInput,
  normalizeOptionalString,
  normalizeRequiredString,
  normalizeUserId,
  notEnabled,
  parsePositiveInt,
  resolveCapabilities,
} from './shared.js';

const router = Router();

router.post('/welcomes', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'welcome_inbox')) {
    return notEnabled(res, 'welcome_inbox');
  }

  const requesterUserId = String(req.user.id);
  const items = normalizeBatchInput(req.body);
  if (items.length === 0 || items.length > MAX_BATCH_ITEMS) {
    return res.status(400).json({ success: false, error: `Provide 1-${MAX_BATCH_ITEMS} welcome items` });
  }

  let client;
  try {
    await ensureSchema();
    client = await pool.connect();
    await client.query('BEGIN');

    const inserted = [];

    for (const item of items) {
      const userId = normalizeUserId(item?.user_id) || requesterUserId;
      const welcomeRef = normalizeRequiredString(item?.welcome_ref ?? item?.welcomeRef, MAX_EVENT_REF_LENGTH);
      const payload = normalizeRequiredString(item?.payload, MAX_MESSAGE_PAYLOAD_LENGTH);
      const conversationIdentifier = normalizeOptionalString(
        item?.conversation_id ?? item?.conversationId,
        128
      );
      const keyVersionRaw = item?.key_version ?? item?.keyVersion;
      const keyVersion = keyVersionRaw == null ? null : parsePositiveInt(keyVersionRaw, -1);

      if (!welcomeRef || !payload) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Each item requires welcome_ref and payload',
        });
      }

      if (keyVersion === -1) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'key_version must be a positive integer when provided',
        });
      }

      let conversationId = null;
      if (conversationIdentifier) {
        const resolvedConversation = await findConversationByIdentifier(conversationIdentifier, client);
        if (!resolvedConversation) {
          await client.query('ROLLBACK');
          return res.status(404).json({ success: false, error: `Conversation not found: ${conversationIdentifier}` });
        }
        conversationId = resolvedConversation.id;
      }

      const result = await client.query(
        `INSERT INTO mls_welcome_messages (user_id, welcome_ref, conversation_id, payload, key_version, received_at, consumed_at)
         VALUES ($1::UUID, $2, $3::UUID, $4, $5, NOW(), NULL)
         ON CONFLICT (user_id, welcome_ref)
         DO UPDATE SET
           conversation_id = EXCLUDED.conversation_id,
           payload = EXCLUDED.payload,
           key_version = EXCLUDED.key_version,
           received_at = NOW(),
           consumed_at = NULL
         RETURNING user_id::text AS user_id,
                   welcome_ref,
                   conversation_id::text AS conversation_id,
                   key_version,
                   received_at,
                   consumed_at`,
        [userId, welcomeRef, conversationId, payload, keyVersion]
      );

      inserted.push(result.rows[0]);
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
    console.error('MLS welcome ingest error:', err);
    return res.status(500).json({ success: false, error: 'Failed to ingest MLS welcomes' });
  } finally {
    client?.release();
  }
});

router.post('/welcomes/:welcomeRef/consume', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'welcome_inbox')) {
    return notEnabled(res, 'welcome_inbox');
  }

  const userId = String(req.user.id);
  const welcomeRef = normalizeRequiredString(req.params.welcomeRef, MAX_EVENT_REF_LENGTH);
  if (!welcomeRef) {
    return res.status(400).json({ success: false, error: 'welcomeRef is required' });
  }

  try {
    await ensureSchema();

    const result = await pool.query(
      `UPDATE mls_welcome_messages
       SET consumed_at = COALESCE(consumed_at, NOW())
       WHERE user_id = $1::UUID
         AND welcome_ref = $2
       RETURNING user_id::text AS user_id, welcome_ref, consumed_at`,
      [userId, welcomeRef]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Welcome not found' });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('MLS welcome consume error:', err);
    return res.status(500).json({ success: false, error: 'Failed to consume MLS welcome' });
  }
});

export default router;
