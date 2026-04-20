import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import express from 'express';
import pg from 'pg';
import argon2 from 'argon2';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const localEnvPath = path.join(__dirname, '.env');
const apiEnvPath = path.join(projectRoot, 'VOID0000-api', '.env');

if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
} else if (fs.existsSync(apiEnvPath)) {
  dotenv.config({ path: apiEnvPath });
}

const app = express();
const port = Number.parseInt(process.env.ADMIN_PANEL_PORT || '4310', 10);
const adminUsername = process.env.ADMIN_PANEL_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PANEL_PASSWORD || 'admin';

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: Number.parseInt(process.env.PGPORT || '5432', 10),
});

function safeCompare(expected, actual) {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function requireBasicAuth(req, res, next) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="VOID Admin"');
    return res.status(401).send('Authentication required');
  }

  let decoded = '';

  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    res.setHeader('WWW-Authenticate', 'Basic realm="VOID Admin"');
    return res.status(401).send('Invalid credentials');
  }

  const separatorIndex = decoded.indexOf(':');
  const username = separatorIndex === -1 ? decoded : decoded.slice(0, separatorIndex);
  const password = separatorIndex === -1 ? '' : decoded.slice(separatorIndex + 1);

  if (!safeCompare(adminUsername, username) || !safeCompare(adminPassword, password)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="VOID Admin"');
    return res.status(401).send('Invalid credentials');
  }

  return next();
}

function parsePagination(req, defaultLimit = 25, maxLimit = 100) {
  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(
    maxLimit,
    Math.max(1, Number.parseInt(String(req.query.limit || String(defaultLimit)), 10) || defaultLimit),
  );
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function toSearchPattern(queryValue) {
  const q = String(queryValue || '').trim();
  return {
    term: q,
    pattern: q ? `%${q}%` : '',
  };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

app.disable('x-powered-by');
app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({ ok: false });
  }
});

app.use(requireBasicAuth);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/users', async (req, res) => {
  const { page, limit, offset } = parsePagination(req, 25, 100);
  const { term, pattern } = toSearchPattern(req.query.q);

  try {
    const [countResult, rowsResult] = await Promise.all([
      pool.query(
        `
          SELECT COUNT(*)::int AS total
          FROM users u
          LEFT JOIN user_profiles p ON p.id = u.profile_id
          WHERE (
            $1 = ''
            OR u.username ILIKE $2
            OR u.email ILIKE $2
            OR u.id::text ILIKE $2
            OR COALESCE(p.display_name, '') ILIKE $2
          )
        `,
        [term, pattern],
      ),
      pool.query(
        `
          SELECT
            u.id,
            u.username,
            u.email,
            u.is_verified,
            u.profile_id,
            u.created_at,
            u.updated_at,
            p.display_name,
            p.bio
          FROM users u
          LEFT JOIN user_profiles p ON p.id = u.profile_id
          WHERE (
            $1 = ''
            OR u.username ILIKE $2
            OR u.email ILIKE $2
            OR u.id::text ILIKE $2
            OR COALESCE(p.display_name, '') ILIKE $2
          )
          ORDER BY u.created_at DESC
          LIMIT $3 OFFSET $4
        `,
        [term, pattern, limit, offset],
      ),
    ]);

    const total = countResult.rows[0]?.total || 0;

    res.json({
      rows: rowsResult.rows,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error('Failed to load users:', error);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

app.get('/api/security-logs', async (req, res) => {
  const { page, limit, offset } = parsePagination(req, 50, 100);
  const { term, pattern } = toSearchPattern(req.query.q);

  try {
    const [countResult, rowsResult] = await Promise.all([
      pool.query(
        `
          SELECT COUNT(*)::int AS total
          FROM ip_security_logs l
          LEFT JOIN users u ON u.id = l.user_id
          WHERE (
            $1 = ''
            OR COALESCE(l.action, '') ILIKE $2
            OR COALESCE(l.path, '') ILIKE $2
            OR COALESCE(l.user_agent, '') ILIKE $2
            OR COALESCE(l.device_fingerprint, '') ILIKE $2
            OR COALESCE(l.ip_address::text, '') ILIKE $2
            OR COALESCE(u.username, '') ILIKE $2
            OR COALESCE(u.email, '') ILIKE $2
          )
        `,
        [term, pattern],
      ),
      pool.query(
        `
          SELECT
            l.id,
            l.ip_address::text AS ip_address,
            l.action,
            l.user_id,
            l.user_agent,
            l.device_fingerprint,
            l.path,
            l.created_at,
            u.username,
            u.email
          FROM ip_security_logs l
          LEFT JOIN users u ON u.id = l.user_id
          WHERE (
            $1 = ''
            OR COALESCE(l.action, '') ILIKE $2
            OR COALESCE(l.path, '') ILIKE $2
            OR COALESCE(l.user_agent, '') ILIKE $2
            OR COALESCE(l.device_fingerprint, '') ILIKE $2
            OR COALESCE(l.ip_address::text, '') ILIKE $2
            OR COALESCE(u.username, '') ILIKE $2
            OR COALESCE(u.email, '') ILIKE $2
          )
          ORDER BY l.created_at DESC
          LIMIT $3 OFFSET $4
        `,
        [term, pattern, limit, offset],
      ),
    ]);

    const total = countResult.rows[0]?.total || 0;

    res.json({
      rows: rowsResult.rows,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error('Failed to load security logs:', error);
    res.status(500).json({ error: 'Failed to load security logs' });
  }
});

app.patch('/api/users/:userId', async (req, res) => {
  const userId = String(req.params.userId || '').trim();
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : undefined;
  const password = typeof req.body?.password === 'string' ? req.body.password : undefined;
  const isVerified = typeof req.body?.is_verified === 'boolean' ? req.body.is_verified : undefined;

  if (!userId) {
    return res.status(400).json({ error: 'User id is required' });
  }

  if (!isUuid(userId)) {
    return res.status(400).json({ error: 'User id must be a valid UUID' });
  }

  if (email === undefined && password === undefined && isVerified === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  if (email !== undefined && !email) {
    return res.status(400).json({ error: 'Email cannot be empty' });
  }

  if (password !== undefined && !password.trim()) {
    return res.status(400).json({ error: 'Password cannot be empty' });
  }

  try {
    const existingResult = await pool.query(
      `
        SELECT id, username, email, is_verified, profile_id, created_at, updated_at
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [userId],
    );

    if (!existingResult.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (email !== undefined) {
      const duplicateResult = await pool.query(
        `
          SELECT id
          FROM users
          WHERE lower(email) = lower($1)
            AND id <> $2
          LIMIT 1
        `,
        [email, userId],
      );

      if (duplicateResult.rows.length) {
        return res.status(409).json({ error: 'Email is already in use' });
      }
    }

    const updates = [];
    const values = [userId];

    if (email !== undefined) {
      values.push(email);
      updates.push(`email = $${values.length}`);
    }

    if (password !== undefined) {
      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 2 ** 16,
        timeCost: 3,
        parallelism: 1,
      });
      values.push(passwordHash);
      updates.push(`password_hash = $${values.length}`);
    }

    if (isVerified !== undefined) {
      values.push(isVerified);
      updates.push(`is_verified = $${values.length}`);
    }

    updates.push('updated_at = NOW()');

    const updatedResult = await pool.query(
      `
        UPDATE users
        SET ${updates.join(', ')}
        WHERE id = $1
        RETURNING id, username, email, is_verified, profile_id, created_at, updated_at
      `,
      values,
    );

    return res.json({ row: updatedResult.rows[0] });
  } catch (error) {
    console.error('Failed to update user:', error);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`VOIDADMIN running on http://127.0.0.1:${port}`);
});
