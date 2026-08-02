# Webxdc Sidebar Improvements Design

**Date:** 2026-08-01  
**Status:** Approved  
**Approach:** Frontend-Only with Event Listeners

## Overview

This design improves the webxdc apps sidebar with three main enhancements:

1. **Fix "View All" functionality** - Show all instances of apps with multiple launches
2. **Restructure clickable areas** - Make app box/icon/name clickable, move "View All" to kebab menu
3. **Implement proper unread tracking** - Track per-instance unreads based on launch/close times, excluding self-sent messages

## Background

The current implementation has several issues:

- "View All" link exists but does nothing
- Unread tracking is app-level (by attachment URL), not instance-level
- All incoming webxdc updates increment unreads, including user's own messages
- No tracking of when instances are opened/closed
- Clickable area is limited to small "Open" link instead of the whole box

Previously implemented: "Per-app unread count badges with aggregate counts" (commits 438bfe48, bebb6d43, 26ddd7b3) - this implementation will be replaced with per-instance tracking.

## Goals

- Enable users to see and open specific instances when an app is launched multiple times
- Make the UI more intuitive with larger clickable areas
- Show accurate unread counts that reflect actual unseen updates (excluding self-sent)
- Track which instances have been opened/closed to calculate unreads properly

## Non-Goals

- Persistent unread tracking across app restarts (can be added later if needed)
- Retroactive unread calculation for messages before tracking starts
- Backend database storage of launch/close times

## Data Model Changes

### WebxdcInstance Interface

Extend the `WebxdcInstance` interface in `apps/fluux/src/stores/webxdcPanelStore.ts`:

```typescript
export interface WebxdcInstance {
  instanceId: string
  attachmentUrl: string
  messageId: string
  installedAt: number
  conversationId: string
  attachment: FileAttachment
  lastLaunchedAt?: number  // NEW: timestamp when window last opened
  lastClosedAt?: number    // NEW: timestamp when window last closed
  unreadCount: number      // NEW: per-instance unread count
}
```

### WebxdcAppGroup Interface

Remove group-level unread count (now computed from instances):

```typescript
export interface WebxdcAppGroup {
  appName: string
  icon?: string
  instances: WebxdcInstance[]
  // REMOVED: unreadCount (now calculated by summing instance unreads)
}
```

**Rationale:**
- Per-instance tracking allows accurate unreads when multiple instances exist
- Launch/close timestamps enable "unreads = updates after last close" logic
- Aggregate unreads computed on-demand: instance → group → conversation

## Architecture

### Component Flow

```
User opens instance
  ↓
webxdcWindow.ts: openWebxdcWindow()
  ↓
Store: recordLaunch(conversationId, instanceId)
  ↓
Store: clearUnread(instanceId)
  ↓
Backend: Tauri opens window

---

User closes window
  ↓
Backend: WindowEvent::CloseRequested
  ↓
Backend: emit("fluux://webxdc-window-closed", { instance_id, closed_at })
  ↓
Frontend: listen() receives event
  ↓
Store: recordClose(instanceId, closedAt)

---

Webxdc update message arrives
  ↓
xmppBridge.ts: webxdc:update event
  ↓
Filter: sender !== currentUserJID?
  ↓ (yes)
Store: incrementUnread(instanceId, senderId)
  ↓
UI: badges auto-update via store reactivity
```

### Unread Count Aggregation

```
Instance Level:
  instance.unreadCount (tracked directly)
    ↓
Group Level:
  sum of all instance.unreadCount in group
    ↓
Conversation Level:
  sum of all group unreads
    ↓
Header Badge:
  getTotalUnread(conversationId)
```

## Backend Changes

### Window Close Event

**File:** `apps/fluux/src-tauri/src/webxdc/window.rs`

Modify the `on_window_event` handler to emit a close event:

```rust
window.on_window_event(move |event| {
    if let WindowEvent::CloseRequested { .. } = event {
        // Existing cleanup code
        let http_server = crate::webxdc::get_http_server();
        http_server.unregister_instance(&hash_clone, &token_clone);

        let mut windows = registry_clone.lock().unwrap();
        windows.remove(&instance_id_clone);

        // NEW: Emit close event to frontend
        let _ = app_handle.emit("fluux://webxdc-window-closed", WindowClosedEvent {
            instance_id: instance_id_clone.clone(),
            closed_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
        });

        eprintln!("[WebXDC] Window closed: {}", instance_id_clone);
    }
});
```

**Event Structure:**

```rust
#[derive(Clone, serde::Serialize)]
struct WindowClosedEvent {
    instance_id: String,
    closed_at: u64,  // milliseconds since epoch
}
```

**Location:** Add this struct near the top of `window.rs` with other event types.

## Frontend Changes

### Store Methods

**File:** `apps/fluux/src/stores/webxdcPanelStore.ts`

**New Methods:**

```typescript
interface WebxdcPanelStore {
  // Existing fields...
  
  // NEW: Lifecycle tracking
  recordLaunch: (conversationId: string, instanceId: string) => void
  recordClose: (instanceId: string, closedAt: number) => void
  
  // MODIFIED: Track per-instance with sender filtering
  incrementUnread: (instanceId: string, senderId: string) => void
  clearUnread: (instanceId: string) => void
  
  // NEW: Computed unreads
  getInstanceUnread: (instanceId: string) => number
  getAppGroupUnread: (conversationId: string, appName: string) => number
  getTotalUnread: (conversationId: string) => number  // exists, needs update
}
```

**Implementation Details:**

1. **recordLaunch:**
   - Find instance by instanceId
   - Set `lastLaunchedAt = Date.now()`
   - Save to localStorage

2. **recordClose:**
   - Find instance by instanceId
   - Set `lastClosedAt = closedAt` (from event)
   - Save to localStorage

3. **incrementUnread:**
   - Extract conversation ID from instanceId (format: `"jid:url"`)
   - Find matching instance
   - Get current user JID from `connectionStore`
   - Only increment if `senderId !== currentUserJID`
   - Increment `instance.unreadCount`
   - Save to localStorage

4. **clearUnread:**
   - Find instance by instanceId
   - Set `instance.unreadCount = 0`
   - Save to localStorage

5. **getAppGroupUnread:**
   - Get group by conversationId + appName
   - Sum all `instance.unreadCount` in group
   - Return total

6. **getTotalUnread (modified):**
   - Get all groups for conversationId
   - For each group, sum instance unreads
   - Return grand total

### Window Lifecycle Tracking

**File:** `apps/fluux/src/utils/webxdc/webxdcWindow.ts`

Add launch tracking before opening window:

```typescript
export async function openWebxdcWindow(
  attachment: FileAttachment,
  conversationId: string
): Promise<void> {
  const instanceId = getInstanceId(conversationId, attachment.url)

  // NEW: Record launch and clear unreads
  const { recordLaunch, clearUnread } = useWebxdcPanelStore.getState()
  recordLaunch(conversationId, instanceId)
  clearUnread(instanceId)

  // Existing window opening code...
}
```

**File:** Create `apps/fluux/src/utils/webxdc/windowLifecycle.ts` (new file)

Listen for window close events:

```typescript
import { listen } from '@tauri-apps/api/event'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'

interface WindowClosedEvent {
  instance_id: string
  closed_at: number
}

export function initializeWindowLifecycleListener() {
  listen<WindowClosedEvent>('fluux://webxdc-window-closed', (event) => {
    const { instance_id, closed_at } = event.payload
    useWebxdcPanelStore.getState().recordClose(instance_id, closed_at)
    console.log('[webxdc] Window closed, recorded:', instance_id)
  }).catch((err) => {
    console.error('[webxdc] Failed to set up window close listener:', err)
  })
}
```

Call `initializeWindowLifecycleListener()` once in `App.tsx` on mount.

### Unread Tracking Changes

**File:** `apps/fluux/src/utils/webxdc/xmppBridge.ts`

Modify the incoming update handler (around lines 108-164):

```typescript
// BEFORE:
const updateConversationId = sender ? sender.split('/')[0] : undefined
if (updateConversationId) {
  const attachmentUrl = resolvedInstance.match(/^[^:]+:[^:]+:\/\//)
    ? resolvedInstance.substring(resolvedInstance.indexOf('https://'))
    : resolvedInstance
  useWebxdcPanelStore.getState().incrementUnread(updateConversationId, attachmentUrl)
}

// AFTER:
if (sender) {
  useWebxdcPanelStore.getState().incrementUnread(resolvedInstance, sender)
}
```

**Rationale:**
- Pass full `resolvedInstance` (instance ID) instead of just attachment URL
- Pass `sender` so store can filter out self-sent messages
- Store extracts conversation ID internally from instance ID format

### UI Changes

**File:** `apps/fluux/src/components/WebxdcAppPanel.tsx`

**AppGroupItem Component:**

Current structure (simplified):
```typescript
<div className="px-4 py-2">
  <div className="flex items-center gap-3">
    <div className="icon">{/* icon with badge */}</div>
    <div className="flex-1">{/* name + count */}</div>
    <button className="kebab">{/* kebab menu */}</button>
  </div>
  <div className="flex items-center gap-3 mt-2">
    <button onClick={onOpen}>Open</button>
    {hasMultiple && <button>View All</button>}
  </div>
</div>
```

New structure:
```typescript
<div className="px-4 py-2">
  {/* Main clickable box */}
  <button
    onClick={() => handleOpenInstance(mostRecentInstance)}
    className="flex items-center gap-3 w-full hover:bg-fluux-hover/60 p-2 -m-2 rounded-lg transition-colors"
  >
    <div className="relative size-10">
      {/* Icon */}
      {groupUnreadCount > 0 && (
        <span className="badge">{formatUnreadCount(groupUnreadCount)}</span>
      )}
    </div>
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{group.appName}</span>
        {hasMultiple && <span className="text-xs text-fluux-muted">({group.instances.length})</span>}
      </div>
    </div>
  </button>

  {/* Kebab menu - positioned absolutely, stopPropagation on click */}
  <div className="absolute top-2 right-2">
    <button onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen) }}>
      <MoreVertical />
    </button>
    {menuOpen && (
      <div className="menu">
        {hasMultiple && <button onClick={() => setExpanded(!expanded)}>View All</button>}
        <button onClick={handleRemove}>Remove</button>
      </div>
    )}
  </div>

  {/* Expanded instances list */}
  {expanded && hasMultiple && (
    <div className="mt-2 space-y-1">
      {otherInstances.map(instance => (
        <InstanceItem key={instance.instanceId} instance={instance} onOpen={handleOpenInstance} />
      ))}
    </div>
  )}
</div>
```

**Key Changes:**
1. Entire box is wrapped in `<button>` that opens most recent instance
2. Kebab menu uses `stopPropagation()` to prevent triggering box click
3. Remove "Open" and "View All" links below box
4. Add "View All" to kebab menu (only if `instances.length > 1`)
5. "View All" toggles `expanded` state
6. When expanded, show list of other instances (excluding most recent)

**InstanceItem Component (new):**

```typescript
function InstanceItem({ instance, onOpen }: { instance: WebxdcInstance, onOpen: (instance: WebxdcInstance) => void }) {
  const launchedDate = instance.lastLaunchedAt 
    ? new Date(instance.lastLaunchedAt).toLocaleDateString()
    : new Date(instance.installedAt).toLocaleDateString()

  return (
    <button
      onClick={() => onOpen(instance)}
      className="flex items-center gap-2 w-full p-2 hover:bg-fluux-hover/60 rounded-lg transition-colors"
    >
      <div className="relative size-8">
        <PackageIcon className="size-8" />
        {instance.unreadCount > 0 && (
          <span className="badge-small">{formatUnreadCount(instance.unreadCount)}</span>
        )}
      </div>
      <span className="text-xs text-fluux-muted">{launchedDate}</span>
    </button>
  )
}
```

**Sorting Logic:**

Most recent instance = highest `lastLaunchedAt || installedAt`:

```typescript
const sortedInstances = [...group.instances].sort((a, b) => 
  (b.lastLaunchedAt || b.installedAt) - (a.lastLaunchedAt || a.installedAt)
)
const mostRecentInstance = sortedInstances[0]
const otherInstances = sortedInstances.slice(1)
```

### Badge Display

**Locations:**

1. **Header Package Icon** (`ChatHeader.tsx`, `RoomHeader.tsx`):
   - Already implemented: `getTotalUnread(conversationId)`
   - Update logic to sum from instances instead of groups

2. **Sidebar App Box Icon** (`WebxdcAppPanel.tsx` - `AppGroupItem`):
   - Call `getAppGroupUnread(conversationId, appName)`
   - Sum all instance unreads in this group

3. **Expanded Instance Items**:
   - Show `instance.unreadCount` directly
   - Only render badge if count > 0

4. **Attachment Box** (`WebxdcAttachment.tsx`):
   - NEW: Add badge showing unreads for this attachment
   - Calculate by finding all instances with matching `attachmentUrl`
   - Sum their `unreadCount` values

**Badge Styling:**

All badges use consistent styling:
```typescript
className="absolute -top-1 -end-1 z-10 min-w-4 h-4 px-1 bg-fluux-badge-strong text-white text-[10px] font-bold rounded-full flex items-center justify-center"
```

Use `formatUnreadCount()` utility for display (e.g., "99+" for counts > 99).

## Migration & Cleanup

### Remove Old Implementation

**In `webxdcPanelStore.ts`:**

1. Remove `unreadCount: number` from `WebxdcAppGroup` interface
2. Change `incrementUnread` signature from `(conversationId: string, attachmentUrl: string)` to `(instanceId: string, senderId: string)`
3. Update `getTotalUnread` to sum from instances instead of groups
4. Remove old `clearUnread(conversationId, appName)` - replace with `clearUnread(instanceId)`

**In `xmppBridge.ts`:**

Replace the URL-based increment logic (lines 140-148) with instance+sender approach.

**In `WebxdcAppPanel.tsx`:**

Remove the action buttons section (lines 220-237).

### Migration Strategy

**localStorage Key Change:**

Bump the installations key to force fresh start:
```typescript
const INSTALLATIONS_KEY = 'webxdc-installations-v2'  // was 'webxdc-installations'
```

**Rationale:**
- Unreads are transient session data (acceptable to lose)
- Avoid complex migration logic for alpha/beta feature
- Users start fresh with correct per-instance tracking

**Backward Compatibility:**

None needed - existing data is abandoned, new structure starts clean.

## Error Handling

**Window Close Event Missing:**

If window crashes without emitting close event:
- Instance's `lastClosedAt` remains undefined
- Unreads continue to accumulate
- Next time window opens, unreads are cleared (acceptable)

**Sender JID Unavailable:**

If `sender` is undefined in incoming update:
- Skip unread increment (fail safe - don't increment)
- Log warning to console

**Instance Not Found:**

If `incrementUnread` can't find instance by instanceId:
- Log warning to console
- No crash, update is ignored for unread counting
- Instance might have been removed or not yet installed

## Testing Strategy

**Manual Testing:**

1. Install same app 3 times → verify 3 instances show in sidebar
2. Click main box → most recent instance opens
3. Click "View All" → other instances expand below
4. Click an older instance → that specific instance opens
5. Send webxdc update from another device → unread badge appears
6. Send webxdc update from self → no unread badge (filtered)
7. Open instance → unread badge clears
8. Close instance, receive update → unread badge appears again

**Unit Tests:**

Add to `webxdcPanelStore.test.ts`:
- `recordLaunch` updates `lastLaunchedAt`
- `recordClose` updates `lastClosedAt`
- `incrementUnread` filters self-sent messages
- `getAppGroupUnread` sums instance unreads
- `getTotalUnread` aggregates across all groups

**Integration Tests:**

Add to `WebxdcAppPanel.test.tsx`:
- Most recent instance rendered first
- "View All" only shown if multiple instances
- Expanded list shows other instances sorted by launch time
- Clicking box opens correct instance

## Open Questions

None - all requirements clarified during design discussion.

## Future Enhancements

1. **Persistent Unread Tracking:**
   - Store launch/close times in backend SQLite
   - Survive app restarts
   - Retroactively calculate unreads from message history

2. **Advanced Sorting:**
   - Allow user to sort by date, name, or unread count
   - Remember sort preference per conversation

3. **Instance Management:**
   - Rename instances (add custom labels)
   - Delete specific instances (not just whole app)
   - Export/import instance data

4. **Unread Filtering:**
   - Mark all as read for an app
   - Filter sidebar to show only apps with unreads

## Summary

This design fixes the webxdc sidebar by:
- Making the entire app box clickable to open the most recent instance
- Adding "View All" to the kebab menu to expand and show all instances
- Tracking per-instance unreads based on window open/close events
- Filtering out self-sent updates from unread counts
- Displaying accurate badges at instance, group, and conversation levels

The frontend-only approach with event listeners provides the simplest implementation while meeting all requirements. Future persistence can be added without major refactoring if needed.
