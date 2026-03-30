import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(projectRoot, 'db', 'migrations');

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

function checksumOf(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadMigrations() {
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const migrations = [];
  for (const filename of files) {
    const fullPath = path.join(migrationsDir, filename);
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

export async function runMigrations({ logger = console, statusOnly = false } = {}) {
  const pool = createPool();
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);

    const migrations = await loadMigrations();
    const appliedResult = await client.query(
      `SELECT filename, checksum, applied_at
       FROM schema_migrations
       ORDER BY filename`
    );

    const appliedByFilename = new Map(
      appliedResult.rows.map((row) => [row.filename, row])
    );

    const pending = [];
    for (const migration of migrations) {
      const applied = appliedByFilename.get(migration.filename);
      if (!applied) {
        pending.push(migration);
        continue;
      }

      if (applied.checksum !== migration.checksum) {
        throw new Error(
          `Applied migration "${migration.filename}" no longer matches the repo copy. ` +
          'Create a new migration instead of editing an old one.'
        );
      }
    }

    if (statusOnly) {
      logger.log(`Applied migrations: ${appliedResult.rows.length}`);
      logger.log(`Pending migrations: ${pending.length}`);

      for (const row of appliedResult.rows) {
        logger.log(`applied  ${row.filename}  ${new Date(row.applied_at).toISOString()}`);
      }
      for (const migration of pending) {
        logger.log(`pending  ${migration.filename}`);
      }

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
