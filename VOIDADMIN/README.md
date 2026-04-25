# VOIDADMIN

Small standalone admin panel for:

- `users`
- `ip_security_logs`

It is intentionally simple:

- basic auth in front of the whole app
- no frontend build step
- plain HTML/CSS/JS
- direct PostgreSQL access
- quick user actions for email, password, and verification state

## Setup

Default behavior:

- reuses the PostgreSQL env from `VOID0000-api/.env`
- runs on `127.0.0.1:4310`
- uses default admin login:
  - username: `admin`
  - password: `admin`

Start the panel:

```bash
npm install
npm start
```

Default local URL:

```text
http://127.0.0.1:4310
```

## Notes

- This app is meant for private/internal use.
- It can update user email, password, and verification state.
- If you want different credentials or port, create a local `.env` in `VOIDADMIN/`.
- If you expose it beyond localhost, put it behind HTTPS and an extra network restriction if possible.

- This only work in Linux setup not tested yet in docker
