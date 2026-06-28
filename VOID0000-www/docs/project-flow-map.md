# Project Flow Map

This is the high-level map of the whole project so we do not need to keep the system in our heads.

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
    AccountSvc[Account/control service :3001]
    MessageSvc[Message service :3002]
    SocialSvc[Social/profile service :3004]
    ConvSvc[Conversation service :3005]
    WorkerSvc[Worker service]
    GatewayAPI[Phoenix gateway :4001]
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

  Auth --> AccountSvc
  Settings --> AccountSvc
  Settings --> SocialSvc
  Friends --> SocialSvc
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

  AccountSvc --> RateLimit
  SocialSvc --> RateLimit
  ConvSvc --> RateLimit
  MessageSvc --> RateLimit

  AccountSvc --> PG
  SocialSvc --> PG
  ConvSvc --> PG
  MessageSvc --> PG
  MessageSvc --> SCY
  MessageSvc --> MINIO
  SocialSvc --> MINIO
  WorkerSvc --> MINIO
  AccountSvc --> VALKEY
  SocialSvc --> VALKEY
  ConvSvc --> VALKEY
  MessageSvc --> VALKEY
  WorkerSvc --> VALKEY
  GatewayAPI --> VALKEY

  KeyMgr --> LOCAL
  MLSClient --> LOCAL
  Media --> LOCAL
  Composer --> MessageSvc
  Media --> MessageSvc
  Handshake --> ConvSvc
  Stream --> MessageSvc
  Friends --> SocialSvc
```

Use this section as the “how everything connects” map.
The sections below zoom into one lane at a time so the details stay readable.

## 1. System Shape

```mermaid
flowchart LR
  UI[React UI] --> Hooks[Frontend hooks]
  Hooks --> Services[Frontend services]
  Services --> AccountAPI[Account/control API]
  Services --> MessageAPI[Message API]
  Services --> SocialAPI[Social/profile API]
  Services --> ConversationAPI[Conversation API]
  Services --> Gateway[Phoenix WebSocket gateway]
  Services --> LocalState[IndexedDB / local browser state]
  AccountAPI --> Postgres[(Postgres)]
  SocialAPI --> Postgres
  ConversationAPI --> Postgres
  MessageAPI --> Postgres
  MessageAPI --> Scylla[(Scylla messages)]
  MessageAPI --> MinIO[(MinIO attachments)]
  SocialAPI --> MinIO
  AccountAPI --> Valkey[(Valkey sessions / rate limits)]
  SocialAPI --> Valkey
  ConversationAPI --> Valkey
  MessageAPI --> Valkey
  Gateway --> Presence[Presence + live events]
```

Main frontend layers:
- auth: [UserContext.tsx](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Auth/UserContext.tsx), [authServiceApi.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Auth/authServiceApi.ts)
- chat: [chatService.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Chat/chatService.ts), [messageService.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Chat/messageService.ts)
- crypto: [keyManager.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Crypto/keyManager.ts), [chatCryptoProtocolService.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Crypto/protocols/chatCryptoProtocolService.ts)
- gateway: [gateway.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/Gateway/gateway.ts)

Main backend surfaces:
- account/control service: [account-server.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/entrypoints/account-server.js)
- message service: [message-server.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/entrypoints/message-server.js)
- social/profile service: [social-server.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/entrypoints/social-server.js)
- conversation service: [conversation-server.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/entrypoints/conversation-server.js)
- worker service: [worker-server.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/entrypoints/worker-server.js)
- Phoenix gateway: [/void_gateway](/home/void0000/Desktop/VOIDAPP/VOID0000-api/void_gateway)

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
- `deviceId` is stable instead of being tied to the current IP.
- Active Sessions is device-based, not IP-churn-based.
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
- full list and presence use separate routes
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
  E --> F[Handshake decides whether encrypted bootstrap is needed]
```

Relevant routes:
- [dm.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/dm.js)
- [root index](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/root/index.js)
- [members.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/members.js)
- [ownership.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/members/ownership.js)
- [leave.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/routes/conversations/members/leave.js)

Group settings note:
- the UI exposes Profile, Members, Invites, and Permissions
- ownership can be transferred before the owner leaves
- a solo owner leaving is treated as deleting the group
- custom role-builder and access-control screens are not part of this repo

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
- protocol lane is MLS-based account-scope chat
- durable catch-up comes from synced welcomes, commits, group states, and archived keys
- commit receipts are per user, which matches the account-scope model
- the MLS implementation depends on `ts-mls`, which upstream has explicitly said is not formally audited yet

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

Reaction consistency notes:
- reaction writes live in Scylla reaction tables
- live reaction fanout is micro-batched through the gateway path
- the frontend coalesces rapid taps from the same user before sending the final desired state
- cached pages are validated against the server before rendering so stale IndexedDB reaction maps do not disagree with a fresh browser

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
- attachment metadata is carried inside the encrypted message path
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
  account key material, locally stored recovery key record, MLS local state, caches, decrypted-in-memory media cache

## 16. Rate Limiting Map

Main limiter exports live in [rate_limit.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/middleware/rate_limit.js).
Policy definitions live in [policies.js](/home/void0000/Desktop/VOIDAPP/VOID0000-api/server/middleware/rateLimits/policies.js).

Important buckets:
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
  C -- Yes --> D{Recovery key backup exists?}
  D -- Yes --> E[Ask for recovery key]
  D -- No --> F[Try legacy password backup restore]
  E --> G{Recovery key works?}
  F --> G
  G -- No --> H[Encrypted chat recovery gate]
  G -- Yes --> I[Restore local key + MLS state]
  C -- No --> I
  I --> J[Refresh password backup if password is still available]
  I --> K[Refresh recovery-key backup if local recovery key exists]
```

Notes:
- recovery key is the preferred explicit fresh-device recovery path after setup
- password backup still exists for legacy/fallback recovery
- forgot-password on a fresh device can still fail if the user never saved a recovery key
- full limitation doc: [secure-chat-recovery-limitations.md](./secure-chat-recovery-limitations.md)

## 18. Known Limits

- encrypted chat recovery after forgot-password is still limited on fresh devices without a saved recovery key
- the `ts-mls` dependency has no formal upstream security audit yet
- some flows are durable, but edge-case testing still matters for auth, sessions, friends, conversations, MLS, and recovery behavior
