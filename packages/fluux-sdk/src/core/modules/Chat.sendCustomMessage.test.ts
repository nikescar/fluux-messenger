import { describe, it, expect, vi, beforeEach } from 'vitest'
import { xml } from '@xmpp/client'
import { Chat } from './Chat'
import type { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { createMockPresenceReader } from '../test-utils'

// sendStanza is read back via .mock.calls in these tests, which a plain
// ModuleDependencies annotation would erase (it only declares the callable
// signature, not that the value is also a vi.fn() Mock).
type MockDeps = ModuleDependencies & { sendStanza: ReturnType<typeof vi.fn<ModuleDependencies['sendStanza']>> }

function stubMAM(): MAM {
  // Chat.sendCustomMessage never touches MAM; an empty stub is enough.
  return {} as unknown as MAM
}

describe('Chat.sendCustomMessage', () => {
  let chat: Chat
  let mockDeps: MockDeps

  beforeEach(() => {
    mockDeps = {
      sendStanza: vi.fn<ModuleDependencies['sendStanza']>().mockResolvedValue(undefined),
      emitSDK: vi.fn(),
      emit: vi.fn(),
      stores: {} as any,
      presence: createMockPresenceReader(),
      sendIQ: vi.fn(),
      getXmpp: vi.fn(() => null),
      getE2EEManager: vi.fn().mockReturnValue(null),
      getCurrentJid: vi.fn().mockReturnValue('me@example.com'),
    }
    chat = new Chat(mockDeps, stubMAM())
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
