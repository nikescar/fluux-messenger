# WebXDC HTTP Server Plugin

Implements WebXDC app support via local HTTP server bridge.

## Architecture

Due to Tauri v2 limitations, we use a local HTTP server:

1. **HTTP Server** (`http_server.rs`): Serves files from temp directories on `127.0.0.1:random_port`
2. **Token Isolation** (`window.rs`): Each instance gets unique 128-bit token
3. **IPC Injection** (`tauri_bridge.rs`): Provides `window.__TAURI__` via initialization_script
4. **WebXDC Bridge** (`api.rs`): Injects `window.webxdc` API

## Request Flow

```
Open WebXDC → extract to /tmp/fluux-webxdc/{conversation}/{hash}/
           → generate token
           → register (hash, token) → extract_path
           → open http://127.0.0.1:{port}/{hash}/{token}/index.html
           → initialization_script injects Tauri + WebXDC bridges
           → HTTP server validates token and serves files
```

## Security

- **128-bit tokens** prevent instance cross-access
- **Path validation** prevents traversal (canonicalize + starts_with)
- **localhost only** (binds to 127.0.0.1)
- **No token logging**

## Files

- `mod.rs` - Module exports, commands, server singleton
- `http_server.rs` - HTTP server core
- `tauri_bridge.rs` - Tauri IPC bridge script
- `window.rs` - Window management, token generation
- `storage.rs` - SQLite storage for updates
- `api.rs` - WebXDC bridge script
- `extraction.rs` - ZIP extraction and validation
- `cleanup.rs` - Temp directory cleanup

## New APIs (2026-07-27)

### sendToChat()
- Export files and text from WebXDC to messenger chat
- Backend: `webxdc_send_to_chat` command
- Frontend: `fluux://webxdc-send-to-chat` event handler

### importFiles()
- Import files from messenger into WebXDC app
- Backend: `webxdc_import_files`, `webxdc_read_imported_file` commands
- Native file picker with MIME/extension filtering

### joinRealtimeChannel()
- Real-time P2P communication via XMPP MUC
- Backend: `webxdc_realtime_*` commands, `RealtimeChannelManager`
- Frontend: `realtimeBridge.ts` handles XMPP room lifecycle
- Rooms are private, auto-invite conversation participants

## Testing

- Unit: `cargo test webxdc`
- Integration: `cargo test --test webxdc_http_bridge`
- Manual: See `WEBXDC_HTTP_BRIDGE_TEST_RESULTS.md`
