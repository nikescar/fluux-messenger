import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RealtimeChannelManager } from './RealtimeChannelManager'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

describe('RealtimeChannelManager', () => {
  let manager: RealtimeChannelManager

  beforeEach(() => {
    manager = new RealtimeChannelManager()
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  describe('room naming', () => {
    it('generates deterministic room JID from instance ID', () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const roomJid = manager.getRoomJid(instanceId)

      // Should be deterministic
      const roomJid2 = manager.getRoomJid(instanceId)
      expect(roomJid).toBe(roomJid2)
    })

    it('generates different room JIDs for different instances', () => {
      const instance1 = 'alice@example.com:https://example.com/app1.xdc'
      const instance2 = 'bob@example.com:https://example.com/app2.xdc'

      const room1 = manager.getRoomJid(instance1)
      const room2 = manager.getRoomJid(instance2)

      expect(room1).not.toBe(room2)
    })

    it('generates valid XMPP room JID format', () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const roomJid = manager.getRoomJid(instanceId)

      // Should follow format: roomname@{muc_service}
      expect(roomJid).toMatch(/^webxdc-[a-f0-9]+@\{muc_service\}$/)
    })

    it('uses MUC service placeholder in room JID', () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const roomJid = manager.getRoomJid(instanceId)

      expect(roomJid).toContain('{muc_service}')
    })
  })

  describe('channel lifecycle', () => {
    it('creates new channel on first join', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'

      const channel = await manager.join(instanceId, 'Alice')

      expect(channel).toBeDefined()
      expect(channel.instanceId).toBe(instanceId)
      expect(channel.nickname).toBe('Alice')
    })

    it('returns same channel for multiple joins', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'

      const channel1 = await manager.join(instanceId, 'Alice')
      const channel2 = await manager.join(instanceId, 'Alice')

      expect(channel1).toBe(channel2)
    })

    it('tracks active channels', async () => {
      const instance1 = 'alice@example.com:app1.xdc'
      const instance2 = 'bob@example.com:app2.xdc'

      await manager.join(instance1, 'Alice')
      await manager.join(instance2, 'Bob')

      expect(manager.getActiveChannels()).toHaveLength(2)
    })

    it('removes channel on leave', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'

      await manager.join(instanceId, 'Alice')
      await manager.leave(instanceId)

      expect(manager.getActiveChannels()).toHaveLength(0)
    })

    it('handles leave for non-existent channel', async () => {
      await expect(
        manager.leave('nonexistent')
      ).resolves.not.toThrow()
    })
  })

  describe('message sending', () => {
    it('sends binary data to channel', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const channel = await manager.join(instanceId, 'Alice')

      const data = new Uint8Array([1, 2, 3, 4, 5])

      await expect(
        channel.send(data)
      ).resolves.not.toThrow()
    })

    it('rejects data over 128KB limit', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const channel = await manager.join(instanceId, 'Alice')

      const largeData = new Uint8Array(128001) // 128KB + 1 byte

      await expect(
        channel.send(largeData)
      ).rejects.toThrow('data exceeds 128KB limit')
    })

    it('accepts data at exactly 128KB', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const channel = await manager.join(instanceId, 'Alice')

      const exactSize = new Uint8Array(128000)

      await expect(
        channel.send(exactSize)
      ).resolves.not.toThrow()
    })

    it('encodes Uint8Array to base64', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const channel = await manager.join(instanceId, 'Alice')

      const data = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
      await channel.send(data)

      // Should encode to base64 internally
      expect(channel.getLastSentBase64()).toBe('SGVsbG8=')
    })
  })

  describe('message receiving', () => {
    it('delivers messages to listener', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const channel = await manager.join(instanceId, 'Alice')

      const received: Uint8Array[] = []
      channel.setListener((data) => {
        received.push(data)
      })

      // Simulate receiving base64 message
      const testData = new Uint8Array([1, 2, 3])
      await manager.receiveMessage(instanceId, 'AQID') // base64 for [1,2,3]

      expect(received).toHaveLength(1)
      expect(received[0]).toEqual(testData)
    })

    it('handles multiple listeners correctly', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const channel = await manager.join(instanceId, 'Alice')

      let count1 = 0
      let count2 = 0

      channel.setListener(() => count1++)
      channel.setListener(() => count2++)

      await manager.receiveMessage(instanceId, 'AQID')

      // Second listener should replace first
      expect(count1).toBe(0)
      expect(count2).toBe(1)
    })

    it('ignores messages for channels without listener', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      await manager.join(instanceId, 'Alice')

      // Should not throw
      await expect(
        manager.receiveMessage(instanceId, 'AQID')
      ).resolves.not.toThrow()
    })

    it('decodes base64 to Uint8Array', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const channel = await manager.join(instanceId, 'Alice')

      let received: Uint8Array | null = null
      channel.setListener((data) => {
        received = data
      })

      // "Hello" in base64
      await manager.receiveMessage(instanceId, 'SGVsbG8=')

      expect(received).toBeInstanceOf(Uint8Array)
      expect(received).toEqual(new Uint8Array([72, 101, 108, 108, 111]))
    })
  })

  describe('edge cases', () => {
    it('handles empty data send', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const channel = await manager.join(instanceId, 'Alice')

      const emptyData = new Uint8Array(0)

      await expect(
        channel.send(emptyData)
      ).resolves.not.toThrow()
    })

    it('handles receiving empty base64', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const channel = await manager.join(instanceId, 'Alice')

      let received: Uint8Array | null = null
      channel.setListener((data) => {
        received = data
      })

      await manager.receiveMessage(instanceId, '')

      expect(received).toEqual(new Uint8Array(0))
    })

    it('cleans up listener on leave', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const channel = await manager.join(instanceId, 'Alice')

      let callCount = 0
      channel.setListener(() => callCount++)

      await manager.leave(instanceId)

      // Try to send message to left channel
      await manager.receiveMessage(instanceId, 'AQID')

      expect(callCount).toBe(0)
    })
  })

  describe('Tauri integration', () => {
    it('calls Tauri on join', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'

      await manager.join(instanceId, 'Alice')

      expect(invoke).toHaveBeenCalledWith('webxdc_realtime_join', {
        instanceId,
        conversationId: 'alice@example.com',
        roomJid: expect.stringContaining('{muc_service}'),
        nickname: 'Alice'
      })
    })

    it('calls Tauri on send', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'
      const channel = await manager.join(instanceId, 'Alice')

      await channel.send(new Uint8Array([1, 2, 3]))

      expect(invoke).toHaveBeenCalledWith('webxdc_realtime_send', {
        roomJid: expect.any(String),
        data: expect.any(String) // base64
      })

      // Verify base64 encoding
      const call = vi.mocked(invoke).mock.calls[1] // Second call (first was join)
      expect((call[1] as any).data).toBe('AQID')
    })

    it('calls Tauri on leave', async () => {
      const instanceId = 'alice@example.com:https://example.com/app.xdc'

      await manager.join(instanceId, 'Alice')
      await manager.leave(instanceId)

      expect(invoke).toHaveBeenCalledWith('webxdc_realtime_leave', {
        roomJid: expect.any(String)
      })
    })
  })
})
