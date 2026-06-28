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
- `VOID0000-api` account/control service
- `VOID0000-api` message service
- `VOID0000-api` social/profile service
- `VOID0000-api` conversation service
- `VOID0000-api` worker service
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

These are expected to be loopback-only. If `ss -tulpn` shows these app ports on
`0.0.0.0` or `*`, fix the service bind host or firewall before treating the box
as public.

- Frontend: `127.0.0.1:5173`
- Account/control API: `127.0.0.1:3001`
- Message service: `127.0.0.1:3002`
- Social/profile service: `127.0.0.1:3004`
- Conversation service: `127.0.0.1:3005`
- Gateway: `127.0.0.1:4001`
- PostgreSQL: `127.0.0.1:5432`
- ScyllaDB: `127.0.0.1:9042`
- Valkey: `127.0.0.1:6379`
- MinIO API: `127.0.0.1:9000`

Expected MinIO buckets:

- `avatars`
- `group-avatars`
- `chat-attachments`

For a host MinIO systemd service, the bind shape should look like this:

```text
minio server /path/to/minio-data --address "127.0.0.1:9000" --console-address "127.0.0.1:9001"
```

The console should not be public internet-facing. Keep it loopback-only and
reach it through SSH forwarding if you need it remotely.

## Basic Firewall

If this server is directly exposed to the internet through Nginx, keep the
public firewall boring:

- allow `22/tcp` for SSH
- allow `80/tcp` for HTTP
- allow `443/tcp` for HTTPS
- do not expose backend service ports like `3001`, `3002`, `3004`, `3005`,
  `4001`, `5432`, `6379`, `9000`, `9001`, or `9042`

Helper script:

```bash
sudo ./scripts/configure-firewall.sh
```

Preview first:

```bash
./scripts/configure-firewall.sh --dry-run
```

If you only use Cloudflared and do not accept direct public traffic, you may not
need to open `80/443` publicly. In that setup, Cloudflared reaches local Nginx
from inside the machine and the tunnel itself uses outbound connections.

Small future storage note:

- Hot storage means the live MinIO data folder the app reads/writes every day.
  For a better production box, point this at a mounted data drive like
  `/srv/voidapp/minio-data`, not a random folder inside the repo or OS home
  folder.
- Cold storage means backups/archive copies that are not used by the running
  app. This can be another disk, external drive, NAS, or another machine.
- Do not manually move old `chat-attachments` objects out of live MinIO unless
  the app has an archive/restore flow for them. The database still points at
  those objects, so moving them blindly will make old attachments fail to load.

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
- email 2FA code signing secret
- MinIO credentials
- Valkey connection info
- Phoenix secret key base
- frontend origin

The auth secrets are not decorative. If `ACCESS_SECRET`, `REFRESH_SECRET`, `CSRF_ENCRYPTION_KEY`, `TOTP_ENCRYPTION_KEY`, or `TWO_FACTOR_CODE_SECRET` are missing or still look like placeholders, the account service should fail during startup. That is intentional.

Valkey is part of the account-security path. Captcha challenges, trust scoring, rate limits, sessions/cache pieces, and realtime coordination all depend on it, so do not treat it as optional local fluff.

## 3. Frontend Env

The frontend should know the split local service ports when you run the backend manually.

```bash
cp VOID0000-www/.env.example VOID0000-www/.env.local
```

Expected local values:

```env
VITE_API_URL=http://localhost:3001
VITE_MESSAGE_API_URL=http://localhost:3002
VITE_SOCIAL_API_URL=http://localhost:3004
VITE_CONVERSATION_API_URL=http://localhost:3005
VITE_GATEWAY_URL=http://localhost:4001
CDN_URL=http://127.0.0.1:9000
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

## 5. Local Dev Setup

Expected local services:

- frontend: `http://localhost:5173`
- account/control API: `http://localhost:3001`
- message service: `http://localhost:3002`
- social/profile service: `http://localhost:3004`
- conversation service: `http://localhost:3005`
- gateway: `ws://localhost:4001`

If PM2 is already running the backend:

```bash
pm2 status
```

You should see:

```text
voidapp-api
voidapp-message-service
voidapp-conversation-service
voidapp-social-profile-service
voidapp-gateway-phoenix
voidapp-worker-service
```

Then start the frontend:

```bash
cd /path/to/VOIDAPP/VOID0000-www
npm run dev
```

Then open:

```text
http://localhost:5173
```

Vite proxies local requests:

- account/auth/general `/api` routes to `http://localhost:3001`
- message routes to `http://localhost:3002`
- social/profile/friends routes to `http://localhost:3004`
- conversation/group/MLS routes to `http://localhost:3005`
- `/gateway` to `ws://localhost:4001`

So local dev does not need the public domain.

### Start Every Service Manually

Use this if PM2 is not already running the backend.

Start the account/control API:

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run dev
```

Start the message service in another shell:

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run dev:messages
```

Start the social/profile service in another shell:

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run dev:social
```

Start the conversation service in another shell:

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run dev:conversations
```

Start the worker service in another shell:

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run dev:workers
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

Backend services:

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run start
```

In separate shells if you are not using PM2, run one command per shell:

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run start:messages
```

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run start:social
```

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run start:conversations
```

```bash
cd /path/to/VOIDAPP/VOID0000-api
npm run start:workers
```

Gateway:

```bash
cd /path/to/VOIDAPP/VOID0000-api/void_gateway
set -a
source ../.env
set +a
MIX_ENV=prod mix phx.server
```

## 7. Production Shape This Repo Expects

The recommended deployment shape is:

- `nginx`
  serves the built frontend and routes API/gateway/media paths to local services
- `cloudflared`
  or your normal TLS/proxy layer exposes public hostnames to Nginx
- `pm2`
  runs the split Node services, worker, and Phoenix gateway
- `systemd`
  keeps `cloudflared` and the backend process manager alive across boots

Very important:

- public users should hit Nginx or your tunnel, not raw backend ports
- PM2 binds the Node services and Phoenix gateway to `127.0.0.1` by default
- Docker binds published debug ports to `127.0.0.1` too
- if you intentionally expose raw ports, use a firewall and know exactly why

### What Serves What

- `your-domain.example`
  frontend static build through Nginx on `localhost:80`
- `www.your-domain.example`
  same frontend through Nginx on `localhost:80`
- `api.your-domain.example` account/auth/general API paths
  Nginx routes to account/control API on `127.0.0.1:3001`
- `api.your-domain.example` message/reaction/attachment paths
  Nginx routes to message service on `127.0.0.1:3002`
- `api.your-domain.example` friends/profile/search paths
  Nginx routes to social/profile service on `127.0.0.1:3004`
- `api.your-domain.example` conversation/group/MLS paths
  Nginx routes to conversation service on `127.0.0.1:3005`
- `api.your-domain.example/gateway`
  Nginx routes to Phoenix websocket gateway on `127.0.0.1:4001`
- `cdn.your-domain.example`
  Nginx routes public avatar reads to MinIO on `127.0.0.1:9000`

Chat attachments are different. They live in the private `chat-attachments`
bucket and are downloaded through authenticated API paths under
`/api/conversations/:id/attachments/...`.

Reference router config:

- [nginx-router.example.conf](./nginx-router.example.conf)

That file uses fake domains on purpose. Replace `your-domain.example`,
`api.your-domain.example`, `cdn.your-domain.example`, and the frontend build
path with your own values.

### Nginx Frontend Example

Example file:

- `/etc/nginx/sites-available/your-domain.example`

Example content:

```nginx
server {
    listen 80;
    server_name www.your-domain.example;

    return 301 https://your-domain.example$request_uri;
}

server {
    listen 80;
    server_name your-domain.example;
    
    root /var/www/your-frontend-build;
    index index.html;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://cdn.your-domain.example; font-src 'self' data:; connect-src 'self' https://api.your-domain.example wss://api.your-domain.example https://cdn.your-domain.example; media-src 'self' data: blob: https://cdn.your-domain.example; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), autoplay=(self), fullscreen=(self)" always;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://cdn.your-domain.example; font-src 'self' data:; connect-src 'self' https://api.your-domain.example wss://api.your-domain.example https://cdn.your-domain.example; media-src 'self' data: blob: https://cdn.your-domain.example; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests" always;
        add_header X-Frame-Options "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Permissions-Policy "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), autoplay=(self), fullscreen=(self)" always;
    }
}
```

So the simple frontend-only reading is:

- Nginx serves frontend files only
- Nginx does not proxy `/api`
- Nginx does not proxy `/gateway`

For the full split backend, use the router config above instead of this
frontend-only config.

### Public Tunnel Or TLS Proxy

Cloudflared, Caddy, a VPS load balancer, or any other public TLS layer should
route public hostnames to Nginx where possible.

Recommended shape:

- frontend host -> Nginx
- API host -> Nginx
- CDN host -> Nginx
- Nginx -> loopback backend ports

If you choose to route Cloudflared directly to each backend service instead,
target loopback URLs like `http://127.0.0.1:3001`, not public interfaces. That
still works, but it spreads routing rules across more places and is easier to
misconfigure.

That is why the Nginx router config keeps all the path splitting in one file.
It is less magical and easier to review later.

The path split roughly follows the Vite dev proxy:

- `/api/conversations/:id/messages`, `/api/conversations/:id/reactions`, `/api/conversations/:id/attachments` -> message service `3002`
- `/api/friends`, `/api/users/search`, `/api/users/profile`, profile reads -> social/profile service `3004`
- `/api/bootstrap`, `/api/conversations`, conversation members, invites, MLS, keys -> conversation service `3005`
- `/api/auth`, `/api/me`, `/api/csrf`, `/api/captcha`, account/session/preference routes -> account/control service `3001`
- `/gateway` -> Phoenix gateway `4001`

### Frontend Build Deployment

A simple production frontend path is:

- `/var/www/void0000-www`

Use a different path if your server layout is different.

Build and copy the frontend like this:

```bash
cd /path/to/VOIDAPP/VOID0000-www
npm run build
rsync -av --delete dist/ /var/www/void0000-www/
```

Reference files copied from this shape:

- [nginx-router.example.conf](./nginx-router.example.conf)
- [nginx-frontend-only.example.conf](./nginx-frontend-only.example.conf)
- [backups.md](./backups.md)

Cloudflared is intentionally described in prose here instead of a copy-paste
example file. You need to wire your own tunnel, hostnames, and local Nginx
service to match your machine.

### Matching Env Values

For the split-service production shape, the important values look roughly like this:

Backend `.env`:

```env
FRONT_URL=https://your-domain.example
PORT=3001
BIND_HOST=127.0.0.1
MESSAGE_SERVICE_PORT=3002
SOCIAL_SERVICE_PORT=3004
CONVERSATION_SERVICE_PORT=3005
GATEWAY_PORT=4001
GATEWAY_HOST=127.0.0.1
CDN_URL=https://cdn.your-domain.example
```

Frontend production env:

```env
VITE_API_URL=https://api.your-domain.example
VITE_GATEWAY_URL=https://api.your-domain.example
CDN_URL=https://cdn.your-domain.example
```

In production, the frontend still points at one API hostname. Your reverse proxy or tunnel has to route paths on that hostname to the correct backend service.

### Backend Process Startup

A PM2/systemd deployment can use these process-management layers:

- PM2 app config: `VOID0000-api/ecosystem.config.cjs`
- gateway launcher: `VOID0000-api/startup/run-phoenix-gateway.sh`
- PM2 systemd unit: `pm2-void0000.service`
- backend wrapper systemd unit: `voidapp-backend.service`
- cloudflared systemd unit: `cloudflared.service`

Process names under PM2:

- `voidapp-api`
- `voidapp-message-service`
- `voidapp-conversation-service`
- `voidapp-social-profile-service`
- `voidapp-gateway-phoenix`
- `voidapp-worker-service`

With the wrapper unit, the practical restart path is:

```bash
sudo systemctl restart voidapp-backend.service
sudo systemctl restart cloudflared.service
```

If you are using PM2 directly as the app user:

```bash
cd /path/to/VOIDAPP/VOID0000-api
pm2 restart voidapp-api
pm2 restart voidapp-message-service
pm2 restart voidapp-conversation-service
pm2 restart voidapp-social-profile-service
pm2 restart voidapp-gateway-phoenix
pm2 restart voidapp-worker-service
```

### Domain Assumptions

This repo still has project-domain assumptions baked into code.

If you deploy under a different domain, you will need to change them.

Important files:

- `docs/nginx-frontend-only.example.conf`
  redirects the `www` host to the apex host and sets frontend security headers
- `VOID0000-api/server/utils/cookieConfig.js`
  sets a project-specific cookie domain in production
- `VOID0000-api/server/middleware/xss/csp.js`
  includes project-specific API/CDN hosts in CSP defaults

So the honest answer is:

- yes, this project can be deployed elsewhere
- no, it is not domain-agnostic yet
- if you fork it under another domain, change those files before calling the setup done

## Known Setup Notes

- The MLS / encrypted-chat path depends on `ts-mls`, which upstream says is not formally audited.
- Recovery keys are available, but users still need to save the key. Forgot-password recovery without an existing recovery key can still be painful on a fresh device.
- Presence and full friend-list traffic use separate endpoints and separate rate-limit buckets.

If you want the higher-level explanation of how the project fits together, read:

- [../README.md](../README.md)
- [../VOID0000-www/docs/project-flow-map.md](../VOID0000-www/docs/project-flow-map.md)
