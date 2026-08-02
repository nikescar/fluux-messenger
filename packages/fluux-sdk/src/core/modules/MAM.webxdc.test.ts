import { describe, it, expect, vi, beforeEach } from 'vitest'
import { xml } from '@xmpp/client'
import { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { NS_WEBXDC } from '../namespaces'
import { createMockPresenceReader } from '../test-utils'

describe('MAM webxdc update detection', () => {
  let mam: MAM
  let mockDeps: ModuleDependencies

  beforeEach(() => {
    mockDeps = {
      sendStanza: vi.fn(),
      emitSDK: vi.fn(),
      emit: vi.fn(),
      stores: {} as any,
      presence: createMockPresenceReader(),
      sendIQ: vi.fn(),
      getXmpp: vi.fn(() => null),
      getE2EEManager: vi.fn().mockReturnValue(null),
      getCurrentJid: vi.fn().mockReturnValue('me@example.com'),
    }
    mam = new MAM(mockDeps)
  })

  function forwardedWith(messageEl: ReturnType<typeof xml>) {
    return xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, messageEl)
  }

  it('flags a 1:1 archived webxdc update message', () => {
    const messageEl = xml('message', { from: 'alice@example.com', type: 'chat' },
      xml('body', {}, '[WebXDC Update: Alice moved]'),
      xml('x', { xmlns: NS_WEBXDC },
        xml('instance', {}, 'conv1:https://example.com/app.xdc'),
        xml('serial', {}, '1'),
        xml('payload', {}, '{}')
      )
    )

    const message = (mam as any).parseArchiveMessage(forwardedWith(messageEl), 'alice@example.com')

    expect(message).not.toBeNull()
    expect(message.isWebxdcUpdate).toBe(true)
    expect(message.body).toBe('[WebXDC Update: Alice moved]')
  })

  it('does not flag an ordinary 1:1 archived message', () => {
    const messageEl = xml('message', { from: 'alice@example.com', type: 'chat' },
      xml('body', {}, 'Hello there')
    )

    const message = (mam as any).parseArchiveMessage(forwardedWith(messageEl), 'alice@example.com')

    expect(message).not.toBeNull()
    expect(message.isWebxdcUpdate).toBeUndefined()
  })

  it('flags a room archived webxdc update message', () => {
    const messageEl = xml('message', { from: 'room@conference.example.com/nikescar', type: 'groupchat' },
      xml('body', {}, "[WebXDC Update: nikescar added an item to '🛒 Shopping List']"),
      xml('x', { xmlns: NS_WEBXDC },
        xml('instance', {}, 'room1:https://example.com/list.xdc'),
        xml('serial', {}, '3'),
        xml('payload', {}, '{}')
      )
    )

    const message = (mam as any).parseRoomArchiveMessage(forwardedWith(messageEl), 'room@conference.example.com', 'nikescar')

    expect(message).not.toBeNull()
    expect(message.isWebxdcUpdate).toBe(true)
  })

  it('does not flag an ordinary room archived message', () => {
    const messageEl = xml('message', { from: 'room@conference.example.com/nikescar', type: 'groupchat' },
      xml('body', {}, 'Hello room')
    )

    const message = (mam as any).parseRoomArchiveMessage(forwardedWith(messageEl), 'room@conference.example.com', 'nikescar')

    expect(message).not.toBeNull()
    expect(message.isWebxdcUpdate).toBeUndefined()
  })
})
