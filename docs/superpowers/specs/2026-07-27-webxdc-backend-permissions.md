# WebXDC Backend Permissions Implementation

**Date:** 2026-07-27  
**Status:** Approved  
**Approach:** Build Script Command Registration (Approach B)

## Goal

Re-enable all WebXDC Tauri backend commands by properly registering their permissions through the build script, allowing the app to build and run successfully.

## Background

All 13 WebXDC backend commands are already fully implemented in Rust with SQLite storage, file operations, event emission, and comprehensive tests. However, their permissions were removed in commit `45c8992a` due to a misunderstanding that the backend wasn't implemented. The backend IS implemented (commits `e7b4d802`, `9a370c6f`), we just need to properly register the permissions.

## Architecture

Use Tauri v2's build-time command registration system via `build.rs` to auto-generate `default:allow-*` permissions for all WebXDC commands. This is simpler than creating 13 individual permission files and follows Tauri's standard approach.

### Components

1. **build.rs** - Registers WebXDC commands in app manifest
2. **capabilities/webxdc.json** - References auto-generated permissions
3. **Existing commands** - Already implemented and registered in main.rs

### Data Flow

```
Compile Time:
build.rs declares commands
  → Tauri generates default:allow-webxdc-* permissions
    → Stored in target/debug/build/.../permissions/

Runtime:
capabilities/webxdc.json references permissions
  → WebXDC windows (webxdc-*) can call commands
    → Commands execute and emit events to frontend
```

## Technical Specification

### Commands to Register

All 13 WebXDC commands (already implemented in `src-tauri/src/webxdc/mod.rs`):

1. `webxdc_extract` - Extract .xdc file with optional decryption
2. `webxdc_open_window` - Open or focus WebXDC app window
3. `webxdc_send_update` - Store update in SQLite, emit to XMPP
4. `webxdc_get_updates` - Retrieve updates from SQLite
5. `webxdc_receive_update` - Handle incoming XMPP update
6. `webxdc_close_window` - Close window and cleanup
7. `webxdc_send_to_chat` - Export file/text to conversation
8. `webxdc_import_files` - Native file picker dialog
9. `webxdc_read_imported_file` - Read imported file as base64
10. `webxdc_realtime_join` - Join MUC room for realtime
11. `webxdc_realtime_send` - Send realtime data to room
12. `webxdc_realtime_leave` - Leave realtime room
13. `webxdc_realtime_receive` - Receive realtime data from XMPP

### Build Script Modification

File: `src-tauri/build.rs`

**Current state:** Likely minimal or default build script

**Required change:** Add app manifest with command list

```rust
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "webxdc_extract",
                "webxdc_open_window",
                "webxdc_send_update",
                "webxdc_get_updates",
                "webxdc_receive_update",
                "webxdc_close_window",
                "webxdc_send_to_chat",
                "webxdc_import_files",
                "webxdc_read_imported_file",
                "webxdc_realtime_join",
                "webxdc_realtime_send",
                "webxdc_realtime_leave",
                "webxdc_realtime_receive",
            ]))
    )
    .expect("failed to run tauri-build");
}
```

### Capability File Update

File: `src-tauri/capabilities/webxdc.json`

**Current state:** Only core permissions, WebXDC permissions removed

**Required change:** Add all auto-generated WebXDC permissions

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "identifier": "webxdc",
  "description": "Capabilities for WebXDC app windows",
  "windows": ["webxdc-*"],
  "platforms": ["linux", "macOS", "windows"],
  "permissions": [
    "core:default",
    "core:event:default",
    "core:event:allow-listen",
    "core:event:allow-emit",
    "core:window:default",
    "core:window:allow-set-focus",
    "core:webview:default",
    "core:webview:allow-webview-position",
    "notification:default",
    "notification:allow-is-permission-granted",
    "notification:allow-request-permission",
    "default:allow-webxdc-extract",
    "default:allow-webxdc-open-window",
    "default:allow-webxdc-send-update",
    "default:allow-webxdc-get-updates",
    "default:allow-webxdc-receive-update",
    "default:allow-webxdc-close-window",
    "default:allow-webxdc-send-to-chat",
    "default:allow-webxdc-import-files",
    "default:allow-webxdc-read-imported-file",
    "default:allow-webxdc-realtime-join",
    "default:allow-webxdc-realtime-send",
    "default:allow-webxdc-realtime-leave",
    "default:allow-webxdc-realtime-receive"
  ]
}
```

## Testing & Verification

### Build-Time Verification

1. **Clean build to regenerate permissions:**
   ```bash
   cargo clean
   cargo build
   ```

2. **Check generated permissions exist:**
   ```bash
   find target/debug/build -name "permissions" -type d
   ls target/debug/build/fluux-*/out/permissions/
   ```

3. **Verify no permission errors in build output**

### Runtime Verification

1. **Start the app:**
   ```bash
   npm run tauri:dev
   ```

2. **Verify app starts without permission errors**
   - Console should show: `[app] WebXDC bridges initialized`
   - No "Permission not found" errors

3. **Test WebXDC functionality:**
   - Open a WebXDC app (tests `webxdc_extract`, `webxdc_open_window`)
   - Call `window.webxdc.sendUpdate({test: 'data'}, 'Test')` 
     - Should call `webxdc_send_update` successfully
   - Check network tab for XMPP update transmission

### No New Unit Tests Needed

This is build configuration, not code logic. The existing comprehensive tests in `src-tauri/src/webxdc/mod.rs` already verify command functionality:

- `send_to_chat_tests` - File encoding and event serialization
- `import_files_tests` - File reading and base64 encoding
- Unit tests for all commands already exist

## Global Constraints

- **Tauri Version:** v2.x (using new permission system)
- **Rust Edition:** 2021
- **No Breaking Changes:** Existing commands remain unchanged
- **Backward Compatible:** Frontend code unchanged, expects same command signatures

## Success Criteria

✅ App builds successfully (`cargo build` exits 0)  
✅ App starts without permission errors (`npm run tauri:dev`)  
✅ WebXDC windows can call all 13 commands  
✅ Console shows `[app] WebXDC bridges initialized`  
✅ Frontend can send/receive WebXDC updates via XMPP

## Why This Approach

**Chosen: Build Script Registration (Approach B)**

Advantages:
- ✅ Simple - one file change (`build.rs`)
- ✅ Auto-generates permission identifiers  
- ✅ Less boilerplate than 13 TOML files
- ✅ Standard Tauri practice for custom commands

Alternative (not chosen): Permission TOML files
- ❌ Would require 13 new files in `src-tauri/permissions/`
- ❌ More complex for a simple use case
- ✅ Better for complex permission logic (not needed here)

## Implementation Notes

**Build script execution:** Runs at compile time before Rust compilation, so changes require `cargo build` to take effect.

**Permission naming:** Tauri auto-generates `default:allow-<command_name>` format. The `default:` prefix indicates app-specific (not plugin) permissions.

**Window targeting:** The `"windows": ["webxdc-*"]` glob in capabilities means only windows with labels starting with "webxdc-" can use these permissions. Main app window cannot call these commands.
