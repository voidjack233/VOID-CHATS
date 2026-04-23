# VOID Frontend

This folder is the frontend for VOID.

If you are trying to understand or run the project, start here first:

- [../README.md](../README.md)
- [../docs/setup.md](../docs/setup.md)

Frontend-specific notes:

- [docs/project-flow-map.md](docs/project-flow-map.md)
- [docs/crypto-security-notes.md](docs/crypto-security-notes.md)
- [docs/secure-chat-recovery-limitations.md](docs/secure-chat-recovery-limitations.md)

Important honesty note:

- the current MLS / encrypted-chat path is built on `ts-mls`
- that upstream library is maintained by [`LukaJCB`](https://github.com/LukaJCB)
- upstream has already warned that it has not gone through a formal security audit yet

So this frontend should be described as:

- real
- working
- still being improved

but not:

- frontend for a formally audited messenger

Another security/recovery note:

- during login or explicit encrypted-chat recovery, the frontend may hold the raw account password in live JS memory briefly to finish password-derived key restore / backup work
- it is not intended to be persisted in normal browser storage
- current behavior aims to clear it after the immediate bootstrap pass, with a fallback max window of about 2 minutes

## Frontend Commands

```bash
npm install
npm run dev
```

```bash
npm run build
```
