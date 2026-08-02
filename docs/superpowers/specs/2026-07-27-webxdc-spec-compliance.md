# WebXDC Specification Compliance Implementation

**Date:** 2026-07-27  
**Status:** Design  
**Author:** Woojae Park + Claude Sonnet 4.5

## Problem Statement

The current WebXDC implementation in Fluux is missing three critical features from the [WebXDC specification](https://webxdc.org/docs/spec.html):

1. **`sendToChat()`** - Export files and text from WebXDC apps to the messenger chat
2. **`importFiles()`** - Import files from the messenger into WebXDC apps
3. **`joinRealtimeChannel()`** - Real-time peer-to-peer communication between app instances

Additionally, we have an existing stub implementation of `joinRealtimeChannel()` that only logs console warnings.

### Current State

**Already Implemented:**
- ✅ `selfAddr` and `selfName` properties
- ✅ `sendUpdate()` and `setUpdateListener()` for state updates
- ✅ `getAllUpdates()` for fetching update history
- ✅ HTTP server bridge with Tauri IPC injection (solves Tauri v2 constraints)
- ✅ Webview constraints (localStorage, sessionStorage, indexedDB, etc.)

**Missing:**
- ❌ `sendToChat()` - No way to export content from WebXDC to chat
- ❌ `importFiles()` - No way to import files into WebXDC apps
- ❌ `joinRealtimeChannel()` - Only a stub exists, no real implementation

### Specification Requirements

From the WebXDC spec:

**sendToChat():**
- Accept `message` object with optional `file` (blob/base64/plainText) and `text`
- User may modify text before sending
- May exit WebXDC app after invocation
- Promise rejects on error

**importFiles():**
- Accept `filter` object with `extensions`, `mimeTypes`, `multiple`
- Show file picker (prefer recent messenger attachments)
- Return array of `File` objects
- Filter by extensions OR mimeTypes (union)

**joinRealtimeChannel():**
- Return channel object with `setListener()`, `send()`, `leave()` methods
- Private, isolated, ephemeral communication
- Maximum 128,000 bytes per message
- Only one channel active at a time per app
- No delivery guarantees

## Solution: XMPP-Backed Implementation

Implement all three features using Fluux's existing XMPP infrastructure:

1. **sendToChat()**: Native file save dialog + event to frontend for message creation
2. **importFiles()**: Native file picker + copy to temp directory
3. **joinRealtimeChannel()**: Auto-create private XMPP MUC room per instance

### Why XMPP for Realtime?

**Alternatives Considered:**

| Approach | Pros | Cons |
|----------|------|------|
| **XMPP MUC** (chosen) | Multi-device sync, existing infrastructure, no NAT traversal | Higher latency (~100-300ms), 33% base64 overhead |
| WebRTC P2P | Low latency (~20-50ms), efficient binary | Complex (STUN/TURN), single-device only, NAT issues |
| In-process pub/sub | Lowest latency, simple | No multi-device, no remote participants |

**Decision:** XMPP MUC balances multi-device support with implementation simplicity. Latency is acceptable for most WebXDC use cases (collaborative apps, polls, simple games). High-performance gaming can be revisited with WebRTC later if needed.

## Architecture

### High-Level Data Flow

```
┌─────────────────────┐
│  WebXDC App (HTML)  │
│  window.webxdc.*    │
└──────────┬──────────┘
           │ Tauri IPC
           ▼
┌─────────────────────┐
│   Tauri Backend     │
│ - File operations   │
│ - Room management   │
│ - Binary encoding   │
└──────────┬──────────┘
           │ Events
           ▼
┌─────────────────────┐         ┌──────────────┐
│   Frontend SDK      │────────▶│ XMPP Server  │
│ - Send messages     │         │ - MUC rooms  │
│ - Join MUC rooms    │         │ - Messages   │
└─────────────────────┘         └──────────────┘
```

### Component Breakdown

**New Files:**
- `webxdc/realtime.rs` - Realtime channel state management (~200 LOC)

**Modified Files:**
- `webxdc/api.rs` - Add JavaScript bridge for three new APIs (~150 LOC additions)
- `webxdc/mod.rs` - Add Tauri commands (~250 LOC additions)
- Frontend event handlers - Handle backend events (~300 LOC)

**Total New Code:** ~1,300 LOC (Medium complexity)

## Component Design

### 1. sendToChat() Implementation

**JavaScript API (`webxdc/api.rs`):**

```javascript
window.webxdc.sendToChat = async function(message) {
  // Validate message structure
  if (!message || typeof message !== 'object') {
    throw new Error('webxdc.sendToChat: message must be an object');
  }
  
  // Prepare file data
  let fileData = null;
  if (message.file) {
    if (!message.file.name) {
      throw new Error('webxdc.sendToChat: file.name is required');
    }
    
    if (message.file.blob instanceof Blob) {
      // Convert Blob to base64
      const arrayBuffer = await message.file.blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      fileData = {
        name: message.file.name,
        base64: btoa(String.fromCharCode(...bytes))
      };
    } else if (typeof message.file.base64 === 'string') {
      fileData = {
        name: message.file.name,
        base64: message.file.base64
      };
    } else if (typeof message.file.plainText === 'string') {
      fileData = {
        name: message.file.name,
        base64: btoa(message.file.plainText)
      };
    } else {
      throw new Error('webxdc.sendToChat: file must have blob, base64, or plainText');
    }
  }
  
  // Call Tauri backend
  await window.__TAURI__.invoke('webxdc_send_to_chat', {
    instanceId: INSTANCE_ID,
    conversationId: CONVERSATION_ID,
    fileData: fileData,
    text: message.text || null
  });
}
```

**Tauri Backend (`webxdc/mod.rs`):**

```rust
#[derive(serde::Deserialize)]
struct FileData {
    name: String,
    base64: String,
}

#[tauri::command]
async fn webxdc_send_to_chat(
    instance_id: String,
    conversation_id: String,
    file_data: Option<FileData>,
    text: Option<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    // 1. If file provided, save it to temp directory
    let file_path = if let Some(file) = file_data {
        let temp_dir = std::env::temp_dir()
            .join("fluux-webxdc-export")
            .join(&instance_id);
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to create temp dir: {}", e))?;
        
        let file_path = temp_dir.join(&file.name);
        
        // Decode base64 and write
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&file.base64)
            .map_err(|e| format!("Invalid base64: {}", e))?;
        
        std::fs::write(&file_path, bytes)
            .map_err(|e| format!("Failed to write file: {}", e))?;
        
        Some(file_path.to_string_lossy().to_string())
    } else {
        None
    };
    
    // 2. Emit event to frontend to handle message creation
    #[derive(serde::Serialize, Clone)]
    struct SendToChatEvent {
        conversation_id: String,
        file_path: Option<String>,
        text: Option<String>,
    }
    
    app_handle.emit("fluux://webxdc-send-to-chat", SendToChatEvent {
        conversation_id,
        file_path,
        text,
    }).map_err(|e| format!("Failed to emit event: {}", e))?;
    
    Ok(())
}
```

**Frontend Handler:**

```typescript
// Listen to sendToChat events
listen('fluux://webxdc-send-to-chat', async (event) => {
  const { conversationId, filePath, text } = event.payload;
  
  // 1. Open message composer with pre-filled text
  // 2. If file provided, attach it
  // 3. User can edit and send
  
  if (filePath) {
    // Upload file via existing upload mechanism
    const fileUrl = await uploadFile(filePath);
    await sendMessage(conversationId, text || '', { attachment: fileUrl });
  } else {
    await sendMessage(conversationId, text || '');
  }
});
```

**Error Handling:**
- Invalid message object → Promise rejects
- Missing file.name → Promise rejects
- Invalid base64 → Promise rejects
- Filesystem errors → Promise rejects
- User cancels → Promise resolves (per spec ambiguity)

### 2. importFiles() Implementation

**JavaScript API (`webxdc/api.rs`):**

```javascript
window.webxdc.importFiles = async function(filter) {
  filter = filter || {};
  
  // Call Tauri backend with filter options
  const result = await window.__TAURI__.invoke('webxdc_import_files', {
    instanceId: INSTANCE_ID,
    extensions: filter.extensions || null,
    mimeTypes: filter.mimeTypes || null,
    multiple: filter.multiple || false
  });
  
  // Convert returned file paths to File objects
  const files = [];
  for (const fileInfo of result.files) {
    // Read file content via Tauri
    const content = await window.__TAURI__.invoke('webxdc_read_imported_file', {
      filePath: fileInfo.path
    });
    
    // Create Blob from base64
    const bytes = Uint8Array.from(atob(content.base64), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: fileInfo.mimeType });
    
    // Create File object
    const file = new File([blob], fileInfo.name, {
      type: fileInfo.mimeType,
      lastModified: fileInfo.lastModified
    });
    
    files.push(file);
  }
  
  return files;
}
```

**Tauri Backend (`webxdc/mod.rs`):**

```rust
use tauri::api::dialog::FileDialogBuilder;

#[tauri::command]
async fn webxdc_import_files(
    instance_id: String,
    extensions: Option<Vec<String>>,
    mime_types: Option<Vec<String>>,
    multiple: bool,
    app_handle: AppHandle,
) -> Result<ImportFilesResult, String> {
    // Build file dialog with filters
    let mut dialog = FileDialogBuilder::new();
    
    if let Some(exts) = extensions {
        // Convert extensions like [".jpg", ".png"] to filter
        let extensions_clean: Vec<String> = exts.iter()
            .map(|e| e.trim_start_matches('.').to_string())
            .collect();
        
        dialog = dialog.add_filter("Allowed files", &extensions_clean);
    }
    
    // Show file picker (blocking operation, runs on main thread)
    let (tx, rx) = std::sync::mpsc::channel();
    
    if multiple {
        dialog.pick_files(move |file_paths| {
            tx.send(file_paths).ok();
        });
    } else {
        dialog.pick_file(move |file_path| {
            tx.send(file_path.map(|p| vec![p])).ok();
        });
    }
    
    let file_paths = rx.recv()
        .map_err(|_| "File dialog failed".to_string())?
        .ok_or_else(|| "No files selected".to_string())?;
    
    // Copy files to WebXDC temp directory for sandboxed access
    let temp_dir = std::env::temp_dir()
        .join("fluux-webxdc-imports")
        .join(&instance_id);
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    
    let mut file_infos = Vec::new();
    
    for original_path in file_paths {
        let file_name = original_path.file_name()
            .ok_or_else(|| "Invalid file name".to_string())?
            .to_string_lossy()
            .to_string();
        
        let dest_path = temp_dir.join(&file_name);
        
        std::fs::copy(&original_path, &dest_path)
            .map_err(|e| format!("Failed to copy file: {}", e))?;
        
        let metadata = std::fs::metadata(&dest_path)
            .map_err(|e| format!("Failed to read metadata: {}", e))?;
        
        let mime_type = mime_guess::from_path(&dest_path)
            .first_or_octet_stream()
            .to_string();
        
        file_infos.push(FileInfo {
            path: dest_path.to_string_lossy().to_string(),
            name: file_name,
            mime_type,
            last_modified: metadata.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        });
    }
    
    Ok(ImportFilesResult { files: file_infos })
}

#[derive(serde::Serialize)]
struct ImportFilesResult {
    files: Vec<FileInfo>,
}

#[derive(serde::Serialize)]
struct FileInfo {
    path: String,
    name: String,
    mime_type: String,
    last_modified: i64,
}

#[tauri::command]
async fn webxdc_read_imported_file(
    file_path: String,
) -> Result<FileContent, String> {
    let bytes = std::fs::read(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    
    Ok(FileContent { base64 })
}

#[derive(serde::Serialize)]
struct FileContent {
    base64: String,
}
```

**Security:**
- Files copied to isolated temp directory per instance
- Original file paths not exposed to WebXDC app
- Path validation prevents traversal attacks
- Temp files cleaned up when instance closes

**Error Handling:**
- User cancels → Promise rejects with "No files selected"
- File copy fails → Promise rejects with filesystem error
- File too large → Promise rejects (configurable limit, default 100MB)
- MIME detection fails → Fallback to "application/octet-stream"

### 3. joinRealtimeChannel() Implementation

**JavaScript API (`webxdc/api.rs`):**

```javascript
window.webxdc.joinRealtimeChannel = function() {
  // Prevent multiple simultaneous channels
  if (window.__webxdc_realtime_channel) {
    throw new Error('Already joined a realtime channel. Call leave() first.');
  }
  
  let listener = null;
  let isActive = true;
  
  const channel = {
    setListener: function(callback) {
      if (!isActive) {
        throw new Error('Channel is closed');
      }
      listener = callback;
      
      // Subscribe to incoming realtime messages
      window.__TAURI__.event.listen('webxdc_realtime_message', (event) => {
        if (event.payload.instanceId === INSTANCE_ID && listener && isActive) {
          // Decode base64 to Uint8Array
          const bytes = Uint8Array.from(
            atob(event.payload.data),
            c => c.charCodeAt(0)
          );
          listener(bytes);
        }
      });
    },
    
    send: function(data) {
      if (!isActive) {
        throw new Error('Channel is closed');
      }
      
      if (!(data instanceof Uint8Array)) {
        throw new Error('data must be Uint8Array');
      }
      
      if (data.length > 128000) {
        throw new Error('data must not exceed 128,000 bytes');
      }
      
      // Encode to base64
      const base64 = btoa(String.fromCharCode(...data));
      
      window.__TAURI__.invoke('webxdc_realtime_send', {
        instanceId: INSTANCE_ID,
        data: base64
      }).catch(err => {
        console.error('[webxdc] Failed to send realtime data:', err);
      });
    },
    
    leave: function() {
      if (!isActive) return;
      
      isActive = false;
      listener = null;
      window.__webxdc_realtime_channel = null;
      
      window.__TAURI__.invoke('webxdc_realtime_leave', {
        instanceId: INSTANCE_ID
      }).catch(err => {
        console.error('[webxdc] Failed to leave channel:', err);
      });
    }
  };
  
  // Join the channel
  window.__TAURI__.invoke('webxdc_realtime_join', {
    instanceId: INSTANCE_ID,
    conversationId: CONVERSATION_ID,
    selfAddr: SELF_ADDR,
    selfName: SELF_NAME
  }).then(() => {
    console.log('[webxdc] Joined realtime channel');
  }).catch(err => {
    console.error('[webxdc] Failed to join realtime channel:', err);
    isActive = false;
  });
  
  window.__webxdc_realtime_channel = channel;
  return channel;
};
```

**Tauri Backend - New Module (`webxdc/realtime.rs`):**

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};

/// Tracks active realtime channels per WebXDC instance
pub struct RealtimeChannelManager {
    /// Map: instance_id -> RealtimeChannel
    channels: Arc<Mutex<HashMap<String, RealtimeChannel>>>,
}

struct RealtimeChannel {
    instance_id: String,
    conversation_id: String,
    room_jid: String,
    joined: bool,
}

impl RealtimeChannelManager {
    pub fn new() -> Self {
        Self {
            channels: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    
    /// Join or create a realtime channel for this instance
    pub fn join(
        &self,
        instance_id: String,
        conversation_id: String,
    ) -> Result<String, String> {
        let mut channels = self.channels.lock().unwrap();
        
        if channels.contains_key(&instance_id) {
            return Err("Already joined a realtime channel".to_string());
        }
        
        // Generate unique room JID
        let room_local = compute_realtime_room_name(&instance_id);
        let room_jid = format!("{}@{{muc_service}}", room_local);
        
        let channel = RealtimeChannel {
            instance_id: instance_id.clone(),
            conversation_id,
            room_jid: room_jid.clone(),
            joined: false,
        };
        
        channels.insert(instance_id, channel);
        
        Ok(room_jid)
    }
    
    pub fn mark_joined(&self, instance_id: &str) {
        let mut channels = self.channels.lock().unwrap();
        if let Some(channel) = channels.get_mut(instance_id) {
            channel.joined = true;
        }
    }
    
    pub fn get_room_jid(&self, instance_id: &str) -> Option<String> {
        let channels = self.channels.lock().unwrap();
        channels.get(instance_id).map(|c| c.room_jid.clone())
    }
    
    pub fn leave(&self, instance_id: &str) -> Option<String> {
        let mut channels = self.channels.lock().unwrap();
        channels.remove(instance_id).map(|c| c.room_jid)
    }
}

fn compute_realtime_room_name(instance_id: &str) -> String {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(instance_id.as_bytes());
    let hash = hasher.finalize();
    format!("webxdc-rt-{:x}", &hash[..8])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_room_name_generation() {
        let instance_id = "conv123:https://example.com/app.xdc";
        let room_name = compute_realtime_room_name(instance_id);
        
        assert!(room_name.starts_with("webxdc-rt-"));
        assert_eq!(room_name.len(), "webxdc-rt-".len() + 16);
        
        // Same instance ID produces same room name
        let room_name2 = compute_realtime_room_name(instance_id);
        assert_eq!(room_name, room_name2);
    }

    #[test]
    fn test_channel_manager_prevents_double_join() {
        let manager = RealtimeChannelManager::new();
        
        manager.join("instance1".into(), "conv1".into()).unwrap();
        let result = manager.join("instance1".into(), "conv1".into());
        
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Already joined a realtime channel");
    }

    #[test]
    fn test_channel_manager_leave() {
        let manager = RealtimeChannelManager::new();
        
        let room_jid = manager.join("instance1".into(), "conv1".into()).unwrap();
        let left_room = manager.leave("instance1");
        
        assert_eq!(left_room, Some(room_jid));
        
        // Can rejoin after leaving
        let result = manager.join("instance1".into(), "conv1".into());
        assert!(result.is_ok());
    }
}
```

**Tauri Commands (`webxdc/mod.rs`):**

```rust
#[tauri::command]
async fn webxdc_realtime_join(
    instance_id: String,
    conversation_id: String,
    self_addr: String,
    self_name: String,
    app_handle: AppHandle,
    state: State<'_, WebxdcState>,
) -> Result<(), String> {
    // Register channel
    let room_jid = state.realtime_manager
        .join(instance_id.clone(), conversation_id.clone())?;
    
    // Emit event to frontend to create/join XMPP MUC room
    #[derive(serde::Serialize, Clone)]
    struct JoinRealtimeEvent {
        instance_id: String,
        conversation_id: String,
        room_jid: String,
        nickname: String,
    }
    
    app_handle.emit("fluux://webxdc-realtime-join", JoinRealtimeEvent {
        instance_id,
        conversation_id,
        room_jid,
        nickname: self_name,
    }).map_err(|e| format!("Failed to emit event: {}", e))?;
    
    Ok(())
}

#[tauri::command]
async fn webxdc_realtime_send(
    instance_id: String,
    data: String, // base64-encoded
    app_handle: AppHandle,
    state: State<'_, WebxdcState>,
) -> Result<(), String> {
    let room_jid = state.realtime_manager
        .get_room_jid(&instance_id)
        .ok_or_else(|| "Not joined to any channel".to_string())?;
    
    // Emit event to frontend to send message to XMPP room
    #[derive(serde::Serialize, Clone)]
    struct RealtimeSendEvent {
        room_jid: String,
        data: String, // base64
    }
    
    app_handle.emit("fluux://webxdc-realtime-send", RealtimeSendEvent {
        room_jid,
        data,
    }).map_err(|e| format!("Failed to emit event: {}", e))?;
    
    Ok(())
}

#[tauri::command]
async fn webxdc_realtime_leave(
    instance_id: String,
    app_handle: AppHandle,
    state: State<'_, WebxdcState>,
) -> Result<(), String> {
    if let Some(room_jid) = state.realtime_manager.leave(&instance_id) {
        // Emit event to frontend to leave room
        #[derive(serde::Serialize, Clone)]
        struct RealtimeLeaveEvent {
            room_jid: String,
        }
        
        app_handle.emit("fluux://webxdc-realtime-leave", RealtimeLeaveEvent {
            room_jid,
        }).map_err(|e| format!("Failed to emit event: {}", e))?;
    }
    
    Ok(())
}

/// Called by frontend when XMPP room message arrives
#[tauri::command]
async fn webxdc_realtime_receive(
    instance_id: String,
    data: String, // base64
    app_handle: AppHandle,
) -> Result<(), String> {
    // Emit to WebXDC window
    #[derive(serde::Serialize, Clone)]
    struct RealtimeMessageEvent {
        instance_id: String,
        data: String,
    }
    
    app_handle.emit("webxdc_realtime_message", RealtimeMessageEvent {
        instance_id,
        data,
    }).map_err(|e| format!("Failed to emit event: {}", e))?;
    
    Ok(())
}
```

**Frontend Integration:**

```typescript
// 1. Listen to join events
listen('fluux://webxdc-realtime-join', async (event) => {
  const { instanceId, conversationId, roomJid, nickname } = event.payload;
  
  // Get conversation participants
  const participants = await getConversationParticipants(conversationId);
  
  // Create private MUC room
  await createRoom(roomJid, nickname, {
    name: `WebXDC Realtime: ${instanceId}`,
    isPublic: false,
    membersOnly: true,
  });
  
  // Auto-invite all participants
  await inviteMultipleToRoom(roomJid, participants);
  
  // Mark as joined
  await invoke('webxdc_realtime_mark_joined', { instanceId });
});

// 2. Listen to send events
listen('fluux://webxdc-realtime-send', async (event) => {
  const { roomJid, data } = event.payload;
  
  // Send message to XMPP room
  await sendRoomMessage(roomJid, data);
});

// 3. Listen to incoming MUC messages
onRoomMessage((roomJid, message) => {
  // Check if this is a realtime room
  if (roomJid.startsWith('webxdc-rt-')) {
    // Extract instance ID and forward to backend
    const instanceId = lookupInstanceByRoomJid(roomJid);
    if (instanceId) {
      invoke('webxdc_realtime_receive', {
        instanceId,
        data: message.body,
      });
    }
  }
});

// 4. Listen to leave events
listen('fluux://webxdc-realtime-leave', async (event) => {
  const { roomJid } = event.payload;
  
  // Leave room
  await leaveRoom(roomJid);
  
  // Destroy room if creator
  await destroyRoom(roomJid);
});
```

**Room Lifecycle:**
1. First `joinRealtimeChannel()` call creates room
2. All conversation participants auto-invited
3. Room persists while any participant connected
4. Last participant leaving destroys room

**Error Handling:**
- Already joined → Throw error immediately
- Room creation fails → Promise rejects
- Data exceeds 128KB → Throw error on send()
- Not Uint8Array → Throw error on send()
- Channel closed → Throw error on send/setListener
- XMPP disconnected → Messages queue, retry on reconnect

## Data Flow Examples

### sendToChat() Flow

```
1. WebXDC app calls sendToChat({ file: { blob, name }, text })
   ↓
2. JavaScript converts Blob to base64
   ↓
3. Tauri command receives base64, writes to temp file
   ↓
4. Emits "fluux://webxdc-send-to-chat" event
   ↓
5. Frontend uploads file, creates chat message
   ↓
6. Message sent via XMPP to conversation
```

### importFiles() Flow

```
1. WebXDC app calls importFiles({ extensions: ['.jpg'], multiple: true })
   ↓
2. Tauri shows native file picker with filters
   ↓
3. User selects files
   ↓
4. Files copied to temp directory per instance
   ↓
5. File metadata returned to JavaScript
   ↓
6. JavaScript reads files, creates File objects
   ↓
7. Returns array of File objects to app
```

### joinRealtimeChannel() Flow

```
1. WebXDC app calls joinRealtimeChannel()
   ↓
2. Tauri registers channel in manager
   ↓
3. Emits "fluux://webxdc-realtime-join" event
   ↓
4. Frontend creates private XMPP MUC room
   ↓
5. Auto-invites all conversation participants
   ↓
6. Frontend joins room
   ↓
7. Channel object returned to app
   ↓
8. App calls send(Uint8Array)
   ↓
9. JavaScript encodes to base64
   ↓
10. Tauri emits "fluux://webxdc-realtime-send"
   ↓
11. Frontend sends XMPP message to room
   ↓
12. Other participants receive message
   ↓
13. Frontend calls webxdc_realtime_receive
   ↓
14. Tauri emits "webxdc_realtime_message" to windows
   ↓
15. JavaScript decodes base64 to Uint8Array
   ↓
16. Calls listener(Uint8Array)
```

## Security Model

### Threat Model

**Assumptions:**
- WebXDC apps are untrusted code
- Multiple malicious apps may run simultaneously
- Apps will attempt to access other apps' data
- Local filesystem and XMPP server are trusted

**Protection Mechanisms:**

1. **File Isolation:**
   - Temp directories scoped per instance
   - Path validation prevents traversal
   - Files cleaned up on window close

2. **Realtime Channel Isolation:**
   - Cryptographic room name hashing (SHA-256)
   - Private XMPP rooms (membersOnly=true)
   - No cross-instance channel access

3. **Input Validation:**
   - Base64 encoding validated
   - File sizes enforced (default 100MB limit)
   - Binary data size limit (128KB) enforced
   - MIME type detection via safe library

4. **Error Handling:**
   - No sensitive data in error messages
   - Failures logged but don't leak info
   - Promises reject cleanly on errors

### Security Checklist

- [x] Path traversal prevention (canonicalize paths)
- [x] File size limits enforced
- [x] Binary data size limits (128KB)
- [x] Input validation (base64, types)
- [x] Temp file cleanup on window close
- [x] Realtime room name hashing (SHA-256)
- [x] Private XMPP rooms (members-only)
- [x] No cross-instance access
- [ ] Rate limiting (future enhancement)
- [ ] Bandwidth quotas (future enhancement)

## Testing Strategy

### Unit Tests

**`webxdc/api.rs`:**
- Test JavaScript generation includes all three APIs
- Test error messages are correct
- Test single-channel enforcement logic

**`webxdc/realtime.rs`:**
- Test room name generation is deterministic
- Test channel manager prevents double join
- Test leave/rejoin flow
- Test concurrent access (thread safety)

**`webxdc/mod.rs`:**
- Test base64 encoding/decoding
- Test file operations
- Test event emission
- Test error conditions

### Integration Tests

**sendToChat():**
- Test file export with Blob
- Test file export with base64
- Test file export with plainText
- Test text-only export
- Test temp file creation
- Test event emission to frontend

**importFiles():**
- Test single file import
- Test multiple file import
- Test extension filtering
- Test MIME type filtering
- Test file copy to temp directory
- Test File object creation

**joinRealtimeChannel():**
- Test channel lifecycle (join → send → leave)
- Test single-channel enforcement
- Test data size validation (128KB limit)
- Test Uint8Array type enforcement
- Test base64 encoding/decoding
- Test room creation event
- Test message routing

### Manual Testing Checklist

**sendToChat():**
- [ ] Export text-only message
- [ ] Export file (Blob) with text
- [ ] Export file (base64)
- [ ] Export file (plainText)
- [ ] Verify file appears in chat
- [ ] Verify file can be downloaded
- [ ] Test large files (>10MB)

**importFiles():**
- [ ] Import single file
- [ ] Import multiple files
- [ ] Filter by extensions
- [ ] Filter by MIME types
- [ ] Cancel file picker
- [ ] Verify File objects are correct
- [ ] Test large files (>50MB)

**joinRealtimeChannel():**
- [ ] Join channel from app
- [ ] Verify XMPP room created
- [ ] Verify participants invited
- [ ] Send binary data
- [ ] Receive data on other device
- [ ] Test data >128KB rejected
- [ ] Attempt double join
- [ ] Leave channel
- [ ] Test multi-device sync
- [ ] Test reconnection

**Performance:**
- [ ] Import 50 files simultaneously
- [ ] Send 100 messages/second
- [ ] Test 10 participants in channel
- [ ] Monitor memory usage
- [ ] Check temp file cleanup

## Implementation Estimates

**Timeline:**
- sendToChat() implementation: 4 hours
- importFiles() implementation: 4 hours
- joinRealtimeChannel() implementation: 8 hours
- Frontend integration: 6 hours
- Testing & debugging: 8 hours
- **Total: ~30 hours**

**Code Complexity:**
- New code: ~1,300 LOC (Medium complexity)
- Modified files: 4 files
- New files: 1 file (`webxdc/realtime.rs`)
- Tests: ~400 LOC

**Dependencies Added:**
- `sha2` crate for room name hashing (~30 KB)
- Total binary size impact: ~30 KB

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| File dialog platform issues | Medium | Medium | Fallback UI in WebView |
| XMPP room creation fails | Low | High | Retry logic, clear errors |
| Base64 overhead (33%) | High | Low | Acceptable for desktop |
| Realtime latency too high | Medium | Medium | Document latency, future WebRTC |
| Participant invitation fails | Medium | Low | Log warning, partial participants |
| Multi-device sync issues | Medium | Medium | Leverage existing XMPP |
| Temp file cleanup | Low | Medium | Existing cleanup task |

## Acceptance Criteria

**Must Have:**
- ✅ sendToChat() exports files and text
- ✅ importFiles() imports with filtering
- ✅ joinRealtimeChannel() creates XMPP room
- ✅ Realtime send() transmits binary data
- ✅ Realtime setListener() receives data
- ✅ Realtime leave() destroys room
- ✅ Error handling comprehensive
- ✅ No security vulnerabilities

**Nice to Have:**
- Performance metrics logging
- Realtime latency monitoring
- File size quotas per instance
- Bandwidth optimization

## Future Enhancements

### V2 Improvements

1. **WebRTC Fallback:**
   - Detect high-latency scenarios
   - Fallback to WebRTC for gaming
   - Keep XMPP as signaling channel

2. **Recent Attachments Picker:**
   - importFiles() shows recent messenger attachments
   - Quick access to files from conversation
   - Improves UX per spec recommendation

3. **Bandwidth Optimization:**
   - Compress binary data before base64
   - Delta encoding for repeated sends
   - Binary WebSocket protocol

4. **Performance Metrics:**
   - Track realtime latency
   - Monitor bandwidth usage
   - Expose via Tauri command for debugging

## References

### External Documentation

- [WebXDC Specification](https://webxdc.org/docs/spec.html)
- [WebXDC sendToChat()](https://webxdc.org/docs/spec/sendToChat.html)
- [WebXDC importFiles()](https://webxdc.org/docs/spec/importFiles.html)
- [WebXDC joinRealtimeChannel()](https://webxdc.org/docs/spec/joinRealtimeChannel.html)
- [Tauri File Dialog API](https://tauri.app/v1/api/js/dialog)
- [XMPP MUC Specification (XEP-0045)](https://xmpp.org/extensions/xep-0045.html)

### Related Code

- `webxdc/api.rs` - WebXDC JavaScript bridge generation
- `webxdc/mod.rs` - Tauri commands for WebXDC
- `webxdc/http_server.rs` - HTTP server for serving WebXDC files
- `packages/fluux-sdk/src/hooks/useRoomManagement.ts` - XMPP MUC room management
- `apps/fluux/src/components/CreateRoomModal.tsx` - Room creation UI

### Commit History

- `c3137ee3` - Add joinRealtimeChannel stub to WebXDC API
- `ee4a5f35` - Rewrite absolute paths using Referer header
- `0cb8da5a` - Inject base tag and proper Tauri IPC for External URLs

---

**End of Design Document**
