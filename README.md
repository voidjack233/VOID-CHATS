# VOID-CHATS

Private monorepo for the full VOID chat stack.

## What lives here

- `VOID0000-www`
  Frontend app built with React, TypeScript, and Vite.
- `VOID0000-api`
  Express API, PostgreSQL migrations, Scylla message storage, and MinIO-backed media routes.
- `VOID0000-api/void_gateway`
  Phoenix WebSocket gateway for realtime presence and chat fanout.
- `minio-data`
  Local MinIO storage data for development.

## Quick start

1. Install dependencies.
2. Bring up PostgreSQL, ScyllaDB, Valkey, and MinIO.
3. Copy the backend env example and fill in real secrets.
4. Run database migrations.
5. Start the API, gateway, and frontend.

See [docs/setup.md](docs/setup.md) for the full setup flow.

## Repo layout

```text
VOIDAPP/
├── VOID0000-api/
│   ├── db/
│   ├── scripts/
│   ├── server/
│   └── void_gateway/
├── VOID0000-www/
├── VoidCONF/
└── minio-data/
```

## Development commands

Frontend:

```bash
cd VOID0000-www
npm install
npm run dev
```

API:

```bash
cd VOID0000-api
npm install
npm run migrate
npm run dev
```

Gateway:

```bash
cd VOID0000-api/void_gateway
mix deps.get
mix phx.server
```

## Notes

- The current MLS path uses `ts-mls` and should not be described as formally audited yet.
- Secure chat recovery after forgot-password on a fresh device is still a known limitation. See [VOID0000-www/docs/secure-chat-recovery-limitations.md](VOID0000-www/docs/secure-chat-recovery-limitations.md).
- The frontend has additional flow and crypto notes in:
  - [VOID0000-www/docs/project-flow-map.md](VOID0000-www/docs/project-flow-map.md)
  - [VOID0000-www/docs/crypto-security-notes.md](VOID0000-www/docs/crypto-security-notes.md)
