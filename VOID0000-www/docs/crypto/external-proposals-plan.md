# External MLS Proposals

External proposals could eventually make membership cleanup easier when no normal group member initiated the change. They are not required for the current self-leave flow and are not enabled in production.

The useful boundary is simple: the server may propose that a member be removed, but it must never create the MLS commit, derive the next group secret, or decrypt group traffic. A remaining member device still validates and commits the proposal.

Before this can be considered, we need to confirm that `ts-mls` supports `external_senders` and external remove proposals. A future implementation would also need:

- an `external_senders` extension in every compatible group
- a pinned server proposal-signing public key
- client-side signature, conversation, target, and freshness validation
- replay protection and durable proposal identifiers
- a remaining member client that turns the valid proposal into an MLS commit

External proposals would be hardening and coordination, not server-side key management. The server must remain unable to produce the survivor group key.

No production code should be added until library support and interoperability are proven with isolated tests.
