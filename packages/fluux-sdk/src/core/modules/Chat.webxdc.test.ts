import { describe, it, expect, vi, beforeEach } from 'vitest'
import { xml } from '@xmpp/client'
import { Chat } from './Chat'
import type { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { NS_WEBXDC } from '../namespaces'
import { createMockPresenceReader } from '../test-utils'

// sendStanza is read back via .mock.calls in these tests, which a plain
// ModuleDependencies annotation would erase (it only declares the callable
// signature, not that the value is also a vi.fn() Mock).
type MockDeps = ModuleDependencies & { sendStanza: ReturnType<typeof vi.fn<ModuleDependencies['sendStanza']>> }

function stubMAM(): MAM {
  // The webxdc live-path handling never touches MAM; an empty stub is enough.
  return {} as unknown as MAM
}

describe('Chat WebXDC stanza handling', () => {
  let chat: Chat
  let mockDeps: MockDeps

  beforeEach(() => {
    mockDeps = {
      sendStanza: vi.fn<ModuleDependencies['sendStanza']>(),
      emitSDK: vi.fn(),
      emit: vi.fn(),
      stores: {
        roster: { hasContact: vi.fn().mockReturnValue(true), getContact: vi.fn().mockReturnValue(undefined) },
        chat: { hasConversation: vi.fn().mockReturnValue(true) },
      } as any,
      presence: createMockPresenceReader(),
      sendIQ: vi.fn(),
      getXmpp: vi.fn(() => null),
      getE2EEManager: vi.fn().mockReturnValue(null),
      getCurrentJid: vi.fn().mockReturnValue('me@example.com'),
    }
    chat = new Chat(mockDeps, stubMAM())
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
      sender: 'user@example.com/resource',
      thread: undefined,
      isCheogramFormat: false
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
      sender: 'user@example.com',
      thread: undefined,
      isCheogramFormat: false
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

    const _handled = (chat as any).handleMessage(stanza)

    // Should be handled but not emit event
    expect(mockDeps.emitSDK).not.toHaveBeenCalled()
  })

  describe('E2EE encryption', () => {
    it('should encrypt WebXDC update element in E2EE conversations', async () => {
      const mockE2EEManager = {
        encryptOutbound: vi.fn().mockResolvedValue({
          plugin: { descriptor: { id: 'test-e2ee' } },
          payload: {
            stanzaElement: {
              name: 'encrypted',
              attrs: { xmlns: 'test:encrypted' },
              children: []
            },
            fallbackBody: '[encrypted message]',
            protocolId: 'test-e2ee'
          }
        }),
        assertPlaintextPermitted: vi.fn().mockResolvedValue(undefined)
      }
      mockDeps.getE2EEManager = vi.fn().mockReturnValue(mockE2EEManager)

      const customElement = xml('x', { xmlns: NS_WEBXDC },
        xml('instance', {}, 'test-instance'),
        xml('serial', {}, '42'),
        xml('payload', {}, '{"secret":"data"}')
      )

      await chat.sendCustomMessage(
        'user@example.com',
        '[WebXDC Update]',
        'chat',
        [customElement]
      )

      expect(mockDeps.sendStanza).toHaveBeenCalledTimes(1)
      const sentStanza = mockDeps.sendStanza.mock.calls[0][0]

      // CRITICAL SECURITY CHECK: WebXDC element should NOT be at stanza root
      // It should be INSIDE the encrypted envelope
      const plainWebxdcElement = sentStanza.getChild('x', NS_WEBXDC)
      expect(plainWebxdcElement).toBeUndefined()

      // Encrypted element should be present instead
      const encryptedElement = sentStanza.getChild('encrypted', 'test:encrypted')
      expect(encryptedElement).toBeDefined()

      // Verify the encryption was called with WebXDC element in the payload
      expect(mockE2EEManager.encryptOutbound).toHaveBeenCalledTimes(1)
      const encryptArgs = mockE2EEManager.encryptOutbound.mock.calls[0]
      const plaintext = new TextDecoder().decode(encryptArgs[1])

      // The plaintext should contain the WebXDC element serialized
      expect(plaintext).toContain('urn:xmpp:webxdc:0')
      expect(plaintext).toContain('test-instance')
      expect(plaintext).toContain('{"secret":"data"}')
    })

    it('should send WebXDC update in plaintext when E2EE is not available', async () => {
      // No E2EE manager available
      mockDeps.getE2EEManager = vi.fn().mockReturnValue(null)

      const customElement = xml('x', { xmlns: NS_WEBXDC },
        xml('instance', {}, 'test-instance'),
        xml('serial', {}, '42'),
        xml('payload', {}, '{"data":"public"}')
      )

      await chat.sendCustomMessage(
        'user@example.com',
        '[WebXDC Update]',
        'chat',
        [customElement]
      )

      const sentStanza = mockDeps.sendStanza.mock.calls[0][0]

      // WebXDC element should be present at stanza root when E2EE is unavailable
      const webxdcElement = sentStanza.getChild('x', NS_WEBXDC)
      expect(webxdcElement).toBeDefined()
      expect(webxdcElement?.getChildText('instance')).toBe('test-instance')
      expect(webxdcElement?.getChildText('payload')).toBe('{"data":"public"}')
    })
  })

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

  describe('isWebxdcUpdate message emission (live path)', () => {
    it('emits a Message with isWebxdcUpdate for a 1:1 persisted update with a body', () => {
      const stanza = xml('message', {
        from: 'alice@example.com',
        to: 'me@example.com',
        type: 'chat'
      },
        xml('body', {}, '[WebXDC Update: Alice moved]'),
        xml('x', { xmlns: NS_WEBXDC },
          xml('instance', {}, 'conv1:https://example.com/app.xdc'),
          xml('serial', {}, '1'),
          xml('payload', {}, '{}')
        )
      )

      const handled = (chat as any).handleMessage(stanza)

      expect(handled).toBe(true)
      expect(mockDeps.emitSDK).toHaveBeenCalledWith('webxdc:update', expect.objectContaining({
        instance: 'conv1:https://example.com/app.xdc',
      }))
      expect(mockDeps.emit).toHaveBeenCalledWith('message', expect.objectContaining({
        type: 'chat',
        body: '[WebXDC Update: Alice moved]',
        isWebxdcUpdate: true,
      }))
    })

    it('emits a RoomMessage with isWebxdcUpdate for a groupchat persisted update with a body', () => {
      mockDeps.stores = {
        room: {
          getRoom: vi.fn().mockReturnValue({ jid: 'room@conference.example.com', nickname: 'me' }),
        },
      } as any

      const stanza = xml('message', {
        from: 'room@conference.example.com/nikescar',
        type: 'groupchat'
      },
        xml('body', {}, "[WebXDC Update: nikescar added an item to '🛒 Shopping List']"),
        xml('x', { xmlns: NS_WEBXDC },
          xml('instance', {}, 'room1:https://example.com/list.xdc'),
          xml('serial', {}, '3'),
          xml('payload', {}, '{}')
        )
      )

      const handled = (chat as any).handleMessage(stanza)

      expect(handled).toBe(true)
      expect(mockDeps.emit).toHaveBeenCalledWith('message', expect.objectContaining({
        type: 'groupchat',
        isWebxdcUpdate: true,
      }))
    })

    it('does not emit a message for a persisted update with no body', () => {
      const stanza = xml('message', { from: 'alice@example.com', type: 'chat' },
        xml('x', { xmlns: NS_WEBXDC },
          xml('instance', {}, 'test-instance'),
          xml('serial', {}, '1'),
          xml('payload', {}, '{}')
        )
      )

      const handled = (chat as any).handleMessage(stanza)

      expect(handled).toBe(true)
      expect(mockDeps.emit).not.toHaveBeenCalled()
    })

    it('still emits no message for a realtime (data) frame', () => {
      const stanza = xml('message', { from: 'alice@example.com', type: 'chat' },
        xml('x', { xmlns: NS_WEBXDC }, xml('data', {}, 'ZGF0YQ==')),
        xml('thread', {}, 'thread-abc')
      )

      const handled = (chat as any).handleMessage(stanza)

      expect(handled).toBe(true)
      expect(mockDeps.emit).not.toHaveBeenCalled()
      expect(mockDeps.emitSDK).toHaveBeenCalledWith('webxdc:realtime', expect.anything())
    })
  })
})
