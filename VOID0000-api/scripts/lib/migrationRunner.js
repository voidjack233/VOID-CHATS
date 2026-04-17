import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cassandra from 'cassandra-driver';
import pg from 'pg';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, '..', '..');
const postgresMigrationsDir = path.join(projectRoot, 'db', 'migrations');
const scyllaMigrationsDir = path.join(projectRoot, 'db', 'scylla-migrations');
const MIGRATION_LOCK_KEYS = [1448030532, 1296641874];

dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

function createPool() {
  return new Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: parseInt(process.env.PGPORT || '5432', 10),
  });
}

function checksumOf(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function validateIdentifier(value, label) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${label} "${value}". Use only letters, numbers, and underscores.`);
  }
  return value;
}

function resolveScyllaConfig() {
  const keyspace = validateIdentifier(process.env.SCYLLA_KEYSPACE || 'voidapp', 'Scylla keyspace');
  const localDataCenter = process.env.SCYLLA_LOCAL_DATACENTER || 'datacenter1';
  const replicationFactor = Math.max(parseInt(process.env.SCYLLA_REPLICATION_FACTOR || '1', 10) || 1, 1);
  const contactPoints = String(process.env.SCYLLA_HOST || '127.0.0.1')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    keyspace,
    localDataCenter,
    replicationFactor,
    contactPoints: contactPoints.length > 0 ? contactPoints : ['127.0.0.1'],
  };
}

async function ensurePostgresMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureScyllaKeyspace(client, config) {
  await client.execute(
    `CREATE KEYSPACE IF NOT EXISTS ${config.keyspace}
     WITH replication = {'class': 'SimpleStrategy', 'replication_factor': ${config.replicationFactor}}`
  );
}

async function ensureScyllaMigrationsTable(client, keyspace) {
  await client.execute(
    `CREATE TABLE IF NOT EXISTS ${keyspace}.schema_migrations (
      scope text,
      filename text,
      checksum text,
      applied_at timestamp,
      PRIMARY KEY ((scope), filename)
    )`
  );
}

async function loadSqlMigrations() {
  const files = (await fs.readdir(postgresMigrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const migrations = [];
  for (const filename of files) {
    const fullPath = path.join(postgresMigrationsDir, filename);
    const sql = await fs.readFile(fullPath, 'utf8');
    migrations.push({
      filename,
      fullPath,
      sql,
      checksum: checksumOf(sql),
    });
  }

  return migrations;
}

async function loadScyllaMigrations() {
  let files = [];
  try {
    files = await fs.readdir(scyllaMigrationsDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const migrations = [];
  for (const filename of files.filter((file) => file.endsWith('.cql')).sort()) {
    const fullPath = path.join(scyllaMigrationsDir, filename);
    const cql = await fs.readFile(fullPath, 'utf8');
    const statements = cql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    migrations.push({
      filename,
      fullPath,
      cql,
      statements,
      checksum: checksumOf(cql),
    });
  }

  return migrations;
}

function renderScyllaStatement(statement, config) {
  return statement.replaceAll('{{KEYSPACE}}', config.keyspace);
}

function reportMigrationStatus({
  logger,
  appliedRows,
  pending,
  appliedLabel,
  pendingLabel,
}) {
  logger.log(`${appliedLabel}: ${appliedRows.length}`);
  logger.log(`${pendingLabel}: ${pending.length}`);

  for (const row of appliedRows) {
    logger.log(`applied  ${row.filename}  ${new Date(row.applied_at).toISOString()}`);
  }
  for (const migration of pending) {
    logger.log(`pending  ${migration.filename}`);
  }
}

function validateAppliedChecksums({ appliedByFilename, migrations, errorPrefix }) {
  const pending = [];

  for (const migration of migrations) {
    const applied = appliedByFilename.get(migration.filename);
    if (!applied) {
      pending.push(migration);
      continue;
    }

    if (applied.checksum !== migration.checksum) {
      throw new Error(
        `${errorPrefix} "${migration.filename}" no longer matches the repo copy. ` +
        'Create a new migration instead of editing an old one.'
      );
    }
  }

  return pending;
}

function validateUnexpectedAppliedMigrations({ appliedRows, migrations, errorPrefix }) {
  const repoFilenames = new Set(migrations.map((migration) => migration.filename));
  const unexpected = appliedRows
    .map((row) => row.filename)
    .filter((filename) => !repoFilenames.has(filename));

  if (unexpected.length > 0) {
    throw new Error(
      `${errorPrefix} ${unexpected.join(', ')}. ` +
      'This database is ahead of the repo migration set. Realign schema_migrations and any leftover tables before continuing.'
    );
  }
}

async function withGlobalMigrationLock({ logger = console }, callback) {
  const pool = createPool();
  const client = await pool.connect();

  try {
    logger.log('Waiting for global migration lock...');
    await client.query(
      'SELECT pg_advisory_lock($1, $2)',
      MIGRATION_LOCK_KEYS
    );
    logger.log('Acquired global migration lock.');
    return await callback();
  } finally {
    try {
      await client.query(
        'SELECT pg_advisory_unlock($1, $2)',
        MIGRATION_LOCK_KEYS
      );
    } finally {
      client.release();
      await pool.end();
    }
  }
}

export async function runPostgresMigrations({ logger = console, statusOnly = false } = {}) {
  const pool = createPool();
  const client = await pool.connect();

  try {
    await ensurePostgresMigrationsTable(client);

    const migrations = await loadSqlMigrations();
    const appliedResult = await client.query(
      `SELECT filename, checksum, applied_at
       FROM schema_migrations
       ORDER BY filename`
    );

    const appliedByFilename = new Map(
      appliedResult.rows.map((row) => [row.filename, row])
    );
    validateUnexpectedAppliedMigrations({
      appliedRows: appliedResult.rows,
      migrations,
      errorPrefix: 'Unexpected applied PostgreSQL migrations:',
    });
    const pending = validateAppliedChecksums({
      appliedByFilename,
      migrations,
      errorPrefix: 'Applied migration',
    });

    if (statusOnly) {
      reportMigrationStatus({
        logger,
        appliedRows: appliedResult.rows,
        pending,
        appliedLabel: 'Applied migrations',
        pendingLabel: 'Pending migrations',
      });

      return {
        appliedCount: appliedResult.rows.length,
        pendingCount: pending.length,
      };
    }

    for (const migration of pending) {
      logger.log(`Applying migration ${migration.filename}...`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum)
           VALUES ($1, $2)`,
          [migration.filename, migration.checksum]
        );
        await client.query('COMMIT');
        logger.log(`Applied ${migration.filename}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    logger.log(
      pending.length === 0
        ? 'No pending migrations.'
        : `Migration complete. Applied ${pending.length} new migration${pending.length === 1 ? '' : 's'}.`
    );

    return {
      appliedCount: appliedResult.rows.length + pending.length,
      pendingCount: 0,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

export async function runScyllaMigrations({ logger = console, statusOnly = false } = {}) {
  const config = resolveScyllaConfig();
  const client = new cassandra.Client({
    contactPoints: config.contactPoints,
    localDataCenter: config.localDataCenter,
  });

  await client.connect();

  try {
    await ensureScyllaKeyspace(client, config);
    await ensureScyllaMigrationsTable(client, config.keyspace);

    const migrations = await loadScyllaMigrations();
    const appliedResult = await client.execute(
      `SELECT filename, checksum, applied_at
       FROM ${config.keyspace}.schema_migrations
       WHERE scope = ?`,
      ['scylla'],
      { prepare: true }
    );
    const appliedRows = appliedResult.rows || [];
    const appliedByFilename = new Map(
      appliedRows.map((row) => [row.filename, row])
    );
    validateUnexpectedAppliedMigrations({
      appliedRows,
      migrations,
      errorPrefix: 'Unexpected applied Scylla migrations:',
    });
    const pending = validateAppliedChecksums({
      appliedByFilename,
      migrations,
      errorPrefix: 'Applied Scylla migration',
    });

    if (statusOnly) {
      reportMigrationStatus({
        logger,
        appliedRows,
        pending,
        appliedLabel: 'Applied Scylla migrations',
        pendingLabel: 'Pending Scylla migrations',
      });

      return {
        appliedCount: appliedRows.length,
        pendingCount: pending.length,
      };
    }

    for (const migration of pending) {
      logger.log(`Applying Scylla migration ${migration.filename}...`);
      try {
        for (const statement of migration.statements) {
          await client.execute(renderScyllaStatement(statement, config));
        }
        await client.execute(
          `INSERT INTO ${config.keyspace}.schema_migrations (scope, filename, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
          ['scylla', migration.filename, migration.checksum, new Date()],
          { prepare: true }
        );
        logger.log(`Applied ${migration.filename}`);
      } catch (error) {
        throw new Error(`Failed while applying Scylla migration "${migration.filename}": ${error.message}`);
      }
    }

    logger.log(
      pending.length === 0
        ? 'No pending Scylla migrations.'
        : `Scylla migration complete. Applied ${pending.length} new migration${pending.length === 1 ? '' : 's'}.`
    );

    return {
      appliedCount: appliedRows.length + pending.length,
      pendingCount: 0,
    };
  } finally {
    await client.shutdown();
  }
}

export async function runMigrations({ logger = console, statusOnly = false } = {}) {
  const runAll = async () => {
    logger.log('== PostgreSQL ==');
    const postgres = await runPostgresMigrations({ logger, statusOnly });
    logger.log('');
    logger.log('== ScyllaDB ==');
    const scylla = await runScyllaMigrations({ logger, statusOnly });

    return {
      postgres,
      scylla,
    };
  };

  if (statusOnly) {
    return runAll();
  }

  return withGlobalMigrationLock({ logger }, runAll);
}
