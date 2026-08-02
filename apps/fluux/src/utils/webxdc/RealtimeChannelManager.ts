/**
 * Manages WebXDC realtime channels.
 */

import { invoke } from '@tauri-apps/api/core'

const MAX_MESSAGE_SIZE = 128000 // 128KB

interface RealtimeChannel {
  instanceId: string
  nickname: string
  roomJid: string
  listener: ((data: Uint8Array) => void) | null
  lastSentBase64: string | null

  send(data: Uint8Array): Promise<void>
  setListener(callback: (data: Uint8Array) => void): void
  getLastSentBase64(): string | null
}

export class RealtimeChannelManager {
  private channels: Map<string, RealtimeChannel> = new Map()

  /**
   * Generate deterministic room JID from instance ID.
   */
  getRoomJid(instanceId: string): string {
    // Create deterministic hash of instance ID
    const hash = this.simpleHash(instanceId)
    return `webxdc-${hash}@{muc_service}`
  }

  /**
   * Join a realtime channel for the given instance.
   */
  async join(instanceId: string, nickname: string): Promise<RealtimeChannel> {
    // Return existing channel if already joined
    if (this.channels.has(instanceId)) {
      return this.channels.get(instanceId)!
    }

    // Create new channel
    const roomJid = this.getRoomJid(instanceId)

    // Extract conversation ID from instance ID (format: conversationId:url)
    const conversationId = instanceId.split(':')[0]

    const channel: RealtimeChannel = {
      instanceId,
      nickname,
      roomJid,
      listener: null,
      lastSentBase64: null,

      send: async (data: Uint8Array) => {
        // Validate size
        if (data.byteLength > MAX_MESSAGE_SIZE) {
          throw new Error('data exceeds 128KB limit')
        }

        // Convert to base64
        const base64 = this.uint8ArrayToBase64(data)
        channel.lastSentBase64 = base64

        // Send via Tauri IPC
        await invoke('webxdc_realtime_send', {
          roomJid: channel.roomJid,
          data: base64
        })
      },

      setListener: (callback: (data: Uint8Array) => void) => {
        channel.listener = callback
      },

      getLastSentBase64: () => {
        return channel.lastSentBase64
      }
    }

    this.channels.set(instanceId, channel)

    // Emit join event to Tauri backend
    await invoke('webxdc_realtime_join', {
      instanceId,
      conversationId,
      roomJid,
      nickname
    })

    console.log('[RealtimeChannelManager] Joined channel:', instanceId)

    return channel
  }

  /**
   * Leave a realtime channel.
   */
  async leave(instanceId: string): Promise<void> {
    const channel = this.channels.get(instanceId)
    if (!channel) {
      return // Already left or never joined
    }

    this.channels.delete(instanceId)

    // Emit leave event to Tauri backend
    await invoke('webxdc_realtime_leave', {
      roomJid: channel.roomJid
    })

    console.log('[RealtimeChannelManager] Left channel:', instanceId)
  }

  /**
   * Get list of active channels.
   */
  getActiveChannels(): RealtimeChannel[] {
    return Array.from(this.channels.values())
  }

  /**
   * Receive a message from XMPP (called by bridge).
   */
  async receiveMessage(instanceId: string, base64Data: string): Promise<void> {
    const channel = this.channels.get(instanceId)
    if (!channel || !channel.listener) {
      return // No listener registered
    }

    // Decode base64 to Uint8Array
    const data = this.base64ToUint8Array(base64Data)

    // Deliver to listener
    channel.listener(data)
  }

  /**
   * Simple hash function for instance ID.
   */
  private simpleHash(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16)
  }

  /**
   * Convert Uint8Array to base64.
   */
  private uint8ArrayToBase64(data: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < data.byteLength; i++) {
      binary += String.fromCharCode(data[i])
    }
    return btoa(binary)
  }

  /**
   * Convert base64 to Uint8Array.
   */
  private base64ToUint8Array(base64: string): Uint8Array {
    if (base64 === '') {
      return new Uint8Array(0)
    }

    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }

    return bytes
  }
}
