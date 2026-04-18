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
