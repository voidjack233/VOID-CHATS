# VOID-CHATS

This is my chat app hobby project.

It works, but it is still a personal project and not a polished product. Expect rough edges, unfinished ideas, and setup steps that assume you are comfortable running local infrastructure.

Read the next few sections before trying to set it up. They explain the service layout, database pieces, and security caveats without pretending the repo is simpler than it is.

## Before You Clone

- Bare-metal/manual setup is only supported on Linux.
- Docker Compose exists for local dev/testing and may work outside Linux, but it is not the production deployment story.
- The stack is not a one-command install.
- This project includes encrypted chat/media work, but I am not claiming the project is secure or formally audited end to end.
- There may still be hidden vulnerabilities, logic mistakes, or rough UX corners.
- If you want a clean production messenger out of the box, this is probably not that.

## What Is In This Repo

- `VOID0000-www`
  React + TypeScript + Vite frontend
- `VOID0000-api`
  split Express services, PostgreSQL migrations, Scylla message storage, MinIO media routes, workers
- `VOID0000-api/void_gateway`
  Phoenix realtime gateway for presence and chat fanout
- `VOIDADMIN`
  small internal admin panel for users and security logs
- `docs`
  setup notes, flow map, recovery notes, future notes

## About The Docs

These docs are meant to be useful first, pretty second.

Some pages are more detailed than others because different parts of the app need different amounts of explanation. The goal is simple: make the repo understandable without turning it into a fake corporate product page.

## Setup

Short version:

1. Use Linux.
2. Install Node 20+, npm, PostgreSQL, ScyllaDB, Valkey, MinIO, Elixir, and Erlang.
3. Create `VOID0000-api/.env`.
4. Run the database migrations.
5. Start the account, message, social, conversation, worker, gateway, and frontend services.

or

You can use Docker. it work on my machine :) 

Commands:

```bash
cd VOID0000-api
npm install
npm run migrate
npm run dev
```

The command above starts only the account/control service. For the full split backend, run these in separate shells too:

```bash
npm run dev:messages
```

```bash
npm run dev:conversations
```

```bash
npm run dev:social
```

```bash
npm run dev:workers
```

```bash
cd VOID0000-api/void_gateway
mix deps.get
set -a
source ../.env
set +a
mix phx.server
```

```bash
cd VOID0000-www
npm install
npm run dev
```

Full setup notes are here:

- [docs/setup.md](docs/setup.md)
- [docs/nginx-frontend-only.example.conf](docs/nginx-frontend-only.example.conf)

Use the setup doc. This repo depends on local infra and a Linux-first workflow.
It also shows the Nginx + Cloudflared layout used for deployment.

## The Story

I work full-time as a store clerk and built VOID as a hobby project.

I used AI tools while building it. They helped with implementation, debugging, comparing approaches, and checking edge cases. I still handled the direction, tradeoffs, QA, and decisions.

The stack sounds ambitious, which is kind of the joke and kind of the point. I keep thinking, "what if this had millions of users?" while realistically building for a tiny app. That tension is why the repo has both serious infrastructure and hobby-project fingerprints.

## App Shape

VOID has:

- account auth with short-lived access cookies, refresh-token rotation, CSRF protection, captcha, trust scoring, and 2FA flows
- friends, profiles, sessions, presence, and realtime gateway plumbing
- DMs and group conversations
- group owners, admins, members, invites, ownership transfer, and self-leave
- a simple group settings UI with `Profile`, `Members`, `Invites`, and `Permissions`
- encrypted chat/media work built around the MLS path

Not included:

- a polished custom role builder
- a separate group access-control page
- voice calls and video calls
- self-service account deletion
- a formal security or cryptography audit

Group permissions use simple built-in roles like owner, admin, and member. There is no custom role-builder UI in this repo.

Calls are outside the repo on purpose. Reliable voice/video usually means WebRTC plus STUN/TURN and UDP-reachable infrastructure. Without a stable network edge or static IP, that quickly pushes the app toward hosted relay services. I would rather keep VOID focused on messaging than add another hard dependency on third-party realtime media infrastructure.

Self-service account deletion is not in the app because this setup is tiny, roughly 1 to 3 users with limited usage. If an account needs to be removed, handle it manually as the operator.

## Security Reality

VOID includes:

- MLS-backed encrypted chat work
- encrypted media
- durable MLS sync
- auth, sessions, presence, captcha/trust protection, and realtime chat infrastructure

VOID does **not** have:

- a formal end-to-end cryptography audit
- a formal third-party security review of the whole stack
- a guarantee that there are no hidden vulnerabilities

The biggest explicit crypto caveat is `ts-mls`.

This project uses a vendored copy of:

- [`ts-mls`](https://github.com/LukaJCB/ts-mls) `1.6.2`, stored in [`VOID0000-www/vendor/ts-mls`](VOID0000-www/vendor/ts-mls)

Credit to:

- [`LukaJCB`](https://github.com/LukaJCB), the upstream maintainer of `ts-mls`

Upstream states that `ts-mls` has **not** undergone a formal security audit yet, so I do not want this repo to pretend otherwise.
The package is vendored so future upstream or npm updates do not silently change the MLS code used by this project.

What that means:

- the MLS path is real
- the MLS path is still not something I would market as a formally audited messenger

One more implementation note:

- the recovery path uses a user-created recovery key so fresh devices do not have to depend only on the account password
- during login or legacy password-based encrypted-chat recovery, the frontend may keep the raw account password in browser memory briefly so it can finish password-derived key restore / backup work
- that password is not meant to persist in `localStorage`, `sessionStorage`, or IndexedDB
- target behavior is short-lived retention only: usually just for the immediate bootstrap pass, with a fallback max window of about 2 minutes before it is cleared
- the device may store the recovery key locally in an encrypted browser record so it can refresh recovery-key backups
- this is a tradeoff in the recovery design, not something I consider perfect forever

Account-security note:

- access cookies are intentionally short-lived
- refresh tokens are rotated and stored server-side only as hashes
- auth secrets are validated at startup so placeholder secrets fail loudly instead of silently weakening the app
- captcha challenges and trust/rate-limit state live in Valkey so split services do not each invent their own memory-only truth
- `/api/clear-stale` only clears cookies in the browser that calls it; it does not wipe everyone else's session from the server

Related notes:

- [VOID0000-www/docs/secure-chat-recovery-limitations.md](VOID0000-www/docs/secure-chat-recovery-limitations.md)
- [VOID0000-www/docs/project-flow-map.md](VOID0000-www/docs/project-flow-map.md)

## Main Open-Source Building Blocks

This is not a full SBOM. It is a short list of the main building blocks used here.

Frontend:

- `react`, `react-dom`
  UI
- `vite`
  frontend build/dev server
- `tailwindcss`
  styling
- `react-router-dom`
  routing
- `socket.io-client`
  realtime client transport
- `ts-mls`
  MLS-based encrypted chat layer
- `emoji-picker-react`
  emoji picker UI
- `blurhash`
  blurred image placeholders
- `dompurify`
  text sanitization

API:

- `express`
  HTTP API
- `pg`
  PostgreSQL access
- `cassandra-driver`
  ScyllaDB access
- `minio`
  object storage integration
- `ioredis` and `rate-limit-redis`
  Valkey/Redis access and rate limiting
- `bullmq`
  queueing work
- `sharp`
  server-side image processing for non-encrypted image flows like avatars
- `argon2`
  password hashing
- `jsonwebtoken`
  auth/session token work
- `nodemailer`
  email sending
- `qrcode`
  2FA setup helpers

Realtime gateway:

- Phoenix / Elixir
  websocket presence and chat fanout

Full dependency lists live in:

- [VOID0000-www/package.json](VOID0000-www/package.json)
- [VOID0000-api/package.json](VOID0000-api/package.json)
- lockfiles in each app

## Repo Layout

```text
VOIDAPP/
├── VOID0000-api/
│   ├── db/
│   ├── scripts/
│   ├── server/
│   └── void_gateway/
├── VOID0000-www/
└── docs/
```

## A Few Final Honest Notes

- This repo targets Linux infra first, but Docker Compose exists for local testing.
- If you are on Windows or macOS without Docker, you are outside the setup path I actually used.
- If you deploy this publicly, do your own security review.
- Keep raw backend, gateway, and MinIO ports loopback-only. Let Nginx or your tunnel be the public door.
- Profile and group pictures are public-read. Chat attachment blobs are private and downloaded through the authenticated API path.
- If you fork this, feel free to simplify things. I did not optimize it for textbook purity.

Future notes live here:

- [docs/future-notes.md](docs/future-notes.md)

Backup notes live here:

- [docs/backups.md](docs/backups.md)


If you guys have alot of time and the Setup step is not working... (figure it out by yourself) XD


One last note: if you see the root `package.json`, `package-lock.json`, or `server.js`, treat them as legacy root files. The normal run path uses `VOID0000-www`, split services inside `VOID0000-api`, and `VOID0000-api/void_gateway`.
