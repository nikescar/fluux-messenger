import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { XMPPClient } from '@fluux/sdk/core'
import { isMucJid } from '@fluux/sdk'

/**
 * XMPP bridge for WebXDC realtime channels (Cheogram-compatible).
 *
 * Realtime frames ride directly in the conversation the webxdc instance
 * belongs to (1:1 chat, or the group's own already-joined MUC) rather than a
 * dedicated side-channel room. Join/leave are purely local bookkeeping — no
 * XMPP traffic is sent for them.
 */

interface ThreadJoinEvent {
  instance_id: string
  conversation_id: string
  thread_id: string
}

interface ThreadSendEvent {
  conversation_id: string
  thread_id: string
  data: string // base64
}

interface ThreadLeaveEvent {
  instance_id: string
}

// Map thread ID to instance ID for incoming-message routing.
const threadToInstance = new Map<string, string>()

let isListening = false
let xmppClient: XMPPClient | null = null

/**
 * Initialize realtime bridge event listeners.
 *
 * @param client - XMPP client instance
 */
export function initializeRealtimeBridge(client: XMPPClient): void {
  if (isListening) {
    console.warn('[webxdc-realtime] Bridge already initialized')
    return
  }

  xmppClient = client

  listen<ThreadJoinEvent>('fluux://webxdc-realtime-join', (event) => {
    const { instance_id, thread_id } = event.payload
    threadToInstance.set(thread_id, instance_id)
  }).catch((err) => {
    console.error('[webxdc-realtime] Failed to set up join listener:', err)
  })

  listen<ThreadSendEvent>('fluux://webxdc-realtime-send', async (event) => {
    const { conversation_id, thread_id, data } = event.payload

    try {
      if (!xmppClient) {
        throw new Error('XMPP client not initialized')
      }

      const type = isMucJid(conversation_id) ? 'groupchat' : 'chat'
      await (xmppClient.chat as any).sendWebxdcRealtime(conversation_id, type, thread_id, data)
    } catch (error) {
      console.error('[webxdc-realtime] Failed to send:', error)
    }
  }).catch((err) => {
    console.error('[webxdc-realtime] Failed to set up send listener:', err)
  })

  listen<ThreadLeaveEvent>('fluux://webxdc-realtime-leave', (event) => {
    const { instance_id } = event.payload
    for (const [thread, instance] of threadToInstance) {
      if (instance === instance_id) {
        threadToInstance.delete(thread)
      }
    }
  }).catch((err) => {
    console.error('[webxdc-realtime] Failed to set up leave listener:', err)
  })

  xmppClient.on('webxdc:realtime' as any, async (event: any) => {
    const { thread, data } = event
    if (!thread) return

    const instanceId = threadToInstance.get(thread)
    if (!instanceId) return // No window currently joined for this thread

    try {
      await invoke('webxdc_realtime_receive', {
        instanceId,
        data,
      })
    } catch (error) {
      console.error('[webxdc-realtime] Failed to forward message:', error)
    }
  })

  isListening = true
}
