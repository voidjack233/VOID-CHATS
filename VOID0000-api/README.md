# VOID0000 API

Backend services for VOID0000. This package owns the parts of the app that should not live in the browser: authentication, user profiles, friendships, conversations, messages, media uploads, security middleware, database migrations, and background workers.

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

The app processes are separate from the infrastructure services. PM2 starts the split Node services, worker, and Phoenix gateway, but Postgres, Valkey, ScyllaDB, and MinIO must already be running. If one of those is down, the backend may start grumbling in ways that look unrelated at first.

## Requirements

- Node.js and npm
- Postgres
- Valkey or Redis-compatible server
- ScyllaDB
- MinIO
- Erlang/Elixir, if running the Phoenix gateway locally or through PM2

The Dockerfile uses `node:24-bookworm-slim`.

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

For the full local backend without PM2, also start these in separate shells:

```bash
npm run dev:messages
```

```bash
npm run dev:social
```

```bash
npm run dev:conversations
```

```bash
npm run dev:workers
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
| `npm run dev` | Start the account/control service with `nodemon`. |
| `npm run dev:messages` | Start the message/reaction/attachment service with `nodemon`. |
| `npm run dev:conversations` | Start the conversation/group/MLS service with `nodemon`. |
| `npm run dev:social` | Start the friends/profile/search service with `nodemon`. |
| `npm run dev:workers` | Start the background worker service with `nodemon`. |
| `npm start` | Start the account/control service with Node. |
| `npm run start:messages` | Start the message service with Node. |
| `npm run start:conversations` | Start the conversation service with Node. |
| `npm run start:social` | Start the social/profile service with Node. |
| `npm run start:workers` | Start the worker service with Node. |
| `npm run lint` | Run ESLint. |
| `npm run migrate` | Apply pending Postgres and ScyllaDB migrations. |
| `npm run migrate:status` | Show migration status without applying changes. |
| `npm run backfill:conversation-public-ids` | Run the conversation public ID backfill. |
| `npm run migrate:legacy-group-to-general` | Run the legacy group-to-general migration script. |

## Environment

Start from `.env.example` and fill in real values for the target machine.

Do not leave placeholder auth secrets in `.env`. The account service validates the important auth/2FA/CSRF secrets during startup and fails loudly if they are missing, too short, or still look like examples. Annoying at boot time, much better than finding out during a login attempt.

Important groups:

- Postgres: `PGHOST`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`, `PGPORT`
- ScyllaDB: `SCYLLA_HOST`
- Valkey: `VALKEY_HOST`, `VALKEY_PORT`
- MinIO: `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, bucket names
- Auth: `ACCESS_SECRET`, `REFRESH_SECRET`
- CSRF and 2FA: `CSRF_ENCRYPTION_KEY`, `TOTP_ENCRYPTION_KEY`, `TWO_FACTOR_CODE_SECRET`
- Email: `EMAIL_USER`, `EMAIL_PASS`
- Frontend/API: `FRONT_URL`, `VITE_API_URL`, `PORT`, `MESSAGE_SERVICE_PORT`, `SOCIAL_SERVICE_PORT`, `CONVERSATION_SERVICE_PORT`
- Phoenix gateway: `GATEWAY_PORT`, `PHX_SECRET_KEY_BASE`

## Data Stores

| Store | Used For |
| --- | --- |
| Postgres | Users, auth, sessions, profiles, friends, conversation metadata, MLS metadata. |
| ScyllaDB | High-volume message storage, edits, reactions, and reaction counts. |
| Valkey | Realtime pub/sub, captcha challenges, trust/rate-limit state, presence fanout, gateway coordination, session resume buffers. |
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
- `/api/conversations` - DMs, conversation metadata, group members, ownership transfer, self-leave, permissions, keys, MLS, invites, messages, reactions, and attachments.

Self-service account deletion is not exposed as a public flow. This setup is tiny, roughly 1 to 3 users with limited usage, so account removal is handled manually by the operator when needed.

## Security Notes

- Passwords are hashed with Argon2id.
- Login verifies the stored Argon2 hash and can rehash it when the configured Argon2 parameters change.
- Refresh tokens are stored as SHA-256 hashes because the raw tokens are already high-entropy JWTs.
- JWTs are delivered through cookies.
- Access cookies are intentionally short-lived, so refresh-token health matters for normal UX.
- Sensitive state-changing routes use encrypted CSRF protection.
- Captcha challenges, trust scoring, device tracking, and rate limits are backed by Valkey for auth/profile protection across service processes.
- TOTP secrets and email-2FA verification codes use separate server-side secrets. The TOTP encryption key protects stored authenticator secrets; `TWO_FACTOR_CODE_SECRET` protects temporary email-code verification state.
- Image uploads are processed through Sharp to remove metadata.
- DOMPurify, JSDOM, CSP, and security headers are used for XSS hardening.

## Dependency Map

| Dependency | Role |
| --- | --- |
| `argon2` | Password hashing and verification, plus 2FA backup code hashing. |
| `bcryptjs` | Reserved for possible legacy bcrypt hash migration. Remove it if that compatibility path is not needed. |
| `blurhash` | Compact placeholders for image attachments. |
| `bullmq` | Background queue for image/profile processing work. |
| `canvas` | Captcha image generation. |
| `cassandra-driver` | CQL client for ScyllaDB. |
| `cookie-parser` | Cookie parsing for auth and CSRF flows. |
| `cors` | Cross-origin API access for the frontend. |
| `dompurify` and `jsdom` | Server-side sanitization support. |
| `dotenv` | Loads `.env` during startup. |
| `express` | HTTP API framework. |
| `ioredis` | Valkey/Redis client for pub/sub, coordination, sessions/cache, and custom rate-limit storage. |
| `jsonwebtoken` | Access and refresh token signing. |
| `minio` | Object storage client. |
| `nodemailer` | Gmail SMTP email delivery. |
| `pg` | Postgres client. |
| `qrcode` | QR code generation for authenticator-app 2FA setup. |
| `sharp` | Image processing and metadata stripping. |
| `socket.io` | Currently listed, but websocket serving has moved to the Phoenix gateway. |
| `uuid` | Token IDs and unique identifiers. |

## Health Checks

Account/control API:

```bash
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/ready
```

Readiness checks:

```bash
curl http://127.0.0.1:3001/ready
curl http://127.0.0.1:3002/ready
curl http://127.0.0.1:3004/ready
curl http://127.0.0.1:3005/ready
```

Phoenix gateway:

```bash
curl http://127.0.0.1:4001/health
curl http://127.0.0.1:4001/ready
```

If the API starts but realtime, uploads, or message history behave strangely, check the external services first: Postgres, Valkey, ScyllaDB, and MinIO.
