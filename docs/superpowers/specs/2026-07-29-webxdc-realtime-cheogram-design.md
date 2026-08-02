# WebXDC realtime channel: Cheogram-compatible rework

## Problem

Fluux's WebXDC "realtime channel" (used by webxdc apps for ephemeral, non-persisted
background communication via `window.webxdc.joinRealtimeChannel()`) currently works by
creating a private, deterministically-hashed MUC room per webxdc instance, and shipping
realtime data as raw base64 in a plain groupchat `<body>` with no distinguishing XMPP
element at all — see `apps/fluux/src-tauri/src/webxdc/realtime.rs`,
`apps/fluux/src/utils/webxdc/realtimeBridge.ts`.

Cheogram (and by extension Conversations/Delta Chat-family clients) do not use a
side-channel MUC. They send realtime data as an ordinary `<message>` directly into the
*existing* conversation (1:1 chat, or the group's own already-joined MUC), tagged with
a `<no-store/>` hint (XEP-0334) so it isn't archived, wrapped in the same
`urn:xmpp:webxdc:0` namespace used for persisted updates but with a `<data>` child
instead of `<json>`/`<document>`/`<summary>`, and correlated to a specific webxdc app
instance via an XMPP `<thread>` element that both the update message(s) and the realtime
pings share.

We want Fluux's realtime channel to interoperate with this model.

## Scope

- **In scope:** the ephemeral realtime data channel only — send/receive plumbing,
  thread-based correlation, dropping the private-MUC architecture from the active code
  path.
- **In scope (small, additive):** adding a `<thread>` element to our existing persisted
  update send/receive, purely to seed/adopt the correlation value realtime relies on.
  The update message's existing `instance`/`serial`/`payload`/`info`/`document`/`summary`
  structure is not otherwise touched.
- **Out of scope:** restructuring the persisted update wire format to Cheogram's
  `<json>`/`<document>`/`<summary>` shape; fixing MUC/groupchat E2EE (pre-existing gap,
  unaffected by this work).
- **Explicitly kept, but unused:** `apps/fluux/src-tauri/src/webxdc/realtime.rs`
  (`RealtimeChannelManager`, MUC-room-hash based) and
  `apps/fluux/src/utils/webxdc/RealtimeChannelManager.ts` + its test remain in the
  repository, untouched, as dead code. No active command/bridge path calls them after
  this change.

## Wire protocol

Realtime ping, sent directly into the conversation the webxdc instance belongs to:

```xml
<message to="..." type="chat|groupchat" id="...">
  <no-store xmlns="urn:xmpp:hints"/>
  <x xmlns="urn:xmpp:webxdc:0">
    <data>base64-bytes</data>
  </x>
  <thread>thread-id</thread>
</message>
```

Persisted update (unchanged shape, with one added sibling element):

```xml
<message to="..." type="chat" id="...">
  <body>[WebXDC Update: ...]</body>
  <active xmlns="http://jabber.org/protocol/chatstates"/>
  <x xmlns="urn:xmpp:webxdc:0">
    <instance>conversationId:https://example.com/app.xdc</instance>
    <serial>42</serial>
    <payload>{"json":"data"}</payload>
    <info>optional</info>
    <document>optional</document>
    <summary>optional</summary>
  </x>
  <thread>thread-id</thread>
  <origin-id .../>
</message>
```

Both message kinds share the `urn:xmpp:webxdc:0` namespace on `<x>`, distinguished on
receive by the presence of a `<data>` child (realtime) vs. `<instance>`/`<serial>`/
`<payload>` children (update).

## Thread-ID lifecycle

Both peers must agree on the same `<thread>` value to correlate realtime pings to a
specific webxdc app instance. Rules:

1. A new `thread_id TEXT` column is added to the existing `webxdc_metadata` SQLite table
   (`apps/fluux/src-tauri/src/webxdc/storage.rs`), keyed by `instance_id`. Once set for
   an instance, it is immutable (first-write-wins) — no overwrite on subsequent update
   or realtime traffic.
2. A new storage method `get_or_create_thread_id(instance_id) -> String` mints a UUID v4
   the first time it's called for an instance with no stored thread, and persists it.
   All later callers (for the same instance) get the same value back.
3. `webxdc_send_update` (Rust command) calls `get_or_create_thread_id` before emitting
   the outgoing-update event, and includes the resulting `thread_id` in the event
   payload so `xmppBridge.ts` can add `<thread>` to the outgoing stanza.
4. On receiving a persisted update (`webxdc_receive_update`, fed from the SDK's
   `webxdc:update` event), if the incoming stanza carried a `<thread>` and we have none
   stored yet for that instance, we persist the peer's value instead of minting our own.
   This lets us adopt a real Cheogram peer's thread when they share an app to us.
5. `webxdc_realtime_join` resolves the same `get_or_create_thread_id`, so a realtime
   session always uses whatever thread the update channel has (or would) use.

Known limitation, accepted: if both peers manage to mint independent threads before any
update has been exchanged (e.g., both send a realtime ping before either has sent/
received an update), the values may not match until one side later adopts the other's
via an update exchange. This is rare in practice and not solved by this design.

## SDK (`packages/fluux-sdk`) changes

- **`Chat.ts` receive path**: extend the existing `NS_WEBXDC` early-return block (around
  the current `webxdc:update` detection). If the `<x>` element has a `<data>` child,
  treat the message as a realtime ping: extract `<thread>` (top-level, sibling of
  `<x>`) and the base64 `<data>` text, emit a new SDK event `webxdc:realtime`
  `{ from, thread, data }`, and `return { handled: true }` before any chat-bubble /
  body / conversation-list logic runs — mirroring how the update case already
  short-circuits. Otherwise, fall through to the existing update-detection logic,
  additionally reading `<thread>` (optional) and including it in the emitted
  `webxdc:update` event.
- **New send method `sendWebxdcRealtime(to, type, thread, data)`**: a dedicated method
  modeled on the existing signal-only senders (e.g. reactions/retractions), which do
  *not* emit a `chat:message`/local-echo SDK event or a chat bubble. This avoids the
  side effect of `sendCustomMessage` (used by the current update path), which always
  fires a local echo for `type==='chat'` — undesirable for a channel that may send many
  small frames per second. It builds the stanza above (`<no-store/>`, `<x><data>`,
  `<thread>`), reuses the existing `E2EE_PROTECTED_CHILD_KEYS` mechanism (the `<x
  xmlns="urn:xmpp:webxdc:0">` key already covers this element regardless of its
  children, so 1:1 encryption applies with no additional change), and sends via the
  same envelope/carbons/origin-id infrastructure `sendCustomMessage` already uses.
  Groupchat (MUC) sends remain unencrypted, matching the pre-existing limitation for
  update messages — not addressed here.

## Rust (`apps/fluux/src-tauri/src/webxdc`) changes

- **New module** (e.g. `realtime_thread.rs`) with a lightweight manager tracking, only
  for currently-open/joined instances: `instance_id ↔ (conversation_id, thread_id)`
  in memory. This replaces `RealtimeChannelManager` in the four active commands below.
  `realtime.rs` itself is untouched and no longer referenced from `mod.rs`'s command
  bodies.
- **`webxdc_realtime_join(instance_id, conversation_id, self_addr, self_name)`**:
  resolves `thread_id` via `get_or_create_thread_id`, registers the instance in the new
  in-memory manager, and emits an event `{instance_id, conversation_id, thread_id}` for
  the bridge to record locally. No XMPP traffic is sent (no MUC join stanza) — "join" is
  purely local bookkeeping, matching Cheogram (which has no join stanza either).
- **`webxdc_realtime_send(instance_id, data)`**: looks up `(conversation_id,
  thread_id)` for the instance from the in-memory manager (must be joined), emits an
  event carrying `conversation_id`, `thread_id`, and `data` for the bridge to send.
- **`webxdc_realtime_leave(instance_id)`**: unregisters the instance from the in-memory
  manager, emits a leave event for the bridge to drop its local mapping. No XMPP
  traffic (no MUC leave/part stanza).
- **`webxdc_realtime_receive(instance_id, data)`**: unchanged — still just re-emits to
  the webxdc window for local delivery.
- **`webxdc_send_update`/`webxdc_receive_update`**: extended to include/accept
  `thread_id` per the lifecycle rules above.

## Bridge (`apps/fluux/src/utils/webxdc/realtimeBridge.ts`) — full rewrite

- Drops all MUC creation/join/invite logic (`muc.createRoom`, invitee computation) and
  the `getConversationParticipants()` stub (which only ever worked for 1:1 chats) is
  removed as it's no longer needed — realtime pings target the conversation the user
  is already in, so no invite/participant list is ever computed.
- Maintains an in-memory `threadToInstance: Map<string, string>` populated from the
  Rust join/leave events (replacing today's `roomToInstance`).
- On `fluux://webxdc-realtime-send`, resolves whether the target `conversation_id` is a
  1:1 chat or an existing group (reusing whatever helper the codebase already uses to
  make this determination for normal outgoing messages — to be identified during
  implementation) and calls `sendWebxdcRealtime(conversationId, type, threadId, data)`.
- Subscribes to the SDK's `webxdc:realtime` event; looks up the instance via
  `threadToInstance`; if found, forwards to `webxdc_realtime_receive`; if not found
  (no window currently joined for that thread), drops the message — same behavior as
  today's unmatched-room case.

## Required bug fix (pre-existing, blocking)

`apps/fluux/src/components/WebxdcAttachment.tsx` currently hardcodes
`const conversationId = 'stub@example.com'` instead of using the real conversation the
message belongs to (see `// TODO: Get conversationId from message context`). This must
be fixed — threading the real `conversationId` from `MessageBubble` →
`MessageAttachments` → `WebxdcAttachment` → `openWebxdcWindow` — since realtime (and
persisted updates) cannot target the correct conversation otherwise. This is necessary
for the feature to function at all; it is not incidental scope creep.

## Testing approach (TDD)

Implementation will follow test-driven development: for each unit below, write a
failing test first, then the minimal code to pass it.

- **Rust `storage.rs`**: `get_or_create_thread_id` — mints once, stable on repeat calls,
  survives a fresh `WebxdcStorage` handle against the same DB file.
- **Rust new realtime-thread manager**: join registers instance↔(conversation,thread);
  send fails cleanly if not joined; leave unregisters; duplicate join is idempotent.
- **SDK `Chat.ts`**: receiving an `<x xmlns="urn:xmpp:webxdc:0"><data>...</data></x>` +
  `<thread>` message emits `webxdc:realtime` and does not emit `chat:message` or create
  a conversation-list entry; receiving the existing update shape still emits
  `webxdc:update` (regression check); an update stanza carrying `<thread>` is exposed on
  the emitted event; carbon-copied realtime pings are also detected (reuses existing
  carbon-unwrap-then-check ordering).
- **SDK `sendWebxdcRealtime`**: builds the expected stanza shape (`no-store`, `x`/
  `data`, `thread`) for both `chat` and `groupchat`; does not emit `chat:message`; 1:1
  sends get E2EE-protected via the existing `x|urn:xmpp:webxdc:0` key (reuse/extend the
  existing E2EE WebXDC test file added in the "encrypt WebXDC updates" fix).
- **Bridge (`realtimeBridge.ts`)**: join/send/leave/receive wiring against a mocked SDK
  client and mocked Tauri `invoke`/`listen`, verifying no `muc.createRoom` call is ever
  made, and that unmatched threads are dropped silently.
- **Manual verification**: two local Fluux instances exchanging a webxdc app and
  realtime pings end-to-end (both 1:1 and group conversation), per the `verify` skill,
  since this is a UI-driven feature that unit tests alone can't fully validate.

## Files touched (summary)

- `apps/fluux/src-tauri/src/webxdc/storage.rs` — schema migration + thread-id helpers
- `apps/fluux/src-tauri/src/webxdc/mod.rs` — command bodies for join/send/leave, and
  update send/receive thread wiring
- `apps/fluux/src-tauri/src/webxdc/realtime_thread.rs` — new, in-memory join manager
- `apps/fluux/src-tauri/src/webxdc/realtime.rs` — untouched, unused
- `packages/fluux-sdk/src/core/modules/Chat.ts` — receive-path branch + new send method
- `apps/fluux/src/utils/webxdc/realtimeBridge.ts` — rewritten
- `apps/fluux/src/utils/webxdc/xmppBridge.ts` — thread wiring for update send/receive
- `apps/fluux/src/components/WebxdcAttachment.tsx` (+ `MessageBubble.tsx`,
  `MessageAttachments.tsx`) — fix stubbed `conversationId`
- `apps/fluux/src/utils/webxdc/RealtimeChannelManager.ts` (+test) — untouched, unused
