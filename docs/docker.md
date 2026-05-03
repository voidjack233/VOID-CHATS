# Docker Dev Setup

This is the first Docker setup for this repo. Treat it as local-dev help, not
some polished production container story.

It starts:

- frontend on `http://localhost:5173`
- account/control API on `http://localhost:3001`
- message service on `http://localhost:3002`
- social/profile service on `http://localhost:3004`
- conversation service on `http://localhost:3005`
- gateway on `ws://localhost:4001`
- worker service inside the Docker network
- MinIO on `http://localhost:9000`
- MinIO console on `http://localhost:9001`
- Postgres, Valkey, and Scylla inside the Docker network

The database ports are not published to the host on purpose. That avoids
fighting with native Postgres / Valkey / Scylla installs already running on the
machine.

## Start It

From the repo root:

```bash
docker compose up --build
```

Then open:

```text
http://localhost:5173
```

The first run can take a while because Scylla is heavy and the Node images have
native packages to install.

If your normal local dev or PM2 setup is already using those ports, you can run
the Docker stack on throwaway host ports:

```bash
HOST_FRONTEND_PORT=15173 \
HOST_API_PORT=13001 \
HOST_MESSAGE_API_PORT=13002 \
HOST_SOCIAL_API_PORT=13004 \
HOST_CONVERSATION_API_PORT=13005 \
HOST_GATEWAY_PORT=14001 \
HOST_MINIO_API_PORT=19000 \
HOST_MINIO_CONSOLE_PORT=19001 \
FRONT_URL=http://localhost:15173 \
CDN_URL=http://localhost:19000 \
docker compose up --build
```

Then open:

```text
http://localhost:15173
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
curl http://localhost:3001/ready
curl http://localhost:3002/ready
curl http://localhost:3004/ready
curl http://localhost:3005/ready
curl http://localhost:4001/ready
```

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
