import { listen } from '@tauri-apps/api/event'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'

interface WindowClosedEvent {
  instance_id: string
  closed_at: number
}

/**
 * Initialize listener for webxdc window close events.
 *
 * Listens for fluux://webxdc-window-closed events from Tauri backend
 * and updates the store's lastClosedAt timestamp for the instance.
 *
 * Call once on app mount in App.tsx.
 */
export function initializeWindowLifecycleListener() {
  listen<WindowClosedEvent>('fluux://webxdc-window-closed', (event) => {
    const { instance_id, closed_at } = event.payload
    useWebxdcPanelStore.getState().recordClose(instance_id, closed_at)
    console.log('[webxdc] Window closed, recorded:', instance_id)
  }).catch((err) => {
    console.error('[webxdc] Failed to set up window close listener:', err)
  })
}
