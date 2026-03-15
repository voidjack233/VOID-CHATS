#!/usr/bin/env node
/**
 * migrate.js
 * Applies incremental schema changes to the PostgreSQL database.
 * Run with: node scripts/migrate.js
 */

import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: parseInt(process.env.PGPORT || '5432', 10),
});

const MIGRATIONS = [
  {
    name: 'add_mls_backup_columns',
    sql: `
      ALTER TABLE user_key_backups
        ADD COLUMN IF NOT EXISTS mls_state_encrypted TEXT,
        ADD COLUMN IF NOT EXISTS mls_state_iv        TEXT,
        ADD COLUMN IF NOT EXISTS mls_state_salt      TEXT
    `,
  },
];

async function run() {
  const client = await pool.connect();
  try {
    for (const migration of MIGRATIONS) {
      console.log(`Running migration: ${migration.name}...`);
      await client.query(migration.sql);
      console.log(`  ✓ ${migration.name}`);
    }
    console.log('\n✅ All migrations applied.\n');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
