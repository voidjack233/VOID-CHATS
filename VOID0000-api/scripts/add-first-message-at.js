// scripts/add-first-message-at.js
// Migration: add first_message_at to conversations for ghost-DM filtering.
// Run once:  node scripts/add-first-message-at.js

import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: parseInt(process.env.PGPORT || '5432', 10),
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add column (IF NOT EXISTS keeps it idempotent)
    await client.query(`
      ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS first_message_at TIMESTAMPTZ DEFAULT NULL
    `);

    // Backfill: only stamp DMs that have actually diverged from creation
    // (updated_at > created_at means a message was sent and updated the row).
    // DMs where updated_at = created_at are old ghost DMs — leave them NULL.
    await client.query(`
      UPDATE conversations
      SET first_message_at = updated_at
      WHERE type = 'dm'
        AND first_message_at IS NULL
        AND updated_at > created_at
    `);

    await client.query('COMMIT');
    console.log('Migration complete: first_message_at added and backfilled.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
