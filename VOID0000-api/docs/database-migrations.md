# Database Migrations

This repo has a canonical migration path for the Postgres and ScyllaDB schema used by the app.

## Commands

Run all pending migrations:

```bash
npm run migrate
```

Check status without applying anything:

```bash
npm run migrate:status
```

## What This Covers

Canonical migrations cover:

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
- `conversation_membership_rotations`
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
- migrations `0003` through `0013` in numeric order
- `0014_membership_rotation_reservations.sql`
- `0015_mls_claimable_key_packages.sql`
- `0016_account_mls_backups.sql`
- `0017_trust_scores.sql`
- `db/scylla-migrations/0000_message_storage.cql`
- `db/scylla-migrations/0001_message_metadata.cql`
- `db/scylla-migrations/0002_message_link_preview.cql`

The `0000` prefix is intentional because later conversation migrations reference `users(id)`.

## Membership Rotation

`0014_membership_rotation_reservations.sql` puts group member add, invite approval, and member removal on one serialized MLS reservation lane. The API and web client are expected to agree on `operation_id` for finalize and rollback requests.

This migration clears only unfinished `pending_add_*`, `pending_remove_*`, and `pending_approve_*` intents. A user who had one of those changes prepared but not finalized will need to retry it.

## KeyPackage Backup Gate

`0015_mls_claimable_key_packages.sql` quarantines public MLS KeyPackages until the owning authenticated client includes their matching private KeyPackages in a freshly uploaded encrypted MLS-state backup.

Unconsumed KeyPackages are intentionally not claimable until the account opens the app and refreshes its encrypted MLS backup.

The API and web client should be deployed together for this schema because clients must include the backed-up private KeyPackage refs needed to activate staged KeyPackages.

`0016_account_mls_backups.sql` stores a separate MLS snapshot encrypted by the already-unlocked account identity. It lets an active account replenish and activate KeyPackages automatically after login without retaining the password or requiring a manual backup action. Password and recovery backups remain responsible for restoring that account identity on a new browser.

`0017_trust_scores.sql` adds durable account trust-score state. That state helps the auth/security layer treat repeated weird login/captcha behavior as a pattern instead of forgetting everything on every process restart.

## Limitations

This covers the relational Postgres schema and the canonical ScyllaDB message storage schema.

It does **not** manage:

- Valkey state
- MinIO buckets / object lifecycle
- PM2 process state

## Runtime behavior

MLS routes are not responsible for creating or altering tables at runtime.
The server should verify that the Postgres and Scylla schema are already present.

If MLS schema pieces are missing, run:

```bash
npm run migrate
```

That same command also creates the Scylla keyspace and message-storage tables used by the conversation routes.

## Multi-instance safety

`npm run migrate` takes a global PostgreSQL advisory lock before applying migrations.

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

## Compatibility Scripts

These compatibility aliases are available for older setup notes or muscle memory:

- `node scripts/add-first-message-at.js`
- `node scripts/add-group-permissions.js`
- `node scripts/add-conversation-unread-count.js`

They delegate to the canonical migration runner.
