# Message Scroll Mechanism

This page explains how the chat timeline keeps scrolling stable while it trims old pages, loads history in both directions, handles live messages, and lets media finish loading without nudging the user around.

The short version: the scroll system is not one giant trick. It is a few small rules working together:

- keep the newest messages pinned only when the user is actually at the bottom
- keep an anchor near the viewport when the user is reading older messages
- replace logical history gaps with bounded physical spacers so the browser does not carry a huge scroll layer
- capture the viewport before loading history, then restore it immediately after React commits the new rows
- coalesce attachment-load corrections so a group of images does not trigger several tiny scroll fixes

## Main Actors

```mermaid
flowchart TD
  View[MessageViewV2] --> List[useMessageList]
  View --> Geometry[useMessageScrollGeometry]
  View --> Virtualizer[useMessageTimelineVirtualizer]
  View --> Restore[useMessageHistoryViewportRestoration]
  View --> Rows[useMessageRowMeasurements]
  View --> Resize[useMessageViewportResizeObserver]
  View --> Sentinels[useMessageHistorySentinels]
  View --> Boundary[useMessageHistoryBoundaryLock]

  List --> Messages[Visible message window]
  List --> Spacers[Top and bottom logical spacer heights]
  Geometry --> Ranges[Rendered spacer heights and boundary distances]
  Virtualizer --> Loads[Older or newer history load]
  Restore --> Anchors[Viewport anchors and snapshots]
  Rows --> HeightCache[Measured row height cache]
  Resize --> AnchorRestore[Resize anchor restore]
  Sentinels --> Loads
  Boundary --> TopLock[Temporary top boundary lock]
```

`MessageViewV2` is still the conductor, but each hook owns one lane:

- `useMessageList` owns the message window, history pages, spacer totals, and message height recording.
- `useMessageScrollGeometry` turns logical history gaps into rendered spacer heights and boundary distance helpers.
- `useMessageTimelineVirtualizer` watches scroll direction and decides when to load older or newer pages.
- `useMessageHistoryViewportRestoration` captures and restores the viewport around history loads.
- `historyScrollAnchors` contains the low-level DOM anchor math.
- `useMessageRowMeasurements` measures real message row heights and refreshes the height cache.
- `useMessageHistorySentinels` is the IntersectionObserver fallback at the history edges.
- `useMessageHistoryBoundaryLock` prevents overscroll/pull-jank while older history is actively loading.
- `useMessageViewportResizeObserver` restores anchors after viewport size changes.

## Normal Render Flow

```mermaid
flowchart TD
  A[Conversation opens] --> B[useMessageList hydrates latest page]
  B --> C[MessageViewV2 waits for initial hydration]
  C --> D[Scroll to bottom once]
  D --> E[Mark initial latest restore done]
  E --> F[Sync scroll state]
  F --> G{User at present?}
  G -- Yes --> H[Keep newest output pinned when needed]
  G -- No --> I[Capture viewport anchor lock]
```

The first bottom restore is intentionally a one-time action per conversation. After that, the code only follows output if the user is already at the bottom or a send action explicitly asks to jump to present.

## History Load Flow

```mermaid
flowchart TD
  A[User scrolls] --> B[syncScrollState]
  B --> C[maybeStartBestHistoryLoad]
  C --> D{Near older/newer boundary?}
  D -- No --> Z[Do nothing]
  D -- Yes --> E{Already loading, paused, or restoring?}
  E -- Yes --> F[Retain scroll direction signal and retry later]
  E -- No --> G[Capture viewport snapshot]
  G --> H[Call loadOlder or loadNewer]
  H --> I{Load succeeded?}
  I -- No --> J[Clear snapshot or show range error]
  I -- Yes --> K[Mark snapshot ready]
  K --> L[React commits new rows]
  L --> M[restoreHistoryViewportAfterCommit]
  M --> N[Restore anchor / range replacement / distance fallback]
  N --> O[Clear transaction and sync state]
```

The important idea is that history loading is treated like a transaction:

- before the load, capture where the viewport is
- during the load, block unrelated scroll compensation
- after the new rows render, restore the same visual position
- then clear the transaction

## Anchor Strategy

```mermaid
flowchart TD
  A[Need to preserve viewport] --> B{Is a spacer range visible?}
  B -- Yes --> C[Capture range replacement]
  C --> D[Prefer seam message edge]
  D --> E[Fallback to mapped row inside inserted range]

  B -- No --> F[Capture visible message anchor]
  F --> G{Anchor exists after render?}
  G -- Yes --> H[Move scrollTop by anchor offset delta]
  G -- No --> I[Fallback to scrollHeight delta]

  A --> J[For newer loads, also keep fallback anchors and distance from bottom]
```

There are two different preservation modes:

- Message anchor mode keeps a real visible message at the same viewport offset.
- Range replacement mode maps a visible skeleton/spacer range to the real messages that replace it.

Range replacement is why scrolling through unloaded history feels less jumpy. If the user is looking at a spacer/skeleton area when the real messages arrive, the code maps that region instead of pretending a visible message anchor exists.

## Spacer Model

```mermaid
flowchart LR
  LogicalTop[Logical top history height] --> Geometry
  LogicalBottom[Logical bottom history height] --> Geometry
  Geometry[useMessageScrollGeometry] --> RenderedTop[Rendered top spacer]
  Geometry --> RenderedBottom[Rendered bottom spacer]
  Geometry --> BoundaryDistance[Boundary distance helpers]
  Geometry --> State[At-bottom / jump-to-present state]

  LogicalTop -. may be larger than .-> RenderedTop
  LogicalBottom -. may be larger than .-> RenderedBottom
```

The logical spacer height is the real history estimate. The rendered spacer height can be capped. This keeps the browser from managing very large physical scroll layers while still letting the app reason about how much history exists above and below the loaded message window.

## Live Message Flow

```mermaid
flowchart TD
  A[New message event] --> B{Was it sent by current user?}
  B -- Yes --> C[forceFollowOutputRef = true]
  B -- No --> D[Keep current scroll intent]

  C --> E[Message list grows]
  D --> E
  E --> F{At bottom or forced follow?}
  F -- Yes --> G[Scroll to bottom]
  F -- No --> H[Preserve reading position]
```

This is the rule that prevents the timeline from fighting the user. Incoming messages from other people do not yank the viewport if the user is reading above the bottom.

## Attachment Load Polish

```mermaid
flowchart TD
  A[Image or attachment finishes loading] --> B{Correction already scheduled this frame?}
  B -- Yes --> C[Skip duplicate correction]
  B -- No --> D[Schedule one requestAnimationFrame correction]
  D --> E{Highlighted message active?}
  E -- Yes --> F[Recenter highlighted message]
  E -- No --> G{User is reading above bottom?}
  G -- Yes --> H[Restore viewport anchor lock]
  G -- No --> I[Keep bottom pinned]
```

Multiple images can finish loading almost at the same time. Without coalescing, each image could ask for its own anchor or bottom correction. The current behavior batches those load events into one correction per animation frame, which keeps the layout stable without hiding real layout changes.

## Why There Are Multiple Guards

The scroll code has several guards because each one protects a different feeling:

- Initial bottom restore protects conversation open.
- Force follow protects own sends.
- Anchor lock protects reading older messages.
- History snapshots protect history pagination.
- Boundary lock protects the top edge while older history is replacing a spacer.
- Resize restore protects viewport changes from keyboard, window resize, or media layout updates.
- Attachment coalescing protects multi-image messages from repeated tiny corrections.

Removing one guard can make the code look simpler while making the chat feel worse.

## Reviewer Checklist

Use this checklist when changing the timeline:

- Opening a conversation lands at the latest message without a visible jump.
- Sending your own message jumps to present, even from history mode.
- Receiving someone else's message does not yank you down while reading older messages.
- Scrolling near the top loads older history without changing the visible reading position.
- Scrolling near the bottom of a context window loads newer history without losing position.
- Jump-to-present appears when there is newer history or enough distance from the bottom.
- Reply jump scrolls to the target message and highlights it.
- A multi-image message finishing load does not create repeated tiny nudges.
- Mobile keyboard or viewport resize does not lose the current reading anchor.

## Code Map

- [MessageViewV2.tsx](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/components/Chat/MessageView/MessageViewV2.tsx)
- [useMessageList.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/Services/hooks/Chats/useMessageList.ts)
- [useMessageScrollGeometry.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/components/Chat/MessageView/useMessageScrollGeometry.ts)
- [useMessageTimelineVirtualizer.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/components/Chat/MessageView/useMessageTimelineVirtualizer.ts)
- [useMessageHistoryViewportRestoration.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/components/Chat/MessageView/useMessageHistoryViewportRestoration.ts)
- [historyScrollAnchors.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/components/Chat/MessageView/historyScrollAnchors.ts)
- [useMessageRowMeasurements.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/components/Chat/MessageView/useMessageRowMeasurements.ts)
- [useMessageHistorySentinels.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/components/Chat/MessageView/useMessageHistorySentinels.ts)
- [useMessageHistoryBoundaryLock.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/components/Chat/MessageView/useMessageHistoryBoundaryLock.ts)
- [useMessageViewportResizeObserver.ts](/home/void0000/Desktop/VOIDAPP/VOID0000-www/src/components/Chat/MessageView/useMessageViewportResizeObserver.ts)
