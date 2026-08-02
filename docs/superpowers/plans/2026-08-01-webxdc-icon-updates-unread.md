# Webxdc Icon Extraction, Update-Message Hiding, and Unread Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract and display real webxdc app icons, stop `[WebXDC Update: ...]` compat messages from silently leaking into (and being inconsistently hidden from) the message window, and add per-app/aggregate unread badges for incoming webxdc updates.

**Architecture:** Three independent slices layered on the existing webxdc app panel (`webxdcPanelStore`, `WebxdcAttachment`, `WebxdcAppPanel`, `ChatHeader`/`RoomHeader`): (1) a Rust-side change to read icon bytes out of the already-open `.xdc` zip and base64-encode them, consumed unchanged by the existing `manifestCache`/`icon` field; (2) an SDK-side `isWebxdcUpdate` flag applied consistently by both the MAM archive parsers and the live `Chat.ts` stanza handler, filtered client-side by a new per-conversation toggle; (3) new `unreadCount` tracking in `webxdcPanelStore`, incremented via the existing `webxdc:update` SDK event and cleared on app open.

**Tech Stack:** Rust (`zip`, `base64`, `serde`) on the Tauri backend; TypeScript/React, Zustand, Vitest on the frontend; the `@fluux/sdk` package for XMPP stanza parsing.

## Global Constraints

- Follow TDD: write the failing test first, watch it fail, then implement.
- Commit after each task (not each step) unless a step says otherwise.
- No placeholders — every step below has real code.
- Match existing code style exactly (the surrounding file's patterns, not a personal preference).

---

### Task 1: Rust — extract real icon bytes from the `.xdc` zip

**Files:**
- Modify: `apps/fluux/src-tauri/src/webxdc/extraction.rs`

**Interfaces:**
- Produces: `extract_manifest_only(url, filename, decrypt) -> Result<WebxdcManifest, ExtractionError>` now returns `WebxdcManifest.icon` as a `data:<mime>;base64,<...>` URI (previously the raw manifest.toml path string). No signature change — `ManifestData.icon` in `mod.rs` is unaffected structurally.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block at the bottom of `extraction.rs` (after the existing `test_parse_manifest_graceful_fallback` test). These need a helper that builds an in-memory `.xdc` zip:

```rust
    fn build_test_xdc(manifest_toml: &str, icon: Option<(&str, &[u8])>) -> Vec<u8> {
        use std::io::Write;
        use zip::write::FileOptions;

        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = FileOptions::default();

        zip.start_file("manifest.toml", options).unwrap();
        zip.write_all(manifest_toml.as_bytes()).unwrap();

        if let Some((name, bytes)) = icon {
            zip.start_file(name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }

        zip.finish().unwrap().into_inner()
    }

    fn manifest_from_bytes(zip_bytes: Vec<u8>, filename: &str) -> WebxdcManifest {
        let cursor = std::io::Cursor::new(zip_bytes);
        let mut archive = ZipArchive::new(cursor).unwrap();

        let mut manifest_content = String::new();
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).unwrap();
            if file.name() == "manifest.toml" {
                file.read_to_string(&mut manifest_content).unwrap();
                break;
            }
        }

        let mut manifest = parse_manifest(&manifest_content, filename);
        if let Some(icon_path) = manifest.icon.clone() {
            manifest.icon = extract_icon_data_uri(&mut archive, &icon_path);
        }
        manifest
    }

    #[test]
    fn test_icon_extracted_as_data_uri() {
        let png_bytes: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]; // PNG magic bytes
        let zip_bytes = build_test_xdc(
            "name = \"Tic Tac Toe\"\nicon = \"icon.png\"\n",
            Some(("icon.png", png_bytes)),
        );

        let manifest = manifest_from_bytes(zip_bytes, "app.xdc");

        assert_eq!(manifest.name, "Tic Tac Toe");
        let icon = manifest.icon.expect("icon should be extracted");
        assert!(icon.starts_with("data:image/png;base64,"));
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(icon.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        assert_eq!(decoded, png_bytes);
    }

    #[test]
    fn test_icon_none_when_manifest_has_no_icon_field() {
        let zip_bytes = build_test_xdc("name = \"No Icon App\"\n", None);
        let manifest = manifest_from_bytes(zip_bytes, "app.xdc");

        assert_eq!(manifest.name, "No Icon App");
        assert!(manifest.icon.is_none());
    }

    #[test]
    fn test_icon_none_when_path_missing_from_zip() {
        let zip_bytes = build_test_xdc(
            "name = \"Broken Icon\"\nicon = \"missing.png\"\n",
            None, // manifest references icon.png but it's never added to the zip
        );
        let manifest = manifest_from_bytes(zip_bytes, "app.xdc");

        assert_eq!(manifest.name, "Broken Icon");
        assert!(manifest.icon.is_none());
    }

    #[test]
    fn test_icon_none_when_file_exceeds_size_limit() {
        let oversized = vec![0u8; (MAX_ICON_SIZE + 1) as usize];
        let zip_bytes = build_test_xdc(
            "name = \"Huge Icon\"\nicon = \"icon.png\"\n",
            Some(("icon.png", &oversized)),
        );
        let manifest = manifest_from_bytes(zip_bytes, "app.xdc");

        assert!(manifest.icon.is_none());
    }

    #[test]
    fn test_icon_mime_type_by_extension() {
        assert_eq!(icon_mime_type("icon.png"), "image/png");
        assert_eq!(icon_mime_type("icon.jpg"), "image/jpeg");
        assert_eq!(icon_mime_type("icon.jpeg"), "image/jpeg");
        assert_eq!(icon_mime_type("icon.svg"), "image/svg+xml");
        assert_eq!(icon_mime_type("icon.weird"), "application/octet-stream");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux/src-tauri && cargo test --lib webxdc::extraction::tests::test_icon -- --nocapture`
Expected: FAIL — `extract_icon_data_uri`, `icon_mime_type`, and `MAX_ICON_SIZE` are not defined yet.

- [ ] **Step 3: Implement icon extraction**

In `extraction.rs`, add the constant near the top (after `MAX_FILE_COUNT`):

```rust
const MAX_ICON_SIZE: u64 = 512 * 1024; // 512 KB — webxdc icons are small; anything larger is treated as absent.
```

Add these two functions right after `parse_manifest`:

```rust
fn icon_mime_type(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

/// Read the icon file referenced by `icon_path` out of `archive` and return it
/// as a base64 `data:` URI. Returns `None` (never an error) on any failure —
/// missing file, oversized, or unreadable — so a broken icon never blocks
/// manifest extraction.
fn extract_icon_data_uri<R: std::io::Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    icon_path: &str,
) -> Option<String> {
    let mut file = archive.by_name(icon_path).ok()?;

    if file.size() > MAX_ICON_SIZE {
        return None;
    }

    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut bytes).ok()?;

    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", icon_mime_type(icon_path), encoded))
}
```

Update `extract_manifest_only` to call it:

```rust
pub async fn extract_manifest_only(
    url: &str,
    filename: &str,
    decrypt: Option<([u8; 32], [u8; 12])>,
) -> Result<WebxdcManifest, ExtractionError> {
    // Download file
    let bytes = download_file(url, decrypt).await?;

    // Unzip in memory
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)
        .map_err(|e| ExtractionError::InvalidZip(e.to_string()))?;

    // Look for manifest.toml
    let mut manifest_content = String::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| ExtractionError::InvalidZip(e.to_string()))?;

        if file.name() == "manifest.toml" {
            file.read_to_string(&mut manifest_content)
                .map_err(|e| ExtractionError::InvalidZip(e.to_string()))?;
            break;
        }
    }

    // Parse manifest (fallback to filename if missing/invalid)
    let mut manifest = parse_manifest(&manifest_content, filename);

    // manifest.icon (if present) is a path *inside the zip* per the webxdc spec —
    // resolve it to actual image bytes so the frontend can render <img src=...>
    // directly instead of just knowing a filename.
    if let Some(icon_path) = manifest.icon.clone() {
        manifest.icon = extract_icon_data_uri(&mut archive, &icon_path);
    }

    Ok(manifest)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux/src-tauri && cargo test --lib webxdc::extraction::tests -- --nocapture`
Expected: PASS — all existing extraction tests plus the 5 new icon tests.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src-tauri/src/webxdc/extraction.rs
git commit -m "feat(webxdc): extract real icon bytes from .xdc manifest as data URI"
```

---

### Task 2: Frontend — render the real icon on the attachment bubble

**Files:**
- Modify: `apps/fluux/src/components/WebxdcAttachment.tsx`
- Modify: `apps/fluux/src/components/WebxdcAttachment.test.tsx`

**Interfaces:**
- Consumes: `manifestCache.get(attachment.url)?.icon` — already a `string | undefined` on `ManifestCacheEntry` (`apps/fluux/src/stores/webxdcPanelStore.ts:20-25`); now holds a `data:` URI instead of a path string (Task 1), no store change needed.

- [ ] **Step 1: Write the failing test**

Add to `WebxdcAttachment.test.tsx`, inside the `describe('WebxdcAttachment', ...)` block:

```tsx
  it('renders the manifest icon as an image when cached', async () => {
    const { useWebxdcPanelStore } = await import('@/stores/webxdcPanelStore')
    useWebxdcPanelStore.getState().cacheManifest('https://example.com/app.xdc', {
      name: 'Tic Tac Toe',
      icon: 'data:image/png;base64,iVBORw0KGgo=',
      sha256: 'abc',
    })

    render(<WebxdcAttachment attachment={makeAttachment()} conversationId="alice@example.com" />)

    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=')
  })

  it('falls back to the placeholder icon when no manifest icon is cached', () => {
    render(<WebxdcAttachment attachment={makeAttachment()} conversationId="alice@example.com" />)

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
```

Add a `beforeEach` reset alongside the existing `vi.clearAllMocks()` so the manifest cache doesn't leak between tests — modify the existing `beforeEach`:

```tsx
  beforeEach(async () => {
    vi.clearAllMocks()
    const { useWebxdcPanelStore } = await import('@/stores/webxdcPanelStore')
    useWebxdcPanelStore.setState({ manifestCache: new Map(), installations: new Map() })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/WebxdcAttachment.test.tsx`
Expected: FAIL — `getByRole('img')` finds no element (still rendering the `Package` icon).

- [ ] **Step 3: Implement the icon rendering**

In `WebxdcAttachment.tsx`, replace the icon slot (currently lines 131-137):

```tsx
        <div className="size-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-purple-500/20 text-purple-500">
          {busy || extracting ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Package className="size-5" />
          )}
        </div>
```

with:

```tsx
        <div className="size-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-purple-500/20 text-purple-500 overflow-hidden">
          {busy || extracting ? (
            <Loader2 className="size-5 animate-spin" />
          ) : cached?.icon && !iconError ? (
            <img
              src={cached.icon}
              alt=""
              className="size-full object-cover"
              onError={() => setIconError(true)}
            />
          ) : (
            <Package className="size-5" />
          )}
        </div>
```

Add the state near the top of the component, alongside the existing `useState` calls:

```tsx
  const [iconError, setIconError] = useState(false)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/WebxdcAttachment.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/WebxdcAttachment.tsx apps/fluux/src/components/WebxdcAttachment.test.tsx
git commit -m "feat(webxdc): render real app icon on the attachment bubble"
```

---

### Task 3: Frontend — render the real icon in the app panel, add `WebxdcAppPanel.test.tsx`

**Files:**
- Modify: `apps/fluux/src/components/WebxdcAppPanel.tsx`
- Create: `apps/fluux/src/components/WebxdcAppPanel.test.tsx`

**Interfaces:**
- Consumes: `WebxdcAppGroup.icon` (already `string | undefined`, `apps/fluux/src/stores/webxdcPanelStore.ts:5-9`).

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/WebxdcAppPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WebxdcAppPanel } from './WebxdcAppPanel'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'
import type { FileAttachment } from '@fluux/sdk'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: string) => d ?? k }) }))
vi.mock('@/utils/webxdc/webxdcWindow', () => ({ openWebxdcWindow: vi.fn().mockResolvedValue(undefined) }))

function makeAttachment(url: string): FileAttachment {
  return { url, name: 'app.xdc', mediaType: 'application/webxdc+zip', size: 1024 }
}

describe('WebxdcAppPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    useWebxdcPanelStore.setState({ manifestCache: new Map(), installations: new Map() })
  })

  it('renders the app group icon as an image when set', () => {
    useWebxdcPanelStore.getState().cacheManifest('https://example.com/app.xdc', {
      name: 'Tic Tac Toe',
      icon: 'data:image/png;base64,iVBORw0KGgo=',
      sha256: 'abc',
    })
    useWebxdcPanelStore.getState().installApp('room@conference.example.com', 'instance-1', makeAttachment('https://example.com/app.xdc'))

    render(<WebxdcAppPanel conversationId="room@conference.example.com" onClose={vi.fn()} />)

    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=')
  })

  it('falls back to the placeholder icon when the app has no icon', () => {
    useWebxdcPanelStore.getState().installApp('room@conference.example.com', 'instance-1', makeAttachment('https://example.com/app.xdc'))

    render(<WebxdcAppPanel conversationId="room@conference.example.com" onClose={vi.fn()} />)

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/WebxdcAppPanel.test.tsx`
Expected: FAIL — first test finds no `img` element (still rendering static `PackageIcon`).

- [ ] **Step 3: Implement the icon rendering**

In `WebxdcAppPanel.tsx`, replace the icon slot in `AppGroupItem` (currently lines 144-147):

```tsx
        {/* App icon */}
        <div className="size-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-purple-500/20 text-purple-500">
          <PackageIcon className="size-5" />
        </div>
```

with:

```tsx
        {/* App icon */}
        <div className="relative size-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-purple-500/20 text-purple-500 overflow-hidden">
          {group.icon && !iconError ? (
            <img
              src={group.icon}
              alt=""
              className="size-full object-cover"
              onError={() => setIconError(true)}
            />
          ) : (
            <PackageIcon className="size-5" />
          )}
        </div>
```

Add the state inside `AppGroupItem`, alongside the existing `const [menuOpen, setMenuOpen] = useState(false)`:

```tsx
  const [iconError, setIconError] = useState(false)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/WebxdcAppPanel.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/WebxdcAppPanel.tsx apps/fluux/src/components/WebxdcAppPanel.test.tsx
git commit -m "feat(webxdc): render real app icon in the Webxdc Apps panel"
```

---

### Task 4: SDK — add `isWebxdcUpdate` to `BaseMessage`

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/message-base.ts`

**Interfaces:**
- Produces: `BaseMessage.isWebxdcUpdate?: boolean`, inherited by both `Message` and `RoomMessage`. Consumed by Tasks 5, 6, 9.

- [ ] **Step 1: Add the field**

In `message-base.ts`, add to the end of the `BaseMessage` interface (after the `unsupportedEncryption` field, before the closing `}`):

```ts
  /**
   * True when this message was derived from a stanza carrying
   * `<x xmlns="urn:xmpp:webxdc:0">` with `<instance>`/`<json>` children (a
   * persisted webxdc update). Its `body` is the human-readable compat
   * fallback (`[WebXDC Update: ...]`) sent for non-webxdc-aware clients.
   * The UI uses this to let users hide these messages per-conversation.
   */
  isWebxdcUpdate?: boolean
```

This is a type-only change with no test file of its own — it's exercised by Tasks 5 and 6's tests.

- [ ] **Step 2: Verify the SDK still typechecks**

Run: `cd packages/fluux-sdk && npx tsc --noEmit`
Expected: PASS (no errors — this is a purely additive optional field).

- [ ] **Step 3: Commit**

```bash
git add packages/fluux-sdk/src/core/types/message-base.ts
git commit -m "feat(sdk): add isWebxdcUpdate flag to BaseMessage"
```

---

### Task 5: SDK — flag `isWebxdcUpdate` in MAM archive parsing

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts`
- Create: `packages/fluux-sdk/src/core/modules/MAM.webxdc.test.ts`

**Interfaces:**
- Consumes: `NS_WEBXDC` from `../namespaces` (`= 'urn:xmpp:webxdc:0'`), `isWebxdcUpdate` from Task 4.
- Produces: `parseArchiveMessage`/`parseRoomArchiveMessage` (both private methods on `MAM`) now set `isWebxdcUpdate: true` on their returned `Message`/`RoomMessage` when the archived stanza carries `<x xmlns="urn:xmpp:webxdc:0">`.

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/core/modules/MAM.webxdc.test.ts`. This drives the private parsers the same way `Chat.webxdc.test.ts` drives `Chat`'s private handler — via a public entry point. `MAM`'s archive parsers are exercised through `handleMAMResult` (the IQ-result handler); the simplest reliable route is to call the private parser methods directly via `(mam as any)`, matching the `(chat as any).handleMessage(stanza)` pattern already used elsewhere:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { xml } from '@xmpp/client'
import { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { NS_WEBXDC } from '../namespaces'

describe('MAM webxdc update detection', () => {
  let mam: MAM
  let mockDeps: ModuleDependencies

  beforeEach(() => {
    mockDeps = {
      sendStanza: vi.fn(),
      emitSDK: vi.fn(),
      emit: vi.fn(),
      stores: {} as any,
      getE2EEManager: vi.fn().mockReturnValue(null),
      getCurrentJid: vi.fn().mockReturnValue('me@example.com'),
    }
    mam = new MAM(mockDeps)
  })

  function forwardedWith(messageEl: ReturnType<typeof xml>) {
    return xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, messageEl)
  }

  it('flags a 1:1 archived webxdc update message', () => {
    const messageEl = xml('message', { from: 'alice@example.com', type: 'chat' },
      xml('body', {}, '[WebXDC Update: Alice moved]'),
      xml('x', { xmlns: NS_WEBXDC },
        xml('instance', {}, 'conv1:https://example.com/app.xdc'),
        xml('serial', {}, '1'),
        xml('payload', {}, '{}')
      )
    )

    const message = (mam as any).parseArchiveMessage(forwardedWith(messageEl), 'alice@example.com')

    expect(message).not.toBeNull()
    expect(message.isWebxdcUpdate).toBe(true)
    expect(message.body).toBe('[WebXDC Update: Alice moved]')
  })

  it('does not flag an ordinary 1:1 archived message', () => {
    const messageEl = xml('message', { from: 'alice@example.com', type: 'chat' },
      xml('body', {}, 'Hello there')
    )

    const message = (mam as any).parseArchiveMessage(forwardedWith(messageEl), 'alice@example.com')

    expect(message).not.toBeNull()
    expect(message.isWebxdcUpdate).toBeUndefined()
  })

  it('flags a room archived webxdc update message', () => {
    const messageEl = xml('message', { from: 'room@conference.example.com/nikescar', type: 'groupchat' },
      xml('body', {}, "[WebXDC Update: nikescar added an item to '🛒 Shopping List']"),
      xml('x', { xmlns: NS_WEBXDC },
        xml('instance', {}, 'room1:https://example.com/list.xdc'),
        xml('serial', {}, '3'),
        xml('payload', {}, '{}')
      )
    )

    const message = (mam as any).parseRoomArchiveMessage(forwardedWith(messageEl), 'room@conference.example.com', 'nikescar')

    expect(message).not.toBeNull()
    expect(message.isWebxdcUpdate).toBe(true)
  })

  it('does not flag an ordinary room archived message', () => {
    const messageEl = xml('message', { from: 'room@conference.example.com/nikescar', type: 'groupchat' },
      xml('body', {}, 'Hello room')
    )

    const message = (mam as any).parseRoomArchiveMessage(forwardedWith(messageEl), 'room@conference.example.com', 'nikescar')

    expect(message).not.toBeNull()
    expect(message.isWebxdcUpdate).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MAM.webxdc.test.ts`
Expected: FAIL — `message.isWebxdcUpdate` is `undefined` on the webxdc-update test cases (currently nothing sets it).

- [ ] **Step 3: Implement the flag**

In `MAM.ts`, add `NS_WEBXDC` to the existing namespaces import (currently lines 61-71):

```ts
import {
  NS_MAM,
  NS_RSM,
  NS_DATA_FORMS,
  NS_FORWARD,
  NS_DELAY,
  NS_FASTEN,
  NS_OOB,
  NS_OCCUPANT_ID,
  NS_POLL,
  NS_WEBXDC,
} from '../namespaces'
```

In `parseArchiveMessage`, right before the `return { type: 'chat', ... }` object literal, add:

```ts
    const isWebxdcUpdate = !!messageEl.getChild('x', NS_WEBXDC)
```

Then add `...(isWebxdcUpdate && { isWebxdcUpdate: true }),` to the returned object (alongside the other `...(x && {...})` spreads, e.g. right after `...(unsupportedEncryption && { unsupportedEncryption }),`).

Do the same in `parseRoomArchiveMessage`: add `const isWebxdcUpdate = !!messageEl.getChild('x', NS_WEBXDC)` before its `return { type: 'groupchat', ... }`, and add `...(isWebxdcUpdate && { isWebxdcUpdate: true }),` to that returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MAM.webxdc.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full MAM test suite to check for regressions**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MAM`
Expected: PASS — all existing `MAM.*.test.ts` files unaffected (purely additive field).

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/MAM.ts packages/fluux-sdk/src/core/modules/MAM.webxdc.test.ts
git commit -m "feat(sdk): flag archived webxdc update messages with isWebxdcUpdate"
```

---

### Task 6: SDK — flag `isWebxdcUpdate` in the live Chat.ts path, consistently with MAM

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts`
- Modify: `packages/fluux-sdk/src/core/modules/Chat.webxdc.test.ts`

**Interfaces:**
- Consumes: `processChatMessage`/`processRoomMessage` (existing private methods, unchanged signatures), `isWebxdcUpdate` from Task 4.
- Produces: a live persisted webxdc-update stanza now also results in `this.deps.emit('message', <Message|RoomMessage with isWebxdcUpdate: true>)`, in addition to the existing `emitSDK('webxdc:update', ...)`. The ephemeral realtime (`<data>`) path is unchanged — it still never emits a message.

**Root cause recap:** today, `handleMessageInternal`'s `webxdcElement` branch sits *before* `type`/`hasMucUserElement`/`bareFrom` are computed further down the function, and unconditionally returns `{ handled: true }` for persisted updates without ever calling `processChatMessage`/`processRoomMessage`. This task splits that branch: the realtime (`<data>`) case stays exactly where it is (it never needed a message); the persisted-update case (`<instance>`/`<json>`) moves to just before the "Process actual message" block, where `type`/`bareFrom`/`body` are already resolved, so it can reuse the same message-construction path as ordinary messages.

- [ ] **Step 1: Write the failing tests**

Add to `Chat.webxdc.test.ts`, inside the existing `describe('Chat WebXDC stanza handling', ...)` block (after the last existing test, before the closing `})`):

```ts
  describe('isWebxdcUpdate message emission (live path)', () => {
    it('emits a Message with isWebxdcUpdate for a 1:1 persisted update with a body', () => {
      const stanza = xml('message', {
        from: 'alice@example.com',
        to: 'me@example.com',
        type: 'chat'
      },
        xml('body', {}, '[WebXDC Update: Alice moved]'),
        xml('x', { xmlns: NS_WEBXDC },
          xml('instance', {}, 'conv1:https://example.com/app.xdc'),
          xml('serial', {}, '1'),
          xml('payload', {}, '{}')
        )
      )

      const handled = (chat as any).handleMessage(stanza)

      expect(handled).toBe(true)
      expect(mockDeps.emitSDK).toHaveBeenCalledWith('webxdc:update', expect.objectContaining({
        instance: 'conv1:https://example.com/app.xdc',
      }))
      expect(mockDeps.emit).toHaveBeenCalledWith('message', expect.objectContaining({
        type: 'chat',
        body: '[WebXDC Update: Alice moved]',
        isWebxdcUpdate: true,
      }))
    })

    it('emits a RoomMessage with isWebxdcUpdate for a groupchat persisted update with a body', () => {
      mockDeps.stores = {
        room: {
          getRoom: vi.fn().mockReturnValue({ jid: 'room@conference.example.com', nickname: 'me' }),
        },
      } as any

      const stanza = xml('message', {
        from: 'room@conference.example.com/nikescar',
        type: 'groupchat'
      },
        xml('body', {}, "[WebXDC Update: nikescar added an item to '🛒 Shopping List']"),
        xml('x', { xmlns: NS_WEBXDC },
          xml('instance', {}, 'room1:https://example.com/list.xdc'),
          xml('serial', {}, '3'),
          xml('payload', {}, '{}')
        )
      )

      const handled = (chat as any).handleMessage(stanza)

      expect(handled).toBe(true)
      expect(mockDeps.emit).toHaveBeenCalledWith('message', expect.objectContaining({
        type: 'groupchat',
        isWebxdcUpdate: true,
      }))
    })

    it('does not emit a message for a persisted update with no body', () => {
      const stanza = xml('message', { from: 'alice@example.com', type: 'chat' },
        xml('x', { xmlns: NS_WEBXDC },
          xml('instance', {}, 'test-instance'),
          xml('serial', {}, '1'),
          xml('payload', {}, '{}')
        )
      )

      const handled = (chat as any).handleMessage(stanza)

      expect(handled).toBe(true)
      expect(mockDeps.emit).not.toHaveBeenCalled()
    })

    it('still emits no message for a realtime (data) frame', () => {
      const stanza = xml('message', { from: 'alice@example.com', type: 'chat' },
        xml('x', { xmlns: NS_WEBXDC }, xml('data', {}, 'ZGF0YQ==')),
        xml('thread', {}, 'thread-abc')
      )

      const handled = (chat as any).handleMessage(stanza)

      expect(handled).toBe(true)
      expect(mockDeps.emit).not.toHaveBeenCalled()
      expect(mockDeps.emitSDK).toHaveBeenCalledWith('webxdc:realtime', expect.anything())
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.webxdc.test.ts`
Expected: FAIL — the first two new tests fail because `mockDeps.emit` is never called today (the persisted-update branch returns before reaching any message construction).

- [ ] **Step 3: Refactor Chat.ts**

Replace the entire existing `webxdcElement` block. The exact current text (verify with `grep -n "XEP-0491 / Cheogram-compatible WebXDC" packages/fluux-sdk/src/core/modules/Chat.ts` — it starts at line 219 and its closing brace is line 324):

```ts
    // XEP-0491 / Cheogram-compatible WebXDC: both persisted updates and
    // ephemeral realtime frames share the `urn:xmpp:webxdc:0` namespace on
    // <x>, distinguished by a <data> child (realtime) vs <instance>/<serial>/
    // <payload> children (update). Both may carry a sibling <thread> used to
    // correlate them to a specific webxdc app instance.
    const webxdcElement = stanza.getChild('x', NS_WEBXDC)
    if (webxdcElement) {
      const from = stanza.attrs.from
      const bareFrom = from ? getBareJid(from) : undefined
      const threadText = stanza.getChildText('thread') || undefined

      const dataElement = webxdcElement.getChild('data')
      if (dataElement) {
        // Ephemeral realtime frame: no chat bubble, no persistence.
        if (bareFrom) {
          this.deps.emitSDK('webxdc:realtime', {
            from: bareFrom,
            thread: threadText,
            data: webxdcElement.getChildText('data') || ''
          })
        }
        return { handled: true }
      }

      if (bareFrom) {
        // Detect wire format: Fluux uses <instance>/<serial>/<payload>,
        // Cheogram uses <json xmlns="urn:xmpp:json:0"> with thread-based correlation.
        const instanceElement = webxdcElement.getChild('instance')
        const jsonElement = webxdcElement.getChild('json', 'urn:xmpp:json:0')

        let instanceId = ''
        let serial = 0
        let payload: unknown = {}
        let isCheogramFormat = false

        if (instanceElement) {
          // Fluux format
          instanceId = webxdcElement.getChildText('instance') || ''
          const serialText = webxdcElement.getChildText('serial') || '0'
          const payloadText = webxdcElement.getChildText('payload') || '{}'

          serial = parseInt(serialText, 10)
          try {
            payload = JSON.parse(payloadText)
          } catch (err) {
            console.warn('[Chat] Failed to parse WebXDC payload:', err)
          }
          console.log('[Chat] Parsed Fluux-format WebXDC update:', { instanceId, serial, thread: threadText })
        } else if (jsonElement && threadText) {
          // Cheogram format: <json> + <thread> + serial in <summary>
          isCheogramFormat = true
          instanceId = '' // Will be resolved via thread→instance lookup in Rust
          const payloadText = jsonElement.getText() || '{}'

          try {
            payload = JSON.parse(payloadText)
          } catch (err) {
            console.warn('[Chat] Failed to parse Cheogram WebXDC JSON payload:', err)
          }

          // Extract serial from <summary> text: "... (N/M)" → serial=N
          // Cheogram sometimes sends game status text instead, so serial may be 0
          const summaryText = webxdcElement.getChildText('summary') || ''
          const match = summaryText.match(/\((\d+)\/\d+\)/)
          serial = match ? parseInt(match[1], 10) : 0

          // Try to extract serial from payload if summary pattern fails
          if (serial === 0 && typeof payload === 'object' && payload !== null) {
            const payloadObj = payload as any
            // Cheogram sometimes includes serial in payload.serial
            if (typeof payloadObj.serial === 'number') {
              serial = payloadObj.serial
            }
          }

          console.log('[Chat] Parsed Cheogram-format WebXDC update:', { thread: threadText, serial, summary: summaryText, payloadKeys: typeof payload === 'object' && payload !== null ? Object.keys(payload) : [] })
        } else {
          console.warn('[Chat] WebXDC update missing required elements:', {
            hasInstance: !!instanceElement,
            hasJson: !!jsonElement,
            hasThread: !!threadText,
            from: bareFrom
          })
        }

        const updateEvent = {
          from: bareFrom,
          instance: instanceId,
          serial,
          payload,
          info: webxdcElement.getChildText('info') || undefined,
          document: webxdcElement.getChildText('document') || undefined,
          summary: webxdcElement.getChildText('summary') || undefined,
          sender: from || bareFrom,
          thread: threadText,
          isCheogramFormat
        }
        console.log('[Chat] Emitting webxdc:update event:', {
          isCheogramFormat: updateEvent.isCheogramFormat,
          hasInstance: !!updateEvent.instance,
          hasThread: !!updateEvent.thread,
          serial: updateEvent.serial
        })
        this.deps.emitSDK('webxdc:update', updateEvent)
      }
      return { handled: true }
    }
```

with (keeps only the realtime early-return; the persisted-update case is handled later):

```ts
    // XEP-0491 / Cheogram-compatible WebXDC realtime frame: shares the
    // `urn:xmpp:webxdc:0` namespace with persisted updates but carries a
    // <data> child instead of <instance>/<serial>/<payload>. Ephemeral —
    // no chat bubble, no persistence, handled here (before type/bareFrom
    // classification) since it never needs either. The persisted-update
    // case (same <x> element, no <data> child) is handled further below,
    // after type/bareFrom are resolved, so it can reuse the same
    // processChatMessage/processRoomMessage construction as an ordinary
    // message (see the "Process actual message" section).
    const webxdcElement = stanza.getChild('x', NS_WEBXDC)
    const webxdcRealtimeElement = webxdcElement?.getChild('data')
    if (webxdcElement && webxdcRealtimeElement) {
      const rtFrom = stanza.attrs.from
      const rtBareFrom = rtFrom ? getBareJid(rtFrom) : undefined
      const rtThreadText = stanza.getChildText('thread') || undefined
      if (rtBareFrom) {
        this.deps.emitSDK('webxdc:realtime', {
          from: rtBareFrom,
          thread: rtThreadText,
          data: webxdcElement.getChildText('data') || ''
        })
      }
      return { handled: true }
    }
```

Now insert the persisted-update handling just before the `// Process actual message` comment (currently line 515 — verify with `grep -n "// Process actual message" packages/fluux-sdk/src/core/modules/Chat.ts`), i.e. right after the MUC-subject-changes block and before the `if (body || stanza.getChild('x', NS_OOB) ...)` gate:

```ts
    // XEP-0491 / Cheogram-compatible WebXDC persisted update. type/bareFrom/body
    // are resolved by this point, so this reuses the same processChatMessage/
    // processRoomMessage construction an ordinary message would — tagged
    // isWebxdcUpdate so the UI can filter it. Still emits webxdc:update for the
    // functional update-sync bridge regardless of whether a body is present.
    if (webxdcElement) {
      const threadText = stanza.getChildText('thread') || undefined
      const instanceElement = webxdcElement.getChild('instance')
      const jsonElement = webxdcElement.getChild('json', 'urn:xmpp:json:0')

      let instanceId = ''
      let serial = 0
      let payload: unknown = {}
      let isCheogramFormat = false

      if (instanceElement) {
        instanceId = webxdcElement.getChildText('instance') || ''
        const serialText = webxdcElement.getChildText('serial') || '0'
        const payloadText = webxdcElement.getChildText('payload') || '{}'
        serial = parseInt(serialText, 10)
        try {
          payload = JSON.parse(payloadText)
        } catch (err) {
          console.warn('[Chat] Failed to parse WebXDC payload:', err)
        }
      } else if (jsonElement && threadText) {
        isCheogramFormat = true
        instanceId = ''
        const payloadText = jsonElement.getText() || '{}'
        try {
          payload = JSON.parse(payloadText)
        } catch (err) {
          console.warn('[Chat] Failed to parse Cheogram WebXDC JSON payload:', err)
        }
        const summaryText = webxdcElement.getChildText('summary') || ''
        const match = summaryText.match(/\((\d+)\/\d+\)/)
        serial = match ? parseInt(match[1], 10) : 0
        if (serial === 0 && typeof payload === 'object' && payload !== null) {
          const payloadObj = payload as any
          if (typeof payloadObj.serial === 'number') {
            serial = payloadObj.serial
          }
        }
      } else {
        console.warn('[Chat] WebXDC update missing required elements:', {
          hasInstance: !!instanceElement,
          hasJson: !!jsonElement,
          hasThread: !!threadText,
          from: bareFrom
        })
      }

      const updateEvent = {
        from: bareFrom,
        instance: instanceId,
        serial,
        payload,
        info: webxdcElement.getChildText('info') || undefined,
        document: webxdcElement.getChildText('document') || undefined,
        summary: webxdcElement.getChildText('summary') || undefined,
        sender: from || bareFrom,
        thread: threadText,
        isCheogramFormat
      }
      this.deps.emitSDK('webxdc:update', updateEvent)

      if (body) {
        let updateMessage: Message | RoomMessage | null
        if (type === 'groupchat') {
          updateMessage = this.processRoomMessage(stanza, from!, bareFrom, body, isCarbonCopy, isSentCarbon)
        } else {
          updateMessage = this.processChatMessage(stanza, from!, bareFrom, bareTo, body, isCarbonCopy, isSentCarbon)
        }
        if (updateMessage) {
          updateMessage.isWebxdcUpdate = true
          if (!isSentCarbon) {
            this.deps.emit('message', updateMessage as Message)
          }
          return { handled: true, message: updateMessage }
        }
      }
      return { handled: true }
    }

```

(Leave the following `// Process actual message` block exactly as-is — it now never runs for webxdc stanzas, since this new block always returns.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.webxdc.test.ts`
Expected: PASS — all new and pre-existing tests in this file.

- [ ] **Step 5: Run the full Chat test suite to check for regressions**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat`
Expected: PASS — no other `Chat.*.test.ts` file touches the webxdc branch, so unaffected.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.webxdc.test.ts
git commit -m "feat(sdk): emit isWebxdcUpdate message for live persisted webxdc updates"
```

---

### Task 7: Frontend store — `hideUpdateMessages` per-conversation toggle

**Files:**
- Modify: `apps/fluux/src/stores/webxdcPanelStore.ts`
- Modify: `apps/fluux/src/stores/webxdcPanelStore.test.ts`

**Interfaces:**
- Produces: `setHideUpdateMessages(conversationId: string, hide: boolean): void`, `getHideUpdateMessages(conversationId: string): boolean` (default `false`) on `useWebxdcPanelStore`. Consumed by Task 8 (checkbox) and Task 9 (message-list filter).

- [ ] **Step 1: Write the failing tests**

Add to `webxdcPanelStore.test.ts`, as a new `describe` block (after the existing `describe('cacheManifest', ...)` block, following the same style):

```ts
  describe('hideUpdateMessages', () => {
    it('defaults to false for a conversation with no installations', () => {
      const { getHideUpdateMessages } = useWebxdcPanelStore.getState()
      expect(getHideUpdateMessages('room@conference.example.com')).toBe(false)
    })

    it('sets and reads back the toggle for a conversation', () => {
      const { setHideUpdateMessages, getHideUpdateMessages } = useWebxdcPanelStore.getState()

      setHideUpdateMessages('room@conference.example.com', true)

      expect(useWebxdcPanelStore.getState().getHideUpdateMessages('room@conference.example.com')).toBe(true)
    })

    it('does not affect other conversations', () => {
      const { setHideUpdateMessages, getHideUpdateMessages } = useWebxdcPanelStore.getState()

      setHideUpdateMessages('room@conference.example.com', true)

      expect(getHideUpdateMessages('other@conference.example.com')).toBe(false)
    })

    it('persists to localStorage', () => {
      const { setHideUpdateMessages } = useWebxdcPanelStore.getState()

      setHideUpdateMessages('room@conference.example.com', true)

      const stored = JSON.parse(localStorage.getItem('webxdc-installations')!)
      const [, convData] = stored.find(([id]: [string, unknown]) => id === 'room@conference.example.com')
      expect(convData.hideUpdateMessages).toBe(true)
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/stores/webxdcPanelStore.test.ts`
Expected: FAIL — `setHideUpdateMessages`/`getHideUpdateMessages` don't exist yet.

- [ ] **Step 3: Implement the store changes**

In `webxdcPanelStore.ts`, add the field to `ConversationInstallations` (currently lines 27-30):

```ts
interface ConversationInstallations {
  apps: Map<string, WebxdcAppGroup>
  panelOpen: boolean
  hideUpdateMessages: boolean
}
```

Add the two methods to the `WebxdcPanelStore` interface (after `removeConversation`):

```ts
  setHideUpdateMessages: (conversationId: string, hide: boolean) => void
  getHideUpdateMessages: (conversationId: string) => boolean
```

In `loadInstallations`, the deserialization destructures `{ apps, panelOpen }` — update it to also carry `hideUpdateMessages` through, defaulting old/missing entries to `false`:

```ts
function loadInstallations(): Map<string, ConversationInstallations> {
  try {
    const stored = localStorage.getItem(INSTALLATIONS_KEY)
    if (!stored) return new Map()

    const data: [string, { apps: [string, WebxdcAppGroup][]; panelOpen: boolean; hideUpdateMessages?: boolean }][] = JSON.parse(stored)

    return new Map(
      data.map(([convId, { apps, panelOpen, hideUpdateMessages }]) => [
        convId,
        {
          apps: new Map(apps),
          panelOpen,
          hideUpdateMessages: hideUpdateMessages ?? false,
        },
      ])
    )
  } catch {
    return new Map()
  }
}
```

In `saveInstallations`, include the field in the serialized shape:

```ts
function saveInstallations(installations: Map<string, ConversationInstallations>) {
  try {
    const data = Array.from(installations.entries()).map(([convId, { apps, panelOpen, hideUpdateMessages }]) => [
      convId,
      {
        apps: Array.from(apps.entries()),
        panelOpen,
        hideUpdateMessages,
      },
    ])

    localStorage.setItem(INSTALLATIONS_KEY, JSON.stringify(data))
  } catch (error) {
    console.error('[webxdc-panel] Failed to save installations:', error)
  }
}
```

Update `setPanelOpen`'s default-creation fallback (it constructs a bare `ConversationInstallations` when none exists yet) to include the new field — currently:

```ts
      let convData = installations.get(conversationId)
      if (!convData) {
        convData = { apps: new Map(), panelOpen: false }
      }
```

becomes:

```ts
      let convData = installations.get(conversationId)
      if (!convData) {
        convData = { apps: new Map(), panelOpen: false, hideUpdateMessages: false }
      }
```

Do the same in `installApp`'s default-creation fallback (currently `convData = { apps: new Map(), panelOpen: false }`) → `convData = { apps: new Map(), panelOpen: false, hideUpdateMessages: false }`.

Add the two new action implementations to the store object (after `removeConversation`):

```ts
  setHideUpdateMessages: (conversationId, hide) => {
    set((state) => {
      const installations = new Map(state.installations)

      let convData = installations.get(conversationId)
      if (!convData) {
        convData = { apps: new Map(), panelOpen: false, hideUpdateMessages: false }
      }

      convData = { ...convData, hideUpdateMessages: hide }
      installations.set(conversationId, convData)

      saveInstallations(installations)
      return { installations }
    })
  },

  getHideUpdateMessages: (conversationId) => {
    const convData = get().installations.get(conversationId)
    return convData?.hideUpdateMessages ?? false
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/stores/webxdcPanelStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/stores/webxdcPanelStore.ts apps/fluux/src/stores/webxdcPanelStore.test.ts
git commit -m "feat(webxdc): add per-conversation hideUpdateMessages toggle to panel store"
```

---

### Task 8: Frontend UI — hide-updates checkbox in the panel header

**Files:**
- Modify: `apps/fluux/src/components/WebxdcAppPanel.tsx`
- Modify: `apps/fluux/src/components/WebxdcAppPanel.test.tsx`
- Modify: `apps/fluux/src/i18n/locales/en.json`

**Interfaces:**
- Consumes: `setHideUpdateMessages`/`getHideUpdateMessages` from Task 7.

- [ ] **Step 1: Write the failing test**

Add to `WebxdcAppPanel.test.tsx`:

```tsx
  it('toggles hideUpdateMessages via the header checkbox', () => {
    render(<WebxdcAppPanel conversationId="room@conference.example.com" onClose={vi.fn()} />)

    const checkbox = screen.getByRole('checkbox', { name: 'Hide update messages' })
    expect(checkbox).not.toBeChecked()

    checkbox.click()

    expect(useWebxdcPanelStore.getState().getHideUpdateMessages('room@conference.example.com')).toBe(true)
    expect(checkbox).toBeChecked()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/WebxdcAppPanel.test.tsx`
Expected: FAIL — no checkbox with that accessible name exists yet.

- [ ] **Step 3: Add the i18n key**

In `apps/fluux/src/i18n/locales/en.json`, add to the `"webxdc"` object (currently the last top-level key, lines 1424-1435):

```json
    "webxdc": {
        "apps": "Webxdc Apps",
        "back": "Back",
        "closePanel": "Close panel",
        "noAppsInstalled": "No installed apps",
        "installFromAttachments": "Install apps from attachments in this conversation",
        "install": "Install App",
        "remove": "Remove",
        "open": "Open",
        "viewAll": "View All",
        "hashUnavailable": "Hash unavailable",
        "hideUpdateMessages": "Hide update messages"
    }
```

- [ ] **Step 4: Implement the checkbox**

In `WebxdcAppPanel.tsx`, destructure the new store actions (currently `const { getInstalledApps } = useWebxdcPanelStore()`):

```tsx
  const { getInstalledApps, getHideUpdateMessages, setHideUpdateMessages } = useWebxdcPanelStore()
  const hideUpdateMessages = getHideUpdateMessages(conversationId)
```

Add the checkbox row right after the header `div` (currently lines 46-74, closing `</div>` before `{/* App list */}`), i.e. insert a new block between the header and the app list:

```tsx
      {/* Hide update messages toggle */}
      <label className="flex items-center gap-2 px-4 py-2 border-b border-fluux-bg/50 text-sm text-fluux-muted cursor-pointer">
        <input
          type="checkbox"
          checked={hideUpdateMessages}
          onChange={(e) => setHideUpdateMessages(conversationId, e.target.checked)}
          className="size-4"
        />
        {t('webxdc.hideUpdateMessages', 'Hide update messages')}
      </label>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/WebxdcAppPanel.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/WebxdcAppPanel.tsx apps/fluux/src/components/WebxdcAppPanel.test.tsx apps/fluux/src/i18n/locales/en.json
git commit -m "feat(webxdc): add hide-update-messages checkbox to the app panel header"
```

---

### Task 9: Frontend — filter `isWebxdcUpdate` messages out of the message list

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx`
- Create: `apps/fluux/src/components/conversation/MessageList.webxdc.test.tsx`

**Interfaces:**
- Consumes: `getHideUpdateMessages` from Task 7, `isWebxdcUpdate` from Task 4 (present on `BaseMessage`, so available on the generic `T extends BaseMessage` prop type without casts).

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/conversation/MessageList.webxdc.test.tsx`. `MessageList.tsx` renders through a virtualizer by default and needs several supporting mocks to render in jsdom — copy the exact harness already proven by `MessageList.keys.test.tsx` (forces the non-virtualized path via the `featureFlags` mock, stubs `ResizeObserver`, mocks `@/hooks` and `react-i18next`, and passes `renderMessage`/`clearFirstNewMessageId`):

```tsx
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/utils/featureFlags', () => ({ isFeatureEnabled: () => false }))
import { render, screen } from '@testing-library/react'
import { MessageList } from './MessageList'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'
import { scrollStateManager } from '@/utils/scrollStateManager'
import type { BaseMessage } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@/hooks', () => ({
  useMessageCopyFormatter: vi.fn(),
  useMessageRangeSelection: vi.fn(() => ({
    copySelectedIds: new Set<string>(),
    selectionCount: 0,
    isSelecting: false,
    selectAll: vi.fn(),
    extendTo: vi.fn(),
    clearSelection: vi.fn(),
    copySelected: vi.fn(),
  })),
}))

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function message(overrides: Partial<BaseMessage>): BaseMessage {
  return {
    id: 'msg-default',
    from: 'alice@example.com',
    body: 'hello',
    timestamp: new Date(2026, 0, 1, 12, 0),
    isOutgoing: false,
    type: 'chat' as const,
    ...overrides,
  }
}

describe('MessageList webxdc update filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scrollStateManager.reset()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    localStorage.clear()
    useWebxdcPanelStore.setState({ manifestCache: new Map(), installations: new Map() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shows webxdc update messages when hideUpdateMessages is off', () => {
    const messages = [
      message({ id: 'm1', body: 'Hello there' }),
      message({ id: 'm2', body: '[WebXDC Update: moved]', isWebxdcUpdate: true }),
    ]

    render(
      <MessageList
        messages={messages}
        conversationId="alice@example.com"
        clearFirstNewMessageId={vi.fn()}
        renderMessage={(msg) => <div>{msg.body}</div>}
      />
    )

    expect(screen.getByText('Hello there')).toBeInTheDocument()
    expect(screen.getByText('[WebXDC Update: moved]')).toBeInTheDocument()
  })

  it('hides webxdc update messages when hideUpdateMessages is on for the conversation', () => {
    useWebxdcPanelStore.getState().setHideUpdateMessages('alice@example.com', true)

    const messages = [
      message({ id: 'm1', body: 'Hello there' }),
      message({ id: 'm2', body: '[WebXDC Update: moved]', isWebxdcUpdate: true }),
    ]

    render(
      <MessageList
        messages={messages}
        conversationId="alice@example.com"
        clearFirstNewMessageId={vi.fn()}
        renderMessage={(msg) => <div>{msg.body}</div>}
      />
    )

    expect(screen.getByText('Hello there')).toBeInTheDocument()
    expect(screen.queryByText('[WebXDC Update: moved]')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageList.webxdc.test.tsx`
Expected: FAIL on the second test — the flagged message still renders (no filtering yet).

- [ ] **Step 3: Implement the filter**

In `MessageList.tsx`, add the import (alongside the other `@/stores/...` import, e.g. next to `useSettingsStore`):

```tsx
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'
```

Add the selector near the top of the component body (alongside `const { t } = useTranslation()`):

```tsx
  const hideWebxdcUpdates = useWebxdcPanelStore((s) => s.getHideUpdateMessages(conversationId))
```

Update the `deduplicatedMessages` memo (currently lines 241-253) to also filter on the flag:

```tsx
  const deduplicatedMessages = useMemo(() => {
    const seen = new Set<string>()
    return messages.filter((msg) => {
      if (msg.isWebxdcUpdate && hideWebxdcUpdates) {
        return false
      }
      if (!msg.id) {
        return true
      }
      if (seen.has(msg.id)) {
        return false
      }
      seen.add(msg.id)
      return true
    })
  }, [messages, hideWebxdcUpdates])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageList.webxdc.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the full MessageList test suite to check for regressions**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageList`
Expected: PASS — the filter is a no-op (`hideWebxdcUpdates` defaults to `false`) for every existing test's messages, none of which set `isWebxdcUpdate`.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/conversation/MessageList.tsx apps/fluux/src/components/conversation/MessageList.webxdc.test.tsx
git commit -m "feat(webxdc): filter isWebxdcUpdate messages from the message list per conversation toggle"
```

---

### Task 10: Frontend store — unread count tracking

**Files:**
- Modify: `apps/fluux/src/stores/webxdcPanelStore.ts`
- Modify: `apps/fluux/src/stores/webxdcPanelStore.test.ts`

**Interfaces:**
- Produces: `WebxdcAppGroup.unreadCount: number` (default `0`); `incrementUnread(conversationId: string, attachmentUrl: string): void`; `clearUnread(conversationId: string, appName: string): void`; `getTotalUnread(conversationId: string): number` on `useWebxdcPanelStore`. Consumed by Tasks 11, 12, 13.

- [ ] **Step 1: Write the failing tests**

Add to `webxdcPanelStore.test.ts`, as a new `describe` block:

```ts
  describe('unread tracking', () => {
    function install(conversationId: string, instanceId: string, url: string) {
      const { installApp } = useWebxdcPanelStore.getState()
      installApp(conversationId, instanceId, {
        url,
        name: 'app.xdc',
        mediaType: 'application/webxdc+zip',
        size: 1024,
      } as any)
    }

    it('increments unread on the app group matching the attachment URL', () => {
      install('room@conference.example.com', 'instance-1', 'https://example.com/app.xdc')
      const { incrementUnread } = useWebxdcPanelStore.getState()

      incrementUnread('room@conference.example.com', 'https://example.com/app.xdc')
      incrementUnread('room@conference.example.com', 'https://example.com/app.xdc')

      const group = useWebxdcPanelStore.getState().getAppGroup('room@conference.example.com', 'app.xdc')
      expect(group?.unreadCount).toBe(2)
    })

    it('is a no-op when no installed instance matches the URL', () => {
      const { incrementUnread } = useWebxdcPanelStore.getState()

      incrementUnread('room@conference.example.com', 'https://example.com/unknown.xdc')

      expect(useWebxdcPanelStore.getState().installations.get('room@conference.example.com')).toBeUndefined()
    })

    it('clears unread for an app group', () => {
      install('room@conference.example.com', 'instance-1', 'https://example.com/app.xdc')
      const { incrementUnread, clearUnread } = useWebxdcPanelStore.getState()
      incrementUnread('room@conference.example.com', 'https://example.com/app.xdc')

      clearUnread('room@conference.example.com', 'app.xdc')

      const group = useWebxdcPanelStore.getState().getAppGroup('room@conference.example.com', 'app.xdc')
      expect(group?.unreadCount).toBe(0)
    })

    it('sums unread across app groups for getTotalUnread', () => {
      install('room@conference.example.com', 'instance-1', 'https://example.com/app1.xdc')
      install('room@conference.example.com', 'instance-2', 'https://example.com/app2.xdc')
      const { incrementUnread } = useWebxdcPanelStore.getState()

      incrementUnread('room@conference.example.com', 'https://example.com/app1.xdc')
      incrementUnread('room@conference.example.com', 'https://example.com/app2.xdc')
      incrementUnread('room@conference.example.com', 'https://example.com/app2.xdc')

      expect(useWebxdcPanelStore.getState().getTotalUnread('room@conference.example.com')).toBe(3)
    })

    it('getTotalUnread returns 0 for a conversation with no installations', () => {
      expect(useWebxdcPanelStore.getState().getTotalUnread('nobody@example.com')).toBe(0)
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/stores/webxdcPanelStore.test.ts`
Expected: FAIL — `incrementUnread`/`clearUnread`/`getTotalUnread` don't exist yet.

- [ ] **Step 3: Implement the store changes**

Add `unreadCount` to `WebxdcAppGroup` (currently lines 5-9):

```ts
export interface WebxdcAppGroup {
  appName: string
  icon?: string
  instances: WebxdcInstance[]
  unreadCount: number
}
```

Add the three new methods to the `WebxdcPanelStore` interface (after `getHideUpdateMessages`):

```ts
  incrementUnread: (conversationId: string, attachmentUrl: string) => void
  clearUnread: (conversationId: string, appName: string) => void
  getTotalUnread: (conversationId: string) => number
```

In `installApp`, the "create new group" branch currently omits `unreadCount` — update it:

```ts
      if (!group) {
        group = {
          appName,
          icon,
          instances: [],
          unreadCount: 0,
        }
      } else {
        group = { ...group, instances: [...group.instances] }
      }
```

Add the three implementations to the store object (after `getHideUpdateMessages`):

```ts
  incrementUnread: (conversationId, attachmentUrl) => {
    set((state) => {
      const installations = new Map(state.installations)
      const convData = installations.get(conversationId)
      if (!convData) return state

      const apps = new Map(convData.apps)
      let targetAppName: string | null = null
      for (const [appName, group] of apps.entries()) {
        if (group.instances.some((inst) => inst.attachmentUrl === attachmentUrl)) {
          targetAppName = appName
          break
        }
      }
      if (!targetAppName) return state

      const group = apps.get(targetAppName)!
      apps.set(targetAppName, { ...group, unreadCount: group.unreadCount + 1 })
      installations.set(conversationId, { ...convData, apps })

      saveInstallations(installations)
      return { installations }
    })
  },

  clearUnread: (conversationId, appName) => {
    set((state) => {
      const installations = new Map(state.installations)
      const convData = installations.get(conversationId)
      if (!convData) return state

      const group = convData.apps.get(appName)
      if (!group) return state

      const apps = new Map(convData.apps)
      apps.set(appName, { ...group, unreadCount: 0 })
      installations.set(conversationId, { ...convData, apps })

      saveInstallations(installations)
      return { installations }
    })
  },

  getTotalUnread: (conversationId) => {
    const convData = get().installations.get(conversationId)
    if (!convData) return 0
    let total = 0
    for (const group of convData.apps.values()) {
      total += group.unreadCount
    }
    return total
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/stores/webxdcPanelStore.test.ts`
Expected: PASS — including the pre-existing tests (installApp's group-creation shape gained a field, but no existing test asserts the group object's exact shape via strict equality on the whole object, only individual fields, so this is non-breaking; if any existing test does use `toEqual` on a full group object, add `unreadCount: 0` to its expected value).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/stores/webxdcPanelStore.ts apps/fluux/src/stores/webxdcPanelStore.test.ts
git commit -m "feat(webxdc): add per-app unread count tracking to panel store"
```

---

### Task 11: Frontend — increment unread on incoming webxdc updates

**Files:**
- Modify: `apps/fluux/src/utils/webxdc/xmppBridge.ts`
- Modify: `apps/fluux/src/utils/webxdc/xmppBridge.test.ts`

**Interfaces:**
- Consumes: `incrementUnread` from Task 10.

**Pre-existing bug found while scoping this task:** `xmppBridge.ts:107` calls `client.onSDK('webxdc:update', ...)`, but every test in `xmppBridge.test.ts` mocks the client with `on: vi.fn()` (never `onSDK`), and the individual "incoming updates" tests override with `on: mockOn`. Run `cd apps/fluux && npx vitest run src/utils/webxdc/xmppBridge.test.ts` before touching anything — it currently fails all 8 tests with `TypeError: client.onSDK is not a function`, since `initializeXmppBridge` calls `client.onSDK(...)` unconditionally and every test's mock client lacks that method. This is unrelated to this feature but must be fixed first, or the new test added below cannot run either. Step 1 fixes the mock; step 2 adds the new test.

- [ ] **Step 1: Fix the pre-existing broken mock**

In `xmppBridge.test.ts`, in the `beforeEach` block, change:

```ts
    mockClient = {
      chat: {
        sendCustomMessage: mockSendCustomMessage,
        sendMessage: vi.fn().mockResolvedValue('msg-456')
      } as any,
      on: vi.fn()
    }
```

to:

```ts
    mockClient = {
      chat: {
        sendCustomMessage: mockSendCustomMessage,
        sendMessage: vi.fn().mockResolvedValue('msg-456')
      } as any,
      on: vi.fn(),
      onSDK: vi.fn()
    }
```

Then, in each of the three "incoming updates" tests (`'should listen for webxdc:update events and store incoming updates'`, `'should handle updates without optional fields'`, `'should forward thread to webxdc_receive_update when the incoming update carries one'`), change the local override from `on: mockOn` to `onSDK: mockOn` — e.g. the first one currently reads:

```ts
      const clientWithEvents = {
        ...mockClient,
        on: mockOn
      }
```

becomes:

```ts
      const clientWithEvents = {
        ...mockClient,
        onSDK: mockOn
      }
```

Apply the same `on: mockOn` → `onSDK: mockOn` change to the other two tests' `clientWithEvents` objects (one is the same multi-line shape, the third is the single-line `const clientWithEvents = { ...mockClient, on: mockOn }`).

Run: `cd apps/fluux && npx vitest run src/utils/webxdc/xmppBridge.test.ts`
Expected: PASS — all 8 pre-existing tests now pass (this alone is the fix for the pre-existing bug; commit it separately before adding the new test, so the two changes are easy to review independently).

Commit this fix on its own:

```bash
git add apps/fluux/src/utils/webxdc/xmppBridge.test.ts
git commit -m "fix(webxdc): xmppBridge tests mock client.onSDK, not client.on"
```

- [ ] **Step 2: Write the failing test for the unread increment**

Add a new test to the `describe('incoming updates', ...)` block, after `'should forward thread to webxdc_receive_update when the incoming update carries one'`:

```ts
    it('increments the webxdc panel store unread count for the resolved conversation and instance', async () => {
      const { initializeXmppBridge } = await import('./xmppBridge')
      const { useWebxdcPanelStore } = await import('@/stores/webxdcPanelStore')

      useWebxdcPanelStore.setState({ manifestCache: new Map(), installations: new Map() })
      useWebxdcPanelStore.getState().installApp('alice@example.com', 'alice@example.com:https://example.com/app.xdc', {
        url: 'https://example.com/app.xdc',
        name: 'app.xdc',
        mediaType: 'application/webxdc+zip',
        size: 1024,
      } as any)

      let webxdcUpdateHandler: Function | undefined
      const mockOn = vi.fn((event, handler) => {
        if (event === 'webxdc:update') webxdcUpdateHandler = handler
      })
      const clientWithEvents = { ...mockClient, onSDK: mockOn }

      initializeXmppBridge(clientWithEvents as any, mockUploadFile)

      await webxdcUpdateHandler!({
        from: 'alice@example.com',
        instance: 'https://example.com/app.xdc',
        serial: 1,
        payload: {},
        sender: 'alice@example.com',
        thread: undefined,
        isCheogramFormat: false,
      })

      const group = useWebxdcPanelStore.getState().getAppGroup('alice@example.com', 'app.xdc')
      expect(group?.unreadCount).toBe(1)
    })
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/webxdc/xmppBridge.test.ts`
Expected: FAIL on the new test only — `group?.unreadCount` is `undefined` (not incremented yet). The other 8 tests pass (fixed in step 1).

- [ ] **Step 4: Implement the increment hook**

In `xmppBridge.ts`, add the import (alongside existing imports):

```ts
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'
```

In the `client.onSDK('webxdc:update', async (event) => { ... })` handler (around line 107-153), after `resolvedInstance` is finalized (i.e. after the Cheogram thread-resolution `if` block, before the `receiveWebxdcUpdate(...)` call), add:

```ts
      const updateConversationId = event.sender ? event.sender.split('/')[0] : undefined
      if (updateConversationId) {
        useWebxdcPanelStore.getState().incrementUnread(updateConversationId, resolvedInstance)
      }
```

Note: `event.sender.split('/')[0]` strips the resource to get the bare JID without adding a new SDK import — `sender` is already the full/bare `from` value forwarded by `Chat.ts`'s `updateEvent.sender` field (`sender: from || bareFrom`), and a bare JID has no `/resource` to strip, so `.split('/')[0]` is safe for both shapes.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/webxdc/xmppBridge.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/utils/webxdc/xmppBridge.ts apps/fluux/src/utils/webxdc/xmppBridge.test.ts
git commit -m "feat(webxdc): increment panel unread count on incoming webxdc updates"
```

---

### Task 12: Frontend — clear unread on app open, render panel row badge

**Files:**
- Modify: `apps/fluux/src/components/WebxdcAppPanel.tsx`
- Modify: `apps/fluux/src/components/WebxdcAttachment.tsx`
- Modify: `apps/fluux/src/components/WebxdcAppPanel.test.tsx`

**Interfaces:**
- Consumes: `clearUnread` from Task 10, `formatUnreadCount` from `@/utils/formatUnreadCount` (existing shared utility).

- [ ] **Step 1: Write the failing tests**

Add to `WebxdcAppPanel.test.tsx`:

```tsx
  it('renders an unread badge on the app icon when unreadCount > 0', () => {
    useWebxdcPanelStore.getState().installApp('room@conference.example.com', 'instance-1', makeAttachment('https://example.com/app.xdc'))
    useWebxdcPanelStore.getState().incrementUnread('room@conference.example.com', 'https://example.com/app.xdc')
    useWebxdcPanelStore.getState().incrementUnread('room@conference.example.com', 'https://example.com/app.xdc')

    render(<WebxdcAppPanel conversationId="room@conference.example.com" onClose={vi.fn()} />)

    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('clears the unread badge when the app is opened', () => {
    useWebxdcPanelStore.getState().installApp('room@conference.example.com', 'instance-1', makeAttachment('https://example.com/app.xdc'))
    useWebxdcPanelStore.getState().incrementUnread('room@conference.example.com', 'https://example.com/app.xdc')

    render(<WebxdcAppPanel conversationId="room@conference.example.com" onClose={vi.fn()} />)

    screen.getByRole('button', { name: 'Open' }).click()

    expect(useWebxdcPanelStore.getState().getAppGroup('room@conference.example.com', 'app.xdc')?.unreadCount).toBe(0)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/WebxdcAppPanel.test.tsx`
Expected: FAIL — no badge rendered yet; opening doesn't clear unread yet.

- [ ] **Step 3: Implement clearing and the badge**

In `WebxdcAppPanel.tsx`, update `handleOpenApp` (currently lines 29-41) to clear unread:

```tsx
  const handleOpenApp = async (group: WebxdcAppGroup) => {
    // Get most recent instance
    const sorted = [...group.instances].sort((a, b) => b.installedAt - a.installedAt)
    const mostRecent = sorted[0]

    if (!mostRecent) return

    clearUnread(conversationId, group.appName)

    try {
      await openWebxdcWindow(mostRecent.attachment, conversationId)
    } catch (error) {
      console.error('[webxdc] Failed to open app:', error)
    }
  }
```

Destructure `clearUnread` from the store at the top of `WebxdcAppPanel` (alongside `getInstalledApps`, `getHideUpdateMessages`, `setHideUpdateMessages`):

```tsx
  const { getInstalledApps, getHideUpdateMessages, setHideUpdateMessages, clearUnread } = useWebxdcPanelStore()
```

Add the import at the top of the file:

```tsx
import { formatUnreadCount } from '@/utils/formatUnreadCount'
```

In `AppGroupItem`, render the badge inside the (now `relative`) icon container added in Task 3, right after the `<img>`/`<PackageIcon>` conditional:

```tsx
        <div className="relative size-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-purple-500/20 text-purple-500 overflow-hidden">
          {group.icon && !iconError ? (
            <img
              src={group.icon}
              alt=""
              className="size-full object-cover"
              onError={() => setIconError(true)}
            />
          ) : (
            <PackageIcon className="size-5" />
          )}
          {group.unreadCount > 0 && (
            <span className="absolute -top-1 -end-1 z-10 min-w-4 h-4 px-1 bg-fluux-badge-strong text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {formatUnreadCount(group.unreadCount)}
            </span>
          )}
        </div>
```

- [ ] **Step 4: Wire the same clear into `WebxdcAttachment`'s open handler**

In `WebxdcAttachment.tsx`, add `clearUnread` to the store destructure (currently `const { manifestCache, cacheManifest, isInstalled, installApp, removeInstance } = useWebxdcPanelStore()`):

```tsx
  const { manifestCache, cacheManifest, isInstalled, installApp, removeInstance, clearUnread } = useWebxdcPanelStore()
```

Update `handleOpen` (currently lines 96-105) to clear unread for this app before opening — the app name to clear by is the cached manifest name (or filename fallback), matching `displayName`:

```tsx
  const handleOpen = async () => {
    setBusy(true)
    clearUnread(conversationId, displayName)
    try {
      await openWebxdcWindow(attachment, conversationId)
    } catch (error) {
      console.error('[webxdc] Failed to open app:', error)
    } finally {
      setBusy(false)
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/WebxdcAppPanel.test.tsx src/components/WebxdcAttachment.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/WebxdcAppPanel.tsx apps/fluux/src/components/WebxdcAttachment.tsx apps/fluux/src/components/WebxdcAppPanel.test.tsx
git commit -m "feat(webxdc): clear unread badge on app open, render it on the panel row icon"
```

---

### Task 13: Frontend — aggregate unread badge on the header toggle button

**Files:**
- Modify: `apps/fluux/src/components/ChatHeader.tsx`
- Modify: `apps/fluux/src/components/RoomHeader.tsx`
- Modify: `apps/fluux/src/components/ChatHeader.test.tsx`
- Modify: `apps/fluux/src/components/RoomHeader.test.tsx`

**Interfaces:**
- Consumes: `getTotalUnread` from Task 10, `formatUnreadCount` from `@/utils/formatUnreadCount`.

- [ ] **Step 1: Write the failing tests**

Add to `ChatHeader.test.tsx` (inside the top-level `describe('ChatHeader', ...)` block, using the same `setupContact`/`render` pattern as the neighboring tests — check how `jid` gets passed to `<ChatHeader>` in an existing test and mirror it exactly):

```tsx
  it('shows an aggregate unread badge on the webxdc toggle button when apps have unread updates', async () => {
    const { useWebxdcPanelStore } = await import('@/stores/webxdcPanelStore')
    useWebxdcPanelStore.setState({ manifestCache: new Map(), installations: new Map() })
    useWebxdcPanelStore.getState().installApp('alice@example.com', 'instance-1', {
      url: 'https://example.com/app.xdc', name: 'app.xdc', mediaType: 'application/webxdc+zip', size: 1,
    } as any)
    useWebxdcPanelStore.getState().incrementUnread('alice@example.com', 'https://example.com/app.xdc')

    const contact = setupContact()
    render(<ChatHeader name="Alice Smith" type="chat" contact={contact} jid="alice@example.com" />)

    expect(screen.getByText('1')).toBeInTheDocument()
  })
```

Add the analogous test to `RoomHeader.test.tsx`, inside the `describe('Basic Rendering', ...)` block, using the exact same `createRoom(...)` + required-props render shape as the neighboring `'renders room name'` test:

```tsx
  it('shows an aggregate unread badge on the webxdc toggle button when apps have unread updates', async () => {
    const { useWebxdcPanelStore } = await import('@/stores/webxdcPanelStore')
    useWebxdcPanelStore.setState({ manifestCache: new Map(), installations: new Map() })
    useWebxdcPanelStore.getState().installApp('room@conference.example.com', 'instance-1', {
      url: 'https://example.com/app.xdc', name: 'app.xdc', mediaType: 'application/webxdc+zip', size: 1,
    } as any)
    useWebxdcPanelStore.getState().incrementUnread('room@conference.example.com', 'https://example.com/app.xdc')

    render(
      <RoomHeader
        room={createRoom({ name: 'My Room' })}
        showOccupants={false}
        onToggleOccupants={mockOnToggleOccupants}
        setRoomNotifyAll={mockSetRoomNotifyAll}
        setRoomAvatar={mockSetRoomAvatar}
        clearRoomAvatar={mockClearRoomAvatar}
        submitRoomConfig={mockSubmitRoomConfig}
        setSubject={mockSetSubject}
        destroyRoom={mockDestroyRoom}
      />
    )

    expect(screen.getByText('1')).toBeInTheDocument()
  })
```

(`createRoom(...)` defaults `jid` to `'room@conference.example.com'` — see the helper at the top of `RoomHeader.test.tsx` — matching the conversationId used for `incrementUnread` above.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/ChatHeader.test.tsx src/components/RoomHeader.test.tsx`
Expected: FAIL — no badge rendered on the toggle button yet.

- [ ] **Step 3: Implement the badge in ChatHeader**

In `ChatHeader.tsx`, add the import:

```tsx
import { formatUnreadCount } from '@/utils/formatUnreadCount'
```

Update the store destructure (currently `const { setPanelOpen, isPanelOpen } = useWebxdcPanelStore()`):

```tsx
  const { setPanelOpen, isPanelOpen, getTotalUnread } = useWebxdcPanelStore()
  const webxdcPanelOpen = isPanelOpen(jid)
  const webxdcUnread = getTotalUnread(jid)
```

Replace the inline toggle button block (currently lines 185-196):

```tsx
        {/* Webxdc Apps — inline copy (collapses on narrow widths) */}
        <div className={inlineClass('wide')}>
          <button
            type="button"
            onClick={() => setPanelOpen(jid, !webxdcPanelOpen)}
            className="p-1.5 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors tap-target"
            aria-label={webxdcPanelOpen ? t('chat.hideWebxdcApps', 'Hide Webxdc Apps') : t('chat.showWebxdcApps', 'Show Webxdc Apps')}
            title={webxdcPanelOpen ? t('chat.hideWebxdcApps', 'Hide Webxdc Apps') : t('chat.showWebxdcApps', 'Show Webxdc Apps')}
          >
            <Package className="size-4" />
          </button>
        </div>
```

with:

```tsx
        {/* Webxdc Apps — inline copy (collapses on narrow widths) */}
        <div className={inlineClass('wide')}>
          <button
            type="button"
            onClick={() => setPanelOpen(jid, !webxdcPanelOpen)}
            className="relative p-1.5 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors tap-target"
            aria-label={webxdcPanelOpen ? t('chat.hideWebxdcApps', 'Hide Webxdc Apps') : t('chat.showWebxdcApps', 'Show Webxdc Apps')}
            title={webxdcPanelOpen ? t('chat.hideWebxdcApps', 'Hide Webxdc Apps') : t('chat.showWebxdcApps', 'Show Webxdc Apps')}
          >
            <Package className="size-4" />
            {webxdcUnread > 0 && (
              <span className="absolute -top-1 -end-1 z-10 min-w-4 h-4 px-1 bg-fluux-badge-strong text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                {formatUnreadCount(webxdcUnread)}
              </span>
            )}
          </button>
        </div>
```

- [ ] **Step 4: Implement the badge in RoomHeader**

Apply the equivalent change to `RoomHeader.tsx`: add the `formatUnreadCount` import, destructure `getTotalUnread` alongside `setPanelOpen`/`isPanelOpen` (currently `const { setPanelOpen, isPanelOpen } = useWebxdcPanelStore()`), compute `const webxdcUnread = getTotalUnread(room.jid)`, and update the inline toggle button block (currently lines 206-218) the same way — add `relative` to the button's className and the same badge `<span>` after the `<Package className="size-4" />` icon, inside the existing `<Tooltip>` wrapper.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/ChatHeader.test.tsx src/components/RoomHeader.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/ChatHeader.tsx apps/fluux/src/components/RoomHeader.tsx apps/fluux/src/components/ChatHeader.test.tsx apps/fluux/src/components/RoomHeader.test.tsx
git commit -m "feat(webxdc): show aggregate unread badge on the panel toggle button"
```

---

### Task 14: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full Rust test suite**

Run: `cd apps/fluux/src-tauri && cargo test`
Expected: PASS

- [ ] **Step 2: Run the full SDK test suite**

Run: `cd packages/fluux-sdk && npx vitest run`
Expected: PASS

- [ ] **Step 3: Run the full frontend test suite**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS

- [ ] **Step 4: Typecheck both packages**

Run: `cd packages/fluux-sdk && npx tsc --noEmit && cd ../../apps/fluux && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Manual end-to-end check (see the `verify` skill)**

Drive the actual app: install a webxdc app with an icon in its manifest, confirm the real icon shows on both the attachment bubble and the panel row. Send/receive an update in a live session, confirm the panel badge and header badge increment, then open the app and confirm both clear. Toggle "Hide update messages" in the panel header and confirm `[WebXDC Update: ...]` bubbles disappear/reappear in the message list. Reload the conversation (forces a MAM refetch) and confirm the same hide/show behavior applies to historically-loaded update messages.
