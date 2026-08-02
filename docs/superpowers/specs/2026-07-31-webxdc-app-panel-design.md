# Webxdc App Instance Panel Design

**Date:** 2026-07-31  
**Status:** Approved  
**Feature:** Right-side panel for managing webxdc app instances per conversation

## Overview

Add a webxdc app instance management panel to chat and room views. Users can install apps from attachments, view installed apps grouped by name, open/reset/remove instances, and see security information (VirusTotal links). The panel appears on the right side of the conversation (like the Members panel in rooms) and is toggled via a button in the chat/room header.

## Goals

1. **Per-conversation app management**: Each chat/room has its own installed app list
2. **Install before open**: Two-step flow — install adds to panel, open launches from panel
3. **Instance grouping**: Multiple instances of the same app show as "App Name (3)"
4. **Security transparency**: VirusTotal link with SHA256 hash on all attachments
5. **Manifest-driven UX**: Show real app names from manifest.toml, not filenames
6. **Reset without data loss**: Create new instance ID instead of clearing data

## Non-Goals

- Global app drawer across all conversations
- App ratings or reviews
- App discovery/store functionality
- Syncing installed apps across devices (local state only)

## Architecture

### Component Structure

```
ChatView / RoomView
├── ChatHeader / RoomHeader (add toggle button)
├── MessageList (existing)
│   └── WebxdcAttachment (enhanced with Install/Remove buttons + VirusTotal)
├── MessageComposer (existing)
└── WebxdcAppPanel (NEW - right-side panel)
    ├── Panel Header (title + close button)
    ├── App List (grouped by name)
    │   └── AppGroupItem (app icon, name, instance count, actions)
    └── Empty State
```

### State Management

**New Zustand Store: `webxdcPanelStore`**

```typescript
interface WebxdcPanelStore {
  // Manifest cache: url → metadata
  manifestCache: Map<string, {
    name: string
    icon?: string
    sha256: string
    extractedAt: number  // timestamp for staleness
  }>
  
  // Installation state per conversation
  installations: Map<string, {  // conversationId → data
    apps: Map<string, WebxdcAppGroup>  // appName → group
    panelOpen: boolean
  }>
  
  // Actions
  cacheManifest: (url: string, data: ManifestData) => void
  installApp: (conversationId: string, instanceId: string, attachment: FileAttachment) => void
  removeApp: (conversationId: string, appName: string) => void
  removeInstance: (conversationId: string, instanceId: string) => void
  createNewInstance: (conversationId: string, appName: string) => Promise<string>  // returns new instanceId
  setPanelOpen: (conversationId: string, open: boolean) => void
  isInstalled: (conversationId: string, instanceId: string) => boolean
  getAppGroup: (conversationId: string, appName: string) => WebxdcAppGroup | undefined
}

interface WebxdcAppGroup {
  appName: string
  icon?: string
  instances: WebxdcInstance[]
}

interface WebxdcInstance {
  instanceId: string
  attachmentUrl: string
  messageId: string  // for "View all instances" context
  installedAt: number
  conversationId: string
}
```

**Persistence:**
- `manifestCache`: localStorage key `webxdc-manifest-cache` (TTL 7 days, max 100 entries)
- `installations`: localStorage key `webxdc-installations` (persists per-conversation state)

### New Tauri Commands

**1. `webxdc_extract_manifest`**
- **Input:** `{ url: string, filename: string, decryptKey?: string, decryptIv?: string }`
- **Output:** `{ name: string, icon?: string }`
- **Purpose:** Extract manifest.toml without opening full window
- **Error handling:** Returns `{ name: filename }` if extraction fails

**2. `webxdc_compute_hash`**
- **Input:** `{ url: string, decryptKey?: string, decryptIv?: string }`
- **Output:** `{ sha256: string }`
- **Purpose:** Calculate SHA256 hash for VirusTotal link
- **Error handling:** Returns error if download/decryption fails

**3. `webxdc_create_new_instance`**
- **Input:** `{ baseInstanceId: string }`
- **Output:** `{ instanceId: string }`
- **Purpose:** Generate new instance ID for reset (copies attachment data)
- **Error handling:** Returns error if base instance not found

**Tauri Permissions:** Add to `apps/fluux/src-tauri/capabilities/default.json`:
```json
"allow-webxdc-extract-manifest",
"allow-webxdc-compute-hash",
"allow-webxdc-create-new-instance"
```

## Component Design

### WebxdcAppPanel

**Layout:** Right-side panel, 256px width (same as OccupantPanel)

**Header:**
- Title: "Webxdc Apps"
- Close button (X icon) — desktop
- Back arrow + title — mobile fullScreen mode

**App List:**
- Virtualized list (react-virtual) for performance
- Grouped by app name (manifest name, not filename)
- Sorted by most recently installed instance

**App Group Item:**
```
┌──────────────────────────────────────┐
│ [Icon] Tic Tac Toe            (3) ⋮  │
│        Open | View All               │
└──────────────────────────────────────┘
```

- **Icon:** From manifest, or Package fallback
- **Name:** From manifest.toml
- **Count badge:** "(3)" if multiple instances, hidden if 1
- **Open button:** Launches most recent instance (primary action)
- **Kebab menu (⋮):**
  - "View all instances" → expands inline to show list with timestamps
  - "Reset" → creates new instance via `webxdc_create_new_instance`
  - "Remove" → removes entire app group (all instances)

**Empty State:**
```
No installed apps

Install apps from attachments
in this conversation
```

**Props:**
```typescript
interface WebxdcAppPanelProps {
  conversationId: string
  onClose: () => void
  fullScreen?: boolean  // mobile mode
}
```

### Enhanced WebxdcAttachment

**Current behavior:** Shows filename + "Open App" button

**New behavior:**

**Phase 1: Message arrives**
1. Background job triggers: `webxdc_extract_manifest` + `webxdc_compute_hash`
2. Results stored in `manifestCache`
3. Component shows loading state → manifest name when ready

**Phase 2: User interaction**
```
┌─────────────────────────────────────────┐
│ 📦  Tic Tac Toe                          │
│     Webxdc App • 245 KB                  │
└─────────────────────────────────────────┘
  🔗 VirusTotal   [Install App]
```

- **VirusTotal link:** `https://www.virustotal.com/gui/file/{sha256}/details`
  - Opens in external browser
  - Grayed out with tooltip "Hash unavailable" if sha256 is null
  - Icon: ExternalLink (lucide-react)

- **Install button:**
  - Calls `installApp(conversationId, instanceId, attachment)`
  - Changes to "Remove" button after installation
  - If already installed in panel: shows "Remove" immediately

**Props (modified):**
```typescript
interface WebxdcAttachmentProps {
  attachment: FileAttachment
  conversationId: string
  // No new props needed - reads from store
}
```

### ChatHeader & RoomHeader Enhancements

**New toggle button:**
- **Icon:** Package (lucide-react)
- **Tooltip:** "Show Webxdc Apps" / "Hide Webxdc Apps"
- **Position:** After "Search in conversation", before overflow menu
- **Behavior:**
  - Calls `setPanelOpen(conversationId, !open)`
  - Panel slides in/out from right
  - Container-query collapse: moves to overflow menu on narrow widths

**Integration pattern:** Copy the "Search in conversation" button pattern:
```typescript
// Inline copy (collapses on narrow widths)
<div className={inlineClass('webxdc')}>
  <button onClick={() => setPanelOpen(conversationId, true)}>
    <Package className="size-4" />
  </button>
</div>

// Overflow menu entry
overflowEntries.push({
  kind: 'action',
  key: 'webxdc',
  label: t('chat.showWebxdcApps'),
  icon: Package,
  onSelect: () => setPanelOpen(conversationId, true),
  kebabClassName: kebabClass('webxdc')
})
```

## Data Flow

### Install Flow

```
1. Message with .xdc attachment arrives
   ↓
2. Background job (useEffect in WebxdcAttachment):
   - webxdc_extract_manifest(url, decryptKey, decryptIv)
   - webxdc_compute_hash(url, decryptKey, decryptIv)
   ↓
3. Store results:
   - manifestCache.set(url, { name, icon, sha256, extractedAt })
   ↓
4. WebxdcAttachment re-renders:
   - Shows manifest name (not filename)
   - Shows VirusTotal link with sha256
   - Shows "Install" button
   ↓
5. User clicks "Install":
   - installApp(conversationId, instanceId, attachment)
   - Creates app group if first instance
   - Adds instance to group.instances[]
   - Button changes to "Remove"
   ↓
6. Panel updates (subscribed to store):
   - Shows new app in list
   - Badge shows instance count
```

### Open Flow

```
1. User clicks "Open" in panel (or attachment card if already installed)
   ↓
2. Get most recent instance:
   - appGroup.instances.sort((a, b) => b.installedAt - a.installedAt)[0]
   ↓
3. Call existing openWebxdcWindow(attachment, conversationId)
   - Uses cached instanceId from store
   - Tauri opens webview window
```

### Reset Flow

```
1. User clicks "Reset" in kebab menu
   ↓
2. Call webxdc_create_new_instance(baseInstanceId)
   - Tauri generates new instanceId
   - Copies attachment metadata from base
   ↓
3. Add new instance to store:
   - createNewInstance(conversationId, appName)
   - Adds to appGroup.instances[] with installedAt: now()
   - New instance becomes most recent
   ↓
4. Panel updates:
   - Instance count increments
   - Next "Open" launches new instance
   ↓
5. Old instances remain in "View all instances" list
```

### Remove Flow

**Remove App (entire group):**
```
1. User clicks "Remove" in kebab menu
   ↓
2. removeApp(conversationId, appName)
   - Deletes appGroup from installations[conversationId].apps
   - All instances removed from panel
   ↓
3. Attachment card updates:
   - "Remove" button changes back to "Install"
```

**Remove Instance (single):**
```
1. User expands "View all instances", clicks X on one
   ↓
2. removeInstance(conversationId, instanceId)
   - Removes instance from appGroup.instances[]
   - If last instance, removes entire appGroup
   ↓
3. Panel updates:
   - Instance count decrements
   - If count reaches 0, app disappears from panel
```

## Error Handling

### Manifest Extraction Failure
- **Cause:** Corrupted .xdc, missing manifest.toml, decryption error
- **Handling:**
  1. `webxdc_extract_manifest` catches error, returns `{ name: filename }`
  2. Cache fallback: `{ name: filename, sha256: null }`
  3. Attachment shows filename (degraded UX, but functional)
  4. No crash, app still installable

### SHA256 Computation Failure
- **Cause:** Download error, I/O error
- **Handling:**
  1. Cache manifest with `sha256: null`
  2. VirusTotal link grayed out, tooltip: "Hash unavailable"
  3. App still installable (hash is informational)

### Duplicate Installation
- **Cause:** User clicks Install twice on same attachment
- **Handling:**
  1. `installApp` checks if `instanceId` already exists
  2. If exists, no-op, show toast: "App already installed"

### Stale Instance Reference
- **Cause:** Instance removed in Tauri but still in store
- **Handling:**
  1. `openWebxdcWindow` throws "instance not found"
  2. Catch error, call `removeInstance(conversationId, instanceId)`
  3. Toast: "App no longer available, removed from panel"

### Conversation Deletion
- **Cause:** User leaves room or deletes conversation
- **Handling:**
  1. Add cleanup hook in conversation leave flow
  2. Call `removeConversation(conversationId)` (new action)
  3. Tauri closes all webxdc windows for that conversation
  4. Store removes `installations[conversationId]`

## Testing Strategy

### Unit Tests

**webxdcPanelStore.test.ts**
- `cacheManifest`: adds/updates cache, respects TTL
- `installApp`: creates groups, handles duplicates, updates timestamp
- `removeApp`: removes all instances
- `removeInstance`: removes single instance, cleans up empty groups
- `createNewInstance`: generates new ID, preserves metadata
- `setPanelOpen`: toggles per conversation
- `isInstalled`: correctly identifies installed instances
- Persistence: localStorage save/restore

**WebxdcAppPanel.test.tsx**
- Renders empty state when no apps
- Groups instances by app name
- Shows instance count badge "(3)"
- Open button calls openWebxdcWindow with most recent instance
- Reset creates new instance, updates list
- Remove deletes group, panel updates
- Panel state persists across unmounts

**WebxdcAttachment.test.tsx**
- Shows loading state during extraction
- Shows manifest name after extraction
- Shows filename on extraction error
- VirusTotal link opens correct URL
- VirusTotal disabled when sha256 is null
- Install button adds to store, changes to Remove
- Remove button removes from store, changes to Install

**ChatHeader.test.tsx & RoomHeader.test.tsx**
- Webxdc toggle button renders
- Clicking toggles panel open/closed
- State syncs with store
- Button collapses to overflow on narrow widths

### Integration Tests

**install-open-reset.test.ts**
1. Receive message → manifest extracts → name shows
2. Click Install → app in panel
3. Click Open → window opens with correct instanceId
4. Click Reset → new instance created, panel shows updated count
5. Verify old instance in "View all instances"

**multiple-instances.test.ts**
1. Install same app 3 times (different URLs)
2. Panel shows "App (3)"
3. Open → launches most recent
4. Remove instance → count decreases
5. Remove app → all gone

**panel-persistence.test.ts**
1. Open panel in Room A
2. Close panel in Chat B
3. Switch to Room A → still open
4. Restart app → states preserved

**error-recovery.test.ts**
1. Corrupted .xdc → shows filename, no crash
2. Missing hash → VirusTotal disabled
3. Stale instance → auto-removed from panel

## Implementation Order (TDD)

1. **Tauri commands** (backend)
   - Implement `webxdc_extract_manifest`
   - Implement `webxdc_compute_hash`
   - Implement `webxdc_create_new_instance`
   - Add permissions to `default.json`

2. **WebxdcPanelStore** (state)
   - Write tests for all actions
   - Implement store to pass tests
   - Add localStorage persistence

3. **WebxdcAttachment enhancements** (attachment card)
   - Write tests for manifest display + Install/Remove buttons
   - Implement background extraction on message receive
   - Add VirusTotal link with SHA256

4. **WebxdcAppPanel component** (panel UI)
   - Write tests for rendering + interactions
   - Implement panel layout, app list, actions
   - Add virtualization for performance

5. **Header integration** (toggle buttons)
   - Write tests for ChatHeader + RoomHeader toggles
   - Add toggle buttons with container-query collapse
   - Wire up panel open/close state

6. **End-to-end flows**
   - Integration tests for install → open → reset
   - Error recovery tests
   - Persistence tests

## Open Questions

None — all requirements clarified through brainstorming session.

## Future Enhancements (Out of Scope)

- App permissions/trust UI (prompt before install)
- App usage statistics (launch count, last used)
- Export/import installed app list
- Sync installed apps via XMPP (XEP extension)
- App recommendations based on conversation context
