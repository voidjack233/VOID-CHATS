# Setup

This repo runs as three app services plus four supporting services:

- Frontend: `VOID0000-www`
- API: `VOID0000-api`
- Gateway: `VOID0000-api/void_gateway`
- PostgreSQL
- ScyllaDB
- Valkey
- MinIO

## Prerequisites

- Node.js 20+
- npm
- PostgreSQL
- ScyllaDB
- Valkey or Redis-compatible server
- MinIO
- Elixir 1.16+
- Erlang/OTP compatible with your Elixir install

## 1. Install app dependencies

Root:

```bash
cd /path/to/VOIDAPP
npm install
```

API:

```bash
cd VOID0000-api
npm install
```

Frontend:

```bash
cd VOID0000-www
npm install
```

Gateway:

```bash
cd VOID0000-api/void_gateway
mix deps.get
```

## 2. Prepare supporting services

Expected local defaults:

- PostgreSQL: `127.0.0.1:5432`
- ScyllaDB: `127.0.0.1:9042`
- Valkey: `127.0.0.1:6379`
- MinIO API: `127.0.0.1:9000`
- Gateway: `127.0.0.1:4001`
- API: `127.0.0.1:3001`
- Frontend: `127.0.0.1:5173`

MinIO buckets expected by the app:

- `avatars`
- `group-avatars`
- `chat-attachments`

## 3. Create backend env

Copy the example file:

```bash
cd /path/to/VOIDAPP
cp VOID0000-api/.env.example VOID0000-api/.env
```

Fill in real values before running the app.

Important values:

- PostgreSQL connection
- access and refresh JWT secrets
- CSRF encryption key
- TOTP encryption key
- MinIO credentials
- Phoenix secret key base
- frontend origin

## 4. Optional frontend env

For local development, the frontend can usually run without an env file because it falls back to localhost defaults in dev mode.

If you want explicit values, create:

```bash
cp VOID0000-www/.env.example VOID0000-www/.env.local
```

## 5. Run migrations

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run migrate
```

You can inspect status with:

```bash
npm run migrate:status
```

## 6. Start the stack

Start the API:

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run dev
```

Start the gateway in a second shell:

```bash
cd /path/to/VOIDAPP/VOID0000-api/void_gateway
set -a
source ../.env
set +a
mix phx.server
```

Start the frontend in a third shell:

```bash
cd /path/to/VOIDAPP/VOID0000-www
npm run dev
```

## 7. Production build

Frontend:

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

## 8. Known setup notes

- The secure chat path currently depends on `ts-mls`, which upstream has not formally audited yet.
- Forgot-password chat recovery on a fresh device is still a known limitation.
- Presence and full friend-list traffic use separate endpoints and separate rate-limit buckets.
