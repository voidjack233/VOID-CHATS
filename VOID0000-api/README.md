# VOID0000 API

Backend services for VOID0000. This package owns authentication, user profiles, friendships, conversations, messages, media uploads, security middleware, database migrations, and background workers.

Realtime websocket traffic is handled by the Phoenix gateway in `void_gateway`. The Node services publish realtime events through Valkey.

## Runtime Shape

- `server/entrypoints/account-server.js` - account/control API on port `3001`.
- `server/entrypoints/message-server.js` - messages, reactions, and attachment uploads on port `3002`.
- `server/entrypoints/social-server.js` - profiles, friends, and user search on port `3004`.
- `server/entrypoints/conversation-server.js` - conversations, groups, members, invites, and MLS metadata on port `3005`.
- `server/entrypoints/worker-server.js` - background workers, cleanup, and presence fanout.
- `void_gateway` - Phoenix websocket gateway.
- `ecosystem.config.cjs` - PM2 process definitions.
- `db/migrations` - canonical Postgres schema migrations.
- `db/scylla-migrations` - canonical ScyllaDB message storage migrations.
- `docs/backend-startup.md` - detailed startup notes.
- `docs/database-migrations.md` - migration behavior and limitations.

The app processes are separate from the infrastructure services. PM2 starts the Node API and Phoenix gateway, but Postgres, Valkey, ScyllaDB, and MinIO must already be running.

## Requirements

- Node.js and npm
- Postgres
- Valkey or Redis-compatible server
- ScyllaDB
- MinIO
- Erlang/Elixir, if running the Phoenix gateway locally or through PM2

The Dockerfile currently uses `node:24-bookworm-slim`.

## Quick Start

```bash
cd VOID0000-api
cp .env.example .env
npm install
npm run migrate
npm run dev
```

The default development account/control API runs on:

```text
http://localhost:3001
```

For a PM2-style production start:

```bash
cd VOID0000-api
npm run migrate
pm2 start ecosystem.config.cjs --update-env
```

Expected PM2 apps:

- `voidapp-api`
- `voidapp-message-service`
- `voidapp-social-profile-service`
- `voidapp-conversation-service`
- `voidapp-gateway-phoenix`
- `voidapp-worker-service`

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the API with `nodemon`. |
| `npm start` | Start the API with Node. |
| `npm run lint` | Run ESLint. |
| `npm run migrate` | Apply pending Postgres and ScyllaDB migrations. |
| `npm run migrate:status` | Show migration status without applying changes. |
| `npm run backfill:conversation-public-ids` | Run the conversation public ID backfill. |
| `npm run migrate:legacy-group-to-general` | Run the legacy group-to-general migration script. |

## Environment

Start from `.env.example` and fill in real values for the target machine.

Important groups:

- Postgres: `PGHOST`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`, `PGPORT`
- ScyllaDB: `SCYLLA_HOST`
- Valkey: `VALKEY_HOST`, `VALKEY_PORT`
- MinIO: `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, bucket names
- Auth: `ACCESS_SECRET`, `REFRESH_SECRET`
- CSRF and 2FA: `CSRF_ENCRYPTION_KEY`, `TOTP_ENCRYPTION_KEY`
- Email: `EMAIL_USER`, `EMAIL_PASS`
- Frontend/API: `FRONT_URL`, `VITE_API_URL`, `PORT`
- Phoenix gateway: `GATEWAY_PORT`, `PHX_SECRET_KEY_BASE`

## Data Stores

| Store | Used For |
| --- | --- |
| Postgres | Users, auth, sessions, profiles, friends, conversation metadata, MLS metadata. |
| ScyllaDB | High-volume message storage, edits, reactions, and reaction counts. |
| Valkey | Realtime pub/sub, rate-limit state, presence fanout, gateway coordination, session resume buffers. |
| MinIO | Avatars, group avatars, and encrypted chat attachments. |

Run `npm run migrate` before starting a fresh environment. Migrations create schema only; they do not copy existing users, conversations, messages, or media.

## API Areas

- `/api/auth` - register, login, logout, refresh, email verification, password reset, password change.
- `/api/auth/2fa` - TOTP, email 2FA, verification, disabling, and backup codes.
- `/api/csrf` - encrypted CSRF token flow.
- `/api/captcha` - captcha generation and verification.
- `/api/me` - authenticated user lookup.
- `/api/users` - profile reads, profile updates, avatar upload, preferences, sessions, account data, and search.
- `/api/friends` - friend requests, lists, presence, actions, and removal.
- `/api/conversations` - DMs, conversation metadata, members, permissions, keys, MLS, invites, messages, reactions, and attachments.
- `/api/debug/ws-stats` - reports that the Node API is running in Phoenix gateway mode.

## Security Notes

- Passwords are hashed with Argon2id.
- Login verifies the stored Argon2 hash and can rehash it when the configured Argon2 parameters change.
- Refresh tokens are stored as SHA-256 hashes because the raw tokens are already high-entropy JWTs.
- JWTs are delivered through cookies.
- Sensitive state-changing routes use encrypted CSRF protection.
- Captcha, trust scoring, device tracking, and Redis-backed rate limits protect auth and profile flows.
- Image uploads are processed through Sharp to remove metadata.
- DOMPurify, JSDOM, CSP, and security headers are used for XSS hardening.

## Dependency Map

| Dependency | Role |
| --- | --- |
| `argon2` | Password hashing and verification, plus 2FA backup code hashing. |
| `bcryptjs` | Currently listed but not used by the API code. Keep only if you plan to support legacy bcrypt hash migration; otherwise it can be removed. |
| `blurhash` | Compact placeholders for image attachments. |
| `bullmq` | Background queue for image/profile processing work. |
| `canvas` | Captcha image generation. |
| `cassandra-driver` | CQL client for ScyllaDB. |
| `cookie-parser` | Cookie parsing for auth and CSRF flows. |
| `cors` | Cross-origin API access for the frontend. |
| `dompurify` and `jsdom` | Server-side sanitization support. |
| `dotenv` | Loads `.env` during startup. |
| `express` | HTTP API framework. |
| `ioredis` | Valkey/Redis client for pub/sub, coordination, and rate-limit backing storage. |
| `jsonwebtoken` | Access and refresh token signing. |
| `minio` | Object storage client. |
| `nodemailer` | Gmail SMTP email delivery. |
| `pg` | Postgres client. |
| `qrcode` | QR code generation for authenticator-app 2FA setup. |
| `rate-limit-redis` | Redis-backed rate limiting. |
| `sharp` | Image processing and metadata stripping. |
| `socket.io` | Currently listed, but websocket serving has moved to the Phoenix gateway. |
| `uuid` | Token IDs and unique identifiers. |

## Health Checks

API gateway mode:

```bash
curl http://127.0.0.1:3001/api/debug/ws-stats
```

Phoenix gateway:

```bash
curl http://127.0.0.1:4001/health
```

If the API starts but realtime, uploads, or message history behave strangely, check the external services first: Postgres, Valkey, ScyllaDB, and MinIO.
