# WebXDC TODO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 17 outstanding TODOs to enable full WebXDC XMPP synchronization, file import/export, and real-time collaboration.

**Architecture:** Minimal SDK changes (~35 lines to Chat.ts) + WebXDC bridge implementations in app layer. Reuses existing SDK infrastructure (sendMessage, uploadFile, MUC) with two focused additions: sendCustomMessage() method and WebXDC stanza detection.

**Tech Stack:** TypeScript, @fluux/sdk, @xmpp/client, @tauri-apps/api, Vitest

## Global Constraints

- All SDK changes must preserve existing functionality - no breaking changes
- Follow existing SDK patterns (event emission, error handling, encryption)
- All new code must have unit tests (TDD approach)
- WebXDC namespace: `urn:xmpp:webxdc:0` (XEP-0491)
- Maximum file size: 100MB (already enforced)
- Commit after each task completion with descriptive messages
- Use `Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>` in all commits

---

## Task 1: SDK Foundation - sendCustomMessage()

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts:796-980` (sendMessage region)
- Create: `packages/fluux-sdk/src/core/modules/Chat.sendCustomMessage.test.ts`
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts:export` (add public method)

**Interfaces:**
- Consumes: existing `xml()` from `@xmpp/client`, existing `sendMessage()` infrastructure
- Produces: `async sendCustomMessage(to: string, body: string, type: 'chat' | 'groupchat', customChildren: Element[]): Promise<string>`

- [ ] **Step 1: Write failing test for sendCustomMessage with custom XML**

Create `packages/fluux-sdk/src/core/modules/Chat.sendCustomMessage.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { xml } from '@xmpp/client'
import { Chat } from './Chat'
import type { ModuleDependencies } from './BaseModule'

describe('Chat.sendCustomMessage', () => {
  let chat: Chat
  let mockDeps: ModuleDependencies

  beforeEach(() => {
    mockDeps = {
      sendStanza: vi.fn().mockResolvedValue(undefined),
      emitSDK: vi.fn(),
      emit: vi.fn(),
      stores: {} as any,
      getE2EEManager: vi.fn().mockReturnValue(null),
    }
    chat = new Chat(mockDeps)
  })

  it('should send message with custom XML children', async () => {
    const customElement = xml('x', { xmlns: 'urn:xmpp:webxdc:0' },
      xml('instance', {}, 'test-instance'),
      xml('serial', {}, '42')
    )

    await chat.sendCustomMessage(
      'user@example.com',
      '[WebXDC Update]',
      'chat',
      [customElement]
    )

    expect(mockDeps.sendStanza).toHaveBeenCalledTimes(1)
    const sentStanza = mockDeps.sendStanza.mock.calls[0][0]
    
    // Verify message has body
    expect(sentStanza.getChildText('body')).toBe('[WebXDC Update]')
    
    // Verify custom element is present
    const webxdcElement = sentStanza.getChild('x', 'urn:xmpp:webxdc:0')
    expect(webxdcElement).toBeDefined()
    expect(webxdcElement?.getChildText('instance')).toBe('test-instance')
    expect(webxdcElement?.getChildText('serial')).toBe('42')
  })

  it('should include origin-id and active chat state', async () => {
    const customElement = xml('test', { xmlns: 'urn:test:0' })

    await chat.sendCustomMessage('user@example.com', 'Test', 'chat', [customElement])

    const sentStanza = mockDeps.sendStanza.mock.calls[0][0]
    
    // Should have origin-id
    expect(sentStanza.getChild('origin-id')).toBeDefined()
    
    // Should have active chat state
    expect(sentStanza.getChild('active', 'http://jabber.org/protocol/chatstates')).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/fluux-sdk/src/core/modules/Chat.sendCustomMessage.test.ts`

Expected: FAIL with "chat.sendCustomMessage is not a function"

- [ ] **Step 3: Extract message construction helper from sendMessage()**

In `packages/fluux-sdk/src/core/modules/Chat.ts`, add before `sendMessage()`:

```typescript
/**
 * Internal helper: construct a message stanza with common elements.
 * Used by both sendMessage() and sendCustomMessage().
 */
private buildMessageStanza(
  to: string,
  body: string,
  type: 'chat' | 'groupchat' = 'chat',
  additionalChildren: Element[] = []
): { stanza: Element; id: string } {
  const id = generateUUID()
  const recipient = type === 'chat' ? getBareJid(to) : to

  const children = [
    xml('body', {}, body),
    xml('active', { xmlns: NS_CHATSTATES }),
    ...additionalChildren
  ]

  const message = xml('message', { to: recipient, type, id }, ...children)
  
  // Add origin-id
  children.push(createOriginIdElement(id))
  
  return { stanza: message, id }
}
```

- [ ] **Step 4: Refactor sendMessage() to use helper**

Replace the message construction in `sendMessage()` (lines ~804-920) to use `buildMessageStanza()`:

```typescript
async sendMessage(
  to: string,
  body: string,
  type: 'chat' | 'groupchat' = 'chat',
  replyTo?: { id: string; to?: string; fallback?: { author: string; body: string; fromEncrypted?: boolean } },
  references?: MentionReference[],
  attachment?: FileAttachment
): Promise<string> {
  // Build full body with reply fallback
  let fullBody = body
  let fallbackEnd = 0
  if (replyTo?.fallback) {
    const quotedLines = replyTo.fallback.body.split('\n').map(line => `> ${line}`).join('\n')
    const fallbackText = `> ${replyTo.fallback.author} wrote:\n${quotedLines}\n`
    fallbackEnd = fallbackText.length
    fullBody = fallbackText + body
  }

  // Handle attachment URL in body
  let oobFallbackStart = 0
  let oobFallbackEnd = 0
  if (attachment) {
    if (fullBody.length === 0 || fullBody === attachment.url) {
      fullBody = attachment.url
      oobFallbackStart = 0
    } else {
      oobFallbackStart = fullBody.length + 1
      fullBody = fullBody + '\n' + attachment.url
    }
    oobFallbackEnd = fullBody.length
  }

  // Build additional children (reply, references, attachment, etc.)
  const additionalChildren: Element[] = []

  if (replyTo) {
    const replyReferenceId = this.getMessageReferenceId(to, replyTo.id, type)
    const replyAttrs: Record<string, string> = { xmlns: NS_REPLY, id: replyReferenceId }
    if (replyTo.to) replyAttrs.to = replyTo.to
    additionalChildren.push(xml('reply', replyAttrs))

    if (replyTo.fallback) {
      additionalChildren.push(
        xml('fallback', { xmlns: NS_FALLBACK, for: NS_REPLY },
          xml('body', { start: '0', end: String(fallbackEnd) })
        )
      )
    }
  }

  if (references && references.length > 0) {
    let hasMentionAll = false
    for (const ref of references) {
      additionalChildren.push(xml('reference', {
        xmlns: NS_REFERENCE,
        begin: ref.begin.toString(),
        end: ref.end.toString(),
        type: ref.type,
        uri: ref.uri,
      }))
      if (!ref.uri.includes('/')) hasMentionAll = true
    }
    if (hasMentionAll) additionalChildren.push(xml('mention-all', { xmlns: NS_MENTION_ALL }))
  }

  if (attachment) {
    // ... (keep existing attachment logic, add elements to additionalChildren)
  }

  // Use helper to build message
  const { stanza, id } = this.buildMessageStanza(to, fullBody, type, additionalChildren)

  // Apply E2EE if needed
  await this.applyE2EEToOutboundChat(stanza, to, fullBody, type, { encryptBody: true })

  // Send
  await this.deps.sendStanza(stanza)

  // ... (keep existing chat state persistence logic)

  return id
}
```

- [ ] **Step 5: Implement sendCustomMessage() using helper**

Add after `sendMessage()`:

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
): Promise<string> {
  const { stanza, id } = this.buildMessageStanza(to, body, type, customChildren)

  // Apply E2EE if conversation requires it
  await this.applyE2EEToOutboundChat(stanza, to, body, type, { encryptBody: true })

  // Send stanza
  await this.deps.sendStanza(stanza)

  // Emit SDK event for local message tracking
  const conversationId = type === 'chat' ? getBareJid(to) : to
  this.deps.emitSDK('chat:message-sent', { conversationId, messageId: id, body, type })

  return id
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- packages/fluux-sdk/src/core/modules/Chat`

Expected: ALL PASS (both new tests and existing Chat tests)

- [ ] **Step 7: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.sendCustomMessage.test.ts
git commit -m "$(cat <<'EOF'
feat(sdk): add Chat.sendCustomMessage() for custom XML elements

Adds minimal SDK method to send messages with arbitrary XML children.
Refactors sendMessage() to share message construction logic.

- Extract buildMessageStanza() helper
- Implement sendCustomMessage() using helper
- Preserve encryption, carbons, origin-id
- Add comprehensive unit tests

Enables WebXDC update sync and other protocol extensions without
modifying core sendMessage() logic.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SDK Foundation - WebXDC Stanza Detection

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts:175-250` (handleMessageInternal)
- Create: `packages/fluux-sdk/src/core/modules/Chat.webxdc.test.ts`
- Modify: `packages/fluux-sdk/src/core/namespaces.ts` (add NS_WEBXDC constant)
- Modify: `packages/fluux-sdk/src/core/types/index.ts` (add WebxdcUpdateEvent type)

**Interfaces:**
- Consumes: `handleMessageInternal()` stanza processing
- Produces: `'webxdc:update'` SDK event with `{ from: string, instance: string, serial: number, payload: unknown, info?: string, document?: string, summary?: string, sender: string }`

- [ ] **Step 1: Add WebXDC namespace constant**

In `packages/fluux-sdk/src/core/namespaces.ts`, add:

```typescript
export const NS_WEBXDC = 'urn:xmpp:webxdc:0'
```

- [ ] **Step 2: Add WebxdcUpdateEvent type**

In `packages/fluux-sdk/src/core/types/index.ts`, add:

```typescript
export interface WebxdcUpdateEvent {
  from: string
  instance: string
  serial: number
  payload: unknown
  info?: string
  document?: string
  summary?: string
  sender: string
}
```

- [ ] **Step 3: Write failing test for WebXDC stanza detection**

Create `packages/fluux-sdk/src/core/modules/Chat.webxdc.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { xml } from '@xmpp/client'
import { Chat } from './Chat'
import type { ModuleDependencies } from './BaseModule'
import { NS_WEBXDC } from '../namespaces'

describe('Chat WebXDC stanza handling', () => {
  let chat: Chat
  let mockDeps: ModuleDependencies

  beforeEach(() => {
    mockDeps = {
      sendStanza: vi.fn(),
      emitSDK: vi.fn(),
      emit: vi.fn(),
      stores: {} as any,
      getE2EEManager: vi.fn().mockReturnValue(null),
    }
    chat = new Chat(mockDeps)
  })

  it('should detect and emit webxdc:update event for incoming WebXDC stanza', () => {
    const stanza = xml('message', {
      from: 'user@example.com/resource',
      to: 'me@example.com',
      type: 'chat'
    },
      xml('body', {}, '[WebXDC Update]'),
      xml('x', { xmlns: NS_WEBXDC },
        xml('instance', {}, 'conv123:https://example.com/app.xdc'),
        xml('serial', {}, '42'),
        xml('payload', {}, '{"action":"move","position":5}'),
        xml('info', {}, 'Alice moved piece to position 5'),
        xml('summary', {}, 'Game in progress')
      )
    )

    // Call internal handler directly (it's private but we can test via message routing)
    const handled = (chat as any).handleMessage(stanza)

    expect(handled).toBe(true)
    expect(mockDeps.emitSDK).toHaveBeenCalledWith('webxdc:update', {
      from: 'user@example.com',
      instance: 'conv123:https://example.com/app.xdc',
      serial: 42,
      payload: { action: 'move', position: 5 },
      info: 'Alice moved piece to position 5',
      document: undefined,
      summary: 'Game in progress',
      sender: 'user@example.com/resource'
    })
  })

  it('should handle WebXDC stanza without optional fields', () => {
    const stanza = xml('message', {
      from: 'user@example.com',
      type: 'chat'
    },
      xml('x', { xmlns: NS_WEBXDC },
        xml('instance', {}, 'test-instance'),
        xml('serial', {}, '1'),
        xml('payload', {}, '{}')
      )
    )

    const handled = (chat as any).handleMessage(stanza)

    expect(handled).toBe(true)
    expect(mockDeps.emitSDK).toHaveBeenCalledWith('webxdc:update', {
      from: 'user@example.com',
      instance: 'test-instance',
      serial: 1,
      payload: {},
      info: undefined,
      document: undefined,
      summary: undefined,
      sender: 'user@example.com'
    })
  })

  it('should ignore stanza without from attribute', () => {
    const stanza = xml('message', { type: 'chat' },
      xml('x', { xmlns: NS_WEBXDC },
        xml('instance', {}, 'test'),
        xml('serial', {}, '1'),
        xml('payload', {}, '{}')
      )
    )

    const handled = (chat as any).handleMessage(stanza)

    // Should be handled but not emit event
    expect(mockDeps.emitSDK).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- packages/fluux-sdk/src/core/modules/Chat.webxdc.test.ts`

Expected: FAIL - event not emitted

- [ ] **Step 5: Add WebXDC detection to handleMessageInternal()**

In `packages/fluux-sdk/src/core/modules/Chat.ts`, import the namespace:

```typescript
import { NS_WEBXDC } from '../namespaces'
```

In `handleMessageInternal()`, add after carbon copy handling (around line 189), before type routing:

```typescript
// XEP-0491: WebXDC update detection
const webxdcElement = stanza.getChild('x', NS_WEBXDC)
if (webxdcElement) {
  const from = stanza.attrs.from
  const bareFrom = from ? getBareJid(from) : undefined
  
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
      sender: from || bareFrom
    })
  }
  return { handled: true }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- packages/fluux-sdk/src/core/modules/Chat.webxdc.test.ts`

Expected: ALL PASS

- [ ] **Step 7: Run all Chat tests to ensure no regressions**

Run: `npm test -- packages/fluux-sdk/src/core/modules/Chat`

Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.webxdc.test.ts packages/fluux-sdk/src/core/namespaces.ts packages/fluux-sdk/src/core/types/index.ts
git commit -m "$(cat <<'EOF'
feat(sdk): add WebXDC stanza detection to Chat module

Detects incoming XMPP messages with WebXDC update elements
(XEP-0491) and emits 'webxdc:update' SDK event.

- Add NS_WEBXDC namespace constant
- Add WebxdcUpdateEvent type
- Detect <x xmlns="urn:xmpp:webxdc:0"> in handleMessageInternal()
- Parse instance, serial, payload, optional fields
- Emit event with parsed data
- Add comprehensive unit tests

Enables WebXDC apps to receive updates from other users via XMPP.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: XMPP Update Sync - Outgoing Updates

**Files:**
- Modify: `apps/fluux/src/utils/webxdc/xmppBridge.ts:146-245` (sendWebxdcUpdateViaXMPP)
- Create: `apps/fluux/src/utils/webxdc/xmppBridge.test.ts`

**Interfaces:**
- Consumes: `Chat.sendCustomMessage()` from Task 1, `xmppClient` from initialization
- Produces: XMPP message stanzas with WebXDC update elements sent via `sendCustomMessage()`

- [ ] **Step 1: Write failing test for outgoing update transmission**

Create `apps/fluux/src/utils/webxdc/xmppBridge.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { xml } from '@xmpp/client'
import type { XMPPClient } from '@fluux/sdk/core'
import { initializeXmppBridge, sendWebxdcUpdate } from './xmppBridge'

describe('xmppBridge', () => {
  let mockClient: Partial<XMPPClient>
  let mockSendCustomMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockSendCustomMessage = vi.fn().mockResolvedValue('msg-123')
    mockClient = {
      chat: {
        sendCustomMessage: mockSendCustomMessage
      } as any,
      on: vi.fn()
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('sendWebxdcUpdate', () => {
    it('should send WebXDC update via XMPP with correct structure', async () => {
      initializeXmppBridge(mockClient as XMPPClient)

      const instanceId = 'conv123:https://example.com/chess.xdc'
      const payload = { action: 'move', from: 'e2', to: 'e4' }
      const info = 'Player moved pawn'

      await sendWebxdcUpdate(instanceId, payload, info, undefined, undefined, 'user@example.com')

      expect(mockSendCustomMessage).toHaveBeenCalledTimes(1)
      
      const [to, body, type, customChildren] = mockSendCustomMessage.mock.calls[0]
      
      expect(to).toBe('conv123')
      expect(body).toBe('[WebXDC Update: Player moved pawn]')
      expect(type).toBe('chat')
      expect(customChildren).toHaveLength(1)
      
      const webxdcElement = customChildren[0]
      expect(webxdcElement.name).toBe('x')
      expect(webxdcElement.attrs.xmlns).toBe('urn:xmpp:webxdc:0')
      
      const instance = webxdcElement.getChildText('instance')
      const serial = webxdcElement.getChildText('serial')
      const payloadStr = webxdcElement.getChildText('payload')
      const infoText = webxdcElement.getChildText('info')
      
      expect(instance).toBe(instanceId)
      expect(serial).toBe('1') // First update gets serial 1 from Tauri
      expect(JSON.parse(payloadStr)).toEqual(payload)
      expect(infoText).toBe(info)
    })

    it('should include document and summary if provided', async () => {
      initializeXmppBridge(mockClient as XMPPClient)

      await sendWebxdcUpdate(
        'test:app',
        { data: 'test' },
        'Info',
        'document.txt',
        'Summary text',
        'me@example.com'
      )

      const customChildren = mockSendCustomMessage.mock.calls[0][3]
      const webxdcElement = customChildren[0]
      
      expect(webxdcElement.getChildText('document')).toBe('document.txt')
      expect(webxdcElement.getChildText('summary')).toBe('Summary text')
    })

    it('should use default body when info is not provided', async () => {
      initializeXmppBridge(mockClient as XMPPClient)

      await sendWebxdcUpdate('test:app', {}, undefined, undefined, undefined, 'me@example.com')

      const body = mockSendCustomMessage.mock.calls[0][1]
      expect(body).toBe('[WebXDC Update: update]')
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- apps/fluux/src/utils/webxdc/xmppBridge.test.ts`

Expected: FAIL - sendCustomMessage not called

- [ ] **Step 3: Implement sendWebxdcUpdateViaXMPP()**

In `apps/fluux/src/utils/webxdc/xmppBridge.ts`, add import:

```typescript
import { xml } from '@xmpp/client'
```

Replace the TODO section (lines 207-244) with:

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

  // Build WebXDC update element
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

  // Construct message body
  const body = `[WebXDC Update: ${info || 'update'}]`
  
  // Send via SDK
  await xmppClient.chat.sendCustomMessage(
    conversationId,
    body,
    'chat',
    [updateElement]
  )

  console.log('[webxdc] Update transmitted via XMPP:', instanceId, serial)
}
```

- [ ] **Step 4: Update sendWebxdcUpdate() to await Tauri call**

Replace line 278 comment with actual transmission call:

```typescript
export async function sendWebxdcUpdate(
  instanceId: string,
  payload: unknown,
  info?: string,
  document?: string,
  summary?: string,
  senderId?: string
): Promise<void> {
  // Get sender JID from connection store
  const jid = useConnectionStore.getState().jid
  const actualSenderId = senderId || jid || 'unknown@example.com'

  // Store update in Tauri backend SQLite
  const result = await invoke<{ serial: number }>('webxdc_send_update', {
    instanceId,
    payload,
    info,
    document,
    summary,
    senderId: actualSenderId
  })

  // Extract conversation ID from instance_id
  const conversationId = instanceId.split(':')[0]

  // Transmit via XMPP
  await sendWebxdcUpdateViaXMPP(
    conversationId,
    instanceId,
    result.serial,
    payload,
    info,
    document,
    summary
  )

  console.log('[webxdc] Update stored and transmitted:', instanceId, result.serial)
}
```

- [ ] **Step 5: Add import for useConnectionStore**

At top of file:

```typescript
import { useConnectionStore } from '@fluux/sdk/react'
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- apps/fluux/src/utils/webxdc/xmppBridge.test.ts`

Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/utils/webxdc/xmppBridge.ts apps/fluux/src/utils/webxdc/xmppBridge.test.ts
git commit -m "$(cat <<'EOF'
feat(webxdc): implement outgoing XMPP update transmission

Replaces TODO with working implementation that sends WebXDC updates
via XMPP using SDK's sendCustomMessage().

- Build WebXDC update XML element per XEP-0491
- Send via Chat.sendCustomMessage() with custom namespace
- Extract conversation ID from instance_id
- Get sender JID from connection store
- Add comprehensive unit tests

Updates now transmit from sender to XMPP server.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: XMPP Update Sync - Incoming Updates

**Files:**
- Modify: `apps/fluux/src/utils/webxdc/xmppBridge.ts:45-133` (initializeXmppBridge)
- Modify: `apps/fluux/src/utils/webxdc/xmppBridge.test.ts` (add incoming tests)

**Interfaces:**
- Consumes: `'webxdc:update'` SDK event from Task 2, `receiveWebxdcUpdate()` existing function
- Produces: Incoming WebXDC updates processed and stored via Tauri

- [ ] **Step 1: Write failing test for incoming update handling**

In `apps/fluux/src/utils/webxdc/xmppBridge.test.ts`, add:

```typescript
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

describe('xmppBridge incoming updates', () => {
  let mockClient: Partial<XMPPClient>
  let eventHandlers: Map<string, Function>

  beforeEach(() => {
    eventHandlers = new Map()
    
    mockClient = {
      chat: {
        sendCustomMessage: vi.fn()
      } as any,
      on: vi.fn((event, handler) => {
        eventHandlers.set(event, handler)
      })
    }

    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('should listen for webxdc:update events and store incoming updates', async () => {
    initializeXmppBridge(mockClient as XMPPClient)

    // Verify listener was registered
    expect(mockClient.on).toHaveBeenCalledWith('webxdc:update', expect.any(Function))

    // Simulate incoming WebXDC update event
    const updateEvent = {
      from: 'alice@example.com',
      instance: 'conv123:https://example.com/chess.xdc',
      serial: 5,
      payload: { action: 'move', position: 'e4' },
      info: 'Alice moved to e4',
      document: undefined,
      summary: 'Game in progress',
      sender: 'alice@example.com/resource'
    }

    const handler = eventHandlers.get('webxdc:update')
    await handler!(updateEvent)

    // Should call Tauri to receive update
    expect(invoke).toHaveBeenCalledWith('webxdc_receive_update', {
      instanceId: 'conv123:https://example.com/chess.xdc',
      payload: { action: 'move', position: 'e4' },
      info: 'Alice moved to e4',
      document: undefined,
      summary: 'Game in progress',
      senderId: 'alice@example.com/resource',
      timestamp: expect.any(Number)
    })
  })

  it('should handle updates without optional fields', async () => {
    initializeXmppBridge(mockClient as XMPPClient)

    const updateEvent = {
      from: 'bob@example.com',
      instance: 'test:app',
      serial: 1,
      payload: {},
      sender: 'bob@example.com'
    }

    const handler = eventHandlers.get('webxdc:update')
    await handler!(updateEvent)

    expect(invoke).toHaveBeenCalledWith('webxdc_receive_update', {
      instanceId: 'test:app',
      payload: {},
      info: undefined,
      document: undefined,
      summary: undefined,
      senderId: 'bob@example.com',
      timestamp: expect.any(Number)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- apps/fluux/src/utils/webxdc/xmppBridge.test.ts`

Expected: FAIL - event listener not registered

- [ ] **Step 3: Add incoming update listener to initializeXmppBridge()**

In `apps/fluux/src/utils/webxdc/xmppBridge.ts`, after the outgoing update listener (around line 79), add:

```typescript
// Listen for incoming WebXDC updates from XMPP
xmppClient.on('webxdc:update', async (event) => {
  const { from, instance, serial, payload, info, document, summary, sender } = event
  
  try {
    await receiveWebxdcUpdate(instance, {
      serial,
      max_serial: serial,
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

- [ ] **Step 4: Update receiveWebxdcUpdate() to include timestamp**

Modify `receiveWebxdcUpdate()` function (around line 293):

```typescript
export async function receiveWebxdcUpdate(
  instanceId: string,
  update: WebxdcUpdate
): Promise<void> {
  // Store incoming update in Tauri backend and notify windows
  await invoke('webxdc_receive_update', {
    instanceId,
    payload: update.payload,
    info: update.info,
    document: update.document,
    summary: update.summary,
    senderId: update.sender,
    timestamp: Math.floor(Date.now() / 1000)
  })

  console.log('[webxdc] Update received from XMPP and distributed:', instanceId)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- apps/fluux/src/utils/webxdc/xmppBridge.test.ts`

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/utils/webxdc/xmppBridge.ts apps/fluux/src/utils/webxdc/xmppBridge.test.ts
git commit -m "$(cat <<'EOF'
feat(webxdc): implement incoming XMPP update reception

Listens to 'webxdc:update' SDK event and processes incoming updates.

- Register event listener in initializeXmppBridge()
- Call receiveWebxdcUpdate() to store in Tauri backend
- Add timestamp to stored updates
- Add comprehensive unit tests

Updates now flow: sender → XMPP → SDK event → Tauri → WebXDC app.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: sendToChat - Frontend Integration

**Files:**
- Modify: `apps/fluux/src/utils/webxdc/sendToChat.ts:24-80`
- Modify: `apps/fluux/src/utils/webxdc/sendToChat.test.ts` (enhance existing tests)

**Interfaces:**
- Consumes: Tauri `invoke()` API
- Produces: Tauri IPC calls to `webxdc_send_to_chat` command with file/text data

- [ ] **Step 1: Write failing test for sendToChat with file**

In `apps/fluux/src/utils/webxdc/sendToChat.test.ts`, add:

```typescript
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

describe('sendToChat Tauri integration', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('should call Tauri with base64 file data', async () => {
    const blob = new Blob(['test content'], { type: 'text/plain' })
    
    await sendToChat({
      conversationId: 'user@example.com',
      file: {
        name: 'test.txt',
        blob
      }
    })

    expect(invoke).toHaveBeenCalledWith('webxdc_send_to_chat', {
      conversationId: 'user@example.com',
      fileName: 'test.txt',
      fileData: expect.any(String), // base64 encoded
      text: null
    })

    // Verify base64 encoding
    const call = vi.mocked(invoke).mock.calls[0]
    const base64 = call[1].fileData
    expect(atob(base64)).toBe('test content')
  })

  it('should call Tauri with text only', async () => {
    await sendToChat({
      conversationId: 'user@example.com',
      text: 'Hello from WebXDC'
    })

    expect(invoke).toHaveBeenCalledWith('webxdc_send_to_chat', {
      conversationId: 'user@example.com',
      fileName: null,
      fileData: null,
      text: 'Hello from WebXDC'
    })
  })

  it('should call Tauri with both file and text', async () => {
    const blob = new Blob(['file content'], { type: 'text/plain' })
    
    await sendToChat({
      conversationId: 'user@example.com',
      text: 'Check this out',
      file: {
        name: 'document.txt',
        blob
      }
    })

    expect(invoke).toHaveBeenCalledWith('webxdc_send_to_chat', {
      conversationId: 'user@example.com',
      fileName: 'document.txt',
      fileData: expect.any(String),
      text: 'Check this out'
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- apps/fluux/src/utils/webxdc/sendToChat.test.ts`

Expected: FAIL - invoke not called

- [ ] **Step 3: Add Tauri import**

In `apps/fluux/src/utils/webxdc/sendToChat.ts`, add at top:

```typescript
import { invoke } from '@tauri-apps/api/core'
```

- [ ] **Step 4: Implement Tauri integration in sendToChat()**

Replace the TODO sections (lines 56, 69) with:

```typescript
export async function sendToChat(options: SendToChatOptions): Promise<SendToChatResult> {
  // Validate conversationId
  if (!options.conversationId || options.conversationId.trim() === '') {
    throw new Error('conversationId required')
  }

  // Validate that either text or file is provided
  if (!options.text && !options.file) {
    throw new Error('text or file required')
  }

  // Validate text if provided without file
  if (options.text === '' && !options.file) {
    throw new Error('text or file required')
  }

  // Handle file upload
  if (options.file) {
    if (!options.file.name || options.file.name.trim() === '') {
      throw new Error('file name required')
    }

    let base64Data: string

    // Validate file content and convert to base64
    if (options.file.blob) {
      // Check file size
      if (options.file.blob.size > MAX_FILE_SIZE) {
        throw new Error('file size exceeds 100MB limit')
      }

      // Convert blob to base64
      base64Data = await blobToBase64(options.file.blob)
    } else if (options.file.base64 !== undefined) {
      // Validate base64 content
      if (options.file.base64.trim() === '') {
        throw new Error('file content required')
      }

      // Validate base64 encoding
      if (!isValidBase64(options.file.base64)) {
        throw new Error('invalid base64')
      }

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

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- apps/fluux/src/utils/webxdc/sendToChat.test.ts`

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/utils/webxdc/sendToChat.ts apps/fluux/src/utils/webxdc/sendToChat.test.ts
git commit -m "$(cat <<'EOF'
feat(webxdc): integrate sendToChat with Tauri backend

Implements file/text export from WebXDC apps to messenger chat.

- Call Tauri webxdc_send_to_chat command with file data
- Convert blob to base64 for IPC transfer
- Handle text-only, file-only, and combined cases
- Add comprehensive tests for Tauri integration

Frontend bridge complete - backend handler needed for XMPP send.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: sendToChat - XMPP Backend Handler

**Files:**
- Modify: `apps/fluux/src/utils/webxdc/xmppBridge.ts:108-130,292-299` (sendToChat listener)
- Modify: `apps/fluux/src/utils/webxdc/xmppBridge.ts:1-10` (add uploadFile param)
- Modify: `apps/fluux/src/utils/webxdc/xmppBridge.test.ts` (add sendToChat tests)

**Interfaces:**
- Consumes: `uploadFile()` hook, `Chat.sendMessage()`, Tauri event `fluux://webxdc-send-to-chat`
- Produces: XMPP messages with optional file attachments sent to conversation

- [ ] **Step 1: Write failing test for sendToChat XMPP handler**

In `apps/fluux/src/utils/webxdc/xmppBridge.test.ts`, add:

```typescript
import { listen } from '@tauri-apps/api/event'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

describe('sendToChat XMPP handler', () => {
  let mockClient: Partial<XMPPClient>
  let mockUploadFile: ReturnType<typeof vi.fn>
  let mockSendMessage: ReturnType<typeof vi.fn>
  let eventHandlers: Map<string, Function>

  beforeEach(() => {
    eventHandlers = new Map()
    mockSendMessage = vi.fn().mockResolvedValue('msg-id')
    mockUploadFile = vi.fn().mockResolvedValue({
      url: 'https://upload.example.com/file.txt',
      mediaType: 'text/plain',
      size: 100
    })

    mockClient = {
      chat: {
        sendMessage: mockSendMessage,
        sendCustomMessage: vi.fn()
      } as any,
      on: vi.fn()
    }

    vi.mocked(listen).mockImplementation((event, handler) => {
      eventHandlers.set(event, handler)
      return Promise.resolve(() => {})
    })
  })

  it('should upload file and send message when file_path provided', async () => {
    initializeXmppBridge(mockClient as XMPPClient, mockUploadFile)

    const handler = eventHandlers.get('fluux://webxdc-send-to-chat')
    
    await handler!({
      payload: {
        conversation_id: 'user@example.com',
        file_path: '/tmp/test.txt',
        text: 'Check this out'
      }
    })

    // Should upload file
    expect(mockUploadFile).toHaveBeenCalledWith(
      expect.any(File),
      { encrypt: false }
    )

    // Should send message with attachment
    expect(mockSendMessage).toHaveBeenCalledWith(
      'user@example.com',
      'Check this out',
      'chat',
      undefined,
      undefined,
      {
        url: 'https://upload.example.com/file.txt',
        mediaType: 'text/plain',
        size: 100
      }
    )
  })

  it('should send text-only message when no file', async () => {
    initializeXmppBridge(mockClient as XMPPClient, mockUploadFile)

    const handler = eventHandlers.get('fluux://webxdc-send-to-chat')
    
    await handler!({
      payload: {
        conversation_id: 'user@example.com',
        file_path: null,
        text: 'Hello!'
      }
    })

    // Should not upload
    expect(mockUploadFile).not.toHaveBeenCalled()

    // Should send text message
    expect(mockSendMessage).toHaveBeenCalledWith(
      'user@example.com',
      'Hello!',
      'chat',
      undefined,
      undefined,
      undefined
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- apps/fluux/src/utils/webxdc/xmppBridge.test.ts`

Expected: FAIL - uploadFile parameter not accepted

- [ ] **Step 3: Add uploadFile parameter to initializeXmppBridge()**

Modify function signature:

```typescript
let uploadFileFunction: ((file: File, options?: { encrypt?: boolean }) => Promise<FileAttachment | null>) | null = null

export function initializeXmppBridge(
  client: XMPPClient,
  uploadFile: (file: File, options?: { encrypt?: boolean }) => Promise<FileAttachment | null>
): void {
  if (isListening) {
    console.warn('[webxdc] XMPP bridge already initialized')
    return
  }

  xmppClient = client
  uploadFileFunction = uploadFile

  // ... rest of function
}
```

- [ ] **Step 4: Add imports for file handling**

At top of file:

```typescript
import { convertFileSrc } from '@tauri-apps/api/core'
import { chatStore } from '@fluux/sdk'
import type { FileAttachment } from '@fluux/sdk'
```

- [ ] **Step 5: Implement sendToChat event handler**

Replace the TODO section (lines 120-128) in the sendToChat listener:

```typescript
listen<SendToChatEvent>('fluux://webxdc-send-to-chat', async (event) => {
  const { conversation_id, file_path, text } = event.payload

  console.log('[webxdc] sendToChat event:', conversation_id, file_path ? 'with file' : 'text only')

  try {
    if (!xmppClient) {
      console.error('[webxdc] XMPP client not initialized')
      return
    }

    let attachment: FileAttachment | undefined

    // Upload file if provided
    if (file_path && uploadFileFunction) {
      // Convert Tauri file path to File object
      const url = convertFileSrc(file_path)
      const response = await fetch(url)
      const blob = await response.blob()
      const fileName = file_path.split('/').pop() || 'file'
      const file = new File([blob], fileName, { type: blob.type })
      
      // Determine encryption from conversation E2EE state
      const conversation = chatStore.getState().conversations.get(conversation_id)
      const shouldEncrypt = conversation?.e2eeEnabled ?? false
      
      // Upload file
      const result = await uploadFileFunction(file, { encrypt: shouldEncrypt })
      if (result) {
        attachment = result
      }
    }

    // Send message to conversation
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
}).catch((err) => {
  console.error('[webxdc] Failed to set up sendToChat listener:', err)
})
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- apps/fluux/src/utils/webxdc/xmppBridge.test.ts`

Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/utils/webxdc/xmppBridge.ts apps/fluux/src/utils/webxdc/xmppBridge.test.ts
git commit -m "$(cat <<'EOF'
feat(webxdc): implement sendToChat XMPP message handler

Processes Tauri sendToChat events and sends XMPP messages.

- Add uploadFile parameter to initializeXmppBridge()
- Convert Tauri file paths to File objects via fetch
- Upload files using existing uploadFile hook
- Determine encryption from conversation E2EE state
- Send message with optional attachment
- Add comprehensive unit tests

sendToChat now works end-to-end: WebXDC → Tauri → XMPP → chat.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: importFiles Implementation

**Files:**
- Modify: `apps/fluux/src/utils/webxdc/importFiles.ts:17-73`
- Modify: `apps/fluux/src/utils/webxdc/importFiles.test.ts` (add production mode tests)

**Interfaces:**
- Consumes: Tauri `invoke('webxdc_import_files')` command, `convertFileSrc()`
- Produces: Array of File objects from user-selected files

- [ ] **Step 1: Write failing test for production mode file import**

In `apps/fluux/src/utils/webxdc/importFiles.test.ts`, add:

```typescript
import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path) => `asset://localhost/${path}`)
}))

global.fetch = vi.fn()

describe('importFiles production mode', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue(['/home/user/test.txt', '/home/user/image.png'])
    vi.mocked(fetch).mockResolvedValue({
      blob: () => Promise.resolve(new Blob(['file content'], { type: 'text/plain' }))
    } as Response)
  })

  it('should call Tauri file picker and return File objects', async () => {
    const files = await importFiles({
      extensions: ['.txt', '.png'],
      mimeTypes: ['text/plain', 'image/png'],
      multiple: true
    })

    expect(invoke).toHaveBeenCalledWith('webxdc_import_files', {
      extensions: ['.txt', '.png'],
      mimeTypes: ['text/plain', 'image/png'],
      multiple: true
    })

    expect(files).toHaveLength(2)
    expect(files[0]).toBeInstanceOf(File)
    expect(files[0].name).toBe('test.txt')
    expect(files[1].name).toBe('image.png')
  })

  it('should convert file paths to File objects via fetch', async () => {
    await importFiles({ multiple: true })

    expect(convertFileSrc).toHaveBeenCalledWith('/home/user/test.txt')
    expect(convertFileSrc).toHaveBeenCalledWith('/home/user/image.png')
    
    expect(fetch).toHaveBeenCalledWith('asset://localhost//home/user/test.txt')
    expect(fetch).toHaveBeenCalledWith('asset://localhost//home/user/image.png')
  })

  it('should use empty arrays for undefined options', async () => {
    await importFiles({})

    expect(invoke).toHaveBeenCalledWith('webxdc_import_files', {
      extensions: [],
      mimeTypes: [],
      multiple: true
    })
  })

  it('should respect multiple: false option', async () => {
    await importFiles({ multiple: false })

    expect(invoke).toHaveBeenCalledWith('webxdc_import_files', {
      extensions: [],
      mimeTypes: [],
      multiple: false
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- apps/fluux/src/utils/webxdc/importFiles.test.ts`

Expected: FAIL - throws "Native file picker not implemented"

- [ ] **Step 3: Add Tauri imports**

In `apps/fluux/src/utils/webxdc/importFiles.ts`, add:

```typescript
import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'
```

- [ ] **Step 4: Implement production mode file picker**

Replace the TODO section (lines 65-72) with:

```typescript
export async function importFiles(
  options: ImportFilesOptions,
  mockFiles?: File[]
): Promise<File[]> {
  // Validate MIME types
  if (options.mimeTypes) {
    for (const mimeType of options.mimeTypes) {
      if (!mimeType.includes('/')) {
        throw new Error('invalid MIME type format')
      }
    }
  }

  // Validate extensions
  if (options.extensions) {
    for (const ext of options.extensions) {
      if (!ext.startsWith('.')) {
        throw new Error('extension must start with dot')
      }
    }
  }

  // In test mode, use mock files
  if (mockFiles !== undefined) {
    // Filter files based on options
    let filtered = mockFiles

    // Apply MIME type filter if provided and not empty
    if (options.mimeTypes && options.mimeTypes.length > 0) {
      filtered = filtered.filter(file => options.mimeTypes!.includes(file.type))
    }

    // Apply extension filter if provided and not empty
    if (options.extensions && options.extensions.length > 0) {
      filtered = filtered.filter(file => {
        const ext = '.' + file.name.split('.').pop()
        return options.extensions!.includes(ext)
      })
    }

    // Limit to single file if multiple is false
    if (options.multiple === false && filtered.length > 1) {
      filtered = [filtered[0]]
    }

    return filtered
  }

  // Production mode - call Tauri file picker
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

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- apps/fluux/src/utils/webxdc/importFiles.test.ts`

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/utils/webxdc/importFiles.ts apps/fluux/src/utils/webxdc/importFiles.test.ts
git commit -m "$(cat <<'EOF'
feat(webxdc): implement native file picker for importFiles

Integrates Tauri file dialog for importing files into WebXDC apps.

- Call Tauri webxdc_import_files command with filter options
- Convert returned file paths to File objects using fetch
- Handle extensions, MIME types, and multiple selection
- Preserve existing test mode behavior
- Add comprehensive production mode tests

Frontend complete - requires Tauri backend command implementation.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Realtime Channels - Room Management

**Files:**
- Modify: `apps/fluux/src/utils/webxdc/realtimeBridge.ts:38-138` (event listeners)
- Create: `apps/fluux/src/utils/webxdc/realtimeBridge.test.ts`

**Interfaces:**
- Consumes: `MUC.createRoom()`, `MUC.leaveRoom()`, `Chat.sendMessage()`, admin store, chat store
- Produces: MUC room creation/joining, message sending, leaving

- [ ] **Step 1: Write failing test for room creation**

Create `apps/fluux/src/utils/webxdc/realtimeBridge.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { listen } from '@tauri-apps/api/event'
import type { XMPPClient } from '@fluux/sdk/core'
import { initializeRealtimeBridge } from './realtimeBridge'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

vi.mock('@fluux/sdk/react', () => ({
  useAdminStore: {
    getState: () => ({ mucServiceJid: 'conference.example.com' })
  },
  useConnectionStore: {
    getState: () => ({ jid: 'me@example.com' })
  }
}))

vi.mock('@fluux/sdk', () => ({
  chatStore: {
    getState: () => ({
      conversations: new Map(),
      rooms: new Map()
    })
  }
}))

describe('realtimeBridge', () => {
  let mockClient: Partial<XMPPClient>
  let eventHandlers: Map<string, Function>

  beforeEach(() => {
    eventHandlers = new Map()
    mockClient = {
      muc: {
        createRoom: vi.fn().mockResolvedValue(undefined),
        leaveRoom: vi.fn().mockResolvedValue(undefined)
      } as any,
      chat: {
        sendMessage: vi.fn().mockResolvedValue('msg-id')
      } as any
    }

    vi.mocked(listen).mockImplementation((event, handler) => {
      eventHandlers.set(event, handler)
      return Promise.resolve(() => {})
    })
  })

  describe('room creation', () => {
    it('should create MUC room with correct configuration', async () => {
      initializeRealtimeBridge(mockClient as XMPPClient)

      const handler = eventHandlers.get('fluux://webxdc-realtime-join')
      
      await handler!({
        payload: {
          instance_id: 'conv123:chess',
          conversation_id: 'user@example.com',
          room_jid: 'chess-room@{muc_service}',
          nickname: 'Player1'
        }
      })

      expect(mockClient.muc!.createRoom).toHaveBeenCalledWith(
        'chess-room@conference.example.com',
        'Player1',
        {
          name: 'WebXDC Realtime: conv123:chess',
          isPublic: false,
          membersOnly: true
        },
        {
          invitees: ['user@example.com']
        }
      )
    })
  })

  describe('room messaging', () => {
    it('should send groupchat message to room', async () => {
      initializeRealtimeBridge(mockClient as XMPPClient)

      const handler = eventHandlers.get('fluux://webxdc-realtime-send')
      
      await handler!({
        payload: {
          room_jid: 'room@{muc_service}',
          data: 'base64data'
        }
      })

      expect(mockClient.chat!.sendMessage).toHaveBeenCalledWith(
        'room@conference.example.com',
        'base64data',
        'groupchat'
      )
    })
  })

  describe('room leaving', () => {
    it('should leave MUC room', async () => {
      initializeRealtimeBridge(mockClient as XMPPClient)

      const handler = eventHandlers.get('fluux://webxdc-realtime-leave')
      
      await handler!({
        payload: {
          room_jid: 'room@{muc_service}'
        }
      })

      expect(mockClient.muc!.leaveRoom).toHaveBeenCalledWith('room@conference.example.com')
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- apps/fluux/src/utils/webxdc/realtimeBridge.test.ts`

Expected: FAIL - createRoom not called

- [ ] **Step 3: Add imports**

In `apps/fluux/src/utils/webxdc/realtimeBridge.ts`:

```typescript
import { useAdminStore, useConnectionStore } from '@fluux/sdk/react'
import { chatStore, getBareJid } from '@fluux/sdk'
```

- [ ] **Step 4: Implement getMucService()**

Replace placeholder (lines 159-162):

```typescript
function getMucService(): string {
  const mucServiceJid = useAdminStore.getState().mucServiceJid
  return mucServiceJid || 'conference.localhost'
}
```

- [ ] **Step 5: Implement getConversationParticipants()**

Replace placeholder (lines 164-167):

```typescript
async function getConversationParticipants(conversationId: string): Promise<string[]> {
  const myJid = useConnectionStore.getState().jid
  
  if (!myJid) return []
  
  // Check if it's a MUC room
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

- [ ] **Step 6: Implement join event handler**

Replace TODO (lines 64-72):

```typescript
listen<JoinRealtimeEvent>('fluux://webxdc-realtime-join', async (event) => {
  const { instance_id, conversation_id, room_jid, nickname } = event.payload
  console.log('[webxdc-realtime] Join event:', room_jid)

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
}).catch((err) => {
  console.error('[webxdc-realtime] Failed to set up join listener:', err)
})
```

- [ ] **Step 7: Implement send event handler**

Replace TODO (lines 98-100):

```typescript
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
}).catch((err) => {
  console.error('[webxdc-realtime] Failed to set up send listener:', err)
})
```

- [ ] **Step 8: Implement leave event handler**

Replace TODO (lines 121-123):

```typescript
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
}).catch((err) => {
  console.error('[webxdc-realtime] Failed to set up leave listener:', err)
})
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test -- apps/fluux/src/utils/webxdc/realtimeBridge.test.ts`

Expected: ALL PASS

- [ ] **Step 10: Commit**

```bash
git add apps/fluux/src/utils/webxdc/realtimeBridge.ts apps/fluux/src/utils/webxdc/realtimeBridge.test.ts
git commit -m "$(cat <<'EOF'
feat(webxdc): implement MUC room management for realtime channels

Creates, joins, sends to, and leaves MUC rooms for WebXDC collaboration.

- Implement join handler: create private MUC room with invitees
- Implement send handler: send groupchat messages to room
- Implement leave handler: leave room and cleanup mapping
- Get MUC service from admin store with fallback
- Get conversation participants from chat/room store
- Add comprehensive unit tests

Realtime channels can now manage XMPP MUC rooms.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Realtime Channels - Message Reception

**Files:**
- Modify: `apps/fluux/src/utils/webxdc/realtimeBridge.ts:140-156` (incoming messages)
- Modify: `apps/fluux/src/utils/webxdc/realtimeBridge.test.ts` (add reception tests)

**Interfaces:**
- Consumes: `'room:message'` SDK event, `handleRealtimeMessage()` existing function
- Produces: Realtime messages forwarded to Tauri backend

- [ ] **Step 1: Write failing test for incoming room messages**

In `apps/fluux/src/utils/webxdc/realtimeBridge.test.ts`, add:

```typescript
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

describe('realtime message reception', () => {
  let mockClient: Partial<XMPPClient>
  let eventHandlers: Map<string, Function>

  beforeEach(() => {
    eventHandlers = new Map()
    mockClient = {
      muc: {
        createRoom: vi.fn(),
        leaveRoom: vi.fn()
      } as any,
      chat: {
        sendMessage: vi.fn()
      } as any,
      on: vi.fn((event, handler) => {
        eventHandlers.set(event, handler)
      })
    }

    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('should listen for room:message events and forward to Tauri', async () => {
    initializeRealtimeBridge(mockClient as XMPPClient)

    // First join a room to establish mapping
    const joinHandler = eventHandlers.get('fluux://webxdc-realtime-join')
    await joinHandler!({
      payload: {
        instance_id: 'test-instance',
        conversation_id: 'user@example.com',
        room_jid: 'room@{muc_service}',
        nickname: 'Me'
      }
    })

    // Verify room:message listener registered
    expect(mockClient.on).toHaveBeenCalledWith('room:message', expect.any(Function))

    // Simulate incoming room message
    const roomMessageHandler = eventHandlers.get('room:message')
    await roomMessageHandler!({
      roomJid: 'room@conference.example.com',
      message: {
        id: 'msg-123',
        body: 'realtime-data-base64',
        from: 'room@conference.example.com/OtherUser'
      }
    })

    // Should forward to Tauri
    expect(invoke).toHaveBeenCalledWith('webxdc_realtime_receive', {
      instanceId: 'test-instance',
      data: 'realtime-data-base64'
    })
  })

  it('should ignore messages from non-realtime rooms', async () => {
    initializeRealtimeBridge(mockClient as XMPPClient)

    const roomMessageHandler = eventHandlers.get('room:message')
    await roomMessageHandler!({
      roomJid: 'unknown-room@conference.example.com',
      message: {
        id: 'msg-123',
        body: 'message'
      }
    })

    // Should not forward
    expect(invoke).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- apps/fluux/src/utils/webxdc/realtimeBridge.test.ts`

Expected: FAIL - room:message listener not registered

- [ ] **Step 3: Add room:message event listener to initialization**

In `initializeRealtimeBridge()`, after the event listeners setup (around line 136):

```typescript
// Listen for incoming room messages
xmppClient.on('room:message', async (event) => {
  const { roomJid, message } = event
  const instanceId = roomToInstance.get(roomJid)
  
  if (!instanceId) return // Not a realtime room
  
  // Forward to Tauri backend
  await handleRealtimeMessage(roomJid, message.body || '')
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- apps/fluux/src/utils/webxdc/realtimeBridge.test.ts`

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/webxdc/realtimeBridge.ts apps/fluux/src/utils/webxdc/realtimeBridge.test.ts
git commit -m "$(cat <<'EOF'
feat(webxdc): implement realtime message reception from MUC

Listens to room:message events and forwards to WebXDC apps.

- Register room:message SDK event listener
- Filter messages by room-to-instance mapping
- Forward message body to Tauri backend via invoke
- Add comprehensive unit tests

Realtime channels now receive messages from other participants.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: RealtimeChannelManager Integration

**Files:**
- Modify: `apps/fluux/src/utils/webxdc/RealtimeChannelManager.ts:60,75,91`
- Modify: `apps/fluux/src/utils/webxdc/RealtimeChannelManager.test.ts` (verify Tauri calls)

**Interfaces:**
- Consumes: Tauri `invoke()` API
- Produces: Tauri IPC calls for realtime join/send/leave events

- [ ] **Step 1: Write failing test for RealtimeChannelManager Tauri integration**

In `apps/fluux/src/utils/webxdc/RealtimeChannelManager.test.ts`, add:

```typescript
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

describe('RealtimeChannelManager Tauri integration', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('should call Tauri on join', async () => {
    const manager = new RealtimeChannelManager(
      'test-instance',
      'user@example.com',
      'MyNick'
    )

    await manager.join()

    expect(invoke).toHaveBeenCalledWith('webxdc_realtime_join', {
      instanceId: 'test-instance',
      conversationId: 'user@example.com',
      roomJid: expect.stringContaining('{muc_service}'),
      nickname: 'MyNick'
    })
  })

  it('should call Tauri on send', async () => {
    const manager = new RealtimeChannelManager(
      'test-instance',
      'user@example.com',
      'MyNick'
    )

    await manager.send(new Uint8Array([1, 2, 3]))

    expect(invoke).toHaveBeenCalledWith('webxdc_realtime_send', {
      roomJid: expect.any(String),
      data: expect.any(String) // base64
    })
  })

  it('should call Tauri on leave', async () => {
    const manager = new RealtimeChannelManager(
      'test-instance',
      'user@example.com',
      'MyNick'
    )

    await manager.leave()

    expect(invoke).toHaveBeenCalledWith('webxdc_realtime_leave', {
      roomJid: expect.any(String)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- apps/fluux/src/utils/webxdc/RealtimeChannelManager.test.ts`

Expected: FAIL - invoke not called

- [ ] **Step 3: Add Tauri import**

In `apps/fluux/src/utils/webxdc/RealtimeChannelManager.ts`:

```typescript
import { invoke } from '@tauri-apps/api/core'
```

- [ ] **Step 4: Replace TODO at line 60 (send)**

```typescript
async send(data: Uint8Array): Promise<void> {
  // Convert to base64
  const base64 = btoa(String.fromCharCode(...data))
  
  // Emit to Tauri backend
  await invoke('webxdc_realtime_send', {
    roomJid: this.roomJid,
    data: base64
  })
}
```

- [ ] **Step 5: Replace TODO at line 75 (join)**

```typescript
async join(): Promise<void> {
  // Emit join event to Tauri backend
  await invoke('webxdc_realtime_join', {
    instanceId: this.instanceId,
    conversationId: this.conversationId,
    roomJid: this.roomJid,
    nickname: this.nickname
  })
}
```

- [ ] **Step 6: Replace TODO at line 91 (leave)**

```typescript
async leave(): Promise<void> {
  // Emit leave event to Tauri backend
  await invoke('webxdc_realtime_leave', {
    roomJid: this.roomJid
  })
  
  // Clear listeners
  this.listeners.clear()
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- apps/fluux/src/utils/webxdc/RealtimeChannelManager.test.ts`

Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/utils/webxdc/RealtimeChannelManager.ts apps/fluux/src/utils/webxdc/RealtimeChannelManager.test.ts
git commit -m "$(cat <<'EOF'
feat(webxdc): integrate RealtimeChannelManager with Tauri

Connects in-memory channel management to backend IPC.

- Call Tauri webxdc_realtime_join on channel join
- Call Tauri webxdc_realtime_send on data send
- Call Tauri webxdc_realtime_leave on channel leave
- Convert Uint8Array to base64 for IPC transfer
- Add comprehensive unit tests

RealtimeChannelManager now persists state to backend.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Integration - Wire xmppBridge to App Initialization

**Files:**
- Modify: `apps/fluux/src/main.tsx` or equivalent app initialization file
- Create integration test or update existing initialization tests

**Interfaces:**
- Consumes: `initializeXmppBridge()`, `initializeRealtimeBridge()`, `useFileUpload()`, XMPP client
- Produces: Fully initialized WebXDC bridge with all handlers active

- [ ] **Step 1: Find app initialization point**

Run: `grep -rn "new XMPPClient\|client.connect" apps/fluux/src --include="*.tsx" --include="*.ts" | head -5`

Identify where XMPP client is initialized.

- [ ] **Step 2: Add WebXDC bridge initialization**

In the identified initialization file (likely `apps/fluux/src/main.tsx` or a context provider), add:

```typescript
import { initializeXmppBridge } from '@/utils/webxdc/xmppBridge'
import { initializeRealtimeBridge } from '@/utils/webxdc/realtimeBridge'
import { useFileUpload } from '@/hooks/useFileUpload'

// After XMPP client is created and connected:
const xmppClient = // ... existing client initialization

// Get uploadFile function from hook
const { uploadFile } = useFileUpload()

// Initialize WebXDC bridges
initializeXmppBridge(xmppClient, uploadFile)
initializeRealtimeBridge(xmppClient)

console.log('[app] WebXDC bridges initialized')
```

- [ ] **Step 3: Verify initialization doesn't break existing app**

Run: `npm run dev`

Check console for "[app] WebXDC bridges initialized" message

Verify no errors on startup

- [ ] **Step 4: Test WebXDC update flow manually**

1. Open a WebXDC app in dev mode
2. Call `window.webxdc.sendUpdate({ test: 'data' }, 'Test update')`
3. Check console for "[webxdc] Update transmitted via XMPP"
4. Check network tab for XMPP message stanza

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/main.tsx
git commit -m "$(cat <<'EOF'
feat(webxdc): wire bridges to app initialization

Initializes WebXDC XMPP and realtime bridges on app startup.

- Call initializeXmppBridge() with client and uploadFile
- Call initializeRealtimeBridge() with client
- Add initialization logging
- Verify no errors on startup

All 17 WebXDC TODOs now implemented and integrated.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Success Criteria Verification

After all tasks complete, verify:

- [ ] All 17 TODOs removed or replaced with working code
- [ ] All unit tests pass: `npm test`
- [ ] No TypeScript errors: `npm run type-check`
- [ ] SDK tests pass: `npm test -- packages/fluux-sdk`
- [ ] WebXDC bridge tests pass: `npm test -- apps/fluux/src/utils/webxdc`
- [ ] App builds successfully: `npm run build`
- [ ] No console errors on app startup
- [ ] Manual test: Send WebXDC update, verify XMPP transmission
- [ ] Manual test: Trigger sendToChat, verify message appears in chat
- [ ] Manual test: Call importFiles, verify file picker opens
- [ ] Manual test: Join realtime channel, verify MUC room created

---

## Notes for Implementer

**Tauri Backend Commands Required:**

The following Rust commands must be implemented in `apps/fluux/src-tauri/`:

1. `webxdc_import_files` - Show native file picker, return Vec<String> of paths
2. `webxdc_send_to_chat` - Receive file/text data, emit to XMPP bridge
3. `webxdc_realtime_join/send/leave` - Emit IPC events to realtimeBridge

These are NOT part of this plan - they are backend work.

**Testing Philosophy:**

- TDD throughout - write failing test first, then implement
- Run tests after each step to catch regressions early
- Commit after each task - small, focused commits
- Each task should take 15-30 minutes

**Common Pitfalls:**

- Don't skip the "run test to verify it fails" step - it catches bad tests
- Don't batch multiple tasks before committing - commit per task
- Don't skip existing tests - always run full test suite
- Watch for TypeScript errors - fix immediately, don't accumulate

**If You Get Stuck:**

1. Read the spec section for the current task
2. Look at existing similar code (e.g., existing tests for patterns)
3. Check that mocks are set up correctly in tests
4. Verify imports are correct

**Expected Timeline:**

- Tasks 1-2 (SDK): 1-2 hours
- Tasks 3-4 (XMPP sync): 1 hour
- Tasks 5-6 (sendToChat): 1 hour
- Task 7 (importFiles): 30 minutes
- Tasks 8-9 (Realtime): 1.5 hours
- Task 10-11 (Integration): 30 minutes

Total: ~6 hours of focused implementation
