# MLS Heartbeat Rotation

A future heartbeat can periodically create an MLS Update Commit to improve post-compromise security. It is not a substitute for removing a member.

Membership cleanup always wins. If a `self_leave`, add, or remove rotation is pending, the client must finish that operation before considering a heartbeat. A heartbeat must never mark a self-leave as secured because only a finalized Remove Commit removes the old member from the MLS tree.

Possible triggers after self-leave is stable:

- every 12 hours while the account is active
- every 50 successfully sent group messages
- on app open when the last update is stale

Only one client should claim a heartbeat rotation at a time. PostgreSQL remains the durable source of truth, while Valkey may provide a short claim lease. The server coordinates the operation but never creates MLS keys or commits.

A future rotation may use:

- membership rotation kind: `heartbeat`
- key rotation reason: `heartbeat`

Heartbeat production wiring should wait until self-leave event handling, reconnect recovery, claim expiry, and multi-client races have all passed real-device testing.
