# Database Migrations

This repo now has a canonical migration path for the current Postgres and ScyllaDB schema used by the app.

## Commands

Run all pending migrations:

```bash
npm run migrate
```

Check status without applying anything:

```bash
npm run migrate:status
```

## What this covers today

Current canonical migrations cover:

- core user / auth / security tables
  - `users`
  - `user_profiles`
  - `user_preferences`
  - `friendships`
  - `email_verifications`
  - `password_resets`
  - `refresh_tokens`
  - `user_2fa`
  - `user_2fa_backup_codes`
  - `ip_security_logs`
  - `trust_scores`
  - `user_keys`
  - `user_key_backups`
- conversation tables

- `conversations`
- `conversation_categories`
- `conversation_members`
- `conversation_key_rotations`
- `dm_pairs`
- `conversation_invite_links`
- `conversation_join_requests`
- `mls_key_packages`
- `mls_group_states`
- `mls_welcome_messages`
- `mls_commit_messages`
- `mls_group_key_archive`
- ScyllaDB message storage tables
  - `messages`
  - `message_edits`
  - `message_reactions`
  - `user_reactions`
  - `reaction_counts`

Migration order matters:

- `0000_core_schema.sql`
- `0001_conversation_schema.sql`
- `0002_mls_schema.sql`
- `db/scylla-migrations/0000_message_storage.cql`

The `0000` prefix is intentional because later conversation migrations reference `users(id)`.

## Current limitation

This covers the relational Postgres schema and the canonical ScyllaDB message storage schema.

It does **not** manage:

- Valkey state
- MinIO buckets / object lifecycle
- PM2 process state

## Runtime behavior

MLS routes should no longer be responsible for creating or altering tables at runtime.
The server should verify that the Postgres and Scylla schema are already present.

If MLS schema pieces are missing, run:

```bash
npm run migrate
```

That same command now also creates the Scylla keyspace and message-storage tables used by the conversation routes.

## Multi-instance safety

`npm run migrate` now takes a global PostgreSQL advisory lock before applying migrations.

That means if two app instances or deploy hooks try to run migrations at the same time:

- one runner waits
- the other finishes first
- Postgres and Scylla schema changes are serialized through one migration gate

`npm run migrate:status` stays read-only and does not take the lock.

## Important note about data rows

`npm run migrate` creates schema plus migration bookkeeping rows.

It does **not** clone your existing live data such as:

- users
- conversations
- messages
- reactions

If you want existing rows copied into a new environment, that is a database export/import or backfill task, not a schema migration task.

## Legacy one-off scripts

These historical scripts are still available as compatibility aliases:

- `node scripts/add-first-message-at.js`
- `node scripts/add-group-permissions.js`
- `node scripts/add-conversation-unread-count.js`

They now delegate to the canonical migration runner.
