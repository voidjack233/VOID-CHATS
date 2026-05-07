# VOID Frontend

This folder is the frontend for VOID.

If you are trying to understand or run the project, start here first:

- [../README.md](../README.md)
- [../docs/setup.md](../docs/setup.md)

Frontend-specific notes:

- [docs/project-flow-map.md](docs/project-flow-map.md)
- [docs/secure-chat-recovery-limitations.md](docs/secure-chat-recovery-limitations.md)

Important note:

- the current MLS / encrypted-chat path is built on a vendored `ts-mls` `1.6.2` copy in `vendor/ts-mls`
- that upstream library is maintained by [`LukaJCB`](https://github.com/LukaJCB)
- upstream has already warned that it has not gone through a formal security audit yet
- vendoring is intentional so npm or upstream changes do not silently alter the MLS layer
- this frontend should not be described as part of a formally audited messenger

Another security/recovery note:

- recovery keys now exist and are the preferred fresh-device recovery path after setup
- during login or legacy encrypted-chat recovery, the frontend may hold the raw account password in live JS memory briefly to finish password-derived key restore / backup work
- it is not intended to be persisted in normal browser storage
- current behavior aims to clear it after the immediate bootstrap pass, with a fallback max window of about 2 minutes
- the current browser may keep the recovery key in an encrypted local browser record so it can refresh recovery-key backups later

Known ugly encrypted-chat edge while this is still new:

- the DM key-version path has already had one nasty bug where a repair / re-bootstrap could keep using `key_version = 1`
- that path now bumps to newer versions, but encrypted chat recovery is still young and should be tested like it can break
- if a device does not have the exact key that encrypted a message, that message can stay stuck as encrypted text on that device
- the server cannot decrypt it for us, which is the point of E2EE but still painful when recovery data is wrong
- do not treat the current encrypted-chat path as battle-tested yet, especially across multiple devices

Multi-service dev note:

- in development, Vite proxies message, conversation, social/profile, account, and gateway paths to different local services
- in production, the frontend still points at one API hostname, so the deploy tunnel/reverse proxy must split those paths correctly

## Frontend Commands

```bash
npm install
npm run dev
```

```bash
npm run build
```
