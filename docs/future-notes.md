# Future Notes

## Calls and Video Calls

Calls and video calls are intentionally deferred for now.

Why:

- they are a much larger implementation than chat and messaging
- they add realtime media infrastructure, not just UI work
- forcing them into the current chat/MLS path would create unnecessary complexity

Current direction when we return to this:

- keep chat and MLS separate from call media
- use dedicated call infrastructure instead of building raw call orchestration into the current stack
- expect at least:
  - TURN
  - an SFU or call platform layer
  - lightweight signaling from the existing app stack

Likely architecture to revisit later:

- current app handles auth, ringing, presence, and call history
- dedicated call service handles audio/video transport
- media stays outside the normal chat encryption flow

Decision for now:

- do not implement calls or video calls during the current polish/refactor phase
- revisit after the core chat product is more stable

## Reaction Scaling

Reaction storms on one message are a likely future scale concern, but the project should not jump to the heaviest architecture until the lighter protections stop being enough.

Current protections already in place:

- client-side reaction coalescing for rapid repeated taps from one user
- backend reaction toggle rate limiting
- gateway micro-batching for reaction fanout
- maximum of `10` unique reactions per message

These are meant to cover:

- one user spamming the same reaction button
- short burst traffic on one message
- reducing websocket fanout noise during reaction spikes

When to implement the heavier reaction architecture:

- large groups are hitting reaction rate limits during normal use, not abuse
- hot messages regularly receive large reaction bursts within a few seconds
- gateway fanout becomes the bottleneck and reaction floods start causing noticeable delivery lag
- Scylla reaction writes begin causing measurable latency or contention on hot messages
- clients visibly stutter or rerender too often during heavy reaction storms even after batching

What the heavier version should look like:

- move from pure toggle semantics toward explicit add/remove reaction state
- introduce a hot-message reaction buffer in Valkey
- aggregate reaction deltas briefly before durable persistence
- flush grouped reaction updates to Scylla in small batches
- fan out reaction patches or snapshots instead of one event per single reaction change

Decision for now:

- keep the current lightweight protections
- only move to the heavier reaction system after real scale signals appear
- do not add write-behind queues or Valkey-backed reaction persistence preemptively without measured need
