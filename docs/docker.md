# Docker Dev Setup

This is the first Docker setup for this repo. Treat it as local-dev help, not
some polished production container story.

It starts:

- Nginx edge/router on `http://localhost:8080`
- frontend dev server on `http://localhost:5173` for direct debugging
- account/control API on `http://localhost:3001`
- message service on `http://localhost:3002`
- social/profile service on `http://localhost:3004`
- conversation service on `http://localhost:3005`
- gateway on `ws://localhost:4001`
- worker service inside the Docker network
- MinIO on `http://localhost:9000`
- MinIO console on `http://localhost:9001`
- Postgres, Valkey, and Scylla inside the Docker network

Published Docker ports bind to `127.0.0.1` on purpose. This keeps local dev easy
without advertising the raw backend, gateway, or MinIO ports to the whole LAN.
The database ports are not published to the host at all, so they also avoid
fighting with native Postgres / Valkey / Scylla installs already running on the
machine.

## Start It

From the repo root:

```bash
docker compose up --build
```

Then open:

```text
http://localhost:8080
```

The Docker Nginx edge is the normal local entrypoint. It routes:

- `/` to the frontend dev server
- account/control routes to `api:3001`
- message, reaction, and attachment routes to `message-api:3002`
- friends/profile routes to `social-api:3004`
- conversation/group/MLS routes to `conversation-api:3005`
- `/gateway` to the Phoenix gateway on `gateway:4001`
- public avatar bucket paths to MinIO
- private chat attachment downloads to the message API

You can still open `http://localhost:5173` if you specifically want to bypass
the Docker Nginx edge and use Vite's dev proxy directly.

The first run can take a while because Scylla is heavy and the Node images have
native packages to install.

If your normal local dev or PM2 setup is already using those ports, you can run
the Docker stack on throwaway host ports:

```bash
HOST_EDGE_PORT=18080 \
HOST_FRONTEND_PORT=15173 \
HOST_API_PORT=13001 \
HOST_MESSAGE_API_PORT=13002 \
HOST_SOCIAL_API_PORT=13004 \
HOST_CONVERSATION_API_PORT=13005 \
HOST_GATEWAY_PORT=14001 \
HOST_MINIO_API_PORT=19000 \
HOST_MINIO_CONSOLE_PORT=19001 \
FRONT_URL=http://localhost:18080 \
CDN_URL=http://localhost:18080 \
docker compose up --build
```

Then open:

```text
http://localhost:18080
```

If Docker says permission denied for `/var/run/docker.sock`, this Linux session
has not picked up Docker group access yet. Run this once, then open a new
terminal:

```bash
sudo usermod -aG docker "$USER"
```

Or for the current terminal only:

```bash
newgrp docker
```

## Stop It

```bash
docker compose down
```

If you want to wipe the Docker databases too:

```bash
docker compose down -v
```

## Env File

Docker uses:

```text
docker/dev.env
```

Those values are intentionally weak local-dev values. Do not use them for a real
deployment.

## Migrations

Compose runs `npm run migrate` once before the API starts.

To run it again manually:

```bash
docker compose run --rm migrate
```

To check status:

```bash
docker compose run --rm migrate npm run migrate:status
```

## Shells

API shell:

```bash
docker compose exec api sh
```

Frontend shell:

```bash
docker compose exec frontend sh
```

Gateway shell:

```bash
docker compose exec gateway sh
```

Message service shell:

```bash
docker compose exec message-api sh
```

Conversation service shell:

```bash
docker compose exec conversation-api sh
```

Social service shell:

```bash
docker compose exec social-api sh
```

Worker shell:

```bash
docker compose exec worker sh
```

Postgres shell:

```bash
docker compose exec postgres psql -U postgres -d void-app
```

Scylla shell:

```bash
docker compose exec scylla cqlsh
```

## Service Checks

Quick health checks from the host:

```bash
curl http://localhost:8080/ready
curl http://localhost:3001/ready
curl http://localhost:3002/ready
curl http://localhost:3004/ready
curl http://localhost:3005/ready
curl http://localhost:4001/ready
```

The first check goes through Docker Nginx. The rest hit each service directly
through localhost-only debug ports and are useful when you are debugging the
split backend.

The worker has no HTTP port. Check it with:

```bash
docker compose logs worker
```

## Known Rough Edges

- This does not containerize the `VOIDADMIN` app yet.
- This does not replace the existing PM2 / Nginx / Cloudflared deployment docs.
- If PM2 or another local service is already using these ports, use the
  throwaway host port command above. No need to touch the running PM2 process
  just to test Docker.
