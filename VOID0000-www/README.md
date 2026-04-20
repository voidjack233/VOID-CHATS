# VOID Frontend

This folder is the frontend for VOID.

It is not a generic Vite starter anymore, even if some of the original template file names survived early on.

If you are trying to understand or run the project, start here first:

- [../README.md](../README.md)
- [../docs/setup.md](../docs/setup.md)

Frontend-specific notes:

- [docs/project-flow-map.md](docs/project-flow-map.md)
- [docs/crypto-security-notes.md](docs/crypto-security-notes.md)
- [docs/secure-chat-recovery-limitations.md](docs/secure-chat-recovery-limitations.md)

Important honesty note:

- the current secure chat path is built on `ts-mls`
- that upstream library is maintained by [`LukaJCB`](https://github.com/LukaJCB)
- upstream has already warned that it has not gone through a formal security audit yet

So this frontend should be described as:

- real
- working
- actively stress-tested in practice

but not:

- formally audited secure messenger frontend

## Frontend Commands

```bash
npm install
npm run dev
```

```bash
npm run build
```
