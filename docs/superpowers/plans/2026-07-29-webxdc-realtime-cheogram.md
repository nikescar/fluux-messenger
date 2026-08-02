# WebXDC Realtime Channel: Cheogram-Compatible Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the private-MUC-room-based WebXDC realtime channel with Cheogram-compatible direct messages (thread-correlated `<x xmlns="urn:xmpp:webxdc:0"><data>` + `<no-store/>`), while keeping the existing MUC implementation compiled but unused, and fixing the pre-existing stubbed-conversationId bug that blocks the feature from working at all.

**Architecture:** A new SQLite-backed `thread_id` per webxdc instance (minted on first update-send or adopted from a peer's incoming `<thread>`) correlates realtime pings to a specific webxdc app instance without any XMPP-level join/leave traffic — "joining" a realtime channel becomes pure local bookkeeping. Realtime pings are sent as ordinary `<message>` stanzas directly into the conversation the instance belongs to.

**Tech Stack:** Rust (Tauri commands, rusqlite), TypeScript (fluux-sdk `Chat` module, `@xmpp/client` stanza building), React (component prop threading), Vitest, `cargo test`.

## Global Constraints

- Do not modify `apps/fluux/src-tauri/src/webxdc/realtime.rs` or `apps/fluux/src/utils/webxdc/RealtimeChannelManager.ts` (+ its test) — they stay compiled/present but unused.
- Do not restructure the persisted update's `instance`/`serial`/`payload`/`info`/`document`/`summary` fields — only additively parse/emit an optional `thread`.
- Tauri command names and their JS-facing parameter names (`instanceId`, `conversationId`, `selfAddr`, `selfName`, `data`) called from `apps/fluux/src-tauri/src/webxdc/api.rs`'s injected `window.webxdc` API must not change — only the command bodies change.
- Rust tests run via `cargo test` from `apps/fluux/src-tauri/`.
- TS SDK tests run via `cd packages/fluux-sdk && npx vitest run <path>`.
- TS app tests run via `cd apps/fluux && npx vitest run <path>`.
- Follow TDD: write the failing test before the implementation for every unit that has one (Rust storage/manager logic, SDK `Chat.ts`, bridges, the `WebxdcAttachment` fix). Tauri `#[tauri::command]` wrapper bodies are glue with no isolated unit-test surface in this codebase (confirmed: existing command bodies have no dedicated tests, only their underlying logic does) — those are verified by `cargo build`/`cargo test` (no regressions) instead.

---

### Task 1: Rust — persist a thread_id per webxdc instance

**Files:**
- Modify: `apps/fluux/src-tauri/src/webxdc/storage.rs`

**Interfaces:**
- Produces: `WebxdcStorage::get_thread_id(&self, instance_id: &str) -> Result<Option<String>, rusqlite::Error>`, `WebxdcStorage::get_or_create_thread_id(&self, instance_id: &str) -> Result<String, rusqlite::Error>`, `WebxdcStorage::set_thread_id_if_absent(&self, instance_id: &str, thread_id: &str) -> Result<(), rusqlite::Error>`. Task 3 consumes all three.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block at the bottom of `apps/fluux/src-tauri/src/webxdc/storage.rs` (after the existing `test_separate_serials_per_instance` test):

```rust
    #[test]
    fn test_get_or_create_thread_id_mints_once_and_is_stable() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();
        let first = storage.get_or_create_thread_id("instance1").unwrap();
        let second = storage.get_or_create_thread_id("instance1").unwrap();

        assert_eq!(first, second);
        assert!(!first.is_empty());

        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn test_get_or_create_thread_id_differs_per_instance() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();
        let a = storage.get_or_create_thread_id("instance1").unwrap();
        let b = storage.get_or_create_thread_id("instance2").unwrap();

        assert_ne!(a, b);

        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn test_get_thread_id_returns_none_when_unset() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();
        assert_eq!(storage.get_thread_id("nonexistent").unwrap(), None);

        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn test_set_thread_id_if_absent_is_first_write_wins() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();
        storage.set_thread_id_if_absent("instance1", "peer-thread").unwrap();
        storage.set_thread_id_if_absent("instance1", "different-thread").unwrap();

        assert_eq!(storage.get_thread_id("instance1").unwrap(), Some("peer-thread".to_string()));

        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn test_set_thread_id_if_absent_then_get_or_create_reuses_it() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();
        storage.set_thread_id_if_absent("instance1", "peer-thread").unwrap();

        assert_eq!(storage.get_or_create_thread_id("instance1").unwrap(), "peer-thread");

        std::fs::remove_dir_all(&temp).ok();
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux/src-tauri && cargo test webxdc::storage`
Expected: FAIL to compile — `get_or_create_thread_id`, `get_thread_id`, `set_thread_id_if_absent` don't exist yet.

- [ ] **Step 3: Write the minimal implementation**

Add `webxdc_threads` to `SCHEMA_SQL` (after the `webxdc_metadata` table, before the closing `"#`):

```rust
CREATE TABLE IF NOT EXISTS webxdc_metadata (
    instance_id TEXT PRIMARY KEY,
    extract_path TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    last_opened INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webxdc_threads (
    instance_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL
);
"#;
```

Add `use rusqlite::OptionalExtension;` to the top imports (alongside the existing `use rusqlite::{params, Connection};`):

```rust
use rusqlite::{params, Connection, OptionalExtension};
```

Add the three methods to `impl WebxdcStorage` (after `get_stale_instances`, before the closing `}` of the impl block):

```rust
    /// Cheogram-compatible realtime channel: the `<thread>` value correlating
    /// a webxdc app instance's update/realtime messages across peers.
    /// Immutable once set — first write wins, whether that's our own mint or
    /// a value adopted from a peer's incoming message.
    pub fn get_thread_id(&self, instance_id: &str) -> Result<Option<String>, rusqlite::Error> {
        let conn = self.pool.lock().unwrap();
        conn.query_row(
            "SELECT thread_id FROM webxdc_threads WHERE instance_id = ?1",
            params![instance_id],
            |row| row.get(0),
        ).optional()
    }

    /// Returns the instance's thread_id, minting and persisting a fresh UUID
    /// v4 the first time it's called for that instance.
    pub fn get_or_create_thread_id(&self, instance_id: &str) -> Result<String, rusqlite::Error> {
        if let Some(existing) = self.get_thread_id(instance_id)? {
            return Ok(existing);
        }
        let minted = uuid::Uuid::new_v4().to_string();
        self.set_thread_id_if_absent(instance_id, &minted)?;
        // Re-read: if a concurrent caller inserted first, INSERT OR IGNORE
        // above no-op'd and we must return THEIR value, not ours.
        Ok(self.get_thread_id(instance_id)?.unwrap_or(minted))
    }

    /// Persists `thread_id` for `instance_id` only if none is stored yet.
    /// Used to adopt a peer's `<thread>` value from an incoming update.
    pub fn set_thread_id_if_absent(&self, instance_id: &str, thread_id: &str) -> Result<(), rusqlite::Error> {
        let conn = self.pool.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO webxdc_threads (instance_id, thread_id) VALUES (?1, ?2)",
            params![instance_id, thread_id],
        )?;
        Ok(())
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux/src-tauri && cargo test webxdc::storage`
Expected: PASS — all 5 new tests plus the 2 pre-existing ones green.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src-tauri/src/webxdc/storage.rs
git commit -m "feat(webxdc): persist per-instance thread_id for realtime correlation"
```

---

### Task 2: Rust — local-bookkeeping realtime join manager

**Files:**
- Create: `apps/fluux/src-tauri/src/webxdc/realtime_thread.rs`

**Interfaces:**
- Produces: `ThreadRealtimeManager::new() -> Self`, `.join(instance_id: String, conversation_id: String, thread_id: String)`, `.get(instance_id: &str) -> Option<(String, String)>` (returns `(conversation_id, thread_id)`), `.leave(instance_id: &str) -> Option<(String, String)>`. Task 3 consumes all four.

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src-tauri/src/webxdc/realtime_thread.rs`:

```rust
use std::collections::HashMap;
use std::sync::Mutex;

/// Tracks webxdc instances currently "joined" to the Cheogram-compatible
/// realtime channel. Unlike the legacy MUC-based `RealtimeChannelManager`,
/// join/leave involve no XMPP traffic at all — this is pure local
/// bookkeeping used to route incoming thread-tagged messages back to the
/// right webxdc instance while its window is open.
pub struct ThreadRealtimeManager {
    instances: Mutex<HashMap<String, InstanceChannel>>,
}

struct InstanceChannel {
    conversation_id: String,
    thread_id: String,
}

impl ThreadRealtimeManager {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
        }
    }

    /// Registers (or re-registers) an instance as joined. Idempotent —
    /// rejoining simply overwrites the previous mapping.
    pub fn join(&self, instance_id: String, conversation_id: String, thread_id: String) {
        let mut instances = self.instances.lock().unwrap();
        instances.insert(instance_id, InstanceChannel { conversation_id, thread_id });
    }

    /// Returns `(conversation_id, thread_id)` for a joined instance.
    pub fn get(&self, instance_id: &str) -> Option<(String, String)> {
        let instances = self.instances.lock().unwrap();
        instances.get(instance_id).map(|c| (c.conversation_id.clone(), c.thread_id.clone()))
    }

    /// Unregisters an instance, returning its last `(conversation_id, thread_id)`.
    pub fn leave(&self, instance_id: &str) -> Option<(String, String)> {
        let mut instances = self.instances.lock().unwrap();
        instances.remove(instance_id).map(|c| (c.conversation_id, c.thread_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_join_then_get() {
        let manager = ThreadRealtimeManager::new();
        manager.join("instance1".into(), "conv1".into(), "thread1".into());

        assert_eq!(
            manager.get("instance1"),
            Some(("conv1".to_string(), "thread1".to_string()))
        );
    }

    #[test]
    fn test_get_unknown_instance_returns_none() {
        let manager = ThreadRealtimeManager::new();
        assert_eq!(manager.get("nonexistent"), None);
    }

    #[test]
    fn test_leave_removes_and_returns_mapping() {
        let manager = ThreadRealtimeManager::new();
        manager.join("instance1".into(), "conv1".into(), "thread1".into());

        let left = manager.leave("instance1");

        assert_eq!(left, Some(("conv1".to_string(), "thread1".to_string())));
        assert_eq!(manager.get("instance1"), None);
    }

    #[test]
    fn test_leave_unknown_instance_returns_none() {
        let manager = ThreadRealtimeManager::new();
        assert_eq!(manager.leave("nonexistent"), None);
    }

    #[test]
    fn test_rejoin_after_leave_overwrites_mapping() {
        let manager = ThreadRealtimeManager::new();
        manager.join("instance1".into(), "conv1".into(), "thread1".into());
        manager.leave("instance1");
        manager.join("instance1".into(), "conv2".into(), "thread2".into());

        assert_eq!(
            manager.get("instance1"),
            Some(("conv2".to_string(), "thread2".to_string()))
        );
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux/src-tauri && cargo test webxdc::realtime_thread`
Expected: FAIL to compile — the module isn't wired into `mod.rs` yet (`error[E0433]: failed to resolve: use of undeclared crate or module `realtime_thread``, or the test binary simply won't find the module). This is expected; proceed to Step 3.

- [ ] **Step 3: Wire the module in**

In `apps/fluux/src-tauri/src/webxdc/mod.rs`, add the module declaration next to the existing `pub mod realtime;` (do not remove that line):

```rust
pub mod realtime;
pub mod realtime_thread;
```

And export it next to the existing realtime re-export (do not remove that line):

```rust
pub use realtime::RealtimeChannelManager;
pub use realtime_thread::ThreadRealtimeManager;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux/src-tauri && cargo test webxdc::realtime_thread`
Expected: PASS — all 5 tests green. Also run `cargo test webxdc::realtime` to confirm the legacy MUC manager's own tests are untouched and still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src-tauri/src/webxdc/realtime_thread.rs apps/fluux/src-tauri/src/webxdc/mod.rs
git commit -m "feat(webxdc): add local-bookkeeping realtime join manager"
```

---

### Task 3: Rust — rewrite mod.rs command bodies to use thread-based realtime

**Files:**
- Modify: `apps/fluux/src-tauri/src/webxdc/mod.rs`

**Interfaces:**
- Consumes: `WebxdcStorage::get_or_create_thread_id`/`set_thread_id_if_absent` (Task 1), `ThreadRealtimeManager::join`/`get`/`leave` (Task 2).
- Produces: `SendUpdateResult { serial: i64, thread_id: String }` (Task 9's `xmppBridge.ts` update consumes this), event payloads `ThreadJoinEvent { instance_id, conversation_id, thread_id }`, `ThreadSendEvent { conversation_id, thread_id, data }`, `ThreadLeaveEvent { instance_id }` emitted on `fluux://webxdc-realtime-join`/`-send`/`-leave` (Task 8's `realtimeBridge.ts` rewrite consumes these), and `webxdc_receive_update` gains an optional `thread_id: Option<String>` parameter (Task 7's `xmppBridge.ts` passes `threadId`).

- [ ] **Step 1: Add `WebxdcState.thread_realtime_manager` and drop the legacy manager from active wiring**

In `WebxdcState`, add the new field (keep the existing `realtime_manager` field too — it stays compiled but nothing calls it after this task):

```rust
pub struct WebxdcState {
    pub windows: Arc<Mutex<HashMap<String, String>>>,
    pub storage: Arc<WebxdcStorage>,
    pub cleanup_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
    pub realtime_manager: Arc<RealtimeChannelManager>,
    pub thread_realtime_manager: Arc<ThreadRealtimeManager>,
}
```

In `initialize_webxdc_state`, construct it and include it in the returned struct:

```rust
    let realtime_manager = Arc::new(RealtimeChannelManager::new());
    let thread_realtime_manager = Arc::new(ThreadRealtimeManager::new());

    WebxdcState {
        windows,
        storage,
        cleanup_handle,
        realtime_manager,
        thread_realtime_manager,
    }
```

- [ ] **Step 2: Replace the join/send/leave event structs**

Replace the existing `JoinRealtimeEvent`, `RealtimeSendEvent`, `RealtimeLeaveEvent` struct definitions (near the top of the file, before `WebxdcState`) with:

```rust
#[derive(serde::Serialize, Clone)]
struct ThreadJoinEvent {
    instance_id: String,
    conversation_id: String,
    thread_id: String,
}

#[derive(serde::Serialize, Clone)]
struct ThreadSendEvent {
    conversation_id: String,
    thread_id: String,
    data: String,
}

#[derive(serde::Serialize, Clone)]
struct ThreadLeaveEvent {
    instance_id: String,
}
```

(`RealtimeMessageEvent` is unchanged and still used by `webxdc_realtime_receive` — leave it as-is.)

- [ ] **Step 3: Rewrite `webxdc_close_window`'s leave call**

Change:

```rust
    // Leave realtime channel if joined
    if let Some(room_jid) = state.realtime_manager.leave(&instance_id) {
        let _ = app_handle.emit("fluux://webxdc-realtime-leave", RealtimeLeaveEvent {
            room_jid,
        });
    }
```

to:

```rust
    // Leave realtime channel if joined
    if state.thread_realtime_manager.leave(&instance_id).is_some() {
        let _ = app_handle.emit("fluux://webxdc-realtime-leave", ThreadLeaveEvent {
            instance_id: instance_id.clone(),
        });
    }
```

- [ ] **Step 4: Rewrite `webxdc_realtime_join`**

Replace the whole function body:

```rust
#[tauri::command]
pub async fn webxdc_realtime_join(
    instance_id: String,
    conversation_id: String,
    _self_addr: String,
    _self_name: String,
    app_handle: AppHandle,
    state: State<'_, WebxdcState>,
) -> Result<(), String> {
    let thread_id = state.storage.get_or_create_thread_id(&instance_id)
        .map_err(|e| e.to_string())?;

    state.thread_realtime_manager.join(instance_id.clone(), conversation_id.clone(), thread_id.clone());

    app_handle.emit("fluux://webxdc-realtime-join", ThreadJoinEvent {
        instance_id,
        conversation_id,
        thread_id,
    }).map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(())
}
```

- [ ] **Step 5: Rewrite `webxdc_realtime_send`**

```rust
#[tauri::command]
pub async fn webxdc_realtime_send(
    instance_id: String,
    data: String, // base64-encoded
    app_handle: AppHandle,
    state: State<'_, WebxdcState>,
) -> Result<(), String> {
    let (conversation_id, thread_id) = state.thread_realtime_manager
        .get(&instance_id)
        .ok_or_else(|| "Not joined to any channel".to_string())?;

    app_handle.emit("fluux://webxdc-realtime-send", ThreadSendEvent {
        conversation_id,
        thread_id,
        data,
    }).map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(())
}
```

- [ ] **Step 6: Rewrite `webxdc_realtime_leave`**

```rust
#[tauri::command]
pub async fn webxdc_realtime_leave(
    instance_id: String,
    app_handle: AppHandle,
    state: State<'_, WebxdcState>,
) -> Result<(), String> {
    if state.thread_realtime_manager.leave(&instance_id).is_some() {
        app_handle.emit("fluux://webxdc-realtime-leave", ThreadLeaveEvent {
            instance_id,
        }).map_err(|e| format!("Failed to emit event: {}", e))?;
    }

    Ok(())
}
```

(`webxdc_realtime_receive` is unchanged — leave it exactly as-is.)

- [ ] **Step 7: Thread the thread_id through `webxdc_send_update`**

Add this struct near the top of the file, next to the other small result/event structs:

```rust
#[derive(serde::Serialize)]
pub struct SendUpdateResult {
    pub serial: i64,
    pub thread_id: String,
}
```

Change `webxdc_send_update`'s signature return type from `Result<(), String>` to `Result<SendUpdateResult, String>`. After the existing `let saved = state.storage.save_update(&instance_id, update).map_err(|e| e.to_string())?;` line, add:

```rust
    let thread_id = state.storage.get_or_create_thread_id(&instance_id)
        .map_err(|e| e.to_string())?;
```

Add `thread_id: String,` as a new field on the existing local `OutgoingUpdateEvent` struct (defined inline inside this function), and set it when constructing `event`:

```rust
    #[derive(serde::Serialize, Clone)]
    struct OutgoingUpdateEvent {
        instance_id: String,
        serial: i64,
        payload: serde_json::Value,
        info: Option<String>,
        document: Option<String>,
        summary: Option<String>,
        sender: String,
        thread_id: String,
    }

    let event = OutgoingUpdateEvent {
        instance_id: instance_id.clone(),
        serial: saved.serial,
        payload,
        info,
        document,
        summary,
        sender: sender_id,
        thread_id: thread_id.clone(),
    };
```

Change the function's final `Ok(())` to:

```rust
    Ok(SendUpdateResult { serial: saved.serial, thread_id })
```

- [ ] **Step 8: Thread an optional thread_id through `webxdc_receive_update`**

Add a new parameter `thread_id: Option<String>,` to `webxdc_receive_update`'s signature (after `timestamp: i64,`). After the existing `let saved = state.storage.save_update(&instance_id, update).map_err(|e| e.to_string())?;` line, add:

```rust
    if let Some(tid) = thread_id.as_deref() {
        state.storage.set_thread_id_if_absent(&instance_id, tid)
            .map_err(|e| e.to_string())?;
    }
```

- [ ] **Step 9: Build and run the full Rust test suite**

Run: `cd apps/fluux/src-tauri && cargo build && cargo test`
Expected: builds cleanly, all existing tests (including `webxdc::realtime`'s untouched legacy tests, `webxdc::storage`, `webxdc::realtime_thread`) pass.

- [ ] **Step 10: Commit**

```bash
git add apps/fluux/src-tauri/src/webxdc/mod.rs
git commit -m "feat(webxdc): rewire realtime join/send/leave and update thread plumbing"
```

---

### Task 4: SDK — add `thread` to the `webxdc:update` event and a new `webxdc:realtime` event type

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/sdk-events.ts`

**Interfaces:**
- Produces: `'webxdc:update'` event gains optional `thread?: string`; new `'webxdc:realtime'` event `{ from: string; thread?: string; data: string }`. Task 5 emits both, Task 7/8 (bridges) consume both.

- [ ] **Step 1: Modify the type definitions**

Change the existing `'webxdc:update'` entry (around line 307) to:

```ts
  'webxdc:update': {
    from: string
    instance: string
    serial: number
    payload: unknown
    info?: string
    document?: string
    summary?: string
    sender: string
    /** XMPP `<thread>`, if the peer included one — correlates realtime pings. */
    thread?: string
  }

  /**
   * Ephemeral WebXDC realtime data frame (Cheogram-compatible realtime
   * channel: `<x xmlns="urn:xmpp:webxdc:0"><data>`). Not persisted; not a
   * chat message. Correlated to a specific webxdc instance via `thread`.
   */
  'webxdc:realtime': {
    from: string
    thread?: string
    data: string
  }
```

There's no test file for this pure type-definitions file (verified by the build in the next step, plus Task 5/6's tests exercising the shape).

- [ ] **Step 2: Typecheck**

Run: `cd packages/fluux-sdk && npx tsc --noEmit`
Expected: no new errors (this task only adds fields/a new key to an existing map type).

- [ ] **Step 3: Commit**

```bash
git add packages/fluux-sdk/src/core/types/sdk-events.ts
git commit -m "feat(sdk): add thread field and webxdc:realtime event type"
```

---

### Task 5: SDK — detect realtime frames on receive, thread updates too

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts:218-248`
- Test: `packages/fluux-sdk/src/core/modules/Chat.webxdc.test.ts`

**Interfaces:**
- Consumes: `NS_WEBXDC`, `NS_HINTS` (already imported in `Chat.ts`), `webxdc:update`/`webxdc:realtime` event shapes (Task 4).
- Produces: incoming `<x xmlns="urn:xmpp:webxdc:0"><data>...</data></x>` + `<thread>` emits `webxdc:realtime` and returns `{handled: true}` without falling through to chat-message handling; incoming update `<x>` (with `instance`/`serial`/`payload`) additionally reads a sibling `<thread>` and includes it on the emitted `webxdc:update` event.

- [ ] **Step 1: Write the failing tests**

Add to `packages/fluux-sdk/src/core/modules/Chat.webxdc.test.ts`, as new top-level `describe` blocks after the existing `describe('E2EE encryption', ...)` block (still inside the outer `describe('Chat WebXDC stanza handling', ...)`):

```ts
  describe('realtime channel (Cheogram-compatible)', () => {
    it('should emit webxdc:realtime (not webxdc:update) for a data frame', () => {
      const stanza = xml('message', {
        from: 'alice@example.com/resource',
        to: 'me@example.com',
        type: 'chat'
      },
        xml('x', { xmlns: NS_WEBXDC },
          xml('data', {}, 'YmFzZTY0LWJ5dGVz')
        ),
        xml('thread', {}, 'thread-abc')
      )

      const handled = (chat as any).handleMessage(stanza)

      expect(handled).toBe(true)
      expect(mockDeps.emitSDK).toHaveBeenCalledWith('webxdc:realtime', {
        from: 'alice@example.com',
        thread: 'thread-abc',
        data: 'YmFzZTY0LWJ5dGVz'
      })
      expect(mockDeps.emitSDK).not.toHaveBeenCalledWith('webxdc:update', expect.anything())
    })

    it('should not emit anything for a realtime frame without a from attribute', () => {
      const stanza = xml('message', { type: 'chat' },
        xml('x', { xmlns: NS_WEBXDC }, xml('data', {}, 'ZGF0YQ==')),
        xml('thread', {}, 'thread-abc')
      )

      const handled = (chat as any).handleMessage(stanza)

      expect(handled).toBe(true)
      expect(mockDeps.emitSDK).not.toHaveBeenCalled()
    })

    it('should handle a realtime frame with no thread element', () => {
      const stanza = xml('message', { from: 'bob@example.com', type: 'chat' },
        xml('x', { xmlns: NS_WEBXDC }, xml('data', {}, 'ZGF0YQ=='))
      )

      const handled = (chat as any).handleMessage(stanza)

      expect(handled).toBe(true)
      expect(mockDeps.emitSDK).toHaveBeenCalledWith('webxdc:realtime', {
        from: 'bob@example.com',
        thread: undefined,
        data: 'ZGF0YQ=='
      })
    })

    it('should include thread on webxdc:update when the update stanza carries one', () => {
      const stanza = xml('message', { from: 'alice@example.com', type: 'chat' },
        xml('x', { xmlns: NS_WEBXDC },
          xml('instance', {}, 'conv123:https://example.com/app.xdc'),
          xml('serial', {}, '1'),
          xml('payload', {}, '{}')
        ),
        xml('thread', {}, 'thread-xyz')
      )

      const handled = (chat as any).handleMessage(stanza)

      expect(handled).toBe(true)
      expect(mockDeps.emitSDK).toHaveBeenCalledWith('webxdc:update', expect.objectContaining({
        thread: 'thread-xyz'
      }))
    })

    it('should leave thread undefined on webxdc:update when absent (regression check)', () => {
      const stanza = xml('message', { from: 'alice@example.com', type: 'chat' },
        xml('x', { xmlns: NS_WEBXDC },
          xml('instance', {}, 'test-instance'),
          xml('serial', {}, '1'),
          xml('payload', {}, '{}')
        )
      )

      const handled = (chat as any).handleMessage(stanza)

      expect(handled).toBe(true)
      expect(mockDeps.emitSDK).toHaveBeenCalledWith('webxdc:update', expect.objectContaining({
        thread: undefined
      }))
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.webxdc.test.ts`
Expected: FAIL — the 5 new tests fail (no `webxdc:realtime` event is ever emitted yet; `thread` is never read).

- [ ] **Step 3: Write the minimal implementation**

In `packages/fluux-sdk/src/core/modules/Chat.ts`, replace the block from `// XEP-0491: WebXDC update detection` (line 218) through its closing `return { handled: true }` (line 248) with:

```ts
    // XEP-0491 / Cheogram-compatible WebXDC: both persisted updates and
    // ephemeral realtime frames share the `urn:xmpp:webxdc:0` namespace on
    // <x>, distinguished by a <data> child (realtime) vs <instance>/<serial>/
    // <payload> children (update). Both may carry a sibling <thread> used to
    // correlate them to a specific webxdc app instance.
    const webxdcElement = stanza.getChild('x', NS_WEBXDC)
    if (webxdcElement) {
      const from = stanza.attrs.from
      const bareFrom = from ? getBareJid(from) : undefined
      const threadText = stanza.getChildText('thread') || undefined

      const dataElement = webxdcElement.getChild('data')
      if (dataElement) {
        // Ephemeral realtime frame: no chat bubble, no persistence.
        if (bareFrom) {
          this.deps.emitSDK('webxdc:realtime', {
            from: bareFrom,
            thread: threadText,
            data: webxdcElement.getChildText('data') || ''
          })
        }
        return { handled: true }
      }

      if (bareFrom) {
        const instanceId = webxdcElement.getChildText('instance') || ''
        const serialText = webxdcElement.getChildText('serial') || '0'
        const payloadText = webxdcElement.getChildText('payload') || '{}'

        let payload: unknown = {}
        try {
          payload = JSON.parse(payloadText)
        } catch (err) {
          console.warn('[Chat] Failed to parse WebXDC payload:', err)
        }

        this.deps.emitSDK('webxdc:update', {
          from: bareFrom,
          instance: instanceId,
          serial: parseInt(serialText, 10),
          payload,
          info: webxdcElement.getChildText('info') || undefined,
          document: webxdcElement.getChildText('document') || undefined,
          summary: webxdcElement.getChildText('summary') || undefined,
          sender: from || bareFrom,
          thread: threadText
        })
      }
      return { handled: true }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.webxdc.test.ts`
Expected: PASS — all tests (the 3 pre-existing plus 5 new) green.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.webxdc.test.ts
git commit -m "feat(sdk): detect webxdc realtime frames on receive, thread updates"
```

---

### Task 6: SDK — `sendWebxdcRealtime` (bodiless, no local echo, E2EE-aware)

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts`
- Test: `packages/fluux-sdk/src/core/modules/Chat.webxdc.test.ts`

**Interfaces:**
- Consumes: `Chat.E2EE_PROTECTED_CHILD_KEYS` (already includes `` `x|${NS_WEBXDC}` ``, `Chat.ts:782`), `applyE2EEToOutboundChat` (`Chat.ts:559`).
- Produces: `Chat.sendWebxdcRealtime(to: string, type: 'chat' | 'groupchat', thread: string, data: string): Promise<void>`. Task 8's `realtimeBridge.ts` calls this.

- [ ] **Step 1: Write the failing tests**

Add to `packages/fluux-sdk/src/core/modules/Chat.webxdc.test.ts`, inside the `describe('realtime channel (Cheogram-compatible)', ...)` block added in Task 5, after the existing tests:

```ts
    it('should build the expected stanza shape for a 1:1 send with no E2EE', async () => {
      await chat.sendWebxdcRealtime('user@example.com', 'chat', 'thread-1', 'ZGF0YQ==')

      expect(mockDeps.sendStanza).toHaveBeenCalledTimes(1)
      const sentStanza = mockDeps.sendStanza.mock.calls[0][0]

      expect(sentStanza.attrs.to).toBe('user@example.com')
      expect(sentStanza.attrs.type).toBe('chat')

      const x = sentStanza.getChild('x', NS_WEBXDC)
      expect(x?.getChildText('data')).toBe('ZGF0YQ==')
      expect(sentStanza.getChildText('thread')).toBe('thread-1')
      expect(sentStanza.getChild('no-store', 'urn:xmpp:hints')).toBeDefined()
      // No local echo: a realtime ping must never surface as a chat bubble.
      expect(mockDeps.emitSDK).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })

    it('should build the expected stanza shape for a groupchat send', async () => {
      await chat.sendWebxdcRealtime('room@conference.example.com', 'groupchat', 'thread-2', 'Zm9v')

      const sentStanza = mockDeps.sendStanza.mock.calls[0][0]

      expect(sentStanza.attrs.to).toBe('room@conference.example.com')
      expect(sentStanza.attrs.type).toBe('groupchat')
      expect(sentStanza.getChild('x', NS_WEBXDC)?.getChildText('data')).toBe('Zm9v')
      expect(sentStanza.getChildText('thread')).toBe('thread-2')
      expect(sentStanza.getChild('no-store', 'urn:xmpp:hints')).toBeDefined()
    })

    it('should encrypt the x element for a 1:1 peer that can receive E2EE', async () => {
      const mockE2EEManager = {
        canEncryptTo: vi.fn().mockResolvedValue(true),
        encryptOutbound: vi.fn().mockResolvedValue({
          plugin: { descriptor: { id: 'test-e2ee' } },
          payload: {
            stanzaElement: { name: 'encrypted', attrs: { xmlns: 'test:encrypted' }, children: [] },
            fallbackBody: '[encrypted message]',
            protocolId: 'test-e2ee'
          }
        }),
        assertPlaintextPermitted: vi.fn().mockResolvedValue(undefined)
      }
      mockDeps.getE2EEManager = vi.fn().mockReturnValue(mockE2EEManager)

      await chat.sendWebxdcRealtime('user@example.com', 'chat', 'thread-3', 'c2VjcmV0')

      const sentStanza = mockDeps.sendStanza.mock.calls[0][0]

      expect(sentStanza.getChild('x', NS_WEBXDC)).toBeUndefined()
      expect(sentStanza.getChild('encrypted', 'test:encrypted')).toBeDefined()

      const plaintext = new TextDecoder().decode(mockE2EEManager.encryptOutbound.mock.calls[0][1])
      expect(plaintext).toContain('urn:xmpp:webxdc:0')
      expect(plaintext).toContain('c2VjcmV0')
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.webxdc.test.ts`
Expected: FAIL — `chat.sendWebxdcRealtime is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Add to the `Chat` class in `packages/fluux-sdk/src/core/modules/Chat.ts`, right after the closing brace of `sendCustomMessage` (after line 1088):

```ts
  /**
   * Send an ephemeral WebXDC realtime data frame (Cheogram-compatible
   * realtime channel: `window.webxdc.joinRealtimeChannel().send()`).
   *
   * Unlike {@link sendCustomMessage}, this never emits a `chat:message`/
   * local-echo event — realtime pings are not chat messages and must not
   * create a bubble, and a webxdc app may send many of these per second.
   * XEP-0334 `<no-store/>` keeps them off MAM; `<thread>` correlates the
   * frame to a specific webxdc app instance across both peers.
   *
   * @param to - Recipient JID (bare JID for 1:1, room JID for groupchat)
   * @param type - Message type: 'chat' or 'groupchat'
   * @param thread - Correlation id shared with the instance's update messages
   * @param data - Base64-encoded payload bytes
   */
  async sendWebxdcRealtime(
    to: string,
    type: 'chat' | 'groupchat',
    thread: string,
    data: string
  ): Promise<void> {
    const recipient = type === 'chat' ? getBareJid(to) : to
    const id = generateUUID()

    const children: Element[] = [
      xml('x', { xmlns: NS_WEBXDC }, xml('data', {}, data)),
      xml('thread', {}, thread),
    ]

    const manager = this.deps.getE2EEManager?.()
    let peerCanEncrypt = false
    if (type === 'chat' && manager) {
      peerCanEncrypt = await manager
        .canEncryptTo({ kind: 'direct', peer: recipient })
        .catch(() => false)
    }

    if (type === 'chat' && peerCanEncrypt) {
      // Encrypted path: applyE2EEToOutboundChat adds its own <no-store/>
      // hint (via storeHint) once encryption actually succeeds.
      await this.applyE2EEToOutboundChat(recipient, '', children, Chat.E2EE_PROTECTED_CHILD_KEYS, {
        encryptBody: false,
        outerBody: 'remove',
        storeHint: 'no-store',
      })
    } else {
      children.push(xml('no-store', { xmlns: NS_HINTS }))
    }

    const message = xml('message', { to: recipient, type, id }, ...children)
    await this.deps.sendStanza(message)
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.webxdc.test.ts`
Expected: PASS — all tests (8 pre-existing/Task-5 plus 3 new) green.

- [ ] **Step 5: Run the full SDK test suite**

Run: `cd packages/fluux-sdk && npx vitest run`
Expected: PASS — no regressions in unrelated `Chat.ts` tests.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.webxdc.test.ts
git commit -m "feat(sdk): add sendWebxdcRealtime for the Cheogram-compatible realtime channel"
```

---

### Task 7: Frontend — thread wiring through the persisted-update bridge

**Files:**
- Modify: `apps/fluux/src/utils/webxdc/xmppBridge.ts`
- Test: `apps/fluux/src/utils/webxdc/xmppBridge.test.ts`

**Interfaces:**
- Consumes: `SendUpdateResult { serial, thread_id }` (Task 3), `webxdc:update` event now carrying `thread?: string` (Task 4/5).
- Produces: `sendWebxdcUpdateViaXMPP` gains an 8th optional `thread?: string` parameter; outgoing update stanzas gain a sibling `<thread>` when a thread_id is known; `webxdc_receive_update` invoke calls gain a `threadId` argument when the incoming update carried one.

- [ ] **Step 1: Write the failing tests**

Add to `apps/fluux/src/utils/webxdc/xmppBridge.test.ts`, inside the existing `describe('sendWebxdcUpdate', ...)` block, after its last test:

```ts
    it('should include a <thread> element when Rust returns a thread_id', async () => {
      vi.mocked(invoke).mockResolvedValue({ serial: 1, thread_id: 'thread-abc' })

      const { initializeXmppBridge, sendWebxdcUpdate } = await import('./xmppBridge')
      initializeXmppBridge(mockClient as any, mockUploadFile)

      await sendWebxdcUpdate('conv123:https://example.com/app.xdc', { a: 1 }, 'info', undefined, undefined, 'user@example.com')

      const customChildren = mockSendCustomMessage.mock.calls[0][3]
      expect(customChildren).toHaveLength(2)

      const threadElement = customChildren[1]
      expect(threadElement.name).toBe('thread')
      expect(threadElement.children[0]).toBe('thread-abc')
    })

    it('should omit the <thread> element when Rust returns no thread_id', async () => {
      vi.mocked(invoke).mockResolvedValue({ serial: 1 })

      const { initializeXmppBridge, sendWebxdcUpdate } = await import('./xmppBridge')
      initializeXmppBridge(mockClient as any, mockUploadFile)

      await sendWebxdcUpdate('test:app', {}, undefined, undefined, undefined, 'me@example.com')

      const customChildren = mockSendCustomMessage.mock.calls[0][3]
      expect(customChildren).toHaveLength(1)
    })
```

Add to the existing `describe('incoming updates', ...)` block, after its last test:

```ts
    it('should forward thread to webxdc_receive_update when the incoming update carries one', async () => {
      const { initializeXmppBridge } = await import('./xmppBridge')

      let webxdcUpdateHandler: Function | undefined
      const mockOn = vi.fn((event, handler) => {
        if (event === 'webxdc:update') webxdcUpdateHandler = handler
      })
      const clientWithEvents = { ...mockClient, on: mockOn }

      initializeXmppBridge(clientWithEvents as any, mockUploadFile)

      await webxdcUpdateHandler!({
        from: 'alice@example.com',
        instance: 'conv123:app.xdc',
        serial: 2,
        payload: {},
        sender: 'alice@example.com',
        thread: 'thread-xyz'
      })

      expect(invoke).toHaveBeenCalledWith('webxdc_receive_update', expect.objectContaining({
        instanceId: 'conv123:app.xdc',
        threadId: 'thread-xyz'
      }))
    })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/utils/webxdc/xmppBridge.test.ts`
Expected: FAIL — 3 new tests fail (no `<thread>` is ever built or forwarded yet).

- [ ] **Step 3: Write the minimal implementation**

In `apps/fluux/src/utils/webxdc/xmppBridge.ts`:

Add `thread?: string` to the `WebxdcUpdate` interface:

```ts
export interface WebxdcUpdate {
  serial: number
  max_serial: number
  payload: unknown
  info?: string
  document?: string
  summary?: string
  sender: string
  thread?: string
}
```

Add `thread_id: string` to the `OutgoingUpdateEvent` interface:

```ts
interface OutgoingUpdateEvent {
  instance_id: string
  serial: number
  payload: unknown
  info?: string
  document?: string
  summary?: string
  sender: string
  thread_id: string
}
```

In the `fluux://webxdc-outgoing-update` listener, pass `update.thread_id` through:

```ts
      await sendWebxdcUpdateViaXMPP(
        conversationId,
        update.instance_id,
        update.serial,
        update.payload,
        update.info,
        update.document,
        update.summary,
        update.thread_id
      )
```

In the `webxdc:update` SDK-event listener, destructure and pass `thread`:

```ts
  xmppClient.on('webxdc:update' as any, async (event: any) => {
    const { instance, serial, payload, info, document, summary, sender, thread } = event

    try {
      await receiveWebxdcUpdate(instance, {
        serial,
        max_serial: serial,
        payload,
        info,
        document,
        summary,
        sender,
        thread
      })
      console.log('[webxdc] Incoming update received:', instance, serial)
    } catch (error) {
      console.error('[webxdc] Failed to process incoming update:', error)
    }
  })
```

Change `sendWebxdcUpdateViaXMPP`'s signature to accept `thread` and push it as a sibling of the `<x>` element:

```ts
async function sendWebxdcUpdateViaXMPP(
  conversationId: string,
  instanceId: string,
  serial: number,
  payload: unknown,
  info?: string,
  document?: string,
  summary?: string,
  thread?: string
): Promise<void> {
  if (!xmppClient) {
    throw new Error('XMPP client not initialized')
  }

  const updateChildren = [
    xml('instance', {}, instanceId),
    xml('serial', {}, serial.toString()),
    xml('payload', {}, JSON.stringify(payload))
  ]

  if (info) {
    updateChildren.push(xml('info', {}, info))
  }
  if (document) {
    updateChildren.push(xml('document', {}, document))
  }
  if (summary) {
    updateChildren.push(xml('summary', {}, summary))
  }

  const updateElement = xml('x', { xmlns: NS_WEBXDC }, ...updateChildren)

  const customChildren = [updateElement]
  if (thread) {
    customChildren.push(xml('thread', {}, thread))
  }

  const body = `[WebXDC Update: ${info || 'update'}]`

  await (xmppClient.chat as any).sendCustomMessage(
    conversationId,
    body,
    'chat',
    customChildren
  )

  console.log('[webxdc] Update transmitted via XMPP:', instanceId, serial)
}
```

Update `sendWebxdcUpdate` to read `thread_id` from Rust's response and pass it through:

```ts
export async function sendWebxdcUpdate(
  instanceId: string,
  payload: unknown,
  info?: string,
  document?: string,
  summary?: string,
  senderId?: string
): Promise<void> {
  const jid = connectionStore.getState().jid
  const actualSenderId = senderId || jid || 'unknown@example.com'

  const result = await invoke<{ serial: number; thread_id?: string }>('webxdc_send_update', {
    instanceId,
    payload,
    info,
    document,
    summary,
    senderId: actualSenderId
  })

  const conversationId = instanceId.split(':')[0]

  await sendWebxdcUpdateViaXMPP(
    conversationId,
    instanceId,
    result.serial,
    payload,
    info,
    document,
    summary,
    result.thread_id
  )

  console.log('[webxdc] Update stored and transmitted:', instanceId, result.serial)
}
```

Update `receiveWebxdcUpdate` to forward `threadId`:

```ts
export async function receiveWebxdcUpdate(
  instanceId: string,
  update: WebxdcUpdate
): Promise<void> {
  await invoke('webxdc_receive_update', {
    instanceId,
    payload: update.payload,
    info: update.info,
    document: update.document,
    summary: update.summary,
    senderId: update.sender,
    timestamp: Math.floor(Date.now() / 1000),
    threadId: update.thread
  })

  console.log('[webxdc] Update received from XMPP and distributed:', instanceId)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/utils/webxdc/xmppBridge.test.ts`
Expected: PASS — all tests (pre-existing plus 3 new) green.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/webxdc/xmppBridge.ts apps/fluux/src/utils/webxdc/xmppBridge.test.ts
git commit -m "feat(webxdc): thread persisted updates for realtime correlation"
```

---

### Task 8: Frontend — rewrite `realtimeBridge.ts` to drop the MUC channel

**Files:**
- Modify: `apps/fluux/src/utils/webxdc/realtimeBridge.ts`
- Create: `apps/fluux/src/utils/webxdc/realtimeBridge.test.ts`

**Interfaces:**
- Consumes: `Chat.sendWebxdcRealtime` (Task 6), `isMucJid` (`@fluux/sdk`), events `fluux://webxdc-realtime-join`/`-send`/`-leave` with `ThreadJoinEvent`/`ThreadSendEvent`/`ThreadLeaveEvent` shapes (Task 3), SDK event `webxdc:realtime` (Task 5).
- Produces: `initializeRealtimeBridge(client: XMPPClient): void` (same exported signature as before — no caller changes needed in `App.tsx`).

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/utils/webxdc/realtimeBridge.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { XMPPClient } from '@fluux/sdk/core'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

const listenHandlers = new Map<string, (event: { payload: any }) => void>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((eventName: string, handler: (event: { payload: any }) => void) => {
    listenHandlers.set(eventName, handler)
    return Promise.resolve(() => {})
  })
}))

vi.mock('@fluux/sdk', () => ({
  isMucJid: (jid: string) => jid.includes('@conference.')
}))

describe('realtimeBridge', () => {
  let mockClient: Partial<XMPPClient>
  let mockSendWebxdcRealtime: ReturnType<typeof vi.fn>
  let realtimeHandler: ((event: any) => void) | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    listenHandlers.clear()
    vi.mocked(invoke).mockResolvedValue(undefined)

    mockSendWebxdcRealtime = vi.fn().mockResolvedValue(undefined)
    mockClient = {
      chat: { sendWebxdcRealtime: mockSendWebxdcRealtime } as any,
      on: vi.fn((event: string, handler: any) => {
        if (event === 'webxdc:realtime') realtimeHandler = handler
      })
    }

    vi.resetModules()
    const { initializeRealtimeBridge } = await import('./realtimeBridge')
    initializeRealtimeBridge(mockClient as any)
  })

  it('registers the thread on join without any XMPP or Tauri call', () => {
    listenHandlers.get('fluux://webxdc-realtime-join')!({
      payload: { instance_id: 'inst1', conversation_id: 'bob@example.com', thread_id: 'thread1' }
    })

    expect(mockSendWebxdcRealtime).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('sends via sendWebxdcRealtime as chat for a 1:1 conversation', async () => {
    await listenHandlers.get('fluux://webxdc-realtime-send')!({
      payload: { conversation_id: 'bob@example.com', thread_id: 'thread1', data: 'YmFzZTY0' }
    })

    expect(mockSendWebxdcRealtime).toHaveBeenCalledWith('bob@example.com', 'chat', 'thread1', 'YmFzZTY0')
  })

  it('sends via sendWebxdcRealtime as groupchat for a MUC conversation', async () => {
    await listenHandlers.get('fluux://webxdc-realtime-send')!({
      payload: { conversation_id: 'room@conference.example.com', thread_id: 'thread2', data: 'ZGF0YQ==' }
    })

    expect(mockSendWebxdcRealtime).toHaveBeenCalledWith('room@conference.example.com', 'groupchat', 'thread2', 'ZGF0YQ==')
  })

  it('forwards an incoming realtime frame to webxdc_realtime_receive when the thread is joined', async () => {
    listenHandlers.get('fluux://webxdc-realtime-join')!({
      payload: { instance_id: 'inst1', conversation_id: 'bob@example.com', thread_id: 'thread1' }
    })

    await realtimeHandler!({ from: 'bob@example.com', thread: 'thread1', data: 'ZGF0YQ==' })

    expect(invoke).toHaveBeenCalledWith('webxdc_realtime_receive', {
      instanceId: 'inst1',
      data: 'ZGF0YQ=='
    })
  })

  it('drops an incoming realtime frame for an unknown thread', async () => {
    await realtimeHandler!({ from: 'bob@example.com', thread: 'unknown-thread', data: 'ZGF0YQ==' })

    expect(invoke).not.toHaveBeenCalled()
  })

  it('unregisters the thread on leave so later frames are dropped', async () => {
    listenHandlers.get('fluux://webxdc-realtime-join')!({
      payload: { instance_id: 'inst1', conversation_id: 'bob@example.com', thread_id: 'thread1' }
    })
    listenHandlers.get('fluux://webxdc-realtime-leave')!({ payload: { instance_id: 'inst1' } })

    await realtimeHandler!({ from: 'bob@example.com', thread: 'thread1', data: 'ZGF0YQ==' })

    expect(invoke).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/utils/webxdc/realtimeBridge.test.ts`
Expected: FAIL — the current file still does MUC join/create-room logic; event payload shapes and `client.chat.sendWebxdcRealtime` don't match.

- [ ] **Step 3: Write the minimal implementation**

Replace the entire contents of `apps/fluux/src/utils/webxdc/realtimeBridge.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { XMPPClient } from '@fluux/sdk/core'
import { isMucJid } from '@fluux/sdk'

/**
 * XMPP bridge for WebXDC realtime channels (Cheogram-compatible).
 *
 * Realtime frames ride directly in the conversation the webxdc instance
 * belongs to (1:1 chat, or the group's own already-joined MUC) rather than a
 * dedicated side-channel room. Join/leave are purely local bookkeeping — no
 * XMPP traffic is sent for them.
 */

interface ThreadJoinEvent {
  instance_id: string
  conversation_id: string
  thread_id: string
}

interface ThreadSendEvent {
  conversation_id: string
  thread_id: string
  data: string // base64
}

interface ThreadLeaveEvent {
  instance_id: string
}

// Map thread ID to instance ID for incoming-message routing.
const threadToInstance = new Map<string, string>()

let isListening = false
let xmppClient: XMPPClient | null = null

/**
 * Initialize realtime bridge event listeners.
 *
 * @param client - XMPP client instance
 */
export function initializeRealtimeBridge(client: XMPPClient): void {
  if (isListening) {
    console.warn('[webxdc-realtime] Bridge already initialized')
    return
  }

  xmppClient = client

  listen<ThreadJoinEvent>('fluux://webxdc-realtime-join', (event) => {
    const { instance_id, thread_id } = event.payload
    threadToInstance.set(thread_id, instance_id)
  }).catch((err) => {
    console.error('[webxdc-realtime] Failed to set up join listener:', err)
  })

  listen<ThreadSendEvent>('fluux://webxdc-realtime-send', async (event) => {
    const { conversation_id, thread_id, data } = event.payload

    try {
      if (!xmppClient) {
        throw new Error('XMPP client not initialized')
      }

      const type = isMucJid(conversation_id) ? 'groupchat' : 'chat'
      await (xmppClient.chat as any).sendWebxdcRealtime(conversation_id, type, thread_id, data)
    } catch (error) {
      console.error('[webxdc-realtime] Failed to send:', error)
    }
  }).catch((err) => {
    console.error('[webxdc-realtime] Failed to set up send listener:', err)
  })

  listen<ThreadLeaveEvent>('fluux://webxdc-realtime-leave', (event) => {
    const { instance_id } = event.payload
    for (const [thread, instance] of threadToInstance) {
      if (instance === instance_id) {
        threadToInstance.delete(thread)
      }
    }
  }).catch((err) => {
    console.error('[webxdc-realtime] Failed to set up leave listener:', err)
  })

  xmppClient.on('webxdc:realtime' as any, async (event: any) => {
    const { thread, data } = event
    if (!thread) return

    const instanceId = threadToInstance.get(thread)
    if (!instanceId) return // No window currently joined for this thread

    try {
      await invoke('webxdc_realtime_receive', {
        instanceId,
        data,
      })
    } catch (error) {
      console.error('[webxdc-realtime] Failed to forward message:', error)
    }
  })

  isListening = true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/utils/webxdc/realtimeBridge.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Run the full app test suite**

Run: `cd apps/fluux && npx vitest run --passWithNoTests`
Expected: PASS. In particular confirm `src/utils/webxdc/RealtimeChannelManager.test.ts` (the untouched legacy dead-code test) still passes unmodified.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/utils/webxdc/realtimeBridge.ts apps/fluux/src/utils/webxdc/realtimeBridge.test.ts
git commit -m "feat(webxdc): rewrite realtime bridge to send directly in-conversation"
```

---

### Task 9: UI — fix the stubbed conversationId and thread it to WebxdcAttachment

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx`
- Modify: `apps/fluux/src/components/conversation/MessageBubble.test.tsx`
- Modify: `apps/fluux/src/components/MessageAttachments.tsx`
- Modify: `apps/fluux/src/components/WebxdcAttachment.tsx`
- Modify: `apps/fluux/src/components/ChatView.tsx`
- Modify: `apps/fluux/src/components/RoomView.tsx`
- Modify: `apps/fluux/src/components/SearchContextView.tsx`
- Create: `apps/fluux/src/components/WebxdcAttachment.test.tsx`

**Interfaces:**
- Produces: `MessageBubbleProps.conversationId: string`, `MessageAttachmentsProps.conversationId: string`, `WebxdcAttachmentProps.conversationId: string` (required, no more stub).

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/WebxdcAttachment.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WebxdcAttachment } from './WebxdcAttachment'
import type { FileAttachment } from '@fluux/sdk'

const { openWebxdcWindowSpy } = vi.hoisted(() => ({
  openWebxdcWindowSpy: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@/utils/webxdc/webxdcWindow', () => ({
  openWebxdcWindow: (...args: unknown[]) => openWebxdcWindowSpy(...args),
}))

function makeAttachment(): FileAttachment {
  return {
    url: 'https://example.com/app.xdc',
    name: 'app.xdc',
    mediaType: 'application/webxdc+zip',
    size: 1024,
  }
}

describe('WebxdcAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens the webxdc window with the conversation the message actually belongs to', async () => {
    render(<WebxdcAttachment attachment={makeAttachment()} conversationId="alice@example.com" />)

    fireEvent.click(screen.getByRole('button'))

    await waitFor(() => {
      expect(openWebxdcWindowSpy).toHaveBeenCalledWith(makeAttachment(), 'alice@example.com')
    })
  })

  it('uses the room JID as conversationId for a group conversation', async () => {
    render(<WebxdcAttachment attachment={makeAttachment()} conversationId="room@conference.example.com" />)

    fireEvent.click(screen.getByRole('button'))

    await waitFor(() => {
      expect(openWebxdcWindowSpy).toHaveBeenCalledWith(makeAttachment(), 'room@conference.example.com')
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/WebxdcAttachment.test.tsx`
Expected: FAIL — `WebxdcAttachment` doesn't accept a `conversationId` prop yet and calls `openWebxdcWindow` with the hardcoded `'stub@example.com'`.

- [ ] **Step 3: Fix `WebxdcAttachment.tsx`**

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Package, Loader2 } from 'lucide-react'
import type { FileAttachment } from '@fluux/sdk'
import { formatBytes } from '@/hooks'
import { openWebxdcWindow } from '@/utils/webxdc/webxdcWindow'

interface WebxdcAttachmentProps {
  attachment: FileAttachment
  /** Conversation JID (bare JID for 1:1, room JID for groupchat) this message belongs to. */
  conversationId: string
}

/**
 * Webxdc app preview card.
 *
 * Shows app icon (from manifest) + name + description + "Open App" button.
 * Clicking the button extracts the .xdc and opens it in a Tauri webview window.
 */
export function WebxdcAttachment({ attachment, conversationId }: WebxdcAttachmentProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  const handleOpen = async () => {
    setBusy(true)
    try {
      await openWebxdcWindow(attachment, conversationId)
    } catch (error) {
      console.error('[webxdc] Failed to open app:', error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pt-2 max-w-sm">
      <button
        type="button"
        onClick={handleOpen}
        disabled={busy}
        className="flex items-center gap-3 p-3 w-full rounded-lg bg-fluux-bg/60 border border-fluux-border hover:bg-fluux-hover/60 transition-colors disabled:opacity-70 text-start"
        tabIndex={-1}
      >
        <div className="size-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-purple-500/20 text-purple-500">
          {busy ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Package className="size-5" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-fluux-text truncate">
            {attachment.name || 'Webxdc App'}
          </p>
          <p className="text-xs text-fluux-muted">
            {t('chat.webxdcApp')}
            {attachment.size && ` • ${formatBytes(attachment.size)}`}
          </p>
        </div>
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Thread `conversationId` through `MessageAttachments.tsx`**

```tsx
interface MessageAttachmentsProps {
  attachment: FileAttachment | undefined
  /** Conversation this message belongs to — required so WebxdcAttachment can open the app against the right conversation. */
  conversationId: string
  /** Called when media (images) finish loading - useful for scroll adjustment */
  onMediaLoad?: () => void
  /** Whether the parent message is selected (for gradient adaptation) */
  isSelected?: boolean
  /** Whether the parent message is hovered (for gradient adaptation) */
  isHovered?: boolean
  /** Whether the parent message is the local user's own (bypasses media-autoload deferral). */
  isOwnMessage?: boolean
}

/**
 * Renders all applicable attachment types for a message.
 * Each attachment component internally checks if it should render
 * based on the attachment's media type.
 */
export function MessageAttachments({ attachment, conversationId, onMediaLoad, isSelected, isHovered, isOwnMessage }: MessageAttachmentsProps) {
  if (!attachment) return null

  const canPreview = canPreviewAsText(attachment.mediaType, attachment.name)

  return (
    <>
      {/* Image attachment preview */}
      <ImageAttachment attachment={attachment} onLoad={onMediaLoad} isOwnMessage={isOwnMessage} />

      {/* Video attachment with inline player */}
      <VideoAttachment attachment={attachment} onLoad={onMediaLoad} isOwnMessage={isOwnMessage} />

      {/* Audio attachment with inline player */}
      <AudioAttachment attachment={attachment} isOwnMessage={isOwnMessage} />

      {/* Text file preview (code, markdown, json, etc.) */}
      {canPreview && <TextFilePreview attachment={attachment} isSelected={isSelected} isHovered={isHovered} isOwnMessage={isOwnMessage} />}

      {/* Webxdc app attachment */}
      {isWebxdcMimeType(attachment.mediaType, attachment.name) && (
        <WebxdcAttachment attachment={attachment} conversationId={conversationId} />
      )}

      {/* Document/file attachment card (PDF, Word, etc.) */}
      {shouldShowFileCard(attachment, canPreview) && (
        <FileAttachmentCard attachment={attachment} />
      )}
    </>
  )
}
```

- [ ] **Step 5: Thread `conversationId` through `MessageBubble.tsx`**

Add the prop to `MessageBubbleProps` (`apps/fluux/src/components/conversation/MessageBubble.tsx:48-50`):

```ts
export interface MessageBubbleProps {
  // Core message data (using BaseMessage interface)
  message: BaseMessage
  /** Conversation JID (bare JID for 1:1, room JID for groupchat) this message belongs to. */
  conversationId: string
```

Add it to the destructured function parameters (`MessageBubble.tsx:298-300`):

```tsx
export const MessageBubble = memo(function MessageBubble({
  message,
  conversationId,
  showAvatar,
```

Pass it to `MessageAttachments` (`MessageBubble.tsx:751`):

```tsx
          {!message.isRetracted && <MessageAttachments attachment={message.attachment} conversationId={conversationId} onMediaLoad={handleMediaLoad} isSelected={isSelected} isHovered={isHovered} isOwnMessage={message.isOutgoing} />}
```

- [ ] **Step 6: Pass `conversationId` at all three `<MessageBubble>` call sites**

In `apps/fluux/src/components/ChatView.tsx:994` (the row-wrapper component already destructures `conversationId` at line 882):

```tsx
      <MessageBubble
        message={message}
        conversationId={conversationId}
        showAvatar={showAvatar}
```

In `apps/fluux/src/components/RoomView.tsx:1549` (the row-wrapper component already destructures `roomJid` at line 1316):

```tsx
      <MessageBubble
        message={message}
        conversationId={roomJid}
        showAvatar={showAvatar}
```

In `apps/fluux/src/components/SearchContextView.tsx:581` (inside `renderMessage`, which closes over `previewResult` and the component-level `roomJid`/`isRoom` computed around line 450-453):

```tsx
        <MessageBubble
          message={msg}
          conversationId={isRoom ? (roomJid ?? previewResult.conversationId) : previewResult.conversationId}
          showAvatar={shouldShowAvatar(groupMessages, idx)}
```

- [ ] **Step 7: Update `MessageBubble.test.tsx`'s default props**

In `apps/fluux/src/components/conversation/MessageBubble.test.tsx`, add `conversationId` to `createDefaultProps`:

```ts
function createDefaultProps(overrides: Partial<MessageBubbleProps> = {}): MessageBubbleProps {
  return {
    message: createTestMessage(),
    conversationId: 'alice@example.com',
    showAvatar: true,
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/WebxdcAttachment.test.tsx`
Expected: PASS — both tests green.

- [ ] **Step 9: Run the full app test suite to confirm no regressions**

Run: `cd apps/fluux && npx vitest run --passWithNoTests`
Expected: PASS — `MessageBubble.test.tsx`, `ChatView`/`RoomView`/`SearchContextView`-related tests (if any render through these paths) all still green now that `conversationId` is a required prop with a value supplied everywhere it's rendered.

- [ ] **Step 10: Typecheck**

Run: `cd apps/fluux && npx tsc --noEmit`
Expected: no errors — confirms every `<MessageBubble>`/`<MessageAttachments>`/`<WebxdcAttachment>` call site in the app supplies the now-required `conversationId`.

- [ ] **Step 11: Commit**

```bash
git add apps/fluux/src/components/conversation/MessageBubble.tsx apps/fluux/src/components/conversation/MessageBubble.test.tsx apps/fluux/src/components/MessageAttachments.tsx apps/fluux/src/components/WebxdcAttachment.tsx apps/fluux/src/components/WebxdcAttachment.test.tsx apps/fluux/src/components/ChatView.tsx apps/fluux/src/components/RoomView.tsx apps/fluux/src/components/SearchContextView.tsx
git commit -m "fix(webxdc): thread the real conversationId into WebxdcAttachment"
```

---

### Task 10: Manual end-to-end verification

**Files:** none (manual verification only)

- [ ] **Step 1: Build and launch**

Run: `cd apps/fluux && npm run tauri dev` (or the project's equivalent dev-launch command — check `apps/fluux/package.json` `scripts` if this differs)

- [ ] **Step 2: 1:1 verification**

With two Fluux accounts in a 1:1 chat: share a `.xdc` file, open it on both sides, and confirm a `window.webxdc.joinRealtimeChannel().send(...)` call from one side's app is received by the other side's app via `setListener`, with no chat bubble appearing for the realtime frames and no MUC room created (check server-side room list / MUC admin if available).

- [ ] **Step 3: Group verification**

Repeat inside an existing group conversation (MUC) both parties are already members of, confirming realtime frames are sent as `type="groupchat"` directly to the room (per `isMucJid`) and still don't create chat bubbles.

- [ ] **Step 4: Interop check (best-effort)**

If a Cheogram or Conversations client is available, confirm: (a) our client correctly parses a webxdc app + realtime frames sent by them (adopting their `<thread>`), and (b) our own outgoing update messages now carry a `<thread>` they can read back.

- [ ] **Step 5: Report results**

Note any deviations from expected behavior for follow-up; this task has no code changes to commit unless a bug is found, in which case return to the relevant task above.
