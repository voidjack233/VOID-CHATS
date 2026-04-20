# Setup

This setup guide is written for the way this project was actually built:

- Linux
- local infra
- multiple services
- some manual wiring

If you are on Windows or macOS, I am not going to pretend this doc was tested there. Some parts may still work, but Linux is the only setup path I can honestly stand behind right now.

## What You Need

App services:

- `VOID0000-www`
- `VOID0000-api`
- `VOID0000-api/void_gateway`

Supporting services:

- PostgreSQL
- ScyllaDB
- Valkey
- MinIO

Tooling:

- Node.js 20+
- npm
- Elixir 1.16+
- Erlang/OTP compatible with your Elixir install

## Expected Local Ports

- Frontend: `127.0.0.1:5173`
- API: `127.0.0.1:3001`
- Gateway: `127.0.0.1:4001`
- PostgreSQL: `127.0.0.1:5432`
- ScyllaDB: `127.0.0.1:9042`
- Valkey: `127.0.0.1:6379`
- MinIO API: `127.0.0.1:9000`

Expected MinIO buckets:

- `avatars`
- `group-avatars`
- `chat-attachments`

## 1. Install Dependencies

Frontend:

```bash
cd /path/to/VOIDAPP/VOID0000-www
npm install
```

API:

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm install
```

Gateway:

```bash
cd /path/to/VOIDAPP/VOID0000-api/void_gateway
mix deps.get
```

## 2. Create The Backend Env File

The backend env file is the important one.

```bash
cd /path/to/VOIDAPP
cp VOID0000-api/.env.example VOID0000-api/.env
```

Fill in the real values before starting anything.

Important values include:

- PostgreSQL connection info
- JWT secrets
- CSRF encryption key
- TOTP encryption key
- MinIO credentials
- Phoenix secret key base
- frontend origin

## 3. Frontend Env

The frontend can usually run in local dev without its own env file because it falls back to localhost defaults in development.

If you still want an explicit frontend env:

```bash
cp VOID0000-www/.env.example VOID0000-www/.env.local
```

## 4. Run Database Migrations

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run migrate
```

Migration status:

```bash
npm run migrate:status
```

## 5. Start The Stack

Start the API:

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run dev
```

Start the gateway in another shell:

```bash
cd /path/to/VOIDAPP/VOID0000-api/void_gateway
set -a
source ../.env
set +a
mix phx.server
```

Start the frontend in another shell:

```bash
cd /path/to/VOIDAPP/VOID0000-www
npm run dev
```

## 6. Production-ish Commands

Frontend build:

```bash
cd /path/to/VOIDAPP/VOID0000-www
npm run build
```

API:

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run start
```

Gateway:

```bash
cd /path/to/VOIDAPP/VOID0000-api/void_gateway
set -a
source ../.env
set +a
MIX_ENV=prod mix phx.server
```

## Known Setup Notes

- This repo is not Docker-first yet.
- The secure chat path depends on `ts-mls`, which upstream says is not formally audited.
- Forgot-password chat recovery on a fresh device is still a known limitation.
- Presence and full friend-list traffic use separate endpoints and separate rate-limit buckets.

If you want the higher-level explanation of how the project fits together, read:

- [../README.md](../README.md)
- [../VOID0000-www/docs/project-flow-map.md](../VOID0000-www/docs/project-flow-map.md)
