import type { FileAttachment } from '@fluux/sdk'
import { connectionStore } from '@fluux/sdk/stores'
import { invoke } from '@tauri-apps/api/core'
import { getInstanceId } from './instanceId'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'

/**
 * Open webxdc app in Tauri webview window.
 *
 * Downloads/decrypts the .xdc file, extracts to temp directory,
 * and creates a WebviewWindow with injected webxdc API.
 *
 * Automatically retrieves selfAddr and selfName from connection store.
 *
 * @param attachment - Webxdc file attachment
 * @param conversationId - Conversation JID (bare JID or room JID)
 */
export async function openWebxdcWindow(
  attachment: FileAttachment,
  conversationId: string,
  explicitInstanceId?: string
): Promise<void> {
  // Use explicit instanceId if provided (from sidebar), otherwise calculate from URL (from chat)
  const instanceId = explicitInstanceId || getInstanceId(conversationId, attachment.url)

  // Get current user info from connection store
  const { jid, ownNickname } = connectionStore.getState()
  const selfAddr = jid || 'unknown@example.com'
  const selfName = ownNickname || jid?.split('@')[0] || 'User'

  console.log('[webxdc] Opening window for instance:', instanceId)
  console.log('[webxdc] User:', selfAddr, selfName)

  // Record launch and clear unreads asynchronously (non-blocking)
  // These happen in background while window is being opened
  Promise.resolve().then(() => {
    const { recordLaunch, clearUnread } = useWebxdcPanelStore.getState()
    recordLaunch(conversationId, instanceId)
    clearUnread(instanceId)
  })

  // Step 1: Download and extract .xdc file
  const { extract_path } = await invoke<{ extract_path: string; manifest: unknown }>(
    'webxdc_extract',
    {
      url: attachment.url,
      instanceId,
      conversationId,
      filename: attachment.name || 'app.xdc',
      decryptKey: attachment.encryption?.key,
      decryptIv: attachment.encryption?.iv
    }
  )

  console.log('[webxdc] Extracted to:', extract_path)

  // Step 1.5: If this attachment carried a <thread> (Cheogram interop), save
  // the thread→instance mapping so future Cheogram-format updates can be correlated.
  if (attachment.thread) {
    await invoke('webxdc_set_thread_for_instance', {
      instanceId,
      threadId: attachment.thread
    })
    console.log('[webxdc] Thread→instance mapping saved:', attachment.thread, '→', instanceId)
  }

  // Step 2: Open WebviewWindow with injected API
  const windowLabel = await invoke<string>('webxdc_open_window', {
    instanceId,
    extractPath: extract_path,
    selfAddr,
    selfName
  })

  console.log('[webxdc] Window opened:', windowLabel)
}
