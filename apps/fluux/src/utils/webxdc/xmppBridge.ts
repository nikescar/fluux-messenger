import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { XMPPClient } from '@fluux/sdk/core'
import { xml, connectionStore } from '@fluux/sdk'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'

export interface WebxdcUpdate {
  serial: number
  max_serial: number
  payload: unknown
  info?: string
  document?: string
  summary?: string
  sender: string
  thread?: string
}

/**
 * XMPP bridge for webxdc updates.
 *
 * Routes webxdc update events between Tauri backend and XMPP transport.
 * Updates are stored in SQLite by Tauri, then transmitted via XMPP.
 */

// XEP-0491: Webxdc namespace
const NS_WEBXDC = 'urn:xmpp:webxdc:0'

interface OutgoingUpdateEvent {
  instance_id: string
  serial: number
  payload: unknown
  info?: string
  document?: string
  summary?: string
  sender: string
  thread_id: string
}

// Module-level state for XMPP bridge
let xmppClient: XMPPClient | null = null
let uploadFileFunction: ((file: File, options?: { encrypt?: boolean }) => Promise<any | null>) | null = null
let isInitialized = false

/**
 * Initialize XMPP bridge event listeners.
 *
 * Attaches event handlers to the XMPP client for routing webxdc updates.
 * Only initializes once - subsequent calls update client/uploadFile references.
 *
 * @param client - XMPP client instance for sending messages
 * @param uploadFile - File upload function from useFileUpload hook
 */
export function initializeXmppBridge(
  client: XMPPClient,
  uploadFile: (file: File, options?: { encrypt?: boolean }) => Promise<any | null>
): void {
  // Update references (listeners use module-level variables, so this updates them)
  xmppClient = client
  uploadFileFunction = uploadFile

  // Only set up listeners once
  if (isInitialized) {
    console.log('[webxdc] XMPP bridge already initialized, updated client reference')
    return
  }
  isInitialized = true

  console.log('[webxdc] Setting up XMPP bridge event listeners (one-time initialization)')

  // Listen for outgoing updates from Tauri
  listen<OutgoingUpdateEvent>('fluux://webxdc-outgoing-update', async (event) => {
    const update = event.payload
    console.log('[webxdc] ▶ LAYER 3: Outgoing update event received from Tauri', {
      instance_id: update.instance_id,
      serial: update.serial,
      payload: update.payload,
      info: update.info,
      summary: update.summary,
      thread_id: update.thread_id
    })

    try {
      // Parse instance_id to get conversation JID
      // Format: conversationId:attachmentUrl
      const conversationId = update.instance_id.split(':')[0]
      console.log('[webxdc] → Parsed conversationId:', conversationId)

      await sendWebxdcUpdateViaXMPP(
        conversationId,
        update.instance_id,
        update.serial,
        update.payload,
        update.info,
        update.document,
        update.summary,
        update.thread_id
      )

      console.log('[webxdc] ✓ LAYER 4: Update transmitted via XMPP successfully')
    } catch (err) {
      console.error('[webxdc] ✗ LAYER 4: Failed to transmit update via XMPP:', err)
    }
  }).catch((err) => {
    console.error('[webxdc] Failed to set up outgoing update listener:', err)
  })

  // Listen for incoming WebXDC updates from XMPP SDK events
  client.onSDK('webxdc:update', async (event) => {
    const { from, instance, serial, payload, info, document, summary, sender, thread, isCheogramFormat } = event

    console.log('[webxdc] ◀ INCOMING: Received webxdc:update from XMPP', {
      isCheogramFormat,
      from,
      instance,
      thread,
      serial,
      payload,
      summary,
      sender
    })

    try {
      let resolvedInstance = instance

      // Cheogram format: instance is empty, need to resolve via thread→instance lookup
      if (isCheogramFormat && thread && !instance) {
        console.log('[webxdc] Resolving thread→instance for:', thread)
        const result = await invoke<{ instance_id: string | null }>('webxdc_get_instance_by_thread', {
          threadId: thread
        })

        if (result.instance_id) {
          resolvedInstance = result.instance_id
          console.log('[webxdc] Resolved thread→instance:', thread, '→', result.instance_id)
        } else {
          console.warn('[webxdc] Cheogram update for unknown thread:', thread)
          return
        }
      } else if (instance && from) {
        // Check if instance is in canonical format (URL only) vs internal format (conversationId:URL)
        // Internal format always has @ somewhere in the conversationId part (since conversationId is a JID)
        // Canonical format is just the URL (e.g., "https://...")
        // If instance contains @ it's already in internal format, otherwise convert it
        if (instance.includes('@')) {
          // Already has conversationId prefix (internal format)
          resolvedInstance = instance
        } else {
          // Canonical format (URL only) - convert to internal format
          resolvedInstance = `${from}:${instance}`
        }
      }

      if (sender) {
        useWebxdcPanelStore.getState().incrementUnread(resolvedInstance, sender)
      }

      await receiveWebxdcUpdate(resolvedInstance, {
        serial,
        max_serial: serial,
        payload,
        info,
        document,
        summary,
        sender,
        thread
      })
      console.log('[webxdc] Incoming update received:', resolvedInstance, serial)
    } catch (error) {
      console.error('[webxdc] Failed to process incoming update:', error)
    }
  })

  // Listen for sendToChat events
  listen<SendToChatEvent>('fluux://webxdc-send-to-chat', async (event) => {
    const { conversation_id, file_path, text } = event.payload

    console.log('[webxdc] sendToChat event:', conversation_id, file_path ? 'with file' : 'text only')

    try {
      if (!xmppClient) {
        console.error('[webxdc] XMPP client not initialized')
        return
      }

      let attachment: any | undefined

      // Upload file if provided
      if (file_path && uploadFileFunction) {
        // Convert Tauri file path to File object
        const url = convertFileSrc(file_path)
        const response = await fetch(url)
        const blob = await response.blob()
        const fileName = file_path.split('/').pop() || 'file'
        const file = new File([blob], fileName, { type: blob.type })

        // Upload file (encryption will be determined by sendMessage)
        const result = await uploadFileFunction(file)
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

  console.log('[webxdc] XMPP bridge initialized')
}

interface SendToChatEvent {
  conversation_id: string
  file_path: string | null
  text: string | null
}

/**
 * Send a webxdc update via XMPP.
 *
 * Constructs an XMPP message with XEP-0491 webxdc update payload.
 */
async function sendWebxdcUpdateViaXMPP(
  conversationId: string,
  instanceId: string,
  serial: number,
  payload: unknown,
  info?: string,
  document?: string,
  summary?: string,
  thread?: string
): Promise<void> {
  if (!xmppClient) {
    throw new Error('XMPP client not initialized')
  }

  // Extract canonical instance ID (URL only) from internal format (conversationId:URL)
  // Internal format: "jid@server:https://example.com/file.xdc"
  // Canonical format: "https://example.com/file.xdc"
  const urlStart = instanceId.indexOf('https://')
  const canonicalInstanceId = urlStart >= 0 ? instanceId.substring(urlStart) : instanceId

  console.log('[webxdc] ▶ LAYER 4a: Building XMPP stanza', {
    conversationId,
    internalInstanceId: instanceId,
    canonicalInstanceId,
    serial,
    payload,
    info,
    summary,
    thread
  })

  // Build dual-wire format: single <x> element with BOTH Fluux and Cheogram children
  // Use canonical instance ID (URL only) so both peers see the same value
  const updateChildren = [
    // Fluux format (XEP-0491)
    xml('instance', {}, canonicalInstanceId),
    xml('serial', {}, serial.toString()),
    xml('payload', {}, JSON.stringify(payload)),
    // Cheogram format
    xml('json', { xmlns: 'urn:xmpp:json:0' }, JSON.stringify(payload))
  ]

  if (info) {
    updateChildren.push(xml('info', {}, info))
  }
  if (document) {
    updateChildren.push(xml('document', {}, document))
  }

  // Cheogram summary format: "Update (serial/serial)" - both numbers are the same serial
  const cheogramSummary = `${summary || info || 'Update'} (${serial}/${serial})`
  updateChildren.push(xml('summary', {}, cheogramSummary))

  const updateElement = xml('x', { xmlns: NS_WEBXDC }, ...updateChildren)

  const customChildren = [updateElement]

  if (thread) {
    customChildren.push(xml('thread', {}, thread))
  }

  // Construct message body
  const body = `[WebXDC Update: ${info || 'update'}]`

  console.log('[webxdc] → XMPP stanza structure:', {
    body,
    hasThread: !!thread,
    updateChildren: updateChildren.map(c => c.name),
    thread
  })

  // Send via SDK
  await (xmppClient.chat as any).sendCustomMessage(
    conversationId,
    body,
    'chat',
    customChildren
  )

  console.log('[webxdc] ✓ LAYER 4b: XMPP stanza sent (dual-wire):', instanceId, serial)
}

/**
 * Send a webxdc update to XMPP.
 *
 * Called by webxdc apps via window.webxdc.sendUpdate().
 * Stores update in Tauri backend, then transmits via XMPP.
 *
 * @param instanceId - Webxdc instance ID
 * @param payload - Update payload (serializable JSON)
 * @param info - Optional summary text
 * @param document - Optional document name
 * @param summary - Optional status summary
 * @param senderId - Sender's JID
 */
export async function sendWebxdcUpdate(
  instanceId: string,
  payload: unknown,
  info?: string,
  document?: string,
  summary?: string,
  senderId?: string
): Promise<void> {
  // Get sender JID from connection store
  const jid = connectionStore.getState().jid
  const actualSenderId = senderId || jid || 'unknown@example.com'

  // Store update in Tauri backend SQLite
  const result = await invoke<{ serial: number; thread_id?: string }>('webxdc_send_update', {
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
    summary,
    result.thread_id
  )

  console.log('[webxdc] Update stored and transmitted:', instanceId, result.serial)
}

/**
 * Receive a webxdc update from XMPP.
 *
 * Called when an XMPP message with webxdc update arrives.
 * Stores in Tauri backend and notifies open windows.
 *
 * @param instanceId - Webxdc instance ID
 * @param update - Update object from XMPP
 */
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
    timestamp: Math.floor(Date.now() / 1000),
    threadId: update.thread
  })

  console.log('[webxdc] Update received from XMPP and distributed:', instanceId)
}

/**
 * Get all updates for a webxdc instance.
 *
 * @param instanceId - Webxdc instance ID
 * @param fromSerial - Optional serial number to start from
 * @returns Array of updates
 */
export async function getWebxdcUpdates(
  instanceId: string,
  fromSerial?: number
): Promise<WebxdcUpdate[]> {
  return await invoke<WebxdcUpdate[]>('webxdc_get_updates', {
    instanceId,
    fromSerial
  })
}
