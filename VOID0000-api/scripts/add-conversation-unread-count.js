// scripts/add-conversation-unread-count.js
// Migration: add unread_count to conversation_members for sidebar unread badges.
// Run once: node scripts/add-conversation-unread-count.js

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

    await client.query(`
      ALTER TABLE conversation_members
      ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0
    `);

    await client.query('COMMIT');
    console.log('Migration complete: conversation_members.unread_count added.');
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
