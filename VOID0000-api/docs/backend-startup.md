# Backend Startup Overview

This note explains how the current `VOID0000-api` backend starts up on a machine.

It covers:

- the Node API services
- the Phoenix websocket gateway
- Postgres
- Valkey
- ScyllaDB
- MinIO
- PM2 startup behavior

## Big Picture

The backend is not one single process.

At runtime it is split into:

- `voidapp-api`
  - account/control API
  - runs from `server/entrypoints/account-server.js`
  - default port: `3001`
- `voidapp-message-service`
  - messages, reactions, and attachment uploads
  - runs from `server/entrypoints/message-server.js`
  - default port: `3002`
- `voidapp-social-profile-service`
  - profiles, friends, and user search
  - runs from `server/entrypoints/social-server.js`
  - default port: `3004`
- `voidapp-conversation-service`
  - conversations, groups, members, invites, and MLS metadata
  - runs from `server/entrypoints/conversation-server.js`
  - default port: `3005`
- `voidapp-gateway-phoenix`
  - Phoenix websocket gateway
  - runs from `startup/run-phoenix-gateway.sh`
  - default port: `4001`
- `voidapp-worker-service`
  - image jobs, cleanup, and presence fanout
  - runs from `server/entrypoints/worker-server.js`

PM2 manages those app processes.

PM2 does **not** start the databases or object storage for you.

For the normal PM2 deployment, the app services bind to `127.0.0.1` through
`ecosystem.config.cjs`. Public traffic should reach them through Nginx,
Cloudflared, or another trusted local reverse proxy, not by exposing raw Node or
Phoenix ports directly.

Those services must already exist and be reachable:

- Postgres
- Valkey
- ScyllaDB
- MinIO

Before starting the app processes, run:

- `npm run migrate`

That migration command now covers:

- core user / auth / security tables
- conversation tables
- MLS tables

## Main Startup Files

Main runtime files:

- `ecosystem.config.cjs`
- `server/entrypoints/account-server.js`
- `server/entrypoints/message-server.js`
- `server/entrypoints/social-server.js`
- `server/entrypoints/conversation-server.js`
- `server/entrypoints/worker-server.js`
- `server/config.json`
- `startup/run-phoenix-gateway.sh`
- `void_gateway/config/runtime.exs`

Service connection files:

- `server/db.js`
- `server/valkey.js`
- `server/valkey-pubsub.js`
- `server/scylla.js`
- `server/minio.js`

## How PM2 Starts The Backend

PM2 reads:

- `ecosystem.config.cjs`

That file defines the backend apps:

1. `voidapp-api`
   - script: `server/entrypoints/account-server.js`
2. `voidapp-message-service`
   - script: `server/entrypoints/message-server.js`
3. `voidapp-conversation-service`
   - script: `server/entrypoints/conversation-server.js`
4. `voidapp-social-profile-service`
   - script: `server/entrypoints/social-server.js`
5. `voidapp-gateway-phoenix`
   - script: `startup/run-phoenix-gateway.sh`
6. `voidapp-worker-service`
   - script: `server/entrypoints/worker-server.js`

`server/config.json` controls:

- whether Node clustering is enabled
- which gateway mode is expected

Current expectation:

- `gateway.mode` must be `"phoenix"`

If it is not, the backend intentionally fails fast.

## Node API Startup Flow

Account/control entry:

- `server/entrypoints/account-server.js`

Startup sequence:

1. Load `.env`
2. Build the Express app
3. Register account, auth, security, preferences, CSRF, and captcha routes
4. Start the HTTP server on `HOST:PORT`

Host/port env:

- `PORT` / service-specific port env, such as `MESSAGE_SERVICE_PORT` and `CONVERSATION_SERVICE_PORT`
- `HOST` or `BIND_HOST`

Default manual bind is `0.0.0.0` for compatibility, but the PM2 config sets
`HOST=127.0.0.1` for the host deployment.

Important detail:

The Node API does **not** run the websocket server itself anymore.

The Node service set:

- serves REST/API routes across the account, message, social, and conversation services
- publishes realtime events into Valkey where needed
- runs background cleanup, image processing, and presence fanout in `voidapp-worker-service`

So seeing `phoenix gateway mode` in Node logs means:

- Node knows Phoenix is the active gateway mode
- not that Node itself is serving websocket traffic

## Phoenix Gateway Startup Flow

Entry:

- `startup/run-phoenix-gateway.sh`

That launcher:

1. resolves the repo root
2. loads `.env`
3. exports `MIX_ENV`
4. exports `GATEWAY_PORT` if needed
5. changes directory into `void_gateway`
6. runs `mix phx.server`

Phoenix runtime config lives in:

- `void_gateway/config/runtime.exs`

Important env used there:

- `PHX_SECRET_KEY_BASE`
- `ACCESS_SECRET`
- `VALKEY_HOST`
- `VALKEY_PORT`
- `GATEWAY_PORT`
- `GATEWAY_HOST` or `BIND_HOST`
- `FRONT_URL`

Phoenix serves the websocket gateway on:

- `GATEWAY_HOST:GATEWAY_PORT`

The default manual bind is `0.0.0.0:4001`, but the PM2 config sets
`GATEWAY_HOST=127.0.0.1`.

## Required Service Dependencies

These services are part of the backend runtime story.

### 1. Postgres

Used by:

- main relational app data
- auth/session-related data
- user and conversation metadata

Connection file:

- `server/db.js`

Important env:

- `PGHOST`
- `PGUSER`
- `PGDATABASE`
- `PGPASSWORD`
- `PGPORT`

Expected default port:

- `5432`

### 2. Valkey

Used by:

- realtime event pub/sub
- Phoenix session buffer/resume state
- presence snapshots
- internal gateway coordination

Connection files:

- `server/valkey.js`
- `server/valkey-pubsub.js`
- Phoenix also connects directly from `void_gateway`

Important env:

- `VALKEY_HOST`
- `VALKEY_PORT`

Expected default port:

- `6379`

Important detail:

If Valkey is down:

- the API may still boot partially
- but realtime fanout, gateway commands, resume buffering, and presence behavior will break

### 3. ScyllaDB

Used by:

- message storage / high-volume conversation data paths
- time-ordered message operations

Connection file:

- `server/scylla.js`

Important env:

- `SCYLLA_HOST`

Expected default port:

- `9042`

Startup behavior:

- the client connects on module load
- success logs `✅ ScyllaDB connected`
- failure logs `❌ ScyllaDB connection error`

Important detail:

PM2 does not manage Scylla.

It must already be running as:

- a system service
- a container
- or another separately managed process

### 4. MinIO

Used by:

- user avatars
- group avatars
- chat attachments

Connection file:

- `server/minio.js`

Important env:

- `MINIO_ENDPOINT`
- `MINIO_PORT`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_BUCKET`
- `MINIO_GROUP_AVATAR_BUCKET`
- `MINIO_ATTACH_BUCKET`

Expected default port:

- `9000`

Startup behavior:

On startup, the backend tries to:

1. ensure the required buckets exist
2. apply public read policy to avatar buckets
3. clear public read policy from the chat attachment bucket

Expected buckets:

- avatars
- group-avatars
- chat-attachments

Success logs look like:

- `MinIO bucket 'avatars' public read policy set`
- `MinIO bucket 'chat-attachments' private policy set`
- `MinIO connected`

Important detail:

PM2 does not manage MinIO.

It must already be running before the app expects uploads and object URLs to work.

Attachment privacy split:

- avatars and group avatars are public by nature
- new chat attachments are encrypted client-side and downloaded through an
  authenticated API route
- old encrypted attachment URLs can still be served through a compatibility
  API path after membership checks, because their original public object names
  were already stored inside encrypted message payloads

## Recommended Service Startup Order

When bringing up a fresh machine, the safest order is:

1. Postgres
2. Valkey
3. ScyllaDB
4. MinIO
5. `pm2 start ecosystem.config.cjs --update-env`

That avoids noisy boot errors from missing dependencies.

## Recommended PM2 Commands

From the backend repo:

```bash
cd ~/Desktop/VOIDAPP/VOID0000-api
pm2 start ecosystem.config.cjs --update-env
```

Check status:

```bash
pm2 ls
```

Expected apps:

- `voidapp-api`
- `voidapp-message-service`
- `voidapp-conversation-service`
- `voidapp-social-profile-service`
- `voidapp-gateway-phoenix`
- `voidapp-worker-service`

Useful logs:

```bash
pm2 logs voidapp-api
pm2 logs voidapp-message-service
pm2 logs voidapp-conversation-service
pm2 logs voidapp-social-profile-service
pm2 logs voidapp-gateway-phoenix
pm2 logs voidapp-worker-service
```

## Saving Startup State For Reboot

After the app list is correct:

```bash
pm2 save
```

That writes the PM2 process dump.

To make PM2 restore apps on machine boot, run the one-time startup command PM2 prints on your machine, usually something like:

```bash
sudo env PATH=$PATH:/home/<user>/.nvm/versions/node/<version>/bin /home/<user>/.nvm/versions/node/<version>/lib/node_modules/pm2/bin/pm2 startup systemd -u <user> --hp /home/<user>
```

Important detail:

- `pm2 save` stores the current app list
- `pm2 startup ...` installs the system boot integration

You generally need both.

## Health Checks

Account/control API:

```bash
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/ready
```

Message service:

```bash
curl http://127.0.0.1:3002/ready
```

Social/profile service:

```bash
curl http://127.0.0.1:3004/ready
```

Conversation service:

```bash
curl http://127.0.0.1:3005/ready
```

Phoenix gateway health:

```bash
curl http://127.0.0.1:4001/health
curl http://127.0.0.1:4001/ready
```

Expected:

- Node reports websocket mode as `phoenix`
- Phoenix returns `{"status":"ok", ...}`

## Migration To Another Device

For another machine, the backend startup recipe is:

1. clone the repo
2. create `.env`
3. install Node dependencies
4. install Erlang/Elixir for Phoenix
5. make sure Postgres, Valkey, ScyllaDB, and MinIO are running
6. start PM2 with `ecosystem.config.cjs`
7. run `pm2 save`
8. install PM2 startup service if you want auto-start on reboot

## Practical Rule

The app processes are:

- Node account/control service
- Node message service
- Node social/profile service
- Node conversation service
- Node worker service
- Phoenix gateway

The infrastructure services are:

- Postgres
- Valkey
- ScyllaDB
- MinIO

If the app boots but behavior is strange, check the infrastructure services first before assuming PM2 or the API code is wrong.
