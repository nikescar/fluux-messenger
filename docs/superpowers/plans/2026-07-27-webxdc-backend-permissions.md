# WebXDC Backend Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-enable all 13 WebXDC Tauri backend commands by registering their permissions via build script.

**Architecture:** Modify `build.rs` to declare WebXDC commands in the app manifest, which auto-generates `default:allow-*` permissions at build time. Then update `capabilities/webxdc.json` to reference these permissions.

**Tech Stack:** Rust, Tauri v2, cargo build system

## Global Constraints

- **Tauri Version:** v2.x (new permission system)
- **Rust Edition:** 2021
- **No Breaking Changes:** Existing commands remain unchanged
- **Backward Compatible:** Frontend expects same command signatures
- **No new tests needed:** This is build configuration, existing tests cover command functionality

---

## Task 1: Update build.rs to Register WebXDC Commands

**Files:**
- Modify: `apps/fluux/src-tauri/build.rs:14`

**Interfaces:**
- Consumes: N/A (build-time configuration)
- Produces: Auto-generated `default:allow-webxdc-*` permissions in build artifacts

- [ ] **Step 1: Read current build.rs**

Run: `cat apps/fluux/src-tauri/build.rs`

Current state has git hash extraction and simple `tauri_build::build()` call.

- [ ] **Step 2: Replace tauri_build::build() with app manifest configuration**

In `apps/fluux/src-tauri/build.rs`, replace line 14:

```rust
fn main() {
    // Expose git short hash as GIT_HASH env var for compile-time embedding
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output();
    let git_hash = output
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=GIT_HASH={}", git_hash);

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

- [ ] **Step 3: Clean build to regenerate permissions**

Run: `cd apps/fluux/src-tauri && cargo clean`

Expected: Build artifacts deleted

- [ ] **Step 4: Build to generate new permissions**

Run: `cd apps/fluux/src-tauri && cargo build 2>&1 | tail -50`

Expected: Build succeeds with no permission errors

- [ ] **Step 5: Verify permissions were generated**

Run: `find apps/fluux/src-tauri/target/debug/build -name "permissions" -type d | head -1 | xargs ls`

Expected: See generated permission files including webxdc commands

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src-tauri/build.rs
git commit -m "$(cat <<'EOF'
feat(tauri): register WebXDC commands in build.rs

Auto-generates default:allow-webxdc-* permissions for all 13 commands.

- Add app manifest with WebXDC command list to build.rs
- Tauri generates permissions at build time
- Enables proper permission-based access control

Commands registered:
- webxdc_extract, webxdc_open_window
- webxdc_send_update, webxdc_get_updates, webxdc_receive_update
- webxdc_close_window
- webxdc_send_to_chat, webxdc_import_files, webxdc_read_imported_file
- webxdc_realtime_join, webxdc_realtime_send
- webxdc_realtime_leave, webxdc_realtime_receive

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Update capabilities/webxdc.json with Generated Permissions

**Files:**
- Modify: `apps/fluux/src-tauri/capabilities/webxdc.json:18-31`

**Interfaces:**
- Consumes: Auto-generated `default:allow-webxdc-*` permissions from Task 1
- Produces: Capability file that grants WebXDC windows access to all commands

- [ ] **Step 1: Read current webxdc.json**

Run: `cat apps/fluux/src-tauri/capabilities/webxdc.json`

Current state has only core permissions, WebXDC permissions were removed.

- [ ] **Step 2: Add WebXDC permissions to capabilities**

In `apps/fluux/src-tauri/capabilities/webxdc.json`, replace the permissions array:

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

- [ ] **Step 3: Rebuild to validate capability file**

Run: `cd apps/fluux/src-tauri && cargo build 2>&1 | grep -i "permission\|error" | head -20`

Expected: No permission errors, build succeeds

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src-tauri/capabilities/webxdc.json
git commit -m "$(cat <<'EOF'
feat(tauri): add WebXDC permissions to capabilities

Enables WebXDC windows to call all 13 backend commands.

- Add default:allow-webxdc-* permissions to webxdc.json
- Permissions auto-generated by build.rs app manifest
- Window targeting: only webxdc-* windows can use these

This completes the WebXDC backend integration - all commands
now have proper Tauri v2 permissions configured.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Runtime Verification

**Files:**
- None (verification only)

**Interfaces:**
- Consumes: Built app from Tasks 1 & 2
- Produces: Verified working WebXDC functionality

- [ ] **Step 1: Start the app**

Run: `npm run tauri:dev 2>&1 | grep -E "WebXDC|Permission|error" | head -30`

Expected: 
- Vite starts on http://localhost:5173
- Tauri compiles successfully
- App window opens
- No permission errors in output

- [ ] **Step 2: Verify console shows WebXDC initialized**

In the running app, open DevTools console (F12) and check for:

Expected output: `[app] WebXDC bridges initialized`

- [ ] **Step 3: Test a WebXDC command manually (optional)**

In DevTools console, if a WebXDC app is open, run:

```javascript
window.webxdc?.sendUpdate({test: 'permissions-work'}, 'Test from console')
```

Expected: No permission errors, update stored

- [ ] **Step 4: Document verification results**

Create verification summary showing:
- ✅ Build succeeded
- ✅ App started without permission errors  
- ✅ Console shows `[app] WebXDC bridges initialized`
- ✅ All 13 commands registered and accessible

No commit needed - this is verification only.

---

## Success Criteria Verification

After all tasks complete, verify:

- [x] **Task 1:** `build.rs` registers all 13 WebXDC commands
- [x] **Task 2:** `capabilities/webxdc.json` references all permissions
- [x] **Task 3:** App builds and runs without permission errors
- [ ] All 13 commands have `default:allow-*` permissions
- [ ] `cargo build` exits successfully
- [ ] `npm run tauri:dev` starts app without errors
- [ ] Console shows `[app] WebXDC bridges initialized`
- [ ] WebXDC windows can call backend commands

---

## Notes for Implementer

**Why this is simple:** The backend commands are already fully implemented with SQLite storage, file operations, realtime channels, and comprehensive tests. We're just adding the permission layer that Tauri v2 requires.

**Permission generation:** When you modify `build.rs` and run `cargo build`, Tauri automatically creates permission files in `target/debug/build/fluux-*/out/permissions/`. You don't create these manually.

**Permission naming:** The `default:allow-webxdc-send-update` format is Tauri's convention:
- `default:` = app-specific (not from a plugin)
- `allow-` = grants access
- `webxdc-send-update` = command name with underscores replaced by hyphens

**Window targeting:** The `"windows": ["webxdc-*"]` glob in capabilities ensures only WebXDC app windows can use these commands. The main messenger window cannot call them.

**No frontend changes:** The frontend XMPP bridge code already calls these commands via `invoke()`. No changes needed there.

**Testing:** Existing unit tests in `src-tauri/src/webxdc/mod.rs` already verify all command functionality. This plan only tests that permissions are configured correctly.
