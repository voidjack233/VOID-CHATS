# Database Migrations

This repo now has a canonical migration path for the current Postgres schema used by the app.

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

Migration order matters:

- `0000_core_schema.sql`
- `0001_conversation_schema.sql`
- `0002_mls_schema.sql`

The `0000` prefix is intentional because later conversation migrations reference `users(id)`.

## Current limitation

This only covers the relational Postgres schema.

It does **not** manage:

- Valkey state
- ScyllaDB message storage
- MinIO buckets / object lifecycle
- PM2 process state

## Runtime behavior

MLS routes should no longer be responsible for creating or altering tables at runtime.
The server should verify that the MLS schema is already present.

If MLS schema pieces are missing, run:

```bash
npm run migrate
```

## Legacy one-off scripts

These historical scripts are still available as compatibility aliases:

- `node scripts/add-first-message-at.js`
- `node scripts/add-group-permissions.js`
- `node scripts/add-conversation-unread-count.js`

They now delegate to the canonical migration runner.
