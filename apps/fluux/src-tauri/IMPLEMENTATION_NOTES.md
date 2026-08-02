# WebXDC HTTP Bridge Implementation Notes

**Implementation Date:** 2026-07-27  
**Branch:** feature/webxdc

## Key Changes from Original Design

- **No iife.js bundling**: Tauri v2 doesn't have dist/iife.js, uses different architecture
- **Custom Tauri IPC bridge**: Created minimal `window.__TAURI__` shim in `tauri_bridge.rs`
- **Uses `initialization_script`**: Injects both Tauri bridge and WebXDC bridge before page load
- **Plugin-style structure**: Cleaner modular organization
- **Simpler implementation**: ~380 LOC vs originally estimated 450

## Actual Code Size

- `http_server.rs`: ~180 lines (HTTP server core + request handling)
- `tauri_bridge.rs`: ~90 lines (Tauri IPC shim)
- `window.rs` changes: ~70 lines (token generation + HTTP URL handling)
- Integration tests: ~60 lines
- **Total**: ~400 lines

## Dependencies Added

- `once_cell = "1"` - For server singleton
- `rand = "0.8"` - For token generation
- No other new dependencies (sha2, reqwest already present)

## Architecture Highlights

1. **Single Global HTTP Server**: Lazy-initialized singleton serves all instances
2. **Token-Based Isolation**: 128-bit random tokens prevent cross-instance access
3. **Thread-per-Connection**: Simple blocking I/O model, sufficient for desktop use
4. **Manual Script Injection**: Both Tauri core and WebXDC API injected via initialization_script

## Security Features

- Path traversal protection via canonicalize() + starts_with()
- Token validation before serving any file
- localhost-only binding (127.0.0.1)
- No token logging to prevent leakage

## Testing

- Unit tests: All passing
- Integration tests: Full flow + security validation
- Manual testing: Pending (see Task 8)

## Known Limitations

- All instances share same origin (`http://127.0.0.1:PORT`)
  - Mitigated by 128-bit token entropy
- No CSP headers yet (future enhancement)
- No rate limiting (acceptable for desktop single-user app)

## Future Improvements

1. Add CSP headers if compatible with WebXDC apps
2. Token expiration after 24 hours
3. Request logging for debugging (optional flag)
4. Per-instance ports for true origin isolation (if needed)
