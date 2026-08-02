pub fn generate_api_script(
    instance_id: &str,
    conversation_id: &str,
    self_addr: &str,
    self_name: &str,
) -> String {
    format!(r#"
(function() {{
  const INSTANCE_ID = {instance_id};
  const CONVERSATION_ID = {conversation_id};
  const SELF_ADDR = {self_addr};
  const SELF_NAME = {self_name};

  let updateListener = null;

  // Wait for Tauri to be ready before initializing webxdc API
  function initWebxdcAPI() {{
    if (typeof window.__TAURI__ === 'undefined') {{
      console.error('[webxdc] ERROR: window.__TAURI__ is not available');
      console.error('[webxdc] This window may not have Tauri IPC enabled');
      return;
    }}

    window.webxdc = {{
      selfAddr: SELF_ADDR,
      selfName: SELF_NAME,

      sendUpdate: function(update, description) {{
        try {{
          JSON.stringify(update.payload);
        }} catch (e) {{
          throw new Error('webxdc: payload must be JSON-serializable');
        }}

        window.__TAURI__.invoke('webxdc_send_update', {{
          instanceId: INSTANCE_ID,
          payload: update.payload,
          info: description || update.info || '',
          document: update.document,
          summary: update.summary,
          senderId: SELF_ADDR,
        }}).catch(err => {{
          console.error('[webxdc] Failed to send update:', err);
        }});
      }},

      setUpdateListener: function(callback, serial) {{
        serial = serial || 0;
        updateListener = callback;

        window.__TAURI__.invoke('webxdc_get_updates', {{
          instanceId: INSTANCE_ID,
          fromSerial: serial,
        }}).then(updates => {{
          for (const update of updates) {{
            callback(update);
          }}
        }}).catch(err => {{
          console.error('[webxdc] Failed to fetch updates:', err);
        }});

        window.__TAURI__.event.listen('webxdc_update', (event) => {{
          if (event.payload.instanceId === INSTANCE_ID && updateListener) {{
            updateListener(event.payload.update);
          }}
        }});
      }},

      getAllUpdates: function() {{
        return window.__TAURI__.invoke('webxdc_get_updates', {{
          instanceId: INSTANCE_ID,
        }});
      }},

      // window.webxdc.importFiles
      importFiles: async function(filter) {{
        filter = filter || {{}};

        // Call Tauri backend with filter options
        const result = await window.__TAURI__.invoke('webxdc_import_files', {{
          instanceId: INSTANCE_ID,
          extensions: filter.extensions || null,
          mimeTypes: filter.mimeTypes || null,
          multiple: filter.multiple || false
        }});

        // Convert returned file paths to File objects
        const files = [];
        for (const fileInfo of result.files) {{
          // Read file content via Tauri
          const content = await window.__TAURI__.invoke('webxdc_read_imported_file', {{
            filePath: fileInfo.path
          }});

          // Create Blob from base64
          const bytes = Uint8Array.from(atob(content.base64), c => c.charCodeAt(0));
          const blob = new Blob([bytes], {{ type: fileInfo.mimeType }});

          // Create File object
          const file = new File([blob], fileInfo.name, {{
            type: fileInfo.mimeType,
            lastModified: fileInfo.lastModified
          }});

          files.push(file);
        }}

        return files;
      }},

      // window.webxdc.sendToChat
      sendToChat: async function(message) {{
        // Validate message structure
        if (!message || typeof message !== 'object') {{
          throw new Error('webxdc.sendToChat: message must be an object');
        }}

        // Prepare file data
        let fileData = null;
        if (message.file) {{
          if (!message.file.name) {{
            throw new Error('webxdc.sendToChat: file.name is required');
          }}

          if (message.file.blob instanceof Blob) {{
            // Convert Blob to base64
            const arrayBuffer = await message.file.blob.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            fileData = {{
              name: message.file.name,
              base64: btoa(String.fromCharCode(...bytes))
            }};
          }} else if (typeof message.file.base64 === 'string') {{
            fileData = {{
              name: message.file.name,
              base64: message.file.base64
            }};
          }} else if (typeof message.file.plainText === 'string') {{
            fileData = {{
              name: message.file.name,
              base64: btoa(message.file.plainText)
            }};
          }} else {{
            throw new Error('webxdc.sendToChat: file must have blob, base64, or plainText');
          }}
        }}

        // Call Tauri backend
        await window.__TAURI__.invoke('webxdc_send_to_chat', {{
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          fileData: fileData,
          text: message.text || null
        }});
      }},

      // Realtime channel API (optional WebXDC feature)
      // window.webxdc.joinRealtimeChannel
      joinRealtimeChannel: function() {{
        // Prevent multiple simultaneous channels
        if (window.__webxdc_realtime_channel) {{
          throw new Error('Already joined a realtime channel. Call leave() first.');
        }}

        let listener = null;
        let isActive = true;

        const channel = {{
          setListener: function(callback) {{
            if (!isActive) {{
              throw new Error('Channel is closed');
            }}
            listener = callback;

            // Subscribe to incoming realtime messages
            window.__TAURI__.event.listen('webxdc_realtime_message', (event) => {{
              if (event.payload.instanceId === INSTANCE_ID && listener && isActive) {{
                // Decode base64 to Uint8Array
                const bytes = Uint8Array.from(
                  atob(event.payload.data),
                  c => c.charCodeAt(0)
                );
                listener(bytes);
              }}
            }});
          }},

          send: function(data) {{
            if (!isActive) {{
              throw new Error('Channel is closed');
            }}

            if (!(data instanceof Uint8Array)) {{
              throw new Error('data must be Uint8Array');
            }}

            if (data.length > 128000) {{
              throw new Error('data must not exceed 128,000 bytes');
            }}

            // Encode to base64
            const base64 = btoa(String.fromCharCode(...data));

            window.__TAURI__.invoke('webxdc_realtime_send', {{
              instanceId: INSTANCE_ID,
              data: base64
            }}).catch(err => {{
              console.error('[webxdc] Failed to send realtime data:', err);
            }});
          }},

          leave: function() {{
            if (!isActive) return;

            isActive = false;
            listener = null;
            window.__webxdc_realtime_channel = null;

            window.__TAURI__.invoke('webxdc_realtime_leave', {{
              instanceId: INSTANCE_ID
            }}).catch(err => {{
              console.error('[webxdc] Failed to leave channel:', err);
            }});
          }}
        }};

        // Join the channel
        window.__TAURI__.invoke('webxdc_realtime_join', {{
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          selfAddr: SELF_ADDR,
          selfName: SELF_NAME
        }}).then(() => {{
          console.log('[webxdc] Joined realtime channel');
        }}).catch(err => {{
          console.error('[webxdc] Failed to join realtime channel:', err);
          isActive = false;
        }});

        window.__webxdc_realtime_channel = channel;
        return channel;
      }}
    }};

    console.log('[webxdc] API initialized for instance:', INSTANCE_ID);
  }}

  // Initialize immediately if __TAURI__ is already available
  if (typeof window.__TAURI__ !== 'undefined') {{
    initWebxdcAPI();
  }} else {{
    // Otherwise wait for DOMContentLoaded and try again
    if (document.readyState === 'loading') {{
      document.addEventListener('DOMContentLoaded', initWebxdcAPI);
    }} else {{
      // DOM already loaded, try in next tick
      setTimeout(initWebxdcAPI, 0);
    }}
  }}
}})();
"#,
        instance_id = serde_json::to_string(instance_id).unwrap(),
        conversation_id = serde_json::to_string(conversation_id).unwrap(),
        self_addr = serde_json::to_string(self_addr).unwrap(),
        self_name = serde_json::to_string(self_name).unwrap(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generates_script_with_instance_id() {
        let script = generate_api_script(
            "chat@example.com:https://example.com/app.xdc",
            "chat@example.com",
            "user@example.com",
            "Alice"
        );
        assert!(script.contains("chat@example.com:https://example.com/app.xdc"));
    }

    #[test]
    fn test_includes_self_addr_and_name() {
        let script = generate_api_script(
            "test:url",
            "conv@ex.com",
            "alice@example.com",
            "Alice Smith"
        );
        assert!(script.contains("alice@example.com"));
        assert!(script.contains("Alice Smith"));
    }

    #[test]
    fn test_defines_window_webxdc() {
        let script = generate_api_script("test:url", "conv@ex.com", "u@ex.com", "U");
        assert!(script.contains("window.webxdc"));
        assert!(script.contains("sendUpdate"));
        assert!(script.contains("setUpdateListener"));
        assert!(script.contains("getAllUpdates"));
    }

    #[test]
    fn test_generates_send_to_chat_function() {
        let script = generate_api_script("test-id", "conv@ex.com", "user@ex.com", "User");
        assert!(script.contains("window.webxdc.sendToChat"));
        assert!(script.contains("webxdc_send_to_chat"));
        assert!(script.contains("file.blob instanceof Blob"));
        assert!(script.contains("file.base64"));
        assert!(script.contains("file.plainText"));
    }

    #[test]
    fn test_send_to_chat_validates_file_name() {
        let script = generate_api_script("test-id", "conv@ex.com", "user@ex.com", "User");
        assert!(script.contains("file.name is required"));
    }

    #[test]
    fn test_send_to_chat_validates_message_object() {
        let script = generate_api_script("test-id", "conv@ex.com", "user@ex.com", "User");
        assert!(script.contains("message must be an object"));
    }

    #[test]
    fn test_generates_import_files_function() {
        let script = generate_api_script("test-id", "conv@ex.com", "user@ex.com", "User");
        assert!(script.contains("window.webxdc.importFiles"));
        assert!(script.contains("webxdc_import_files"));
        assert!(script.contains("webxdc_read_imported_file"));
        assert!(script.contains("filter.extensions"));
        assert!(script.contains("filter.mimeTypes"));
        assert!(script.contains("filter.multiple"));
    }

    #[test]
    fn test_import_files_creates_file_objects() {
        let script = generate_api_script("test-id", "conv@ex.com", "user@ex.com", "User");
        assert!(script.contains("new File"));
        assert!(script.contains("new Blob"));
        assert!(script.contains("Uint8Array.from"));
    }

    #[test]
    fn test_generates_join_realtime_channel() {
        let script = generate_api_script("test-id", "conv@ex.com", "user@ex.com", "User");
        assert!(script.contains("window.webxdc.joinRealtimeChannel"));
        assert!(script.contains("webxdc_realtime_join"));
        assert!(script.contains("webxdc_realtime_send"));
        assert!(script.contains("webxdc_realtime_leave"));
    }

    #[test]
    fn test_realtime_channel_enforces_single_instance() {
        let script = generate_api_script("test-id", "conv@ex.com", "user@ex.com", "User");
        assert!(script.contains("__webxdc_realtime_channel"));
        assert!(script.contains("Already joined a realtime channel"));
    }

    #[test]
    fn test_realtime_channel_validates_data_size() {
        let script = generate_api_script("test-id", "conv@ex.com", "user@ex.com", "User");
        assert!(script.contains("128000"));
        assert!(script.contains("must not exceed"));
    }

    #[test]
    fn test_realtime_channel_validates_uint8array() {
        let script = generate_api_script("test-id", "conv@ex.com", "user@ex.com", "User");
        assert!(script.contains("data instanceof Uint8Array"));
        assert!(script.contains("data must be Uint8Array"));
    }
}
