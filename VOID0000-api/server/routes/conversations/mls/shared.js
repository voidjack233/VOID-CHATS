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
const REQUIRED_MLS_TABLES = [
  'mls_key_packages',
  'mls_group_states',
  'mls_group_state_history',
  'mls_welcome_messages',
  'mls_commit_messages',
  'mls_commit_receipts',
  'mls_group_key_archive',
  'conversation_membership_rotations',
];
const REQUIRED_MLS_COLUMNS = [
  ['mls_key_packages', 'claimable_at'],
  ['mls_group_states', 'user_id'],
  ['mls_group_states', 'key_version'],
  ['mls_welcome_messages', 'key_version'],
  ['mls_group_key_archive', 'user_id'],
];
const REQUIRED_MLS_INDEXES = [
  'idx_mls_key_packages_user_id',
  'idx_mls_key_packages_claimable',
  'idx_mls_group_states_updated_at',
  'idx_mls_group_states_user_unique',
  'idx_mls_group_state_history_conversation_version',
  'idx_mls_group_state_history_user',
  'idx_mls_welcome_messages_user_id',
  'idx_mls_commit_messages_conversation_id',
  'idx_mls_commit_receipts_conversation_user',
  'idx_mls_group_key_archive_user_unique',
  'idx_conversation_membership_rotations_pending',
];

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
      const missingTablesResult = await pool.query(
        `SELECT name
         FROM unnest($1::text[]) AS required(name)
         WHERE to_regclass('public.' || name) IS NULL`,
        [REQUIRED_MLS_TABLES]
      );

      const missingColumnsResult = await pool.query(
        `SELECT required.table_name, required.column_name
         FROM unnest($1::text[], $2::text[]) AS required(table_name, column_name)
         LEFT JOIN information_schema.columns cols
           ON cols.table_schema = 'public'
          AND cols.table_name = required.table_name
          AND cols.column_name = required.column_name
         WHERE cols.column_name IS NULL`,
        [
          REQUIRED_MLS_COLUMNS.map(([tableName]) => tableName),
          REQUIRED_MLS_COLUMNS.map(([, columnName]) => columnName),
        ]
      );

      const missingIndexesResult = await pool.query(
        `SELECT name
         FROM unnest($1::text[]) AS required(name)
         WHERE NOT EXISTS (
           SELECT 1
           FROM pg_indexes
           WHERE schemaname = 'public'
             AND indexname = required.name
         )`,
        [REQUIRED_MLS_INDEXES]
      );

      const missingTables = missingTablesResult.rows.map((row) => row.name);
      const missingColumns = missingColumnsResult.rows.map(
        (row) => `${row.table_name}.${row.column_name}`
      );
      const missingIndexes = missingIndexesResult.rows.map((row) => row.name);

      if (missingTables.length || missingColumns.length || missingIndexes.length) {
        const missingParts = [
          missingTables.length ? `tables: ${missingTables.join(', ')}` : null,
          missingColumns.length ? `columns: ${missingColumns.join(', ')}` : null,
          missingIndexes.length ? `indexes: ${missingIndexes.join(', ')}` : null,
        ].filter(Boolean);

        throw new Error(
          `MLS schema is not migrated (${missingParts.join(' | ')}). ` +
          'Run `npm run migrate` in VOID0000-api before using MLS routes.'
        );
      }
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
       AND claimable_at IS NOT NULL
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
