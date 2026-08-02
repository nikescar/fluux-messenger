/**
 * Generate webxdc API injection script.
 *
 * This script is injected into the webxdc webview window before
 * index.html loads, providing the window.webxdc API per the
 * webxdc specification.
 *
 * The API communicates with the main app via Tauri IPC commands.
 *
 * @param instanceId - Instance identifier (conversationId:attachmentUrl)
 * @param selfAddr - User's XMPP JID
 * @param selfName - User's display name
 * @returns JavaScript code to inject
 */
export function generateWebxdcApiScript(
  instanceId: string,
  selfAddr: string,
  selfName: string
): string {
  return `
(function() {
  const INSTANCE_ID = ${JSON.stringify(instanceId)};
  const SELF_ADDR = ${JSON.stringify(selfAddr)};
  const SELF_NAME = ${JSON.stringify(selfName)};

  let updateListener = null;

  window.webxdc = {
    selfAddr: SELF_ADDR,
    selfName: SELF_NAME,

    sendUpdate: function(update, description) {
      // Validate payload is JSON-serializable
      try {
        JSON.stringify(update.payload);
      } catch (e) {
        throw new Error('webxdc: payload must be JSON-serializable');
      }

      console.log('[webxdc] ▶ LAYER 1: sendUpdate called in webxdc app', {
        instanceId: INSTANCE_ID,
        payload: update.payload,
        info: description || update.info || '',
        summary: update.summary
      });

      // Send to Tauri backend
      window.__TAURI__.invoke('webxdc_send_update', {
        instanceId: INSTANCE_ID,
        payload: update.payload,
        info: description || update.info || '',
        document: update.document,
        summary: update.summary
      }).then(() => {
        console.log('[webxdc] ✓ LAYER 2: Tauri IPC acknowledged');
      }).catch(err => {
        console.error('[webxdc] ✗ LAYER 2: Failed to send update:', err);
      });
    },

    setUpdateListener: function(callback, serial) {
      serial = serial || 0;
      updateListener = callback;

      // Fetch historical updates
      window.__TAURI__.invoke('webxdc_get_updates', {
        instanceId: INSTANCE_ID,
        fromSerial: serial
      }).then(updates => {
        for (const update of updates) {
          callback(update);
        }
      }).catch(err => {
        console.error('[webxdc] Failed to fetch updates:', err);
      });

      // Subscribe to live updates
      window.__TAURI__.event.listen('webxdc_update', (event) => {
        if (event.payload.instanceId === INSTANCE_ID && updateListener) {
          updateListener(event.payload.update);
        }
      });
    },

    getAllUpdates: function() {
      return window.__TAURI__.invoke('webxdc_get_all_updates', {
        instanceId: INSTANCE_ID
      });
    }
  };

  console.log('[webxdc] API initialized for instance:', INSTANCE_ID);
})();
`.trim()
}
