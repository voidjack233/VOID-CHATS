# Project Flow Map

This is the current high-level map of the whole project so we do not need to keep the system in our heads.

## 0. Master Connected Flow

```mermaid
flowchart LR
  subgraph Client
    UI[React UI]
    Auth[Auth + UserContext]
    Settings[Settings / Profile / Sessions]
    Friends[Friends + Presence hooks]
    ChatMgr[Chat manager]
    Handshake[Conversation handshake]
    Stream[Message stream]
    Composer[Message input]
    KeyMgr[Key manager]
    MLSClient[MLS services + store]
    Media[Attachment encryption]
    GatewayClient[Gateway client]
  end

  subgraph API
    AuthAPI[/Auth routes/]
    UserAPI[/User routes/]
    FriendsAPI[/Friends routes/]
    ConvAPI[/Conversation routes/]
    MLSAPI[/MLS routes/]
    AttachAPI[/Attachment route/]
    GatewayAPI[Gateway server]
    RateLimit[Rate limiting]
  end

  subgraph Storage
    PG[(Postgres)]
    SCY[(Scylla)]
    MINIO[(MinIO)]
    VALKEY[(Valkey)]
    LOCAL[(Browser local state)]
  end

  UI --> Auth
  UI --> Settings
  UI --> Friends
  UI --> ChatMgr

  Auth --> AuthAPI
  Settings --> UserAPI
  Friends --> FriendsAPI
  ChatMgr --> Handshake
  ChatMgr --> Stream
  ChatMgr --> Composer

  Handshake --> KeyMgr
  Handshake --> MLSClient
  Stream --> KeyMgr
  Stream --> MLSClient
  Composer --> KeyMgr
  Composer --> MLSClient
  Composer --> Media

  Auth --> GatewayClient
  Friends --> GatewayClient
  ChatMgr --> GatewayClient
  GatewayClient --> GatewayAPI

  AuthAPI --> RateLimit
  FriendsAPI --> RateLimit
  ConvAPI --> RateLimit
  MLSAPI --> RateLimit

  AuthAPI --> PG
  UserAPI --> PG
  FriendsAPI --> PG
  ConvAPI --> PG
  MLSAPI --> PG
  ConvAPI --> SCY
  AttachAPI --> MINIO
  AuthAPI --> VALKEY
  FriendsAPI --> VALKEY
  ConvAPI --> VALKEY
  GatewayAPI --> VALKEY

  KeyMgr --> LOCAL
  MLSClient --> LOCAL
  Media --> LOCAL
  Composer --> ConvAPI
  Media --> AttachAPI
  Handshake --> MLSAPI
  Stream --> ConvAPI
  Friends --> FriendsAPI
```

Use this section as the “how everything connects” map.
The sections below zoom into one lane at a time so the details stay readable.

## 1. System Shape

```mermaid
flowchart LR
  UI[React UI] --> Hooks[Frontend hooks]
  Hooks --> Services[Frontend services]
  Services --> API[Express API]
  Services --> Gateway[WebSocket gateway]
  Services --> LocalState[IndexedDB / local browser state]
  API --> Postgres[(Postgres)]
  API --> Scylla[(Scylla messages)]
  API --> MinIO[(MinIO attachments)]
  API --> Valkey[(Valkey sessions / rate limits)]
  Gateway --> Presence[Presence + live events]
```

Main frontend layers:
- auth: [UserContext.tsx](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Auth/UserContext.tsx), [authServiceApi.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Auth/authServiceApi.ts)
- chat: [chatService.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Chat/chatService.ts), [messageService.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Chat/messageService.ts)
- crypto: [keyManager.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Crypto/keyManager.ts), [chatCryptoProtocolService.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Crypto/protocols/chatCryptoProtocolService.ts)
- gateway: [gateway.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Gateway/gateway.ts)

Main backend surfaces:
- auth routes: [/server/routes/auth](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/auth)
- user routes: [/server/routes/user](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/user)
- friends routes: [/server/routes/friends](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/friends)
- conversation routes: [/server/routes/conversations](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations)
- gateway: [/server/gateway](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/gateway)

## 2. Auth Login Flow

```mermaid
flowchart TD
  A[User submits login] --> B[POST /api/auth/login]
  B --> C{Password valid?}
  C -- No --> D[Reject login + trust/rate-limit hit]
  C -- Yes --> E{2FA enabled?}
  E -- Yes --> F[Create pending 2FA session]
  F --> G[POST /api/auth/2fa/verify-login]
  G --> H{2FA valid?}
  H -- No --> I[Count failure / block if too many]
  H -- Yes --> J[Issue access + refresh tokens]
  E -- No --> J
  J --> K[Set stable deviceId cookie]
  K --> L[Upsert refresh_tokens by device_id]
  L --> M[Create / touch live session in Valkey]
```

Key files:
- [login.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/auth/login.js)
- [verify-login.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/auth/2fa/verify-login.js)
- [refresh.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/auth/refresh.js)
- [deviceFingerprint.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/utils/deviceFingerprint.js)

## 3. Session Flow

```mermaid
flowchart TD
  A[Browser has accessToken + refreshToken + deviceId] --> B[API request]
  B --> C[authenticateUser]
  C --> D{Access token valid?}
  D -- No --> E[POST /api/auth/refresh]
  E --> F[Validate refresh token + device_id]
  F --> G[Rotate refresh token]
  G --> H[Touch same device session]
  D -- Yes --> I[Use request normally]
  H --> I
```

Notes:
- `deviceId` is stable and no longer tied to current IP.
- Active Sessions is device-based now, not IP-churn-based.
- Session list route: [sessions.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/user/sessions.js)

## 4. Profile / Account / Settings Flow

```mermaid
flowchart TD
  A[Settings UI] --> B[Account/profile hooks]
  B --> C[GET /api/users/account or profile read]
  B --> D[PATCH /api/users/profile]
  B --> E[PUT/DELETE /api/users/profile/avatar]
  B --> F[GET /api/users/sessions]
  F --> G[Revoke by device]
```

Key files:
- [useProfileRecord.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/hooks/profile/useProfileRecord.ts)
- [useProfileAvatarUpload.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/hooks/profile/useProfileAvatarUpload.ts)
- [profileFields.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/user/profileFields.js)
- [profileAvatar.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/user/profileAvatar.js)

## 5. Friends + Presence Flow

```mermaid
flowchart TD
  A[FriendsProvider mounts] --> B[GET /api/friends]
  B --> C[Full friend list with profile + presence snapshot]
  C --> D[Cache friend list in frontend]

  E[PresenceProvider mounts] --> F[GET /api/friends/presence]
  F --> G[Presence-only snapshot]
  G --> H[Cache presence map]

  I[Gateway READY / RESUMED / PRESENCE_UPDATE] --> H
  J[Visibility / interval refresh] --> F
```

Notes:
- full list and presence are now separate routes
- presence uses its own rate-limit bucket
- friend requests live separately from the accepted-friends cache

Key files:
- [useFriends.tsx](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/hooks/Friends/useFriends.tsx)
- [usePresence.tsx](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/hooks/Friends/usePresence.tsx)
- [useFriendRequests.tsx](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/hooks/Friends/useFriendRequests.tsx)
- [list.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/friends/list.js)
- [presence.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/friends/presence.js)
- [actions.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/friends/actions.js)

## 6. Conversation Flow

```mermaid
flowchart TD
  A[Chats page loads] --> B[Conversation list / cache]
  B --> C[User opens DM or group]
  C --> D[useChatManager]
  D --> E[Load conversation details]
  E --> F[Start handshake + message stream + sync]
```

Frontend chat control:
- [useChatManager.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/hooks/Chats/useChatManager.ts)
- [useConversationSync.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/hooks/Chats/useConversationSync.ts)
- [useMessageList.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/hooks/Chats/useMessageList.ts)

Backend conversation entry:
- [index.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/index.js)

## 7. DM / Group Creation Flow

```mermaid
flowchart TD
  A[User starts DM or creates group] --> B[Conversation route]
  B --> C[Check friendship / permissions]
  C --> D[Create conversation records]
  D --> E[Client opens conversation]
  E --> F[Handshake decides whether secure bootstrap is needed]
```

Relevant routes:
- [dm.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/dm.js)
- [root index](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/root/index.js)
- [members.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/members.js)

## 8. Chat Open / Handshake Flow

```mermaid
flowchart TD
  A[Conversation becomes active] --> B[useConversationHandshake]
  B --> C[Load cached conversation details]
  C --> D[Fetch members if needed]
  D --> E[Resolve key / required version]
  E --> F{DM or group?}
  F -- DM --> G[Try DM bootstrap / prewarm / peer coverage repair]
  F -- Group --> H[Use group key version + MLS durable sync]
  G --> I[Handshake cache entry]
  H --> I
  I --> J[Conversation marked ready]
```

Key files:
- [useConversationHandshake.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/hooks/Chats/useConversationHandshake.ts)
- [chatCryptoService.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Chat/chatCryptoService.ts)
- [conversationSecurityState.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Chat/conversationSecurityState.ts)

## 9. MLS Flow

```mermaid
flowchart TD
  A[Account startup or chat open] --> B[bootstrapAccount]
  B --> C[Ensure server key package reserve]
  C --> D[syncInbox]
  D --> E[Import welcomes / commits / group states / archive keys]
  E --> F[Local MLS store updated]
  F --> G[Conversation handshake or message decrypt uses local MLS state]
```

MLS backend routes:
- [mls.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/mls.js)
- [keyPackages.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/mls/keyPackages.js)
- [groupStates.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/mls/groupStates.js)
- [welcomes.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/mls/welcomes.js)
- [commits.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/mls/commits.js)
- [groupKeyArchive.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/mls/groupKeyArchive.js)
- [sync.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/mls/sync.js)

MLS frontend services:
- [mlsService.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Crypto/mls/mlsService.ts)
- [mlsGroupService.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Crypto/mls/mlsGroupService.ts)
- [mlsStore.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Crypto/mls/mlsStore.ts)
- [chatCryptoProtocolService.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Crypto/protocols/chatCryptoProtocolService.ts)

Notes:
- current protocol lane is MLS-based account-scope chat
- durable catch-up comes from synced welcomes, commits, group states, and archived keys
- commit receipts are per user, which matches the account-scope model
- the current MLS implementation depends on `ts-mls`, which upstream has explicitly said is not formally audited yet

## 10. Message History + Live Stream

```mermaid
flowchart TD
  A[Conversation open] --> B[Fetch history]
  B --> C[Render existing messages]
  C --> D[Gateway MESSAGE_CREATE / UPDATE / DELETE]
  D --> E[useMessageStream]
  E --> F[Decrypt payload]
  F --> G[Push message into UI]
```

Key files:
- [messages.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/messages.js)
- [useMessageStream.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/hooks/Chats/useMessageStream.ts)
- [messageEnvelope.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Chat/messageEnvelope.ts)

## 11. Message Send Flow

```mermaid
flowchart TD
  A[User sends text] --> B[useMessageInput]
  B --> C[Resolve conversation key / MLS state]
  C --> D[Encrypt message payload]
  D --> E[POST /api/conversations/:id/messages]
  E --> F[Store message]
  F --> G[Gateway fanout]
  G --> H[Recipient decrypts locally]
```

Relevant files:
- [useMessageInput.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/hooks/Chats/useMessageInput.ts)
- [messageService.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Chat/messageService.ts)
- [create.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/messages/create.js)

## 12. Typing / Read / Reactions Flow

```mermaid
flowchart TD
  A[User types / reads / reacts] --> B[Message sub-routes]
  B --> C[Persist state]
  C --> D[Gateway fanout]
  D --> E[Frontend updates UI]
```

Relevant files:
- [typing.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/messages/typing.js)
- [read.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/messages/read.js)
- [reactions.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/reactions.js)
- [batchReactions.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/batchReactions.js)

## 13. Encrypted Attachment Flow

```mermaid
flowchart TD
  A[User selects image] --> B[Client validates size]
  B --> C[Encrypt bytes locally]
  C --> D[Generate blurhash + dimensions]
  D --> E[POST /api/conversations/:id/attachments]
  E --> F[Server stores ciphertext in MinIO]
  F --> G[Attachment metadata goes inside encrypted message payload]
  G --> H[Recipient downloads ciphertext]
  H --> I[Recipient decrypts locally]
```

Notes:
- MinIO stores ciphertext, not readable image files
- attachment metadata is carried inside the secure message path
- plaintext attachment uploads are disabled server-side

Key files:
- [attachmentEncryption.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Crypto/attachmentEncryption.ts)
- [messageAttachments.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Chat/messageAttachments.ts)
- [attachments.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/attachments.js)

## 14. Gateway Flow

```mermaid
flowchart TD
  A[Frontend gateway connects] --> B[READY or RESUMED]
  B --> C[Presence / conversation resync]
  B --> D[Message stream listeners]
  B --> E[Friend + profile live events]
```

Gateway files:
- [gateway.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Gateway/gateway.ts)
- [client.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/gateway/client.js)
- [control.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/gateway/control.js)
- [presence-fanout.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/gateway/presence-fanout.js)
- [protocol.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/gateway/protocol.js)

## 15. Storage Map

- Postgres:
  users, profiles, friendships, refresh tokens, MLS metadata, conversation metadata
- Scylla:
  message bodies / message timeline storage
- MinIO:
  encrypted attachment blobs
- Valkey:
  active sessions, rate limits, some short-lived auth state
- Browser local state:
  account key material, MLS local state, caches, decrypted-in-memory media cache

## 16. Rate Limiting Map

Main limiter buckets live in [rate_limit.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/middleware/rate_limit.js).

Important current buckets:
- auth login
- forgot/reset/register
- auth refresh/check
- friends list
- friends presence
- friend actions
- messages fetch/send
- MLS sync / key-package / archive
- DM anti-spam guard

## 17. Recovery / Backup Flow

```mermaid
flowchart TD
  A[Key manager starts] --> B[Load local account key if present]
  B --> C{No local key?}
  C -- Yes --> D[Try password backup restore]
  D --> E{Success?}
  E -- No --> F[Secure chat recovery gate]
  E -- Yes --> G[Restore local key + MLS state]
  C -- No --> G
  G --> H[Ensure password backup is current]
```

Notes:
- password backup is the active recovery path
- forgot-password on a fresh device can still require the old password
- full limitation doc: [secure-chat-recovery-limitations.md](./secure-chat-recovery-limitations.md)

## 18. Current Known Limits

- secure chat recovery after forgot-password is still limited on fresh devices
- the current `ts-mls` dependency has no formal upstream security audit yet
- some flows are durable, but edge-case testing still matters after auth/session/MLS changes
- this doc is meant to be updated when auth, sessions, friends, conversations, MLS, or recovery behavior changes
