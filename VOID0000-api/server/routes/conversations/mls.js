import { Router } from 'express';
import { pool } from '../../db.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';

const router = Router();

const DEFAULT_SYNC_LIMIT = 100;
const MAX_SYNC_LIMIT = 500;
const MAX_BATCH_ITEMS = 200;
const MAX_PACKAGE_REF_LENGTH = 255;
const MAX_EVENT_REF_LENGTH = 255;
const MAX_GROUP_ID_LENGTH = 255;
const MAX_PACKAGE_DATA_LENGTH = 1024 * 1024;
const MAX_STATE_BLOB_LENGTH = 4 * 1024 * 1024;
const MAX_MESSAGE_PAYLOAD_LENGTH = 4 * 1024 * 1024;

let schemaReadyPromise = null;

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  if (typeof max === 'number') return Math.min(parsed, max);
  return parsed;
}

function normalizeOptionalString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (typeof maxLength === 'number' && normalized.length > maxLength) return null;
  return normalized;
}

function normalizeRequiredString(value, maxLength) {
  const normalized = normalizeOptionalString(value, maxLength);
  return normalized || null;
}

function normalizeUserId(value) {
  return normalizeOptionalString(value, 64);
}

function normalizeBatchInput(body) {
  if (Array.isArray(body?.items)) {
    return body.items;
  }
  if (Array.isArray(body)) {
    return body;
  }
  return [body || {}];
}

function resolveCapabilities() {
  const supported = parseBoolean(process.env.MLS_PROTOCOL_ENABLED, true);

  return {
    supported,
    key_packages: parseBoolean(process.env.MLS_KEY_PACKAGES_ENABLED, supported),
    group_state: parseBoolean(process.env.MLS_GROUP_STATE_ENABLED, supported),
    commit_fanout: parseBoolean(process.env.MLS_COMMIT_FANOUT_ENABLED, supported),
    welcome_inbox: parseBoolean(process.env.MLS_WELCOME_INBOX_ENABLED, supported),
  };
}

function isEnabledFor(capabilities, key) {
  return capabilities.supported && capabilities[key] === true;
}

function notEnabled(res, feature) {
  return res.status(503).json({
    success: false,
    code: 'MLS_NOT_ENABLED',
    error: `MLS feature "${feature}" is not enabled on this server`,
  });
}

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS mls_key_packages (
           id BIGSERIAL PRIMARY KEY,
           user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           package_ref TEXT NOT NULL,
           package_data TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           published_at TIMESTAMPTZ,
           consumed_at TIMESTAMPTZ,
           UNIQUE (user_id, package_ref)
         )`
      );

      await pool.query(
        `CREATE TABLE IF NOT EXISTS mls_group_states (
           conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
           group_id TEXT NOT NULL,
           epoch INTEGER NOT NULL,
           state_blob TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`
      );

      await pool.query(
        `CREATE TABLE IF NOT EXISTS mls_welcome_messages (
           id BIGSERIAL PRIMARY KEY,
           user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           welcome_ref TEXT NOT NULL,
           conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
           payload TEXT NOT NULL,
           received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           consumed_at TIMESTAMPTZ,
           UNIQUE (user_id, welcome_ref)
         )`
      );

      await pool.query(
        `CREATE TABLE IF NOT EXISTS mls_commit_messages (
           id BIGSERIAL PRIMARY KEY,
           conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
           commit_ref TEXT NOT NULL,
           payload TEXT NOT NULL,
           epoch INTEGER,
           received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           applied_at TIMESTAMPTZ,
           UNIQUE (conversation_id, commit_ref)
         )`
      );

      await pool.query('CREATE INDEX IF NOT EXISTS idx_mls_key_packages_user_id ON mls_key_packages(user_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_mls_group_states_updated_at ON mls_group_states(updated_at DESC)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_mls_welcome_messages_user_id ON mls_welcome_messages(user_id, consumed_at, received_at)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_mls_commit_messages_conversation_id ON mls_commit_messages(conversation_id, applied_at, received_at)');
    })().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }

  return schemaReadyPromise;
}

async function ensureConversationMembership(conversationId, userId, db = pool) {
  const membership = await db.query(
    `SELECT 1
     FROM conversation_members
     WHERE conversation_id = $1
       AND user_id = $2
     LIMIT 1`,
    [conversationId, userId]
  );

  return membership.rows.length > 0;
}

async function resolveAccessibleConversationId(identifier, userId, db = pool) {
  const resolvedConversation = await findConversationByIdentifier(identifier, db);
  if (!resolvedConversation) return { conversationId: null, error: 'not_found' };

  const hasAccess = await ensureConversationMembership(resolvedConversation.id, userId, db);
  if (!hasAccess) return { conversationId: null, error: 'forbidden' };

  return { conversationId: resolvedConversation.id, error: null };
}

// GET /api/conversations/mls/capabilities
router.get('/capabilities', async (_req, res) => {
  try {
    return res.json({
      success: true,
      capabilities: resolveCapabilities(),
    });
  } catch (err) {
    console.error('MLS capabilities error:', err);
    return res.status(500).json({ success: false, error: 'Failed to resolve MLS capabilities' });
  }
});

// POST /api/conversations/mls/key-packages
router.post('/key-packages', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'key_packages')) {
    return notEnabled(res, 'key_packages');
  }

  const requesterUserId = String(req.user.id);
  // Always use the JWT user — ignore body user_id to avoid format-mismatch 403s.
  const userId = requesterUserId;
  const packageRef = normalizeRequiredString(req.body?.package_ref, MAX_PACKAGE_REF_LENGTH);
  const packageData = normalizeRequiredString(req.body?.package_data, MAX_PACKAGE_DATA_LENGTH);

  if (!packageRef) {
    return res.status(400).json({ success: false, error: 'package_ref is required and must be <= 255 characters' });
  }

  if (!packageData) {
    return res.status(400).json({ success: false, error: 'package_data is required and must be <= 1MB' });
  }

  try {
    await ensureSchema();

    const result = await pool.query(
      `INSERT INTO mls_key_packages (user_id, package_ref, package_data, published_at)
       VALUES ($1::UUID, $2, $3, NOW())
       ON CONFLICT (user_id, package_ref)
       DO UPDATE SET
         package_data = EXCLUDED.package_data,
         published_at = NOW()
       RETURNING user_id::text AS user_id, package_ref, published_at`,
      [userId, packageRef, packageData]
    );

    return res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    console.error('MLS key package publish error:', err);
    return res.status(500).json({ success: false, error: 'Failed to publish MLS key package' });
  }
});

// POST /api/conversations/mls/group-states
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

      if (!conversationIdentifier || !groupId || !stateBlob || epoch <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Each item requires conversation_id, group_id, state_blob, and positive epoch',
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
        `INSERT INTO mls_group_states (conversation_id, group_id, epoch, state_blob, created_at, updated_at)
         VALUES ($1::UUID, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (conversation_id)
         DO UPDATE SET
           group_id = EXCLUDED.group_id,
           epoch = EXCLUDED.epoch,
           state_blob = EXCLUDED.state_blob,
           updated_at = NOW()
         WHERE mls_group_states.epoch IS NULL
            OR EXCLUDED.epoch >= mls_group_states.epoch
         RETURNING conversation_id::text AS conversation_id, group_id, epoch, updated_at`,
        [resolved.conversationId, groupId, epoch, stateBlob]
      );

      if (result.rows[0]) {
        upserted.push(result.rows[0]);
        continue;
      }

      const existing = await client.query(
        `SELECT conversation_id::text AS conversation_id, group_id, epoch, updated_at
         FROM mls_group_states
         WHERE conversation_id = $1::UUID
         LIMIT 1`,
        [resolved.conversationId]
      );

      if (existing.rows[0]) {
        console.log('[MLS_GROUP_STATE] ignoring stale upload', {
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

// GET /api/conversations/mls/key-packages/:userId — claim one available key package (atomic)
router.get('/key-packages/:userId', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'key_packages')) {
    return notEnabled(res, 'key_packages');
  }

  const requesterUserId = String(req.user.id);
  const targetUserId = normalizeUserId(req.params.userId);
  if (!targetUserId) {
    return res.status(400).json({ success: false, error: 'userId param is required' });
  }

  let client;
  try {
    await ensureSchema();
    client = await pool.connect();
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE mls_key_packages
       SET consumed_at = NOW()
       WHERE id = (
         SELECT id FROM mls_key_packages
         WHERE user_id = $1::UUID
           AND published_at IS NOT NULL
           AND consumed_at IS NULL
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING user_id::text AS user_id, package_ref, package_data, published_at`,
      [targetUserId]
    );

    await client.query('COMMIT');

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No key packages available for this user', code: 'NO_KEY_PACKAGE' });
    }

    void requesterUserId; // requester is authenticated; key is HPKE-encrypted to recipient
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('MLS key package claim error:', err);
    return res.status(500).json({ success: false, error: 'Failed to claim MLS key package' });
  } finally {
    client?.release();
  }
});

// POST /api/conversations/mls/welcomes
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

      if (!welcomeRef || !payload) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Each item requires welcome_ref and payload',
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
        `INSERT INTO mls_welcome_messages (user_id, welcome_ref, conversation_id, payload, received_at, consumed_at)
         VALUES ($1::UUID, $2, $3::UUID, $4, NOW(), NULL)
         ON CONFLICT (user_id, welcome_ref)
         DO UPDATE SET
           conversation_id = EXCLUDED.conversation_id,
           payload = EXCLUDED.payload,
           received_at = NOW(),
           consumed_at = NULL
         RETURNING user_id::text AS user_id,
                   welcome_ref,
                   conversation_id::text AS conversation_id,
                   received_at,
                   consumed_at`,
        [userId, welcomeRef, conversationId, payload]
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

// POST /api/conversations/mls/commits
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

      const result = await client.query(
        `INSERT INTO mls_commit_messages (conversation_id, commit_ref, payload, epoch, received_at, applied_at)
         VALUES ($1::UUID, $2, $3, $4, NOW(), NULL)
         ON CONFLICT (conversation_id, commit_ref)
         DO UPDATE SET
           payload = EXCLUDED.payload,
           epoch = EXCLUDED.epoch,
           received_at = NOW(),
           applied_at = NULL
         RETURNING conversation_id::text AS conversation_id,
                   commit_ref,
                   epoch,
                   received_at,
                   applied_at`,
        [resolved.conversationId, commitRef, payload, epoch]
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
    console.error('MLS commit ingest error:', err);
    return res.status(500).json({ success: false, error: 'Failed to ingest MLS commits' });
  } finally {
    client?.release();
  }
});

// POST /api/conversations/mls/welcomes/:welcomeRef/consume
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

// POST /api/conversations/mls/commits/:conversationId/:commitRef/apply
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

    const result = await client.query(
      `UPDATE mls_commit_messages
       SET applied_at = COALESCE(applied_at, NOW())
       WHERE conversation_id = $1::UUID
         AND commit_ref = $2
       RETURNING conversation_id::text AS conversation_id, commit_ref, applied_at`,
      [resolved.conversationId, commitRef]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Commit not found' });
    }

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

// POST /api/conversations/mls/sync
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

  // Always use the authenticated user from the JWT — the body's user_id is
  // ignored to avoid 403 errors caused by format mismatches (e.g. numeric ID
  // vs UUID string).
  const requesterUserId = String(req.user.id);

  const limit = parsePositiveInt(req.body?.limit ?? req.query?.limit, DEFAULT_SYNC_LIMIT, MAX_SYNC_LIMIT);

  try {
    await ensureSchema();

    const [keyPackagesResult, groupStatesResult, welcomesResult, commitsResult] = await Promise.all([
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
            `SELECT gs.conversation_id::text AS conversation_id,
                    gs.group_id,
                    gs.epoch,
                    gs.state_blob,
                    gs.updated_at
             FROM mls_group_states gs
             JOIN conversation_members cm
               ON cm.conversation_id = gs.conversation_id
             WHERE cm.user_id = $1::UUID
               AND gs.epoch >= COALESCE(cm.joined_key_version, 1)
             ORDER BY gs.updated_at DESC
             LIMIT $2`,
            [requesterUserId, limit]
          )
        : Promise.resolve({ rows: [] }),
      isEnabledFor(capabilities, 'welcome_inbox')
        ? pool.query(
            `SELECT user_id::text AS user_id,
                    welcome_ref,
                    payload,
                    conversation_id::text AS conversation_id,
                    received_at
             FROM mls_welcome_messages
             WHERE user_id = $1::UUID
               AND consumed_at IS NULL
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
    ]);

    return res.json({
      success: true,
      data: {
        key_packages: keyPackagesResult.rows,
        group_states: groupStatesResult.rows,
        welcomes: welcomesResult.rows,
        commits: commitsResult.rows,
      },
    });
  } catch (err) {
    console.error('MLS sync error:', err);
    return res.status(500).json({ success: false, error: 'Failed to sync MLS state' });
  }
});

export default router;
