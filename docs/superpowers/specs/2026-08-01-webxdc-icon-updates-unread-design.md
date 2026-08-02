# Webxdc Icon Extraction, Update-Message Hiding, and Unread Badges Design

**Date:** 2026-08-01
**Status:** Approved
**Feature:** Three additions to the existing webxdc app panel ([2026-07-31-webxdc-app-panel-design.md](2026-07-31-webxdc-app-panel-design.md)):
1. Extract and display each app's real icon (attachment bubble + panel).
2. Per-conversation checkbox to hide `[WebXDC Update: ...]` messages from the message window.
3. Per-app unread badges on the panel (plus an aggregate badge on the header toggle button) for incoming webxdc updates.

## Background

The webxdc app panel (installed in the previous feature) already tracks manifest data (`manifestCache`) and per-conversation app installations (`installations`) in `webxdcPanelStore`. Three gaps remain, each traced to a specific root cause during brainstorming:

1. **Icon:** `WebxdcManifest.icon` (Rust) is parsed straight from `manifest.toml`'s `icon` key, which per the webxdc spec is a *relative path inside the zip* (e.g. `"icon.png"`), not image data. Nothing reads that file's bytes. Both `WebxdcAttachment.tsx` and `WebxdcAppPanel.tsx` render a static `Package`/`PackageIcon` placeholder regardless.

2. **Update messages leaking into the message window:** `xmppBridge.ts` attaches a human-readable compat fallback body (`[WebXDC Update: ${info}]`) to outgoing update stanzas, for XMPP clients that don't understand `urn:xmpp:webxdc:0`. Our own client should never render these as chat bubbles, but two independent gaps let them through:
   - `MAM.ts`'s `parseArchiveMessage` (1:1) and `parseRoomArchiveMessage` (rooms) build a `Message`/`RoomMessage` from any archived stanza with a `<body>`, without checking for the `<x xmlns="urn:xmpp:webxdc:0">` sibling — so any update stanza loaded from MAM history renders as an ordinary message.
   - `Chat.ts`'s **live** stanza handler *does* detect `<x xmlns="urn:xmpp:webxdc:0">` (used to route the update to the webxdc panel/backend) and returns `{ handled: true }` without ever emitting a `Message` — so a live-received update is invisible today, while the *same* stanza reloaded later via MAM becomes visible. This asymmetry is itself a bug: it means "toggle to hide/show" would behave differently depending on whether you're in a live session or just reloaded history.

3. **No unread tracking for webxdc apps:** `WebxdcAppGroup` has no unread field. The `webxdc:update` SDK event (consumed in `xmppBridge.ts`) currently only carries a bare/canonical instance URL (no `conversationId`), which is enough to resolve *which install* to route the update to on the Rust side, but nothing today correlates it back to a specific entry in the frontend's per-conversation `webxdcPanelStore.installations` map for badge purposes.

## Goals

1. Show each app's real icon (from its `.xdc`) on the attachment bubble in the message list and on its row in the Webxdc Apps panel.
2. Let a user hide/show `[WebXDC Update: ...]` messages per conversation, consistently whether they arrived live or were loaded from MAM history.
3. Show a per-app unread badge in the Webxdc Apps panel that increments on incoming updates and clears when that app is opened, plus an aggregate badge on the panel's header toggle button.

## Non-Goals

- Fetching/caching icons for apps that are not installed or not yet attached to a visible message.
- A global (cross-conversation) hide-updates setting — this is per-conversation, matching how `panelOpen` already works.
- Per-instance unread tracking/display (the panel only ever showed one row per app *group*, not per instance — see [2026-07-31-webxdc-app-panel-design.md](2026-07-31-webxdc-app-panel-design.md)). Unread counts are tracked and cleared at the app-group level.
- Retroactively marking already-loaded historical updates as "unread" — unread counts only track updates received after this feature ships.

## 1. Icon Extraction

### Backend (`src-tauri/src/webxdc/extraction.rs`)

`extract_manifest_only` currently:
1. Downloads/decrypts the `.xdc` zip.
2. Opens it as a `ZipArchive`.
3. Reads `manifest.toml`, parses it into `WebxdcManifest { name, icon: Option<String>, min_api, source_code_url }`.

Change: after parsing the manifest, if `manifest.icon` is `Some(path)`, look up that path (case-sensitive, matching zip entry names exactly — no fuzzy matching) in the **same already-open archive**, read its bytes, and base64-encode them into a `data:` URI. Content type is derived from the icon path's extension (`.png` → `image/png`, `.jpg`/`.jpeg` → `image/jpeg`, `.svg` → `image/svg+xml`; unknown extension → `application/octet-stream`, still valid as an `<img src>` for browsers that sniff, but logged as a warning).

`ManifestData` (the tauri-command-facing DTO in `mod.rs`) keeps its `icon: Option<String>` field — its *meaning* changes from "icon path" to "icon data URI". No consumer today reads this as a path (grep confirms), so this is not a breaking change to any caller.

Failure handling (missing icon file in zip, read error, oversized icon): return `icon: None` and log a warning — never fail the whole manifest extraction over an icon problem, matching the existing graceful-fallback philosophy for manifest parsing.

**Size guard:** cap icon extraction at 512 KB (webxdc icons are small app icons, not general images); an icon file larger than that is treated as absent (`icon: None`) rather than decoded, to avoid bloating `manifestCache`'s localStorage entry.

### Frontend

No shape changes to `manifestCache` — `ManifestCacheEntry.icon` already exists as `string | undefined` and simply now holds a data URI instead of being unused/path-shaped.

- `WebxdcAttachment.tsx`: the `size-10 rounded-lg ... bg-purple-500/20` icon slot (currently always `<Package>`) renders `<img src={cached.icon} className="size-5 rounded" />` when `cached?.icon` is set and hasn't errored; falls back to the current `Package` icon otherwise (including on `<img onError>`).
- `WebxdcAppPanel.tsx`'s `AppGroupItem`: same treatment for `group.icon`, replacing the static `PackageIcon`.

## 2. Hide WebXDC Update Messages

### Data model

Add `isWebxdcUpdate?: boolean` to the shared `Message` and `RoomMessage` types (`packages/fluux-sdk`). Omitted/`false` for all existing message kinds; `true` only for messages derived from a stanza carrying `<x xmlns="urn:xmpp:webxdc:0">` with `<instance>`/`<json>` children (i.e. a persisted update, not a realtime/ephemeral `<data>` frame, which still never becomes a message).

### MAM.ts (history path)

In both `parseArchiveMessage` and `parseRoomArchiveMessage`, after resolving `messageEl`, check `messageEl.getChild('x', NS_WEBXDC)`. If present, set `isWebxdcUpdate: true` on the returned `Message`/`RoomMessage`. `NS_WEBXDC` needs importing from `../namespaces` (already used in `Chat.ts`). This is purely additive — existing body/attachment parsing is untouched, so an update message still renders its `[WebXDC Update: ...]` text when not hidden, exactly as today.

### Chat.ts (live path)

Today, the `webxdcElement` branch (the block handling `<x xmlns="urn:xmpp:webxdc:0">`) ends with an unconditional `return { handled: true }` for persisted-update stanzas (the `<instance>`/`<json>` branch, as opposed to the ephemeral `<data>` realtime branch, which is untouched by this change). Replace that with:

1. Keep emitting `webxdc:update` exactly as today (the functional bridge that drives the actual app-instance update sync must not change).
2. Additionally construct a `Message`/`RoomMessage` with `isWebxdcUpdate: true`, `body` set to the stanza's `<body>` text (the compat fallback), and the same `from`/`type`/timestamp handling the normal body path below it would use — determining 1:1 vs groupchat requires hoisting the existing `hasMucUserElement`/`isWhisper`-adjacent type detection (currently computed *after* the webxdc branch) above it, or duplicating the minimal `type === 'chat' && hasMucUserElement` check locally. Emit it via `this.deps.emit('message', ...)`, mirroring the existing whisper-emission pattern (`Chat.ts` ~line 396).
3. Still `return { handled: true }` — this only ever gated the *outer* stanza-dispatch loop, not storage, so no other module double-processes the stanza.

Net effect: a live update and the same update reloaded later via MAM now produce an identical `Message` shape, both flagged `isWebxdcUpdate: true`.

### Per-conversation toggle

Add `hideUpdateMessages: boolean` to `ConversationInstallations` in `webxdcPanelStore` (default `false` — current rendering behavior is unchanged until a user opts in), alongside the existing `panelOpen` field, persisted the same way (`localStorage` under `webxdc-installations`). New store actions: `setHideUpdateMessages(conversationId, hide)`, `getHideUpdateMessages(conversationId)`.

**UI:** a checkbox in `WebxdcAppPanel`'s header (both desktop and `fullScreen` layouts), labeled e.g. "Hide update messages", bound to `getHideUpdateMessages(conversationId)` / `setHideUpdateMessages`.

**Filtering:** wherever the message list turns stored messages into rendered list items (the message-to-list-item mapping used by `MessageList`/room equivalent), skip entries where `message.isWebxdcUpdate && getHideUpdateMessages(conversationId)`. This is a pure client-side render filter — messages are still stored and counted normally; only presentation is affected.

## 3. Unread Webxdc Update Badges

### Data model

Add `unreadCount: number` to `WebxdcAppGroup` (default `0`, persisted as part of the existing `installations` localStorage blob — no migration needed since `JSON.parse` of old entries simply yields `undefined`, and all read sites will treat `undefined` as `0`).

New store actions on `webxdcPanelStore`:
- `incrementUnread(conversationId, attachmentUrl)`: finds the conversation's app group containing an instance whose `attachmentUrl` matches, and increments that group's `unreadCount` by 1. No-op if no installed instance matches (app not installed in that conversation — nothing to badge).
- `clearUnread(conversationId, appName)`: sets that group's `unreadCount` to `0`.
- `getTotalUnread(conversationId)`: sums `unreadCount` across all app groups for that conversation (for the header aggregate badge).

### Correlation (incoming update → app group)

`xmppBridge.ts`'s `client.onSDK('webxdc:update', ...)` handler already computes/receives everything needed:
- `resolvedInstance`: the canonical attachment URL (resolved via thread lookup for Cheogram-format updates before this handler's existing logic runs).
- `event.sender`: the stanza's `from` (bare or full JID) — its bare form is the conversationId (bare JID for 1:1, room JID for MUC), matching how `installations` is keyed.

After the existing `resolvedInstance` resolution (and before/alongside the existing `receiveWebxdcUpdate(...)` call), call `useWebxdcPanelStore.getState().incrementUnread(getBareJid(event.sender), resolvedInstance)`. This only affects the frontend badge; it does not change the existing Rust-side update storage/distribution call.

### Clearing

Call `clearUnread(conversationId, group.appName)`:
- In `WebxdcAppPanel.tsx`'s `handleOpenApp`, when the user opens an app from the panel.
- In `WebxdcAttachment.tsx`'s `handleOpen`, when the user opens an already-installed app directly from its attachment bubble in the message list.

### UI

- **Panel row badge:** a small circular badge (red background, white count text, e.g. `9+` past 9) anchored to the top-right corner of each `AppGroupItem`'s icon in `WebxdcAppPanel.tsx`, shown only when `group.unreadCount > 0`.
- **Header aggregate badge:** the existing `Package` toggle button in `ChatHeader.tsx` and `RoomHeader.tsx` (both the inline copy and, where present, the overflow-menu entry) gets the same style of badge showing `getTotalUnread(conversationId)`, shown only when `> 0`.

## Error Handling

- **Icon extraction failure** (missing file in zip, oversized, unreadable): `icon: None`, same "app still installable, degraded but functional" behavior as an unparseable manifest today.
- **Update-message flag on a stanza without a resolvable conversation** (e.g. a malformed `from`): existing `if (!bareFrom) return { handled: false }` guard in `Chat.ts` already covers this upstream of the new emit — no new failure mode introduced.
- **Unread increment for an uninstalled app**: no-op (there is no panel row to badge). If the app is installed later, no retroactive badge is created — only updates received after install/after this feature ships are counted, consistent with the Non-Goals.
- **Stale/renamed app group** (e.g. `removeApp`/`removeInstance` mid-flight): `unreadCount` is deleted along with the group, same as any other group field.

## Testing Strategy

**Rust (`extraction.rs`):**
- Icon present at manifest-specified path → returns correct `data:` URI with correct MIME type.
- Icon path missing from manifest → `icon: None`, manifest name/other fields still parsed correctly.
- Icon path present in manifest but file absent from zip → `icon: None`, no panic, manifest extraction still succeeds.
- Icon file exceeds 512 KB → `icon: None`.

**`webxdcPanelStore.test.ts`:**
- `hideUpdateMessages`: default `false`; `setHideUpdateMessages`/`getHideUpdateMessages` round-trip; persists across store reload.
- `incrementUnread`: increments the matching group; no-op when no instance matches the URL; no-op for a conversation with no installations.
- `clearUnread`: resets to 0; no-op for a nonexistent group.
- `getTotalUnread`: sums correctly across multiple app groups; 0 when no installations.

**`MAM.test.ts` (or equivalent archive-parsing tests):**
- `parseArchiveMessage` and `parseRoomArchiveMessage` each set `isWebxdcUpdate: true` for a stanza containing `<x xmlns="urn:xmpp:webxdc:0">`, and leave it `undefined` for ordinary messages.

**`Chat.webxdc.test.ts`:**
- A live persisted-update stanza now results in exactly one `emit('message', ...)` call with `isWebxdcUpdate: true`, in addition to the existing `webxdc:update` SDK event — verifying the live/history asymmetry is resolved.
- A live realtime (`<data>`) frame still results in *no* emitted message (unchanged).

**`WebxdcAttachment.test.tsx` / `WebxdcAppPanel.test.tsx`:**
- Icon renders as `<img>` when `manifestCache`/`group.icon` is set; falls back to placeholder icon when absent or on load error.
- Panel checkbox toggles `hideUpdateMessages` and (via a rendering-integration test) hides/shows `isWebxdcUpdate` messages in the list.
- Opening an app via panel or attachment bubble clears that app's `unreadCount`.
- Badge renders with correct count on the panel row and header toggle button; hidden when count is 0.

## Implementation Order (TDD)

1. **Rust icon extraction** — tests first, then implement reading icon bytes out of the already-open zip and base64-encoding.
2. **`isWebxdcUpdate` flag** — types, then `MAM.ts` archive parsers (smaller, self-contained change), then `Chat.ts` live-path emit (the reordering-sensitive change).
3. **Hide-updates toggle** — store field/actions, then panel checkbox, then message-list filter.
4. **Unread tracking** — store field/actions, then `xmppBridge.ts` increment hook, then clear hooks in panel/attachment, then badge UI (panel row, then header aggregate).
5. **End-to-end verification** — manual run through `verify` skill: receive a webxdc update in a live session, confirm badge increments and the update message appears/hides correctly with the checkbox; reload the conversation (MAM path) and confirm identical behavior.

## Open Questions

None — all three features were scoped and root-caused through code investigation and clarifying questions during brainstorming.
