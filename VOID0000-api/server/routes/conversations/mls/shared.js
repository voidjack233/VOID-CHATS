import { pool } from '../../../db.js';
import { findConversationByIdentifier } from '../../../utils/conversationIdentity.js';

export const DEFAULT_SYNC_LIMIT = 100;
export const MAX_SYNC_LIMIT = 500;
export const MAX_BATCH_ITEMS = 200;
export const MAX_PACKAGE_REF_LENGTH = 255;
export const MAX_EVENT_REF_LENGTH = 255;
export const MAX_GROUP_ID_LENGTH = 255;
export const MAX_PACKAGE_DATA_LENGTH = 1024 * 1024;
export const MAX_STATE_BLOB_LENGTH = 4 * 1024 * 1024;
export const MAX_MESSAGE_PAYLOAD_LENGTH = 4 * 1024 * 1024;

export const MLS_KEY_PACKAGE_MINIMUM = 3;
export const MLS_KEY_PACKAGE_TARGET = 10;
export const MLS_KEY_PACKAGE_LOW_WATERMARK = 3;

let schemaReadyPromise = null;

export function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function parsePositiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  if (typeof max === 'number') return Math.min(parsed, max);
  return parsed;
}

export function normalizeOptionalString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (typeof maxLength === 'number' && normalized.length > maxLength) return null;
  return normalized;
}

export function normalizeRequiredString(value, maxLength) {
  const normalized = normalizeOptionalString(value, maxLength);
  return normalized || null;
}

export function normalizeUserId(value) {
  return normalizeOptionalString(value, 64);
}

export function normalizeBatchInput(body) {
  if (Array.isArray(body?.items)) {
    return body.items;
  }
  if (Array.isArray(body)) {
    return body;
  }
  return [body || {}];
}

export function resolveCapabilities() {
  const supported = parseBoolean(process.env.MLS_PROTOCOL_ENABLED, true);

  return {
    supported,
    key_packages: parseBoolean(process.env.MLS_KEY_PACKAGES_ENABLED, supported),
    group_state: parseBoolean(process.env.MLS_GROUP_STATE_ENABLED, supported),
    commit_fanout: parseBoolean(process.env.MLS_COMMIT_FANOUT_ENABLED, supported),
    welcome_inbox: parseBoolean(process.env.MLS_WELCOME_INBOX_ENABLED, supported),
  };
}

export function isEnabledFor(capabilities, key) {
  return capabilities.supported && capabilities[key] === true;
}

export function notEnabled(res, feature) {
  return res.status(503).json({
    success: false,
    code: 'MLS_NOT_ENABLED',
    error: `MLS feature "${feature}" is not enabled on this server`,
  });
}

export async function ensureSchema() {
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
           conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
           user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           group_id TEXT NOT NULL,
           epoch INTEGER NOT NULL,
           key_version INTEGER,
           state_blob TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           PRIMARY KEY (conversation_id, user_id)
         )`
      );

      await pool.query(
        `ALTER TABLE mls_group_states ADD COLUMN IF NOT EXISTS key_version INTEGER`
      );

      await pool.query(
        `ALTER TABLE mls_group_states ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE`
      );
      await pool.query(
        `DELETE FROM mls_group_states WHERE user_id IS NULL`
      );
      await pool.query(
        `ALTER TABLE mls_group_states DROP CONSTRAINT IF EXISTS mls_group_states_pkey`
      );
      await pool.query(
        `ALTER TABLE mls_group_states ALTER COLUMN user_id SET NOT NULL`
      );
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_mls_group_states_user_unique
         ON mls_group_states(conversation_id, user_id)`
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

      await pool.query(
        `CREATE TABLE IF NOT EXISTS mls_group_key_archive (
           conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
           key_version INTEGER NOT NULL,
           key_data TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           PRIMARY KEY (conversation_id, key_version, user_id)
         )`
      );

      await pool.query(
        `ALTER TABLE mls_group_key_archive ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE`
      );
      await pool.query(
        `DELETE FROM mls_group_key_archive WHERE user_id IS NULL`
      );
      await pool.query(
        `ALTER TABLE mls_group_key_archive DROP CONSTRAINT IF EXISTS mls_group_key_archive_pkey`
      );
      await pool.query(
        `ALTER TABLE mls_group_key_archive ALTER COLUMN user_id SET NOT NULL`
      );
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_mls_group_key_archive_user_unique
         ON mls_group_key_archive(conversation_id, key_version, user_id)`
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

export async function getAvailableKeyPackageCount(userId, db = pool) {
  const result = await db.query(
    `SELECT COUNT(*)::int AS available_count
     FROM mls_key_packages
     WHERE user_id = $1::UUID
       AND published_at IS NOT NULL
       AND consumed_at IS NULL`,
    [userId]
  );

  return result.rows[0]?.available_count || 0;
}

export async function ensureConversationMembership(conversationId, userId, db = pool) {
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

export async function resolveAccessibleConversationId(identifier, userId, db = pool) {
  const resolvedConversation = await findConversationByIdentifier(identifier, db);
  if (!resolvedConversation) return { conversationId: null, error: 'not_found' };

  const hasAccess = await ensureConversationMembership(resolvedConversation.id, userId, db);
  if (!hasAccess) return { conversationId: null, error: 'forbidden' };

  return { conversationId: resolvedConversation.id, error: null };
}
