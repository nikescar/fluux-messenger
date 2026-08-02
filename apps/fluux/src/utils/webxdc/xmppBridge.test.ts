import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { XMPPClient } from '@fluux/sdk/core'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

vi.mock('@fluux/sdk', () => ({
  xml: (name: string, attrs: any, ...children: any[]) => ({
    name,
    attrs: attrs || {},
    children,
    getChildText: (name: string) => {
      const child = children.find((c: any) => c?.name === name)
      return child?.children?.[0]
    }
  }),
  chatStore: {
    getState: () => ({
      conversations: new Map()
    })
  },
  connectionStore: {
    getState: () => ({ jid: 'me@example.com' })
  }
}))

describe('xmppBridge', () => {
  let mockClient: Partial<XMPPClient>
  let mockSendCustomMessage: ReturnType<typeof vi.fn>
  let mockUploadFile: (file: File, options?: { encrypt?: boolean }) => Promise<any>

  beforeEach(() => {
    mockSendCustomMessage = vi.fn().mockResolvedValue('msg-123')
    mockUploadFile = vi.fn().mockResolvedValue({
      url: 'https://upload.example.com/file.txt',
      mediaType: 'text/plain',
      size: 100
    }) as any

    mockClient = {
      chat: {
        sendCustomMessage: mockSendCustomMessage,
        sendMessage: vi.fn().mockResolvedValue('msg-456')
      } as any,
      on: vi.fn(),
      onSDK: vi.fn()
    }

    // Mock Tauri invoke to return a serial number
    vi.mocked(invoke).mockResolvedValue({ serial: 1 })

    // Re-import to reset module state
    vi.resetModules()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('incoming updates', () => {
    it('should listen for webxdc:update events and store incoming updates', async () => {
      const { initializeXmppBridge } = await import('./xmppBridge')

      let webxdcUpdateHandler: ((event: any) => void | Promise<void>) | undefined
      const mockOn = vi.fn((event, handler) => {
        if (event === 'webxdc:update') {
          webxdcUpdateHandler = handler
        }
      })

      const clientWithEvents = {
        ...mockClient,
        onSDK: mockOn
      }

      initializeXmppBridge(clientWithEvents as any, mockUploadFile)

      // Verify listener was registered
      expect(mockOn).toHaveBeenCalledWith('webxdc:update', expect.any(Function))

      // Simulate incoming WebXDC update event
      const updateEvent = {
        from: 'alice@example.com',
        instance: 'alice@example.com:https://example.com/chess.xdc',
        serial: 5,
        payload: { action: 'move', position: 'e4' },
        info: 'Alice moved to e4',
        document: undefined,
        summary: 'Game in progress',
        sender: 'alice@example.com/resource'
      }

      await webxdcUpdateHandler!(updateEvent)

      // Should call Tauri to receive update
      expect(invoke).toHaveBeenCalledWith('webxdc_receive_update', {
        instanceId: 'alice@example.com:https://example.com/chess.xdc',
        payload: { action: 'move', position: 'e4' },
        info: 'Alice moved to e4',
        document: undefined,
        summary: 'Game in progress',
        senderId: 'alice@example.com/resource',
        timestamp: expect.any(Number)
      })
    })

    it('should handle updates without optional fields', async () => {
      const { initializeXmppBridge } = await import('./xmppBridge')

      let webxdcUpdateHandler: ((event: any) => void | Promise<void>) | undefined
      const mockOn = vi.fn((event, handler) => {
        if (event === 'webxdc:update') {
          webxdcUpdateHandler = handler
        }
      })

      const clientWithEvents = {
        ...mockClient,
        onSDK: mockOn
      }

      initializeXmppBridge(clientWithEvents as any, mockUploadFile)

      const updateEvent = {
        from: 'bob@example.com',
        instance: 'bob@example.com:app.xdc',
        serial: 1,
        payload: {},
        sender: 'bob@example.com'
      }

      await webxdcUpdateHandler!(updateEvent)

      expect(invoke).toHaveBeenCalledWith('webxdc_receive_update', {
        instanceId: 'bob@example.com:app.xdc',
        payload: {},
        info: undefined,
        document: undefined,
        summary: undefined,
        senderId: 'bob@example.com',
        timestamp: expect.any(Number)
      })
    })

    it('should forward thread to webxdc_receive_update when the incoming update carries one', async () => {
      const { initializeXmppBridge } = await import('./xmppBridge')

      let webxdcUpdateHandler: ((event: any) => void | Promise<void>) | undefined
      const mockOn = vi.fn((event, handler) => {
        if (event === 'webxdc:update') webxdcUpdateHandler = handler
      })
      const clientWithEvents = { ...mockClient, onSDK: mockOn }

      initializeXmppBridge(clientWithEvents as any, mockUploadFile)

      await webxdcUpdateHandler!({
        from: 'alice@example.com',
        instance: 'alice@example.com:app.xdc',
        serial: 2,
        payload: {},
        sender: 'alice@example.com',
        thread: 'thread-xyz'
      })

      expect(invoke).toHaveBeenCalledWith('webxdc_receive_update', expect.objectContaining({
        instanceId: 'alice@example.com:app.xdc',
        threadId: 'thread-xyz'
      }))
    })

    it('increments the webxdc panel store unread count for the resolved conversation and instance', async () => {
      const { initializeXmppBridge } = await import('./xmppBridge')
      const { useWebxdcPanelStore } = await import('@/stores/webxdcPanelStore')
      const { connectionStore } = await import('@fluux/sdk/stores')

      connectionStore.setState({ jid: 'currentuser@example.com' })
      useWebxdcPanelStore.setState({ manifestCache: new Map(), installations: new Map() })
      useWebxdcPanelStore.getState().installApp('alice@example.com', 'alice@example.com:https://example.com/app.xdc', {
        url: 'https://example.com/app.xdc',
        name: 'app.xdc',
        mediaType: 'application/webxdc+zip',
        size: 1024,
      } as any)

      let webxdcUpdateHandler: ((event: any) => void | Promise<void>) | undefined
      const mockOn = vi.fn((event, handler) => {
        if (event === 'webxdc:update') webxdcUpdateHandler = handler
      })
      const clientWithEvents = { ...mockClient, onSDK: mockOn }

      initializeXmppBridge(clientWithEvents as any, mockUploadFile)

      await webxdcUpdateHandler!({
        from: 'alice@example.com',
        instance: 'https://example.com/app.xdc',
        serial: 1,
        payload: {},
        sender: 'alice@example.com',
        thread: undefined,
        isCheogramFormat: false,
      })

      expect(useWebxdcPanelStore.getState().getInstanceUnread('alice@example.com:https://example.com/app.xdc')).toBe(1)
    })

    it('increments unread count when instance ID includes conversationId prefix', async () => {
      const { initializeXmppBridge } = await import('./xmppBridge')
      const { useWebxdcPanelStore } = await import('@/stores/webxdcPanelStore')
      const { connectionStore } = await import('@fluux/sdk/stores')

      connectionStore.setState({ jid: 'currentuser@example.com' })
      useWebxdcPanelStore.setState({ manifestCache: new Map(), installations: new Map() })
      useWebxdcPanelStore.getState().installApp('bob@example.com', 'bob@example.com:https://example.com/chess.xdc', {
        url: 'https://example.com/chess.xdc',
        name: 'chess.xdc',
        mediaType: 'application/webxdc+zip',
        size: 2048,
      } as any)

      let webxdcUpdateHandler: ((event: any) => void | Promise<void>) | undefined
      const mockOn = vi.fn((event, handler) => {
        if (event === 'webxdc:update') webxdcUpdateHandler = handler
      })
      const clientWithEvents = { ...mockClient, onSDK: mockOn }

      initializeXmppBridge(clientWithEvents as any, mockUploadFile)

      // Update with full instance ID format (conversationId:url)
      await webxdcUpdateHandler!({
        from: 'bob@example.com',
        instance: 'bob@example.com:https://example.com/chess.xdc',
        serial: 5,
        payload: { move: 'e4' },
        sender: 'bob@example.com/phone',
        thread: undefined,
        isCheogramFormat: false,
      })

      expect(useWebxdcPanelStore.getState().getInstanceUnread('bob@example.com:https://example.com/chess.xdc')).toBe(1)
    })
  })

  describe('sendWebxdcUpdate', () => {
    it('should send WebXDC update via XMPP with correct structure', async () => {
      // Import fresh for each test
      const { initializeXmppBridge, sendWebxdcUpdate } = await import('./xmppBridge')
      initializeXmppBridge(mockClient as any, mockUploadFile)

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

      // The wire format uses the canonical URL only (no conversationId: prefix)
      // so both peers see the same instance identifier.
      expect(instance).toBe('https://example.com/chess.xdc')
      expect(serial).toBe('1') // First update gets serial 1 from Tauri
      expect(JSON.parse(payloadStr)).toEqual(payload)
      expect(infoText).toBe(info)
    })

    it('should include document and summary if provided', async () => {
      const { initializeXmppBridge, sendWebxdcUpdate } = await import('./xmppBridge')
      initializeXmppBridge(mockClient as any, mockUploadFile)

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
      // Cheogram-compat summary format appends "(serial/serial)".
      expect(webxdcElement.getChildText('summary')).toBe('Summary text (1/1)')
    })

    it('should use default body when info is not provided', async () => {
      const { initializeXmppBridge, sendWebxdcUpdate } = await import('./xmppBridge')
      initializeXmppBridge(mockClient as any, mockUploadFile)

      await sendWebxdcUpdate('test:app', {}, undefined, undefined, undefined, 'me@example.com')

      const body = mockSendCustomMessage.mock.calls[0][1]
      expect(body).toBe('[WebXDC Update: update]')
    })

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
  })
})
