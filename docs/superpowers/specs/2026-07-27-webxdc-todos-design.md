# WebXDC TODO Implementation Design

**Date:** 2026-07-27  
**Status:** Approved  
**Authors:** Claude Code + User

## Overview

This document specifies the implementation of 17 outstanding TODOs in the Fluux WebXDC integration, enabling full XMPP-based synchronization, file import/export, and real-time collaboration features.

## Background

Fluux has a partial WebXDC implementation with:
- ✅ Window opening & API injection
- ✅ Permission system (recently fixed)
- ✅ Local storage (SQLite via Tauri)
- ✅ Basic WebXDC API

**Missing:** XMPP synchronization for updates, file import/export to chat, and real-time MUC-based collaboration.

The implementation has 17 TODOs spread across:
- `xmppBridge.ts` - Update sync, sendToChat handlers
- `sendToChat.ts` - File/text export implementation
- `importFiles.ts` - Native file picker integration
- `realtimeBridge.ts` - MUC room management
- `RealtimeChannelManager.ts` - Backend persistence

## Goals

1. **XMPP Update Sync:** WebXDC apps sync state between users via XMPP (XEP-0491)
2. **sendToChat:** Users can export files/text from WebXDC apps to messenger chat
3. **importFiles:** Users can import files from messenger into WebXDC apps
4. **Realtime Channels:** Multi-user WebXDC apps can collaborate via XMPP MUC rooms
5. **Minimal SDK Changes:** Keep SDK modifications focused and small

## Architecture

### Layered Design

```
┌─────────────────────────────────────────────────────────┐
│  WebXDC Apps (running in Tauri windows)                │
│  └─ window.webxdc API (sendUpdate, importFiles, etc.)  │
└────────────────┬────────────────────────────────────────┘
                 │ Tauri IPC events
┌────────────────▼────────────────────────────────────────┐
│  Frontend Bridge Layer (apps/fluux/src/utils/webxdc/)  │
│  ├─ xmppBridge.ts      (XMPP update sync)              │
│  ├─ sendToChat.ts      (export to chat)                │
│  ├─ importFiles.ts     (file import)                   │
│  └─ realtimeBridge.ts  (MUC collaboration)             │
└────────────────┬────────────────────────────────────────┘
                 │ SDK events & methods
┌────────────────▼────────────────────────────────────────┐
│  Fluux SDK (packages/fluux-sdk/)                        │
│  ├─ Chat.sendCustomMessage()  ← NEW (minimal)          │
│  ├─ Chat.handleMessageInternal() ← ENHANCED (10 lines) │
│  ├─ MUC.createRoom()           ← EXISTING              │
│  └─ uploadFile() hook          ← EXISTING              │
└────────────────┬────────────────────────────────────────┘
                 │ XMPP stanzas
┌────────────────▼────────────────────────────────────────┐
│  XMPP Server (Prosody/ejabberd/etc.)                    │
│  └─ XEP-0491: WebXDC namespace support                 │
└─────────────────────────────────────────────────────────┘
```

**Principles:**
- SDK changes minimal and focused (2 additions to Chat module, ~35 lines total)
- WebXDC logic stays in app layer (`apps/fluux/src/utils/webxdc/`)
- Reuse existing SDK patterns (events, message infrastructure, MUC methods)
- Tauri backend already handles storage/windowing - we wire XMPP transport

## Component Design

### 1. SDK Changes (Minimal)

**File:** `packages/fluux-sdk/src/core/modules/Chat.ts`

#### 1.1 New Method: `sendCustomMessage()`

```typescript
/**
 * Send a message with custom XML children.
 * Used by extensions (e.g., WebXDC) that need to attach protocol-specific elements.
 * Reuses sendMessage infrastructure (encryption, carbons, origin-id, etc.).
 * 
 * @param to - Recipient JID (bare for chat, full for groupchat)
 * @param body - Message body text (can be empty for signal-only messages)
 * @param type - Message type: 'chat' or 'groupchat'
 * @param customChildren - Array of XML elements to append to message stanza
 * @returns Message ID
 * 
 * @example Send WebXDC update
 * ```typescript
 * await client.chat.sendCustomMessage(
 *   'user@example.com',
 *   '[WebXDC Update]',
 *   'chat',
 *   [xml('x', { xmlns: 'urn:xmpp:webxdc:0' },
 *     xml('instance', {}, instanceId),
 *     xml('serial', {}, '42'),
 *     xml('payload', {}, JSON.stringify(data))
 *   )]
 * )
 * ```
 */
async sendCustomMessage(
  to: string,
  body: string,
  type: 'chat' | 'groupchat' = 'chat',
  customChildren: Element[]
): Promise<string>
```

**Implementation approach:**
- Extract message construction logic from `sendMessage()` into shared helper
- `sendMessage()` continues unchanged - just calls the helper
- `sendCustomMessage()` calls same helper, appends `customChildren` to stanza
- All features preserved: encryption, carbons, origin-id, chat states

**Lines of code:** ~20 (mostly refactoring)

#### 1.2 Enhanced: `handleMessageInternal()`

Add WebXDC stanza detection before existing message routing:

```typescript
// In handleMessageInternal(), after carbon copy handling, before type routing:

// XEP-0491: WebXDC update detection
const webxdcElement = stanza.getChild('x', 'urn:xmpp:webxdc:0')
if (webxdcElement) {
  const from = stanza.attrs.from
  const bareFrom = from ? getBareJid(from) : undefined
  
  if (bareFrom) {
    this.deps.emitSDK('webxdc:update', {
      from: bareFrom,
      instance: webxdcElement.getChildText('instance') || '',
      serial: parseInt(webxdcElement.getChildText('serial') || '0', 10),
      payload: JSON.parse(webxdcElement.getChildText('payload') || '{}'),
      info: webxdcElement.getChildText('info') || undefined,
      document: webxdcElement.getChildText('document') || undefined,
      summary: webxdcElement.getChildText('summary') || undefined,
      sender: from || bareFrom
    })
  }
  return { handled: true }
}
```

**Lines of code:** ~15

**Total SDK footprint:** ~35 lines in Chat.ts

### 2. XMPP Update Synchronization

**File:** `apps/fluux/src/utils/webxdc/xmppBridge.ts`

#### 2.1 Outgoing Updates

**Current state:** Stores locally, logs "XMPP transmission pending"

**Fix (TODO line 207-235):**
```typescript
async function sendWebxdcUpdateViaXMPP(
  conversationId: string,
  instanceId: string,
  serial: number,
  payload: unknown,
  info?: string,
  document?: string,
  summary?: string
): Promise<void> {
  if (!xmppClient) {
    throw new Error('XMPP client not initialized')
  }

  const updateElement = xml('x', { xmlns: NS_WEBXDC },
    xml('instance', {}, instanceId),
    xml('serial', {}, serial.toString()),
    xml('payload', {}, JSON.stringify(payload)),
    ...(info ? [xml('info', {}, info)] : []),
    ...(document ? [xml('document', {}, document)] : []),
    ...(summary ? [xml('summary', {}, summary)] : [])
  )

  const body = `[WebXDC Update: ${info || 'update'}]`
  
  await xmppClient.chat.sendCustomMessage(
    conversationId,
    body,
    'chat',
    [updateElement]
  )
}
```

#### 2.2 Incoming Updates

**Current state:** No handler (TODO line 81-106)

**Fix:**
```typescript
// In initializeXmppBridge(), after setting up outgoing listener:

xmppClient.on('webxdc:update', async (event) => {
  const { from, instance, serial, payload, info, document, summary, sender } = event
  
  try {
    await receiveWebxdcUpdate(instance, {
      serial,
      max_serial: serial, // Will be updated by backend
      payload,
      info,
      document,
      summary,
      sender
    })
    console.log('[webxdc] Incoming update received:', instance, serial)
  } catch (error) {
    console.error('[webxdc] Failed to process incoming update:', error)
  }
})
```

#### 2.3 Sender ID Resolution

**Current state:** Hardcoded `'unknown@example.com'` (TODO line 275)

**Fix:**
```typescript
import { useConnectionStore } from '@fluux/sdk/react'

// In sendWebxdcUpdate():
const jid = useConnectionStore.getState().jid
const senderId = senderId || jid || 'unknown@example.com'
```

### 3. sendToChat Implementation

**Files:** `apps/fluux/src/utils/webxdc/sendToChat.ts`, `xmppBridge.ts`

#### 3.1 File Upload (sendToChat.ts TODOs line 56, 69)

```typescript
import { invoke } from '@tauri-apps/api/core'

export async function sendToChat(options: SendToChatOptions): Promise<SendToChatResult> {
  // ... existing validation ...

  if (options.file) {
    let base64Data: string
    
    if (options.file.blob) {
      base64Data = await blobToBase64(options.file.blob)
    } else if (options.file.base64) {
      base64Data = options.file.base64
    } else {
      throw new Error('file blob or base64 required')
    }
    
    // Send to Tauri backend via IPC
    await invoke('webxdc_send_to_chat', {
      conversationId: options.conversationId,
      fileName: options.file.name,
      fileData: base64Data,
      text: options.text || null
    })
  } else {
    // Text only
    await invoke('webxdc_send_to_chat', {
      conversationId: options.conversationId,
      fileName: null,
      fileData: null,
      text: options.text
    })
  }

  return { success: true }
}
```

#### 3.2 XMPP Message Sending (xmppBridge.ts TODOs line 120-121)

```typescript
// Add to xmppBridge.ts module-level state:
let uploadFileFunction: ((file: File, options?: { encrypt?: boolean }) => Promise<FileAttachment | null>) | null = null

// Enhance initializeXmppBridge signature:
export function initializeXmppBridge(
  client: XMPPClient,
  uploadFile: (file: File, options?: { encrypt?: boolean }) => Promise<FileAttachment | null>
): void {
  xmppClient = client
  uploadFileFunction = uploadFile
  // ... rest of initialization
}

// In sendToChat event listener:
listen<SendToChatEvent>('fluux://webxdc-send-to-chat', async (event) => {
  const { conversation_id, file_path, text } = event.payload

  try {
    if (!xmppClient) {
      throw new Error('XMPP client not initialized')
    }

    let attachment: FileAttachment | undefined

    // Upload file if provided
    if (file_path && uploadFileFunction) {
      // Convert Tauri file path to File object
      const response = await fetch(convertFileSrc(file_path))
      const blob = await response.blob()
      const fileName = file_path.split('/').pop() || 'file'
      const file = new File([blob], fileName, { type: blob.type })
      
      // Determine encryption from conversation encryption state
      // (Conversation store tracks per-conversation E2EE preference)
      const shouldEncrypt = chatStore.getState().conversations.get(conversation_id)?.e2eeEnabled ?? false
      
      attachment = await uploadFileFunction(file, { encrypt: shouldEncrypt })
    }

    // Send message
    await xmppClient.chat.sendMessage(
      conversation_id,
      text || '',
      'chat',
      undefined, // no reply
      undefined, // no references
      attachment
    )
    
    console.log('[webxdc] Sent to chat:', conversation_id)
  } catch (error) {
    console.error('[webxdc] Failed to send to chat:', error)
  }
})
```

**Integration point:**
- Call site (likely in main app initialization): `initializeXmppBridge(client, useFileUpload().uploadFile)`
- `uploadFile` is from `@/hooks/useFileUpload` (already used in ChatView.tsx)

### 4. importFiles Implementation

**File:** `apps/fluux/src/utils/webxdc/importFiles.ts`

**Current state:** Throws error in production (TODO line 65-72)

**Fix:**
```typescript
export async function importFiles(
  options: ImportFilesOptions,
  mockFiles?: File[]
): Promise<File[]> {
  // ... existing validation ...
  
  // Test mode - use mocks
  if (mockFiles !== undefined) {
    // ... existing mock handling ...
    return filtered
  }

  // Production mode - call Tauri
  const filePaths = await invoke<string[]>('webxdc_import_files', {
    extensions: options.extensions || [],
    mimeTypes: options.mimeTypes || [],
    multiple: options.multiple !== false
  })

  // Convert file paths to File objects
  const files: File[] = []
  for (const path of filePaths) {
    const url = convertFileSrc(path)
    const response = await fetch(url)
    const blob = await response.blob()
    const fileName = path.split('/').pop() || 'file'
    files.push(new File([blob], fileName, { type: blob.type }))
  }

  return files
}
```

**Tauri backend needed:**
- Implement `webxdc_import_files` command (Rust)
- Use `rfd::FileDialog` or `tauri::api::dialog::FileDialogBuilder`
- Return selected file paths as Vec<String>

### 5. Realtime MUC Channels

**Files:** `apps/fluux/src/utils/webxdc/realtimeBridge.ts`, `RealtimeChannelManager.ts`

#### 5.1 Room Creation (realtimeBridge.ts TODO line 64-72)

```typescript
// In join event listener:
listen<JoinRealtimeEvent>('fluux://webxdc-realtime-join', async (event) => {
  const { instance_id, conversation_id, room_jid, nickname } = event.payload

  try {
    if (!xmppClient) {
      throw new Error('XMPP client not initialized')
    }

    // Get MUC service
    const mucService = getMucService()
    const actualRoomJid = room_jid.replace('{muc_service}', mucService)

    // Get conversation participants
    const participants = await getConversationParticipants(conversation_id)

    // Create private MUC room
    await xmppClient.muc.createRoom(
      actualRoomJid,
      nickname,
      {
        name: `WebXDC Realtime: ${instance_id}`,
        isPublic: false,
        membersOnly: true,
      },
      {
        invitees: participants,
      }
    )

    // Track room -> instance mapping
    roomToInstance.set(actualRoomJid, instance_id)

    console.log('[webxdc-realtime] Created and joined room:', actualRoomJid)
  } catch (error) {
    console.error('[webxdc-realtime] Failed to join room:', error)
  }
})
```

#### 5.2 Sending to Room (realtimeBridge.ts TODO line 98-100)

```typescript
// In send event listener:
listen<RealtimeSendEvent>('fluux://webxdc-realtime-send', async (event) => {
  const { room_jid, data } = event.payload

  try {
    if (!xmppClient) {
      throw new Error('XMPP client not initialized')
    }

    const mucService = getMucService()
    const actualRoomJid = room_jid.replace('{muc_service}', mucService)

    // Send as groupchat message (body is base64 data)
    await xmppClient.chat.sendMessage(actualRoomJid, data, 'groupchat')
    
    console.log('[webxdc-realtime] Sent to room:', actualRoomJid)
  } catch (error) {
    console.error('[webxdc-realtime] Failed to send:', error)
  }
})
```

#### 5.3 Leaving Room (realtimeBridge.ts TODO line 121-123)

```typescript
// In leave event listener:
listen<RealtimeLeaveEvent>('fluux://webxdc-realtime-leave', async (event) => {
  const { room_jid } = event.payload

  try {
    if (!xmppClient) {
      throw new Error('XMPP client not initialized')
    }

    const mucService = getMucService()
    const actualRoomJid = room_jid.replace('{muc_service}', mucService)

    // Leave room
    await xmppClient.muc.leaveRoom(actualRoomJid)

    // Cleanup mapping
    roomToInstance.delete(actualRoomJid)

    console.log('[webxdc-realtime] Left room:', actualRoomJid)
  } catch (error) {
    console.error('[webxdc-realtime] Failed to leave:', error)
  }
})
```

#### 5.4 Receiving Room Messages

```typescript
// Listen to SDK room message events
xmppClient.on('room:message', async (event) => {
  const { roomJid, message } = event
  const instanceId = roomToInstance.get(roomJid)
  
  if (!instanceId) return // Not a realtime room
  
  // Forward to Tauri backend
  await handleRealtimeMessage(roomJid, message.body || '')
})
```

#### 5.5 MUC Service Discovery (realtimeBridge.ts TODO line 160-162)

```typescript
import { useAdminStore } from '@fluux/sdk/react'

function getMucService(): string {
  const mucServiceJid = useAdminStore.getState().mucServiceJid
  return mucServiceJid || 'conference.localhost' // Fallback
}
```

#### 5.6 Participant Fetching (realtimeBridge.ts TODO line 165-167)

```typescript
import { chatStore } from '@fluux/sdk'
import { getBareJid } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'

async function getConversationParticipants(conversationId: string): Promise<string[]> {
  const conversation = chatStore.getState().conversations.get(conversationId)
  const myJid = useConnectionStore.getState().jid
  
  if (!conversation || !myJid) return []
  
  // For 1:1 chat: conversationId IS the other party's JID
  // For MUC: need to get participants from room occupants
  const room = chatStore.getState().rooms?.get(conversationId)
  
  if (room) {
    // MUC room - invite all current occupants except self
    return Array.from(room.occupants.keys())
      .filter(jid => getBareJid(jid) !== getBareJid(myJid))
  } else {
    // 1:1 chat - invite the other party
    return [conversationId]
  }
}
```

#### 5.7 RealtimeChannelManager (RealtimeChannelManager.ts TODOs line 60, 75, 91)

Replace TODOs with `invoke()` calls:

```typescript
// Line 60 - send
await invoke('webxdc_realtime_send', {
  roomJid: this.roomJid,
  data: base64Data
})

// Line 75 - join
await invoke('webxdc_realtime_join', {
  instanceId: this.instanceId,
  conversationId: this.conversationId,
  roomJid: this.roomJid,
  nickname: this.nickname
})

// Line 91 - leave
await invoke('webxdc_realtime_leave', {
  roomJid: this.roomJid
})
```

## Data Flow

### Update Sync (Happy Path)

```
User A sends update in WebXDC app
  ↓
window.webxdc.sendUpdate(payload, info)
  ↓
Tauri: webxdc_send_update (stores in SQLite)
  ↓
Tauri emits: fluux://webxdc-outgoing-update
  ↓
xmppBridge.ts: sendWebxdcUpdateViaXMPP()
  ↓
SDK: client.chat.sendCustomMessage(conversationId, body, 'chat', [webxdcElement])
  ↓
XMPP server routes to User B
  ↓
SDK: handleMessageInternal() detects <x xmlns="urn:xmpp:webxdc:0">
  ↓
SDK emits: 'webxdc:update' event
  ↓
xmppBridge.ts: receiveWebxdcUpdate()
  ↓
Tauri: webxdc_receive_update (stores + notifies windows)
  ↓
User B's WebXDC app receives update via setUpdateListener()
```

## Error Handling

### Network Failures
- `sendCustomMessage()` throws on send failure
- Catch in bridge, log error, don't crash app
- Updates stay in SQLite - can add retry mechanism later

### Encryption Failures
- SDK throws `E2EEEncryptionRequiredError` if conversation requires E2EE
- Propagate to user via toast notification
- Don't send update until encryption succeeds

### Invalid Data
- Validate payload is JSON-serializable before sending
- Validate instance_id format (conversationId:attachmentUrl)
- Throw early with clear error messages

### MUC Failures
- Room creation can fail (name taken, permissions)
- SDK's `createRoom()` already throws `RoomJoinError`
- Show error to user, don't leave zombie realtime channel

## Testing Strategy

### Unit Tests (TDD)

**SDK tests:**
- `Chat.sendCustomMessage.test.ts` - verify custom XML elements appended correctly
- `Chat.webxdc.test.ts` - verify incoming WebXDC stanzas emit events

**Bridge tests:**
- `xmppBridge.test.ts` - mock SDK client, verify XMPP calls
- `sendToChat.test.ts` - mock uploadFile/sendMessage, verify integration
- `importFiles.test.ts` - mock Tauri invoke, verify File objects created
- `realtimeBridge.test.ts` - mock MUC methods, verify room lifecycle

### Integration Tests
- Test full flow: send update → SDK processes → receive update
- Use SDK's test harness (existing Chat/MUC tests)
- Mock XMPP server with test stanzas

### Manual Testing Checklist
- [ ] Send update in WebXDC app, verify arrives on other device
- [ ] Export file from WebXDC to chat, verify message appears
- [ ] Import file into WebXDC, verify file picker works
- [ ] Join realtime channel, send data, verify other participants receive
- [ ] Test encryption enabled/disabled scenarios
- [ ] Test offline → online reconnection

## Implementation Phases

### Phase 1: Foundation (SDK Changes)
**Goal:** Add minimal SDK support

**Tasks:**
1. Add `sendCustomMessage()` to Chat.ts with tests
2. Add WebXDC stanza detection to `handleMessageInternal()` with tests
3. Export `'webxdc:update'` event type in SDK types

**Acceptance:** SDK tests pass, can send/receive custom XML

**Effort:** Small (~50 lines, 1-2 test files)

### Phase 2: XMPP Update Sync
**Goal:** Multi-user WebXDC apps sync state

**TDD approach:**
1. Test: mock `sendCustomMessage()`, verify correct XML structure
2. Implement: replace TODO with SDK call in `sendWebxdcUpdateViaXMPP()`
3. Test: mock `'webxdc:update'` event, verify `receiveWebxdcUpdate()` called
4. Implement: listen to SDK event, wire to Tauri
5. Fix sender ID resolution

**Acceptance:** Updates sync between users

**Effort:** Medium (2-3 test files)

### Phase 3: sendToChat
**Goal:** Export content to chat

**TDD approach:**
1. Test: mock `uploadFile()`, verify upload + message sent
2. Implement: integrate `uploadFile()` in xmppBridge.ts
3. Test: mock `sendMessage()`, verify params correct
4. Implement: call `sendMessage()` with attachment
5. Handle file conversion (base64 → File)

**Acceptance:** sendToChat posts message with attachment

**Effort:** Medium (2 test files)

### Phase 4: importFiles
**Goal:** Import files into WebXDC

**TDD approach:**
1. Test: mock Tauri invoke, verify file picker options
2. Implement: call `invoke('webxdc_import_files', ...)`
3. Test: mock file paths, verify File objects created
4. Implement: convert paths to Files using fetch

**Acceptance:** File picker works, files available in app

**Effort:** Small (1 test file)

**Note:** Requires Tauri backend command (Rust)

### Phase 5: Realtime Channels
**Goal:** Real-time collaboration via MUC

**TDD approach:**
1. Test: mock `createRoom()`, verify config correct
2. Implement: call `client.muc.createRoom()` in join handler
3. Test: mock `sendMessage(..., 'groupchat')`, verify data sent
4. Implement: send realtime messages as MUC messages
5. Test: mock room message event, verify forwarded to Tauri
6. Implement: listen to `'room:message'`, filter by room JID
7. Fix MUC service discovery (use admin store)
8. Fix participant fetching (use conversation store)

**Acceptance:** Multi-user realtime collaboration works

**Effort:** Large (3-4 test files)

### Phase 6: Polish
**Goal:** Production-ready

**Tasks:**
- Error handling improvements (user-facing messages)
- Retry logic for failed sends
- Cleanup rooms on window close
- Performance: debounce high-frequency updates
- Documentation: JSDoc comments

**Acceptance:** Smooth UX, no memory leaks

**Effort:** Medium

## Dependencies

### Frontend Dependencies
- All existing - no new npm packages needed
- Uses `@tauri-apps/api`, `@fluux/sdk`, `@xmpp/client`

### Backend Dependencies (Tauri - Rust)
- Add `rfd` crate for file picker (or use `tauri-plugin-dialog`)
- Commands needed:
  - `webxdc_import_files` - show file picker, return paths
  - `webxdc_send_to_chat` - receive file data from frontend
  - `webxdc_realtime_join/send/leave` - emit IPC events to frontend

### XMPP Server
- Must support XEP-0045 (MUC) - already required for rooms
- XEP-0491 (WebXDC) support optional (just custom namespace)

## Security Considerations

### End-to-End Encryption
- WebXDC updates go through same E2EE pipeline as messages
- `sendCustomMessage()` applies encryption if conversation requires it
- Realtime MUC messages can use E2EE if room is configured for it

### File Upload
- File size limits already enforced (100MB in `sendToChat.ts`)
- MIME type validation in `importFiles()`
- Uploaded files go through existing upload security checks

### Input Validation
- JSON.parse() wrapped in try-catch for incoming payloads
- Instance ID format validated (must contain ':')
- Room JIDs validated by SDK (must be valid JID format)

## Open Questions

**Q: Should we add retry logic for failed XMPP sends in Phase 2 or Phase 6?**  
A: Phase 6 (polish). Phase 2 focuses on getting happy path working.

**Q: Should realtime messages be encrypted by default?**  
A: Follow room configuration. If room is E2EE-enabled, encrypt. Otherwise plaintext.

**Q: What happens if MUC service discovery fails?**  
A: Fall back to 'conference.localhost'. Show warning in console. User can manually configure in settings.

**Q: Should we rate-limit realtime updates?**  
A: Yes, but in Phase 6. Debounce at 60Hz (16ms) to prevent flooding.

## Success Criteria

Implementation is complete when:
- [ ] All 17 TODOs removed or replaced with working code
- [ ] All tests pass (unit + integration)
- [ ] Manual testing checklist complete
- [ ] WebXDC demo apps work end-to-end (Chess, Checklist, Poll)
- [ ] No console errors in normal operation
- [ ] Documentation updated (JSDoc on public APIs)

## References

- [XEP-0491: WebXDC](https://xmpp.org/extensions/inbox/webxdc.html)
- [XEP-0045: Multi-User Chat](https://xmpp.org/extensions/xep-0045.html)
- [WebXDC Specification](https://webxdc.org/spec.html)
- [Fluux SDK Documentation](../../packages/fluux-sdk/README.md)
