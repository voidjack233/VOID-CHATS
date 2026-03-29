// scripts/add-group-permissions.js
// Migration: add permissions JSONB column to conversations for group permission settings.
// Run once:  node scripts/add-group-permissions.js

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
      ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT NULL
    `);

    await client.query('COMMIT');
    console.log('Migration complete: permissions JSONB column added to conversations.');
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
