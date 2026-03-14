import { Router } from 'express';
import { webcrypto } from 'node:crypto';
import { pool } from '../../db.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';

const router = Router();

const ENVELOPE_TYPES = new Set(['prekey', 'signal', 'sender_key']);
const DEFAULT_INBOX_LIMIT = 100;
const MAX_INBOX_LIMIT = 200;
const MAX_ENVELOPES_PER_REQUEST = 200;
const subtle = webcrypto.subtle;

function base64ToArrayBuffer(value) {
  const normalized = String(value || '').trim();
  const bytes = Buffer.from(normalized, 'base64');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function verifySignedPrekeySignature(identityKey, signedPrekeyPublicKey, signature) {
  try {
    const identityPublicKey = await subtle.importKey(
      'spki',
      base64ToArrayBuffer(identityKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );

    return await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      identityPublicKey,
      base64ToArrayBuffer(signature),
      base64ToArrayBuffer(signedPrekeyPublicKey)
    );
  } catch {
    // Some Signal stacks (including libsignal) do not use SPKI/ECDSA
    // encodings that Node WebCrypto can verify directly here.
    // Return null to indicate "unverifiable by this server path".
    return null;
  }
}

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

function resolveCapabilities() {
  const supported = parseBoolean(process.env.SIGNAL_PROTOCOL_ENABLED, false);

  return {
    supported,
    device_registry: parseBoolean(process.env.SIGNAL_DEVICE_REGISTRY_ENABLED, supported),
    prekey_bundles: parseBoolean(process.env.SIGNAL_PREKEY_BUNDLES_ENABLED, supported),
    device_message_fanout: parseBoolean(process.env.SIGNAL_DEVICE_FANOUT_ENABLED, supported),
    group_sender_keys: parseBoolean(process.env.SIGNAL_GROUP_SENDER_KEYS_ENABLED, supported),
    membership_rotation_hooks: parseBoolean(process.env.SIGNAL_MEMBERSHIP_ROTATION_ENABLED, supported),
  };
}

function isEnabledFor(capabilities, key) {
  return capabilities.supported && capabilities[key] === true;
}

function notEnabled(res, feature) {
  return res.status(503).json({
    success: false,
    code: 'SIGNAL_NOT_ENABLED',
    error: `Signal feature "${feature}" is not enabled on this server`,
  });
}

function normalizeDeviceId(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 255) return null;
  return normalized;
}

function normalizeLibsignalDeviceId(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

async function ensureConversationMembership(conversationId, userId, db = pool) {
  const membership = await db.query(
    `SELECT 1
     FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2
     LIMIT 1`,
    [conversationId, userId]
  );

  return membership.rows.length > 0;
}

async function canAccessTargetUserSignalData(requesterUserId, targetUserId, db = pool) {
  if (String(requesterUserId) === String(targetUserId)) return true;

  const access = await db.query(
    `SELECT 1
     FROM conversation_members AS me
     JOIN conversation_members AS target
       ON target.conversation_id = me.conversation_id
     WHERE me.user_id = $1
       AND target.user_id = $2
     LIMIT 1`,
    [requesterUserId, targetUserId]
  );

  return access.rows.length > 0;
}

async function resolveKeyConversation(identifier, db = pool) {
  const resolvedConversation = await findConversationByIdentifier(identifier, db);
  if (!resolvedConversation) return null;

  return {
    conversationId: resolvedConversation.parent_conversation_id || resolvedConversation.id,
    conversation: resolvedConversation,
  };
}

// GET /api/conversations/signal/capabilities
router.get('/capabilities', async (_req, res) => {
  try {
    return res.json({
      success: true,
      capabilities: resolveCapabilities(),
    });
  } catch (err) {
    console.error('Signal capabilities error:', err);
    return res.status(500).json({ success: false, error: 'Failed to resolve signal capabilities' });
  }
});

// GET /api/conversations/signal/devices/:userId
router.get('/devices/:userId', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'device_registry')) {
    return notEnabled(res, 'device_registry');
  }

  const requesterUserId = req.user.id;
  const { userId } = req.params;

  try {
    const hasAccess = await canAccessTargetUserSignalData(requesterUserId, userId);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Not allowed to query signal devices for this user' });
    }

    const result = await pool.query(
      `SELECT user_id, device_id, libsignal_device_id, registration_id,
              identity_key, signed_prekey_id, signed_prekey_public_key, signed_prekey_signature,
              created_at, updated_at, last_seen_at
       FROM signal_devices
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY updated_at DESC`,
      [userId]
    );

    return res.json({
      success: true,
      data: {
        devices: result.rows,
      },
    });
  } catch (err) {
    console.error('Signal devices GET error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch signal devices' });
  }
});

// POST /api/conversations/signal/devices
router.post('/devices', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'device_registry')) {
    return notEnabled(res, 'device_registry');
  }

  const userId = req.user.id;
  const { device_id, registration_id, identity_key, signed_prekey } = req.body || {};
  const rawLibsignalDeviceId = req.body?.libsignal_device_id
    ?? req.body?.signal_device_id
    ?? req.body?.device_numeric_id
    ?? req.body?.device_number;
  const requestedLibsignalDeviceId = normalizeLibsignalDeviceId(rawLibsignalDeviceId);
  const normalizedDeviceId = normalizeDeviceId(device_id);

  if (
    !normalizedDeviceId ||
    !Number.isInteger(registration_id) ||
    registration_id <= 0 ||
    typeof identity_key !== 'string' ||
    identity_key.length === 0 ||
    !signed_prekey ||
    !Number.isInteger(signed_prekey.key_id) ||
    signed_prekey.key_id < 0 ||
    typeof signed_prekey.public_key !== 'string' ||
    signed_prekey.public_key.length === 0 ||
    typeof signed_prekey.signature !== 'string' ||
    signed_prekey.signature.length === 0
  ) {
    return res.status(400).json({
      success: false,
      error: 'device_id, registration_id, identity_key, and signed_prekey are required',
    });
  }

  if (rawLibsignalDeviceId != null && requestedLibsignalDeviceId == null) {
    return res.status(400).json({
      success: false,
      error: 'libsignal_device_id must be a positive integer when provided',
    });
  }

  let client;
  try {
    const isValidSignature = await verifySignedPrekeySignature(
      identity_key,
      signed_prekey.public_key,
      signed_prekey.signature
    );

    if (isValidSignature === false) {
      return res.status(400).json({
        success: false,
        error: 'signed_prekey signature is invalid for identity_key',
      });
    }

    if (isValidSignature === null) {
      console.warn('Signal signed_prekey verification skipped (unsupported key format)');
    }

    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(userId)]);

    const existingDevice = await client.query(
      `SELECT libsignal_device_id
       FROM signal_devices
       WHERE user_id = $1 AND device_id = $2
       LIMIT 1
       FOR UPDATE`,
      [userId, normalizedDeviceId]
    );

    let assignedLibsignalDeviceId = normalizeLibsignalDeviceId(existingDevice.rows[0]?.libsignal_device_id);
    if (!assignedLibsignalDeviceId) {
      assignedLibsignalDeviceId = requestedLibsignalDeviceId;
    }
    if (!assignedLibsignalDeviceId) {
      const nextIdResult = await client.query(
        `SELECT COALESCE(MAX(libsignal_device_id), 0) + 1 AS next_libsignal_device_id
         FROM signal_devices
         WHERE user_id = $1`,
        [userId]
      );
      assignedLibsignalDeviceId = normalizeLibsignalDeviceId(nextIdResult.rows[0]?.next_libsignal_device_id) ?? 1;
    }

    const result = await client.query(
      `INSERT INTO signal_devices (
         user_id,
         device_id,
         libsignal_device_id,
         registration_id,
         identity_key,
         signed_prekey_id,
         signed_prekey_public_key,
         signed_prekey_signature,
         is_active,
         updated_at,
         last_seen_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, NOW(), NOW())
       ON CONFLICT (user_id, device_id)
       DO UPDATE SET
         libsignal_device_id = COALESCE(signal_devices.libsignal_device_id, EXCLUDED.libsignal_device_id),
         registration_id = EXCLUDED.registration_id,
         identity_key = EXCLUDED.identity_key,
         signed_prekey_id = EXCLUDED.signed_prekey_id,
         signed_prekey_public_key = EXCLUDED.signed_prekey_public_key,
         signed_prekey_signature = EXCLUDED.signed_prekey_signature,
         is_active = TRUE,
         updated_at = NOW(),
         last_seen_at = NOW()
       RETURNING user_id, device_id, libsignal_device_id, registration_id, created_at, updated_at, last_seen_at`,
      [
        userId,
        normalizedDeviceId,
        assignedLibsignalDeviceId,
        registration_id,
        identity_key,
        signed_prekey.key_id,
        signed_prekey.public_key,
        signed_prekey.signature,
      ]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      device: result.rows[0],
      data: {
        device: result.rows[0],
      },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === '23505') {
      return res.status(409).json({
        success: false,
        error: 'libsignal_device_id is already in use for this account',
      });
    }
    console.error('Signal device register error:', err);
    return res.status(500).json({ success: false, error: 'Failed to register signal device' });
  } finally {
    client?.release();
  }
});

// POST /api/conversations/signal/prekeys
router.post('/prekeys', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'prekey_bundles')) {
    return notEnabled(res, 'prekey_bundles');
  }

  const userId = req.user.id;
  const { device_id, prekeys } = req.body || {};
  const normalizedDeviceId = normalizeDeviceId(device_id);

  if (!normalizedDeviceId || !Array.isArray(prekeys) || prekeys.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'device_id and prekeys[] are required',
    });
  }

  if (prekeys.length > 1000) {
    return res.status(400).json({
      success: false,
      error: 'Too many prekeys in a single request',
    });
  }

  for (const prekey of prekeys) {
    if (
      !prekey ||
      !Number.isInteger(prekey.key_id) ||
      prekey.key_id < 0 ||
      typeof prekey.public_key !== 'string' ||
      prekey.public_key.length === 0
    ) {
      return res.status(400).json({
        success: false,
        error: 'Each prekey must include key_id (integer) and public_key (string)',
      });
    }
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const deviceResult = await client.query(
      `SELECT 1
       FROM signal_devices
       WHERE user_id = $1 AND device_id = $2 AND is_active = TRUE
       LIMIT 1`,
      [userId, normalizedDeviceId]
    );

    if (deviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Signal device not found. Register device first.',
      });
    }

    for (const prekey of prekeys) {
      await client.query(
        `INSERT INTO signal_one_time_prekeys (
           user_id,
           device_id,
           key_id,
           public_key,
           is_used,
           used_at,
           created_at
         )
         VALUES ($1, $2, $3, $4, FALSE, NULL, NOW())
         ON CONFLICT (user_id, device_id, key_id)
         DO UPDATE SET
           public_key = EXCLUDED.public_key,
           created_at = NOW()
         WHERE signal_one_time_prekeys.is_used = FALSE`,
        [userId, normalizedDeviceId, prekey.key_id, prekey.public_key]
      );
    }

    // Clean up old consumed prekeys to prevent table bloat.
    await client.query(
      `DELETE FROM signal_one_time_prekeys
       WHERE user_id = $1
         AND device_id = $2
         AND is_used = TRUE
         AND used_at < NOW() - INTERVAL '7 days'`,
      [userId, normalizedDeviceId]
    );

    await client.query(
      `UPDATE signal_devices
       SET updated_at = NOW(),
           last_seen_at = NOW()
       WHERE user_id = $1 AND device_id = $2`,
      [userId, normalizedDeviceId]
    );

    await client.query('COMMIT');

    return res.status(202).json({
      success: true,
      data: {
        device_id: normalizedDeviceId,
        accepted: prekeys.length,
      },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Signal prekeys upload error:', err);
    return res.status(500).json({ success: false, error: 'Failed to upload one-time prekeys' });
  } finally {
    client?.release();
  }
});

// GET /api/conversations/signal/prekeys/:userId/:deviceId
router.get('/prekeys/:userId/:deviceId', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'prekey_bundles')) {
    return notEnabled(res, 'prekey_bundles');
  }

  const requesterUserId = req.user.id;
  const { userId, deviceId } = req.params;
  const normalizedDeviceId = normalizeDeviceId(deviceId);
  if (!normalizedDeviceId) {
    return res.status(400).json({ success: false, error: 'Invalid device id' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const hasAccess = await canAccessTargetUserSignalData(requesterUserId, userId, client);
    if (!hasAccess) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'Not allowed to fetch signal prekeys for this user' });
    }

    const deviceResult = await client.query(
      `SELECT user_id, device_id, libsignal_device_id, registration_id, identity_key,
              signed_prekey_id, signed_prekey_public_key, signed_prekey_signature
       FROM signal_devices
       WHERE user_id = $1 AND device_id = $2 AND is_active = TRUE
       LIMIT 1`,
      [userId, normalizedDeviceId]
    );

    if (deviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Signal device not found' });
    }

    const prekeyResult = await client.query(
      `SELECT key_id, public_key
       FROM signal_one_time_prekeys
       WHERE user_id = $1
         AND device_id = $2
         AND is_used = FALSE
       ORDER BY key_id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [userId, normalizedDeviceId]
    );

    const oneTimePreKey = prekeyResult.rows[0] || null;

    if (oneTimePreKey) {
      await client.query(
        `UPDATE signal_one_time_prekeys
         SET is_used = TRUE,
             used_at = NOW()
         WHERE user_id = $1
           AND device_id = $2
           AND key_id = $3`,
        [userId, normalizedDeviceId, oneTimePreKey.key_id]
      );
    }

    await client.query(
      `UPDATE signal_devices
       SET last_seen_at = NOW()
       WHERE user_id = $1 AND device_id = $2`,
      [userId, normalizedDeviceId]
    );

    await client.query('COMMIT');

    const device = deviceResult.rows[0];
    return res.json({
      success: true,
      bundle: {
        user_id: device.user_id,
        device_id: device.device_id,
        libsignal_device_id: device.libsignal_device_id,
        registration_id: device.registration_id,
        identity_key: device.identity_key,
        signed_prekey: {
          key_id: device.signed_prekey_id,
          public_key: device.signed_prekey_public_key,
          signature: device.signed_prekey_signature,
        },
        one_time_prekey: oneTimePreKey
          ? {
              key_id: oneTimePreKey.key_id,
              public_key: oneTimePreKey.public_key,
            }
          : null,
      },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Signal prekey bundle lookup error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch signal prekey bundle' });
  } finally {
    client?.release();
  }
});

// POST /api/conversations/signal/messages/:conversationId
router.post('/messages/:conversationId', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'device_message_fanout')) {
    return notEnabled(res, 'device_message_fanout');
  }

  const senderUserId = req.user.id;
  const { conversationId } = req.params;
  const { envelopes, sender_device_id } = req.body || {};
  const senderDeviceId = normalizeDeviceId(sender_device_id || req.user.device_id);

  if (!senderDeviceId) {
    return res.status(400).json({ success: false, error: 'sender_device_id is required' });
  }

  if (!Array.isArray(envelopes) || envelopes.length === 0) {
    return res.status(400).json({ success: false, error: 'envelopes[] is required' });
  }

  if (envelopes.length > MAX_ENVELOPES_PER_REQUEST) {
    return res.status(400).json({ success: false, error: 'Too many envelopes in one request' });
  }

  const normalizedEnvelopes = [];
  for (const envelope of envelopes) {
    const recipientUserId = String(envelope?.recipient_user_id || '').trim();
    const recipientDeviceId = normalizeDeviceId(envelope?.recipient_device_id);
    const type = String(envelope?.type || '').trim();
    const ciphertext = typeof envelope?.ciphertext === 'string' ? envelope.ciphertext : null;

    if (!recipientUserId || !recipientDeviceId || !ENVELOPE_TYPES.has(type) || !ciphertext) {
      return res.status(400).json({
        success: false,
        error: 'Each envelope must include recipient_user_id, recipient_device_id, type, and ciphertext',
      });
    }

    normalizedEnvelopes.push({
      recipientUserId,
      recipientDeviceId,
      type,
      ciphertext,
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const resolved = await resolveKeyConversation(conversationId, client);
    if (!resolved) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }

    const keyConversationId = resolved.conversationId;
    const hasMembership = await ensureConversationMembership(keyConversationId, senderUserId, client);
    if (!hasMembership) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'Not a member' });
    }

    const senderDeviceResult = await client.query(
      `SELECT 1
       FROM signal_devices
       WHERE user_id = $1
         AND device_id = $2
         AND is_active = TRUE
       LIMIT 1`,
      [senderUserId, senderDeviceId]
    );
    if (senderDeviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'Sender device is not registered for Signal' });
    }

    const membersResult = await client.query(
      `SELECT user_id
       FROM conversation_members
       WHERE conversation_id = $1`,
      [keyConversationId]
    );
    const memberSet = new Set(membersResult.rows.map((row) => row.user_id));

    const invalidRecipients = normalizedEnvelopes.filter((envelope) => !memberSet.has(envelope.recipientUserId));
    if (invalidRecipients.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'One or more recipients are not members of this conversation',
      });
    }

    const uniqueRecipients = Array.from(
      new Map(
        normalizedEnvelopes.map((envelope) => [
          `${envelope.recipientUserId}:${envelope.recipientDeviceId}`,
          envelope,
        ])
      ).values()
    );

    const recipientTupleParams = [];
    const recipientTupleValues = [];
    uniqueRecipients.forEach((recipient, index) => {
      const first = index * 2 + 1;
      recipientTupleParams.push(`($${first}::uuid, $${first + 1})`);
      recipientTupleValues.push(recipient.recipientUserId, recipient.recipientDeviceId);
    });

    const registeredDevicesResult = await client.query(
      `SELECT user_id, device_id
       FROM signal_devices
       WHERE is_active = TRUE
         AND (user_id, device_id) IN (${recipientTupleParams.join(', ')})`,
      recipientTupleValues
    );

    const registeredDeviceSet = new Set(
      registeredDevicesResult.rows.map((row) => `${row.user_id}:${row.device_id}`)
    );

    const missingDevices = uniqueRecipients.filter(
      (recipient) => !registeredDeviceSet.has(`${recipient.recipientUserId}:${recipient.recipientDeviceId}`)
    );
    if (missingDevices.length > 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'One or more recipient devices are not registered for Signal',
      });
    }

    for (const envelope of normalizedEnvelopes) {
      await client.query(
        `INSERT INTO signal_device_messages (
           conversation_id,
           sender_user_id,
           sender_device_id,
           recipient_user_id,
           recipient_device_id,
           envelope_type,
           ciphertext
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          keyConversationId,
          senderUserId,
          senderDeviceId,
          envelope.recipientUserId,
          envelope.recipientDeviceId,
          envelope.type,
          envelope.ciphertext,
        ]
      );
    }

    await client.query('COMMIT');

    return res.status(202).json({
      success: true,
      data: {
        accepted: normalizedEnvelopes.length,
      },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Signal envelope fanout error:', err);
    return res.status(500).json({ success: false, error: 'Failed to store signal envelopes' });
  } finally {
    client?.release();
  }
});

// GET /api/conversations/signal/messages/inbox?device_id=...&cursor=...&limit=...
router.get('/messages/inbox', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'device_message_fanout')) {
    return notEnabled(res, 'device_message_fanout');
  }

  const userId = req.user.id;
  const deviceId = normalizeDeviceId(req.query.device_id);
  const limit = parsePositiveInt(req.query.limit, DEFAULT_INBOX_LIMIT, MAX_INBOX_LIMIT);
  const cursor = req.query.cursor != null ? Number(req.query.cursor) : null;

  if (!deviceId) {
    return res.status(400).json({ success: false, error: 'device_id query param is required' });
  }

  if (cursor != null && (!Number.isInteger(cursor) || cursor < 0)) {
    return res.status(400).json({ success: false, error: 'cursor must be a non-negative integer' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const deviceResult = await client.query(
      `SELECT 1
       FROM signal_devices
       WHERE user_id = $1
         AND device_id = $2
         AND is_active = TRUE
       LIMIT 1`,
      [userId, deviceId]
    );

    if (deviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'Device is not registered for this account' });
    }

    const inboxResult = await client.query(
      `SELECT msg.id,
              msg.sender_user_id,
              msg.sender_device_id,
              sender_device.libsignal_device_id AS sender_libsignal_device_id,
              msg.recipient_device_id,
              msg.envelope_type,
              msg.ciphertext,
              msg.created_at
       FROM signal_device_messages AS msg
       LEFT JOIN signal_devices AS sender_device
         ON sender_device.user_id = msg.sender_user_id
        AND sender_device.device_id = msg.sender_device_id
       WHERE msg.recipient_user_id = $1
         AND msg.recipient_device_id = $2
         AND ($3::BIGINT IS NULL OR msg.id > $3)
       ORDER BY msg.id ASC
       LIMIT $4`,
      [userId, deviceId, cursor, limit]
    );

    const ids = inboxResult.rows.map((row) => Number(row.id)).filter((value) => Number.isInteger(value));
    if (ids.length > 0) {
      await client.query(
        `UPDATE signal_device_messages
         SET delivered_at = COALESCE(delivered_at, NOW())
         WHERE id = ANY($1::BIGINT[])`,
        [ids]
      );
    }

    await client.query('COMMIT');

    const items = inboxResult.rows.map((row) => ({
      id: String(row.id),
      sender_user_id: row.sender_user_id,
      sender_device_id: row.sender_device_id,
      sender_libsignal_device_id: row.sender_libsignal_device_id,
      recipient_device_id: row.recipient_device_id,
      type: row.envelope_type,
      ciphertext: row.ciphertext,
      created_at: row.created_at,
    }));

    const nextCursor = items.length === limit
      ? items[items.length - 1]?.id ?? null
      : null;

    return res.json({
      success: true,
      data: {
        items,
        next_cursor: nextCursor,
      },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Signal inbox fetch error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch signal inbox' });
  } finally {
    client?.release();
  }
});

export default router;
