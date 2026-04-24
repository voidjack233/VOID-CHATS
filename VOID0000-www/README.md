# VOID Frontend

This folder is the frontend for VOID.

If you are trying to understand or run the project, start here first:

- [../README.md](../README.md)
- [../docs/setup.md](../docs/setup.md)

Frontend-specific notes:

- [docs/project-flow-map.md](docs/project-flow-map.md)
- [docs/secure-chat-recovery-limitations.md](docs/secure-chat-recovery-limitations.md)

Important note:

- the current MLS / encrypted-chat path is built on `ts-mls`
- that upstream library is maintained by [`LukaJCB`](https://github.com/LukaJCB)
- upstream has already warned that it has not gone through a formal security audit yet
- this frontend should not be described as part of a formally audited messenger

Another security/recovery note:

- during login or explicit encrypted-chat recovery, the frontend may hold the raw account password in live JS memory briefly to finish password-derived key restore / backup work
- it is not intended to be persisted in normal browser storage
- current behavior aims to clear it after the immediate bootstrap pass, with a fallback max window of about 2 minutes

Known ugly encrypted-chat edge while this is still new:

- the DM key-version path has already had one nasty bug where a repair / re-bootstrap could keep using `key_version = 1`
- that path now bumps to newer versions, but encrypted chat recovery is still young and should be tested like it can break
- if a device does not have the exact key that encrypted a message, that message can stay stuck as encrypted text on that device
- the server cannot decrypt it for us, which is the point of E2EE but still painful when recovery data is wrong
- do not treat the current encrypted-chat path as battle-tested yet, especially across multiple devices

## Frontend Commands

```bash
npm install
npm run dev
```

```bash
npm run build
```
