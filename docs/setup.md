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

## 5. Local Dev Setup

Expected local services:

- frontend: `http://localhost:5173`
- API: `http://localhost:3001`
- gateway: `ws://localhost:4001`

If PM2 is already running the backend:

```bash
pm2 status
```

You should see:

```text
voidapp-api
voidapp-gateway-phoenix
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

- `/api` to `http://localhost:3001`
- `/gateway` to `ws://localhost:4001`

So local dev does not need the public domain.

### Start Every Service Manually

Use this if PM2 is not already running the backend.

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

## 7. Production Shape This Repo Actually Uses

The real deployment shape is:

- `nginx`
  serves only the built frontend on port `80`
- `cloudflared`
  exposes the public hostnames and routes them to the right local service
- `pm2`
  runs the Node API and Phoenix gateway
- `systemd`
  keeps `cloudflared` and the backend process manager alive across boots

Very important:

- if you look in Nginx, you will **not** see `/gateway`
- that route is handled by `cloudflared`, not by Nginx

### What Serves What

- `your-domain.example`
  frontend static build through Nginx on `localhost:80`
- `www.your-domain.example`
  same frontend through Nginx on `localhost:80`
- `api.your-domain.example`
  Node API on `localhost:3001`
- `api.your-domain.example/gateway`
  Phoenix websocket gateway on `localhost:4001`
- `cdn.your-domain.example`
  MinIO on `localhost:9000`

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
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), autoplay=(self), fullscreen=(self)" always;

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
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), autoplay=(self), fullscreen=(self)" always;
    }
}
```

So the honest reading is:

- Nginx serves frontend files only
- Nginx does not proxy `/api`
- Nginx does not proxy `/gateway`

### Cloudflared Routing

Cloudflared is the thing routing public hostnames to the local services.

The live shape on this machine is:

- frontend host -> `localhost:80`
- `www` host -> `localhost:80`
- API host -> `localhost:3001`
- API host with `/gateway` path -> `localhost:4001`
- CDN host -> `localhost:9000`

That is why:

- `/gateway` shows up in Cloudflared routing
- not in Nginx
- and `api.your-domain.example` is split by path between Phoenix and Node

### Frontend Build Deployment

The current machine serves the frontend from:

- `/var/www/void0000-www`

If you deploy this somewhere else, use your own frontend build path instead.

The usual update flow is:

```bash
cd /path/to/VOIDAPP/VOID0000-www
npm run build
rsync -av --delete dist/ /var/www/void0000-www/
```

Reference files copied from this shape:

- [nginx-frontend-only.example.conf](./nginx-frontend-only.example.conf)

Cloudflared is intentionally described in prose here instead of a copy-paste example file.
You need to wire your own tunnel, hostnames, and local services to match your machine.

### Matching Env Values

For the current live shape, the important values look roughly like this:

Backend `.env`:

```env
FRONT_URL=https://your-domain.example
PORT=3001
GATEWAY_PORT=4001
CDN_URL=https://cdn.your-domain.example
```

Frontend production env:

```env
VITE_API_URL=https://api.your-domain.example
VITE_GATEWAY_URL=https://api.your-domain.example
CDN_URL=https://cdn.your-domain.example
```

### Backend Process Startup

The current machine has both of these process-management layers:

- PM2 app config: `VOID0000-api/ecosystem.config.cjs`
- gateway launcher: `VOID0000-api/startup/run-phoenix-gateway.sh`
- PM2 systemd unit: `pm2-void0000.service`
- backend wrapper systemd unit: `voidapp-backend.service`
- cloudflared systemd unit: `cloudflared.service`

Current process names under PM2:

- `voidapp-api`
- `voidapp-gateway-phoenix`

That means the practical restart path on this machine is closer to:

```bash
sudo systemctl restart voidapp-backend.service
sudo systemctl restart cloudflared.service
```

If you are using PM2 directly as the app user:

```bash
cd /path/to/VOIDAPP/VOID0000-api
pm2 restart voidapp-api
pm2 restart voidapp-gateway-phoenix
```

### Current Domain Assumptions

This repo still has project-domain assumptions baked into code.

If you deploy under a different domain, you will need to change them.

Important files:

- `docs/nginx-frontend-only.example.conf`
  redirects the `www` host to the apex host and sets frontend security headers
- `VOID0000-api/server/utils/cookieConfig.js`
  currently sets a project-specific cookie domain in production
- `VOID0000-api/server/middleware/xss/csp.js`
  currently includes project-specific API/CDN hosts in CSP defaults

So the honest answer is:

- yes, this project can be deployed elsewhere
- no, it is not domain-agnostic yet
- if you fork it under another domain, patch those files before calling the setup done

## Known Setup Notes

- The MLS / encrypted-chat path depends on `ts-mls`, which upstream says is not formally audited.
- Forgot-password chat recovery on a fresh device is still a known limitation.
- Presence and full friend-list traffic use separate endpoints and separate rate-limit buckets.

If you want the higher-level explanation of how the project fits together, read:

- [../README.md](../README.md)
- [../VOID0000-www/docs/project-flow-map.md](../VOID0000-www/docs/project-flow-map.md)
