# VOID Frontend

This folder is the React frontend for VOID.

It is the part users actually touch, so a lot of the weirdness here comes from trying to make complicated chat behavior feel normal: encrypted-message recovery, realtime updates, old-history scrolling, failed media, group membership changes, and all the little UI states between them.

If you are trying to understand or run the project, start here first:

- [../README.md](../README.md)
- [../docs/setup.md](../docs/setup.md)

Frontend-specific notes:

- [docs/project-flow-map.md](docs/project-flow-map.md)
- [docs/message-scroll-mechanism.md](docs/message-scroll-mechanism.md)
- [docs/secure-chat-recovery-limitations.md](docs/secure-chat-recovery-limitations.md)

## Frontend Shape

- `src/pages/Chat` owns the main chat page shell.
- `src/components/Chat/MessageView` owns the message timeline, history loading, jump-to-present behavior, and viewport restoration.
- `src/components/Chat/Messages` owns message rows, bubbles, reactions, link previews, formatting, and layout decisions.
- `src/components/Chat/Composer` owns the message composer and send controls.
- `src/components/Chat/Groups` owns group settings, members, invites, permissions, ownership transfer, and leaving/deleting group flows.

Group settings expose the sections that have real behavior:

- `Profile`
- `Members`
- `Invites`
- `Permissions`

Basic owner/admin/member roles exist inside the app, but there is no custom role-builder UI in this repo.

## Important Security Note

- the MLS / encrypted-chat path is built on a vendored `ts-mls` `1.6.2` copy in `vendor/ts-mls`
- that upstream library is maintained by [`LukaJCB`](https://github.com/LukaJCB)
- upstream states that it has not gone through a formal security audit yet
- vendoring is intentional so npm or upstream changes do not silently alter the MLS layer
- this frontend should not be described as part of a formally audited messenger

## Recovery Note

- recovery keys are the preferred fresh-device recovery path after setup
- during login or legacy encrypted-chat recovery, the frontend may hold the raw account password in live JS memory briefly to finish password-derived key restore / backup work
- it is not intended to be persisted in normal browser storage
- the app aims to clear it after the immediate bootstrap pass, with a fallback max window of about 2 minutes
- the browser may keep the recovery key in an encrypted local record so it can refresh recovery-key backups

Known ugly encrypted-chat edge while this is still new:

- the DM key-version and encrypted-chat recovery paths are sensitive and should be tested like they can break
- if a device does not have the exact key that encrypted a message, that message can stay stuck as encrypted text on that device
- the server cannot decrypt it for us, which is the point of E2EE but still painful when recovery data is wrong
- do not treat the encrypted-chat path as battle-tested yet, especially across multiple devices

## Multi-Service Dev Note

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
