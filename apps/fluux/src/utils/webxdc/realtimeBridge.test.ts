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
        return () => {}
      }) as any
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
