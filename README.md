# VOID-CHATS

This is my chat app hobby project.

I am dropping it in public as-is instead of pretending it is a polished startup product. It works, it has real infrastructure behind it, and I care about it a lot, but it is still a rough-edged personal build and there are absolutely places where future me may disappear for a while.

If you clone this, please read the next few sections before you sink hours into setup.

## Before You Clone

- This setup is only documented and realistically supported on Linux right now.
- The stack is not a one-command install.
- This project has secure chat and encrypted media, but it is not formally audited end to end.
- There may still be hidden vulnerabilities, logic mistakes, or rough UX corners.
- If you want a clean production messenger out of the box, this is probably not that.

## What Is In This Repo

- `VOID0000-www`
  React + TypeScript + Vite frontend
- `VOID0000-api`
  Express API, PostgreSQL migrations, Scylla message storage, MinIO media routes
- `VOID0000-api/void_gateway`
  Phoenix realtime gateway for presence and chat fanout
- `docs`
  setup notes, flow map, security notes, future notes

## Setup

Short version:

1. Use Linux.
2. Install Node 20+, npm, PostgreSQL, ScyllaDB, Valkey, MinIO, Elixir, and Erlang.
3. Create `VOID0000-api/.env`.
4. Run PostgreSQL migrations.
5. Start the API, gateway, and frontend in separate shells.

Commands:

```bash
cd VOID0000-api
npm install
npm run migrate
npm run dev
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

Please use that doc, because this repo depends on local infra that was originally built around a Linux bare-metal workflow.

## The Story

I work full-time as a store clerk and built VOID as a serious hobby project.

I do not claim that I hand-wrote every line in the most romantic solo-dev way. A lot of this project was built through what I think of as AI conducting: using AI tools to help implement, debug, compare approaches, and sanity-check edge cases while I stayed responsible for the direction, tradeoffs, QA instincts, and all the annoying “what happens if this breaks at 2am?” thinking.

That means this repo is a real build, but also a very human one:

- I chose pragmatic fixes over architecture theater
- I changed direction when something was clearly wrong
- I kept things that worked
- I dropped things that were becoming a headache

So this README is not trying to impress anyone. It is here to tell you honestly what this project is.

## Security Reality

VOID has:

- secure chat
- encrypted media
- durable MLS sync
- auth, sessions, presence, and realtime chat infrastructure

VOID does **not** currently have:

- a formal end-to-end cryptography audit
- a formal third-party security review of the whole stack
- a guarantee that there are no hidden vulnerabilities

The biggest explicit crypto caveat right now is `ts-mls`.

This project currently uses:

- [`ts-mls`](https://github.com/LukaJCB/ts-mls) `1.6.2`

Credit to:

- [`LukaJCB`](https://github.com/LukaJCB), the upstream maintainer of `ts-mls`

Upstream already warns that `ts-mls` has **not** undergone a formal security audit yet, so I do not want this repo to pretend otherwise.

Practical reading of that:

- the MLS path is real
- the MLS path is promising
- the MLS path is not something I would market as “formally audited secure messenger”

Related notes:

- [VOID0000-www/docs/crypto-security-notes.md](VOID0000-www/docs/crypto-security-notes.md)
- [VOID0000-www/docs/secure-chat-recovery-limitations.md](VOID0000-www/docs/secure-chat-recovery-limitations.md)
- [VOID0000-www/docs/project-flow-map.md](VOID0000-www/docs/project-flow-map.md)

## Main Open-Source Building Blocks

This is not a full SBOM. It is the short human version of the main stuff doing the work here.

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
  MLS-based secure chat layer
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

- This repo was built around Linux infra, not Docker-first portability.
- If you are on Windows or macOS, you are outside the setup path I actually used.
- If you deploy this publicly, do your own security review.
- If you fork this, feel free to simplify things. I did not optimize it for textbook purity.

Future notes live here:

- [docs/future-notes.md](docs/future-notes.md)
