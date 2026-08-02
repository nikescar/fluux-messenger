# Webxdc App Instance Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-side panel for managing webxdc app instances per conversation with install/remove/reset actions and security transparency.

**Architecture:** Zustand store for per-conversation state, new Tauri commands for manifest extraction and SHA256 hashing, React components for panel UI and enhanced attachment cards, integration with existing ChatHeader/RoomHeader.

**Tech Stack:** 
- Frontend: React 18, TypeScript, Zustand 4, @tanstack/react-virtual 3, lucide-react
- Backend: Rust, Tauri 2, reqwest, sha2, zip, toml
- Testing: Vitest, @testing-library/react

## Global Constraints

- TypeScript strict mode enabled
- All components must support light/dark themes via CSS variables
- Use existing utility classes from fluux design system
- Follow existing icon patterns from lucide-react
- Panel width: 256px (consistent with OccupantPanel)
- LocalStorage keys: `webxdc-manifest-cache`, `webxdc-installations`
- Manifest cache TTL: 7 days, max 100 entries (LRU eviction)
- VirusTotal URL format: `https://www.virustotal.com/gui/file/{sha256}/details`

---

### Task 1: Tauri Commands for Manifest Extraction and Hashing

**Files:**
- Modify: `apps/fluux/src-tauri/src/webxdc/extraction.rs` (add `extract_manifest_only` function)
- Modify: `apps/fluux/src-tauri/src/webxdc/mod.rs` (add new commands)
- Modify: `apps/fluux/src-tauri/capabilities/default.json:87` (add permissions after line 86)

**Interfaces:**
- Consumes: `download_file`, `parse_manifest` from `extraction.rs`
- Produces:
  - `webxdc_extract_manifest(url: String, filename: String, decrypt_key: Option<String>, decrypt_iv: Option<String>) -> Result<ManifestData, String>`
  - `webxdc_compute_hash(url: String, decrypt_key: Option<String>, decrypt_iv: Option<String>) -> Result<HashData, String>`
  - `webxdc_create_new_instance(base_instance_id: String) -> Result<NewInstanceData, String>`

**Type definitions:**
```rust
#[derive(Serialize)]
struct ManifestData {
    name: String,
    icon: Option<String>,
}

#[derive(Serialize)]
struct HashData {
    sha256: String,
}

#[derive(Serialize)]
struct NewInstanceData {
    instance_id: String,
}
```

- [ ] **Step 1: Add extract_manifest_only function to extraction.rs**

Open `apps/fluux/src-tauri/src/webxdc/extraction.rs` and add after the `download_file` function (around line 256):

```rust
/// Extract only the manifest from a .xdc file without full extraction.
/// Returns manifest data or falls back to filename if extraction fails.
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
    Ok(parse_manifest(&manifest_content, filename))
}

/// Compute SHA256 hash of a .xdc file
pub async fn compute_file_hash(
    url: &str,
    decrypt: Option<([u8; 32], [u8; 12])>,
) -> Result<String, ExtractionError> {
    let bytes = download_file(url, decrypt).await?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}
```

- [ ] **Step 2: Add Tauri commands to mod.rs**

Open `apps/fluux/src-tauri/src/webxdc/mod.rs` and add these commands after the existing webxdc commands (around line 679):

```rust
#[tauri::command]
async fn webxdc_extract_manifest(
    url: String,
    filename: String,
    decrypt_key: Option<String>,
    decrypt_iv: Option<String>,
) -> Result<ManifestData, String> {
    let decrypt = match (decrypt_key, decrypt_iv) {
        (Some(key_str), Some(iv_str)) => {
            let key = decode_base64_key(&key_str)?;
            let iv = decode_base64_iv(&iv_str)?;
            Some((key, iv))
        }
        _ => None,
    };
    
    let manifest = extraction::extract_manifest_only(&url, &filename, decrypt)
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(ManifestData {
        name: manifest.name,
        icon: manifest.icon,
    })
}

#[tauri::command]
async fn webxdc_compute_hash(
    url: String,
    decrypt_key: Option<String>,
    decrypt_iv: Option<String>,
) -> Result<HashData, String> {
    let decrypt = match (decrypt_key, decrypt_iv) {
        (Some(key_str), Some(iv_str)) => {
            let key = decode_base64_key(&key_str)?;
            let iv = decode_base64_iv(&iv_str)?;
            Some((key, iv))
        }
        _ => None,
    };
    
    let sha256 = extraction::compute_file_hash(&url, decrypt)
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(HashData { sha256 })
}

#[tauri::command]
async fn webxdc_create_new_instance(
    base_instance_id: String,
    state: State<'_, WebxdcState>,
) -> Result<NewInstanceData, String> {
    // Generate new instance ID with same conversation prefix but new UUID suffix
    let parts: Vec<&str> = base_instance_id.split(':').collect();
    if parts.len() != 2 {
        return Err("Invalid instance ID format".to_string());
    }
    
    let conversation_id = parts[0];
    let new_uuid = uuid::Uuid::new_v4().to_string();
    let new_instance_id = format!("{}:{}", conversation_id, new_uuid);
    
    // Copy update database from base instance
    let storage = &state.storage;
    storage.clone_instance(&base_instance_id, &new_instance_id)
        .map_err(|e| format!("Failed to clone instance: {}", e))?;
    
    Ok(NewInstanceData {
        instance_id: new_instance_id,
    })
}

// Helper struct for manifest response
#[derive(Serialize)]
struct ManifestData {
    name: String,
    icon: Option<String>,
}

// Helper struct for hash response
#[derive(Serialize)]
struct HashData {
    sha256: String,
}

// Helper struct for new instance response
#[derive(Serialize)]
struct NewInstanceData {
    instance_id: String,
}

// Helper to decode base64 key
fn decode_base64_key(key_str: &str) -> Result<[u8; 32], String> {
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(key_str)
        .map_err(|_| "Invalid base64 key")?;
    
    let key: [u8; 32] = decoded.as_slice().try_into()
        .map_err(|_| "Key must be 32 bytes")?;
    
    Ok(key)
}

// Helper to decode base64 IV
fn decode_base64_iv(iv_str: &str) -> Result<[u8; 12], String> {
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(iv_str)
        .map_err(|_| "Invalid base64 IV")?;
    
    let iv: [u8; 12] = decoded.as_slice().try_into()
        .map_err(|_| "IV must be 12 bytes")?;
    
    Ok(iv)
}
```

- [ ] **Step 3: Add clone_instance method to storage.rs**

Open `apps/fluux/src-tauri/src/webxdc/storage.rs` and add after the existing methods:

```rust
/// Clone an instance's update database to a new instance ID
pub fn clone_instance(&self, from_id: &str, to_id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let updates = self.get_updates(from_id, 0)?;
    
    // Copy all updates to new instance
    for update in updates {
        self.save_update(to_id, &update.payload, update.thread_id.as_deref())?;
    }
    
    Ok(())
}
```

- [ ] **Step 4: Register commands in main.rs**

Open `apps/fluux/src-tauri/src/main.rs` and add the new commands to the `invoke_handler`:

Find the `.invoke_handler` call and add the three new commands to the list:
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    webxdc_extract_manifest,
    webxdc_compute_hash,
    webxdc_create_new_instance,
])
```

- [ ] **Step 5: Add permissions to capabilities/default.json**

Open `apps/fluux/src-tauri/capabilities/default.json` and add after line 86:

```json
    "allow-webxdc-extract-manifest",
    "allow-webxdc-compute-hash",
    "allow-webxdc-create-new-instance"
```

- [ ] **Step 6: Add uuid dependency to Cargo.toml**

Open `apps/fluux/src-tauri/Cargo.toml` and add to `[dependencies]` section:

```toml
uuid = { version = "1.6", features = ["v4"] }
```

- [ ] **Step 7: Test Tauri commands compile**

Run from repository root:
```bash
cd apps/fluux/src-tauri
cargo check
```

Expected: No compilation errors

- [ ] **Step 8: Commit Tauri backend changes**

```bash
git add apps/fluux/src-tauri/
git commit -m "feat(webxdc): add manifest extraction and hashing commands

Add three new Tauri commands for webxdc panel:
- webxdc_extract_manifest: extract manifest.toml without full extraction
- webxdc_compute_hash: compute SHA256 hash for VirusTotal
- webxdc_create_new_instance: create new instance ID for reset

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 2: WebxdcPanelStore Zustand Store

**Files:**
- Create: `apps/fluux/src/stores/webxdcPanelStore.ts`
- Create: `apps/fluux/src/stores/webxdcPanelStore.test.ts`

**Interfaces:**
- Consumes: Nothing (first frontend task)
- Produces: `useWebxdcPanelStore` hook with actions:
  - `cacheManifest(url: string, data: { name: string; icon?: string; sha256: string }): void`
  - `installApp(conversationId: string, instanceId: string, attachment: FileAttachment): void`
  - `removeApp(conversationId: string, appName: string): void`
  - `removeInstance(conversationId: string, instanceId: string): void`
  - `createNewInstance(conversationId: string, appName: string, baseInstanceId: string): Promise<string>`
  - `setPanelOpen(conversationId: string, open: boolean): void`
  - `isInstalled(conversationId: string, instanceId: string): boolean`
  - `getAppGroup(conversationId: string, appName: string): WebxdcAppGroup | undefined`
  - `getInstalledApps(conversationId: string): WebxdcAppGroup[]`
  - `isPanelOpen(conversationId: string): boolean`
  - `removeConversation(conversationId: string): void`

**Type definitions:**
```typescript
interface WebxdcAppGroup {
  appName: string
  icon?: string
  instances: WebxdcInstance[]
}

interface WebxdcInstance {
  instanceId: string
  attachmentUrl: string
  messageId: string
  installedAt: number
  conversationId: string
  attachment: FileAttachment
}

interface ManifestCacheEntry {
  name: string
  icon?: string
  sha256: string
  extractedAt: number
}
```

- [ ] **Step 1: Write failing test for cacheManifest**

Create `apps/fluux/src/stores/webxdcPanelStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useWebxdcPanelStore } from './webxdcPanelStore'

describe('webxdcPanelStore', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear()
    // Reset store state
    useWebxdcPanelStore.setState({
      manifestCache: new Map(),
      installations: new Map(),
    })
  })

  afterEach(() => {
    localStorage.clear()
  })

  describe('cacheManifest', () => {
    it('adds manifest to cache', () => {
      const { cacheManifest, manifestCache } = useWebxdcPanelStore.getState()
      
      cacheManifest('https://example.com/app.xdc', {
        name: 'Tic Tac Toe',
        icon: 'icon.png',
        sha256: 'abc123',
      })
      
      const entry = manifestCache.get('https://example.com/app.xdc')
      expect(entry).toBeDefined()
      expect(entry?.name).toBe('Tic Tac Toe')
      expect(entry?.icon).toBe('icon.png')
      expect(entry?.sha256).toBe('abc123')
      expect(entry?.extractedAt).toBeGreaterThan(0)
    })

    it('updates existing manifest entry', () => {
      const { cacheManifest, manifestCache } = useWebxdcPanelStore.getState()
      
      cacheManifest('https://example.com/app.xdc', {
        name: 'Old Name',
        sha256: 'old',
      })
      
      cacheManifest('https://example.com/app.xdc', {
        name: 'New Name',
        sha256: 'new',
      })
      
      const entry = manifestCache.get('https://example.com/app.xdc')
      expect(entry?.name).toBe('New Name')
      expect(entry?.sha256).toBe('new')
    })

    it('persists to localStorage', () => {
      const { cacheManifest } = useWebxdcPanelStore.getState()
      
      cacheManifest('https://example.com/app.xdc', {
        name: 'Test App',
        sha256: 'hash123',
      })
      
      const stored = localStorage.getItem('webxdc-manifest-cache')
      expect(stored).toBeDefined()
      
      const parsed = JSON.parse(stored!)
      expect(parsed).toEqual([
        [
          'https://example.com/app.xdc',
          expect.objectContaining({
            name: 'Test App',
            sha256: 'hash123',
          }),
        ],
      ])
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- webxdcPanelStore.test.ts`
Expected: FAIL with "Cannot find module './webxdcPanelStore'"

- [ ] **Step 3: Create webxdcPanelStore with cacheManifest**

Create `apps/fluux/src/stores/webxdcPanelStore.ts`:

```typescript
import { create } from 'zustand'
import type { FileAttachment } from '@fluux/sdk'

export interface WebxdcAppGroup {
  appName: string
  icon?: string
  instances: WebxdcInstance[]
}

export interface WebxdcInstance {
  instanceId: string
  attachmentUrl: string
  messageId: string
  installedAt: number
  conversationId: string
  attachment: FileAttachment
}

interface ManifestCacheEntry {
  name: string
  icon?: string
  sha256: string
  extractedAt: number
}

interface ConversationInstallations {
  apps: Map<string, WebxdcAppGroup>
  panelOpen: boolean
}

interface WebxdcPanelStore {
  manifestCache: Map<string, ManifestCacheEntry>
  installations: Map<string, ConversationInstallations>
  
  cacheManifest: (url: string, data: { name: string; icon?: string; sha256: string }) => void
  installApp: (conversationId: string, instanceId: string, attachment: FileAttachment) => void
  removeApp: (conversationId: string, appName: string) => void
  removeInstance: (conversationId: string, instanceId: string) => void
  createNewInstance: (conversationId: string, appName: string, baseInstanceId: string) => Promise<string>
  setPanelOpen: (conversationId: string, open: boolean) => void
  isInstalled: (conversationId: string, instanceId: string) => boolean
  getAppGroup: (conversationId: string, appName: string) => WebxdcAppGroup | undefined
  getInstalledApps: (conversationId: string) => WebxdcAppGroup[]
  isPanelOpen: (conversationId: string) => boolean
  removeConversation: (conversationId: string) => void
}

const MANIFEST_CACHE_KEY = 'webxdc-manifest-cache'
const INSTALLATIONS_KEY = 'webxdc-installations'
const MANIFEST_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const MAX_CACHE_SIZE = 100

// Load from localStorage
function loadManifestCache(): Map<string, ManifestCacheEntry> {
  try {
    const stored = localStorage.getItem(MANIFEST_CACHE_KEY)
    if (!stored) return new Map()
    
    const entries: [string, ManifestCacheEntry][] = JSON.parse(stored)
    const now = Date.now()
    
    // Filter out stale entries (older than TTL)
    const fresh = entries.filter(([_, entry]) => now - entry.extractedAt < MANIFEST_TTL_MS)
    
    return new Map(fresh)
  } catch {
    return new Map()
  }
}

function loadInstallations(): Map<string, ConversationInstallations> {
  try {
    const stored = localStorage.getItem(INSTALLATIONS_KEY)
    if (!stored) return new Map()
    
    const data: [string, { apps: [string, WebxdcAppGroup][]; panelOpen: boolean }][] = JSON.parse(stored)
    
    // Reconstruct nested Maps
    return new Map(
      data.map(([convId, { apps, panelOpen }]) => [
        convId,
        {
          apps: new Map(apps),
          panelOpen,
        },
      ])
    )
  } catch {
    return new Map()
  }
}

// Save to localStorage
function saveManifestCache(cache: Map<string, ManifestCacheEntry>) {
  try {
    // Enforce max size with LRU eviction
    let entries = Array.from(cache.entries())
    if (entries.length > MAX_CACHE_SIZE) {
      // Sort by extractedAt DESC, keep newest MAX_CACHE_SIZE
      entries.sort((a, b) => b[1].extractedAt - a[1].extractedAt)
      entries = entries.slice(0, MAX_CACHE_SIZE)
    }
    
    localStorage.setItem(MANIFEST_CACHE_KEY, JSON.stringify(entries))
  } catch (error) {
    console.error('[webxdc-panel] Failed to save manifest cache:', error)
  }
}

function saveInstallations(installations: Map<string, ConversationInstallations>) {
  try {
    // Convert nested Maps to arrays for JSON serialization
    const data = Array.from(installations.entries()).map(([convId, { apps, panelOpen }]) => [
      convId,
      {
        apps: Array.from(apps.entries()),
        panelOpen,
      },
    ])
    
    localStorage.setItem(INSTALLATIONS_KEY, JSON.stringify(data))
  } catch (error) {
    console.error('[webxdc-panel] Failed to save installations:', error)
  }
}

export const useWebxdcPanelStore = create<WebxdcPanelStore>((set, get) => ({
  manifestCache: loadManifestCache(),
  installations: loadInstallations(),
  
  cacheManifest: (url, data) => {
    set((state) => {
      const cache = new Map(state.manifestCache)
      cache.set(url, {
        ...data,
        extractedAt: Date.now(),
      })
      saveManifestCache(cache)
      return { manifestCache: cache }
    })
  },
  
  installApp: (conversationId, instanceId, attachment) => {
    // Implementation in next test
    throw new Error('Not implemented')
  },
  
  removeApp: (conversationId, appName) => {
    throw new Error('Not implemented')
  },
  
  removeInstance: (conversationId, instanceId) => {
    throw new Error('Not implemented')
  },
  
  createNewInstance: async (conversationId, appName, baseInstanceId) => {
    throw new Error('Not implemented')
  },
  
  setPanelOpen: (conversationId, open) => {
    throw new Error('Not implemented')
  },
  
  isInstalled: (conversationId, instanceId) => {
    throw new Error('Not implemented')
  },
  
  getAppGroup: (conversationId, appName) => {
    throw new Error('Not implemented')
  },
  
  getInstalledApps: (conversationId) => {
    throw new Error('Not implemented')
  },
  
  isPanelOpen: (conversationId) => {
    return false
  },
  
  removeConversation: (conversationId) => {
    throw new Error('Not implemented')
  },
}))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- webxdcPanelStore.test.ts`
Expected: All cacheManifest tests PASS

- [ ] **Step 5: Write failing tests for installApp**

Add to `webxdcPanelStore.test.ts`:

```typescript
  describe('installApp', () => {
    const mockAttachment: FileAttachment = {
      url: 'https://example.com/tictactoe.xdc',
      name: 'tictactoe.xdc',
      mime: 'application/xdc',
      size: 1024,
    }

    beforeEach(() => {
      // Cache manifest first
      const { cacheManifest } = useWebxdcPanelStore.getState()
      cacheManifest(mockAttachment.url, {
        name: 'Tic Tac Toe',
        icon: 'icon.png',
        sha256: 'abc123',
      })
    })

    it('creates new app group for first instance', () => {
      const { installApp, getAppGroup } = useWebxdcPanelStore.getState()
      
      installApp('room@conference.example.com', 'room@conference.example.com:uuid1', mockAttachment)
      
      const group = getAppGroup('room@conference.example.com', 'Tic Tac Toe')
      expect(group).toBeDefined()
      expect(group?.appName).toBe('Tic Tac Toe')
      expect(group?.icon).toBe('icon.png')
      expect(group?.instances).toHaveLength(1)
      expect(group?.instances[0].instanceId).toBe('room@conference.example.com:uuid1')
      expect(group?.instances[0].attachmentUrl).toBe(mockAttachment.url)
    })

    it('adds instance to existing app group', () => {
      const { installApp, getAppGroup } = useWebxdcPanelStore.getState()
      
      installApp('room@conference.example.com', 'room@conference.example.com:uuid1', mockAttachment)
      installApp('room@conference.example.com', 'room@conference.example.com:uuid2', {
        ...mockAttachment,
        url: 'https://example.com/tictactoe2.xdc',
      })
      
      const group = getAppGroup('room@conference.example.com', 'Tic Tac Toe')
      expect(group?.instances).toHaveLength(2)
    })

    it('prevents duplicate instance installation', () => {
      const { installApp, getAppGroup } = useWebxdcPanelStore.getState()
      
      installApp('room@conference.example.com', 'room@conference.example.com:uuid1', mockAttachment)
      installApp('room@conference.example.com', 'room@conference.example.com:uuid1', mockAttachment)
      
      const group = getAppGroup('room@conference.example.com', 'Tic Tac Toe')
      expect(group?.instances).toHaveLength(1)
    })

    it('marks instance as installed', () => {
      const { installApp, isInstalled } = useWebxdcPanelStore.getState()
      
      installApp('room@conference.example.com', 'room@conference.example.com:uuid1', mockAttachment)
      
      expect(isInstalled('room@conference.example.com', 'room@conference.example.com:uuid1')).toBe(true)
      expect(isInstalled('room@conference.example.com', 'room@conference.example.com:uuid2')).toBe(false)
    })

    it('persists to localStorage', () => {
      const { installApp } = useWebxdcPanelStore.getState()
      
      installApp('room@conference.example.com', 'room@conference.example.com:uuid1', mockAttachment)
      
      const stored = localStorage.getItem('webxdc-installations')
      expect(stored).toBeDefined()
      
      const parsed = JSON.parse(stored!)
      expect(parsed).toHaveLength(1)
      expect(parsed[0][0]).toBe('room@conference.example.com')
    })
  })
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- webxdcPanelStore.test.ts`
Expected: installApp tests FAIL with "Not implemented"

- [ ] **Step 7: Implement installApp**

Update `webxdcPanelStore.ts`:

```typescript
  installApp: (conversationId, instanceId, attachment) => {
    set((state) => {
      const installations = new Map(state.installations)
      
      // Get or create conversation installations
      let convData = installations.get(conversationId)
      if (!convData) {
        convData = { apps: new Map(), panelOpen: false }
        installations.set(conversationId, convData)
      }
      
      // Check if instance already installed
      for (const group of convData.apps.values()) {
        if (group.instances.some(inst => inst.instanceId === instanceId)) {
          console.warn('[webxdc-panel] Instance already installed:', instanceId)
          return state
        }
      }
      
      // Get manifest from cache
      const cached = state.manifestCache.get(attachment.url)
      const appName = cached?.name || attachment.name || 'Webxdc App'
      const icon = cached?.icon
      
      // Get or create app group
      const apps = new Map(convData.apps)
      let group = apps.get(appName)
      
      if (!group) {
        group = {
          appName,
          icon,
          instances: [],
        }
      } else {
        group = { ...group, instances: [...group.instances] }
      }
      
      // Add instance
      group.instances.push({
        instanceId,
        attachmentUrl: attachment.url,
        messageId: '', // Will be set by caller if needed
        installedAt: Date.now(),
        conversationId,
        attachment,
      })
      
      apps.set(appName, group)
      convData = { ...convData, apps }
      installations.set(conversationId, convData)
      
      saveInstallations(installations)
      return { installations }
    })
  },
  
  isInstalled: (conversationId, instanceId) => {
    const convData = get().installations.get(conversationId)
    if (!convData) return false
    
    for (const group of convData.apps.values()) {
      if (group.instances.some(inst => inst.instanceId === instanceId)) {
        return true
      }
    }
    return false
  },
  
  getAppGroup: (conversationId, appName) => {
    const convData = get().installations.get(conversationId)
    return convData?.apps.get(appName)
  },
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- webxdcPanelStore.test.ts`
Expected: All installApp tests PASS

- [ ] **Step 9: Write failing tests for removeApp and removeInstance**

Add to `webxdcPanelStore.test.ts`:

```typescript
  describe('removeApp', () => {
    beforeEach(() => {
      const { cacheManifest, installApp } = useWebxdcPanelStore.getState()
      
      cacheManifest('https://example.com/app.xdc', {
        name: 'Tic Tac Toe',
        sha256: 'abc123',
      })
      
      installApp('room@conference.example.com', 'room@conference.example.com:uuid1', {
        url: 'https://example.com/app.xdc',
        name: 'tictactoe.xdc',
        mime: 'application/xdc',
      })
      
      installApp('room@conference.example.com', 'room@conference.example.com:uuid2', {
        url: 'https://example.com/app2.xdc',
        name: 'tictactoe.xdc',
        mime: 'application/xdc',
      })
    })

    it('removes all instances of an app', () => {
      const { removeApp, getAppGroup } = useWebxdcPanelStore.getState()
      
      removeApp('room@conference.example.com', 'Tic Tac Toe')
      
      const group = getAppGroup('room@conference.example.com', 'Tic Tac Toe')
      expect(group).toBeUndefined()
    })

    it('marks instances as not installed', () => {
      const { removeApp, isInstalled } = useWebxdcPanelStore.getState()
      
      removeApp('room@conference.example.com', 'Tic Tac Toe')
      
      expect(isInstalled('room@conference.example.com', 'room@conference.example.com:uuid1')).toBe(false)
      expect(isInstalled('room@conference.example.com', 'room@conference.example.com:uuid2')).toBe(false)
    })

    it('persists removal to localStorage', () => {
      const { removeApp } = useWebxdcPanelStore.getState()
      
      removeApp('room@conference.example.com', 'Tic Tac Toe')
      
      const stored = localStorage.getItem('webxdc-installations')
      const parsed = JSON.parse(stored!)
      const convData = parsed.find((e: any) => e[0] === 'room@conference.example.com')
      expect(convData[1].apps).toHaveLength(0)
    })
  })

  describe('removeInstance', () => {
    beforeEach(() => {
      const { cacheManifest, installApp } = useWebxdcPanelStore.getState()
      
      cacheManifest('https://example.com/app.xdc', {
        name: 'Tic Tac Toe',
        sha256: 'abc123',
      })
      
      installApp('room@conference.example.com', 'room@conference.example.com:uuid1', {
        url: 'https://example.com/app.xdc',
        name: 'tictactoe.xdc',
        mime: 'application/xdc',
      })
      
      installApp('room@conference.example.com', 'room@conference.example.com:uuid2', {
        url: 'https://example.com/app2.xdc',
        name: 'tictactoe.xdc',
        mime: 'application/xdc',
      })
    })

    it('removes single instance from group', () => {
      const { removeInstance, getAppGroup } = useWebxdcPanelStore.getState()
      
      removeInstance('room@conference.example.com', 'room@conference.example.com:uuid1')
      
      const group = getAppGroup('room@conference.example.com', 'Tic Tac Toe')
      expect(group?.instances).toHaveLength(1)
      expect(group?.instances[0].instanceId).toBe('room@conference.example.com:uuid2')
    })

    it('removes entire group when last instance removed', () => {
      const { removeInstance, getAppGroup } = useWebxdcPanelStore.getState()
      
      removeInstance('room@conference.example.com', 'room@conference.example.com:uuid1')
      removeInstance('room@conference.example.com', 'room@conference.example.com:uuid2')
      
      const group = getAppGroup('room@conference.example.com', 'Tic Tac Toe')
      expect(group).toBeUndefined()
    })
  })
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npm test -- webxdcPanelStore.test.ts`
Expected: removeApp and removeInstance tests FAIL with "Not implemented"

- [ ] **Step 11: Implement removeApp and removeInstance**

Update `webxdcPanelStore.ts`:

```typescript
  removeApp: (conversationId, appName) => {
    set((state) => {
      const installations = new Map(state.installations)
      const convData = installations.get(conversationId)
      
      if (!convData) return state
      
      const apps = new Map(convData.apps)
      apps.delete(appName)
      
      installations.set(conversationId, { ...convData, apps })
      saveInstallations(installations)
      return { installations }
    })
  },
  
  removeInstance: (conversationId, instanceId) => {
    set((state) => {
      const installations = new Map(state.installations)
      const convData = installations.get(conversationId)
      
      if (!convData) return state
      
      const apps = new Map(convData.apps)
      let groupToRemove: string | null = null
      
      for (const [appName, group] of apps.entries()) {
        const filtered = group.instances.filter(inst => inst.instanceId !== instanceId)
        
        if (filtered.length !== group.instances.length) {
          // Instance was found and removed
          if (filtered.length === 0) {
            // Last instance removed, delete entire group
            groupToRemove = appName
          } else {
            apps.set(appName, { ...group, instances: filtered })
          }
          break
        }
      }
      
      if (groupToRemove) {
        apps.delete(groupToRemove)
      }
      
      installations.set(conversationId, { ...convData, apps })
      saveInstallations(installations)
      return { installations }
    })
  },
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npm test -- webxdcPanelStore.test.ts`
Expected: All removeApp and removeInstance tests PASS

- [ ] **Step 13: Write failing tests for remaining actions**

Add to `webxdcPanelStore.test.ts`:

```typescript
  describe('setPanelOpen', () => {
    it('sets panel open state for conversation', () => {
      const { setPanelOpen, isPanelOpen } = useWebxdcPanelStore.getState()
      
      setPanelOpen('room@conference.example.com', true)
      expect(isPanelOpen('room@conference.example.com')).toBe(true)
      
      setPanelOpen('room@conference.example.com', false)
      expect(isPanelOpen('room@conference.example.com')).toBe(false)
    })

    it('creates conversation entry if needed', () => {
      const { setPanelOpen, isPanelOpen } = useWebxdcPanelStore.getState()
      
      setPanelOpen('new@example.com', true)
      expect(isPanelOpen('new@example.com')).toBe(true)
    })
  })

  describe('getInstalledApps', () => {
    beforeEach(() => {
      const { cacheManifest, installApp } = useWebxdcPanelStore.getState()
      
      cacheManifest('https://example.com/app1.xdc', {
        name: 'App A',
        sha256: 'hash1',
      })
      
      cacheManifest('https://example.com/app2.xdc', {
        name: 'App B',
        sha256: 'hash2',
      })
      
      installApp('room@conference.example.com', 'room@conference.example.com:uuid1', {
        url: 'https://example.com/app1.xdc',
        name: 'app1.xdc',
        mime: 'application/xdc',
      })
      
      installApp('room@conference.example.com', 'room@conference.example.com:uuid2', {
        url: 'https://example.com/app2.xdc',
        name: 'app2.xdc',
        mime: 'application/xdc',
      })
    })

    it('returns all installed apps for conversation', () => {
      const { getInstalledApps } = useWebxdcPanelStore.getState()
      
      const apps = getInstalledApps('room@conference.example.com')
      expect(apps).toHaveLength(2)
      
      const names = apps.map(g => g.appName).sort()
      expect(names).toEqual(['App A', 'App B'])
    })

    it('sorts by most recently installed', () => {
      const { getInstalledApps } = useWebxdcPanelStore.getState()
      
      const apps = getInstalledApps('room@conference.example.com')
      // App B was installed last
      expect(apps[0].appName).toBe('App B')
    })

    it('returns empty array for conversation with no apps', () => {
      const { getInstalledApps } = useWebxdcPanelStore.getState()
      
      const apps = getInstalledApps('other@example.com')
      expect(apps).toEqual([])
    })
  })

  describe('removeConversation', () => {
    beforeEach(() => {
      const { cacheManifest, installApp, setPanelOpen } = useWebxdcPanelStore.getState()
      
      cacheManifest('https://example.com/app.xdc', {
        name: 'Test App',
        sha256: 'hash',
      })
      
      installApp('room@conference.example.com', 'room@conference.example.com:uuid1', {
        url: 'https://example.com/app.xdc',
        name: 'app.xdc',
        mime: 'application/xdc',
      })
      
      setPanelOpen('room@conference.example.com', true)
    })

    it('removes all conversation data', () => {
      const { removeConversation, getInstalledApps, isPanelOpen } = useWebxdcPanelStore.getState()
      
      removeConversation('room@conference.example.com')
      
      expect(getInstalledApps('room@conference.example.com')).toEqual([])
      expect(isPanelOpen('room@conference.example.com')).toBe(false)
    })
  })
})
```

- [ ] **Step 14: Run test to verify it fails**

Run: `npm test -- webxdcPanelStore.test.ts`
Expected: setPanelOpen, getInstalledApps, removeConversation tests FAIL

- [ ] **Step 15: Implement remaining actions**

Update `webxdcPanelStore.ts`:

```typescript
  setPanelOpen: (conversationId, open) => {
    set((state) => {
      const installations = new Map(state.installations)
      
      let convData = installations.get(conversationId)
      if (!convData) {
        convData = { apps: new Map(), panelOpen: false }
      }
      
      convData = { ...convData, panelOpen: open }
      installations.set(conversationId, convData)
      
      saveInstallations(installations)
      return { installations }
    })
  },
  
  getInstalledApps: (conversationId) => {
    const convData = get().installations.get(conversationId)
    if (!convData) return []
    
    const groups = Array.from(convData.apps.values())
    
    // Sort by most recently installed (max installedAt across instances)
    return groups.sort((a, b) => {
      const aMax = Math.max(...a.instances.map(inst => inst.installedAt))
      const bMax = Math.max(...b.instances.map(inst => inst.installedAt))
      return bMax - aMax
    })
  },
  
  isPanelOpen: (conversationId) => {
    const convData = get().installations.get(conversationId)
    return convData?.panelOpen ?? false
  },
  
  removeConversation: (conversationId) => {
    set((state) => {
      const installations = new Map(state.installations)
      installations.delete(conversationId)
      
      saveInstallations(installations)
      return { installations }
    })
  },
```

- [ ] **Step 16: Run test to verify it passes**

Run: `npm test -- webxdcPanelStore.test.ts`
Expected: All tests PASS

- [ ] **Step 17: Implement createNewInstance (calls Tauri)**

Add test to `webxdcPanelStore.test.ts`:

```typescript
  describe('createNewInstance', () => {
    beforeEach(() => {
      const { cacheManifest, installApp } = useWebxdcPanelStore.getState()
      
      cacheManifest('https://example.com/app.xdc', {
        name: 'Tic Tac Toe',
        sha256: 'hash',
      })
      
      installApp('room@conference.example.com', 'room@conference.example.com:uuid1', {
        url: 'https://example.com/app.xdc',
        name: 'app.xdc',
        mime: 'application/xdc',
      })
    })

    it('creates new instance and adds to group', async () => {
      // Mock Tauri command
      vi.mock('@tauri-apps/api/core', () => ({
        invoke: vi.fn().mockResolvedValue({ instance_id: 'room@conference.example.com:uuid-new' }),
      }))

      const { createNewInstance, getAppGroup } = useWebxdcPanelStore.getState()
      
      const newId = await createNewInstance('room@conference.example.com', 'Tic Tac Toe', 'room@conference.example.com:uuid1')
      
      expect(newId).toBe('room@conference.example.com:uuid-new')
      
      const group = getAppGroup('room@conference.example.com', 'Tic Tac Toe')
      expect(group?.instances).toHaveLength(2)
      expect(group?.instances.some(inst => inst.instanceId === newId)).toBe(true)
    })
  })
```

Update `webxdcPanelStore.ts`:

```typescript
import { invoke } from '@tauri-apps/api/core'

  createNewInstance: async (conversationId, appName, baseInstanceId) => {
    // Call Tauri to create new instance
    const { instance_id } = await invoke<{ instance_id: string }>('webxdc_create_new_instance', {
      baseInstanceId,
    })
    
    // Get base instance's attachment
    const group = get().getAppGroup(conversationId, appName)
    if (!group) {
      throw new Error('App group not found')
    }
    
    const baseInstance = group.instances.find(inst => inst.instanceId === baseInstanceId)
    if (!baseInstance) {
      throw new Error('Base instance not found')
    }
    
    // Install new instance with same attachment
    get().installApp(conversationId, instance_id, baseInstance.attachment)
    
    return instance_id
  },
```

- [ ] **Step 18: Run test to verify createNewInstance passes**

Run: `npm test -- webxdcPanelStore.test.ts`
Expected: All tests PASS

- [ ] **Step 19: Commit store implementation**

```bash
git add apps/fluux/src/stores/webxdcPanelStore.ts apps/fluux/src/stores/webxdcPanelStore.test.ts
git commit -m "feat(webxdc): add webxdcPanelStore for app management

Zustand store with localStorage persistence for:
- Manifest caching (TTL 7 days, max 100 entries)
- Per-conversation app installations
- Panel open/closed state
- Install/remove/reset operations

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 3: Enhanced WebxdcAttachment Component

**Files:**
- Modify: `apps/fluux/src/components/WebxdcAttachment.tsx`
- Modify: `apps/fluux/src/components/WebxdcAttachment.test.tsx`

**Interfaces:**
- Consumes:
  - `useWebxdcPanelStore` from `@/stores/webxdcPanelStore`
  - `invoke` from `@tauri-apps/api/core`
  - `getInstanceId` from `@/utils/webxdc/instanceId`
- Produces: Enhanced attachment card with manifest name, VirusTotal link, Install/Remove buttons

- [ ] **Step 1: Write failing test for manifest extraction**

Open `apps/fluux/src/components/WebxdcAttachment.test.tsx` and add:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { WebxdcAttachment } from './WebxdcAttachment'
import type { FileAttachment } from '@fluux/sdk'

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

// Mock webxdcPanelStore
vi.mock('@/stores/webxdcPanelStore', () => ({
  useWebxdcPanelStore: vi.fn(),
}))

// Mock webxdc utils
vi.mock('@/utils/webxdc/instanceId', () => ({
  getInstanceId: vi.fn((conversationId, url) => `${conversationId}:uuid-${url.slice(-4)}`),
}))

vi.mock('@/utils/webxdc/webxdcWindow', () => ({
  openWebxdcWindow: vi.fn(),
}))

describe('WebxdcAttachment', () => {
  const mockAttachment: FileAttachment = {
    url: 'https://example.com/tictactoe.xdc',
    name: 'zb2rhWiqDaq7Pkwo3XPeKRDyzxp1a1QDhD8wyXVXVzbmFZAs.xdc',
    mime: 'application/xdc',
    size: 245 * 1024, // 245 KB
  }

  const conversationId = 'room@conference.example.com'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows filename initially while manifest loads', () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    const { invoke } = require('@tauri-apps/api/core')
    
    useWebxdcPanelStore.mockReturnValue({
      manifestCache: new Map(),
      cacheManifest: vi.fn(),
      isInstalled: vi.fn(() => false),
      installApp: vi.fn(),
    })
    
    // Slow manifest extraction
    invoke.mockImplementation(() => new Promise(() => {}))
    
    render(<WebxdcAttachment attachment={mockAttachment} conversationId={conversationId} />)
    
    expect(screen.getByText(/zb2rhWiq.*xdc/)).toBeInTheDocument()
  })

  it('shows manifest name after extraction', async () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    const { invoke } = require('@tauri-apps/api/core')
    
    const mockCacheManifest = vi.fn()
    
    useWebxdcPanelStore.mockReturnValue({
      manifestCache: new Map(),
      cacheManifest: mockCacheManifest,
      isInstalled: vi.fn(() => false),
      installApp: vi.fn(),
    })
    
    invoke.mockImplementation((cmd) => {
      if (cmd === 'webxdc_extract_manifest') {
        return Promise.resolve({ name: 'Tic Tac Toe', icon: 'icon.png' })
      }
      if (cmd === 'webxdc_compute_hash') {
        return Promise.resolve({ sha256: 'abc123def456' })
      }
      return Promise.reject(new Error('Unknown command'))
    })
    
    render(<WebxdcAttachment attachment={mockAttachment} conversationId={conversationId} />)
    
    await waitFor(() => {
      expect(screen.getByText('Tic Tac Toe')).toBeInTheDocument()
    })
    
    expect(mockCacheManifest).toHaveBeenCalledWith(
      mockAttachment.url,
      expect.objectContaining({
        name: 'Tic Tac Toe',
        icon: 'icon.png',
        sha256: 'abc123def456',
      })
    )
  })

  it('shows filename when manifest extraction fails', async () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    const { invoke } = require('@tauri-apps/api/core')
    
    useWebxdcPanelStore.mockReturnValue({
      manifestCache: new Map(),
      cacheManifest: vi.fn(),
      isInstalled: vi.fn(() => false),
      installApp: vi.fn(),
    })
    
    invoke.mockRejectedValue(new Error('Extraction failed'))
    
    render(<WebxdcAttachment attachment={mockAttachment} conversationId={conversationId} />)
    
    await waitFor(() => {
      expect(screen.getByText(/zb2rhWiq.*xdc/)).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- WebxdcAttachment.test.tsx`
Expected: Tests FAIL (manifest name not shown)

- [ ] **Step 3: Implement manifest extraction in WebxdcAttachment**

Open `apps/fluux/src/components/WebxdcAttachment.tsx` and replace with:

```typescript
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Package, Loader2, ExternalLink } from 'lucide-react'
import type { FileAttachment } from '@fluux/sdk'
import { formatBytes } from '@/hooks'
import { invoke } from '@tauri-apps/api/core'
import { getInstanceId } from '@/utils/webxdc/instanceId'
import { openWebxdcWindow } from '@/utils/webxdc/webxdcWindow'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'
import { Tooltip } from './Tooltip'

interface WebxdcAttachmentProps {
  attachment: FileAttachment
  conversationId: string
}

export function WebxdcAttachment({ attachment, conversationId }: WebxdcAttachmentProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [extracting, setExtracting] = useState(true)
  
  const { manifestCache, cacheManifest, isInstalled, installApp, removeInstance } = useWebxdcPanelStore()
  
  const instanceId = getInstanceId(conversationId, attachment.url)
  const installed = isInstalled(conversationId, instanceId)
  
  // Get cached manifest or use filename
  const cached = manifestCache.get(attachment.url)
  const displayName = cached?.name || attachment.name || 'Webxdc App'
  const sha256 = cached?.sha256

  // Extract manifest on mount
  useEffect(() => {
    // Skip if already cached
    if (cached) {
      setExtracting(false)
      return
    }

    let cancelled = false

    async function extract() {
      try {
        // Extract manifest and compute hash in parallel
        const [manifestResult, hashResult] = await Promise.allSettled([
          invoke<{ name: string; icon?: string }>('webxdc_extract_manifest', {
            url: attachment.url,
            filename: attachment.name || 'app.xdc',
            decryptKey: attachment.encryption?.key,
            decryptIv: attachment.encryption?.iv,
          }),
          invoke<{ sha256: string }>('webxdc_compute_hash', {
            url: attachment.url,
            decryptKey: attachment.encryption?.key,
            decryptIv: attachment.encryption?.iv,
          }),
        ])

        if (cancelled) return

        const manifest = manifestResult.status === 'fulfilled'
          ? manifestResult.value
          : { name: attachment.name || 'Webxdc App' }

        const hash = hashResult.status === 'fulfilled'
          ? hashResult.value.sha256
          : ''

        // Cache result
        cacheManifest(attachment.url, {
          name: manifest.name,
          icon: manifest.icon,
          sha256: hash,
        })
      } catch (error) {
        console.error('[webxdc] Failed to extract manifest:', error)
        // Cache fallback
        cacheManifest(attachment.url, {
          name: attachment.name || 'Webxdc App',
          sha256: '',
        })
      } finally {
        if (!cancelled) {
          setExtracting(false)
        }
      }
    }

    extract()

    return () => {
      cancelled = true
    }
  }, [attachment.url, attachment.name, attachment.encryption, cached, cacheManifest])

  const handleOpen = async () => {
    setBusy(true)
    try {
      await openWebxdcWindow(attachment, conversationId)
    } catch (error) {
      console.error('[webxdc] Failed to open app:', error)
    } finally {
      setBusy(false)
    }
  }

  const handleInstall = () => {
    installApp(conversationId, instanceId, attachment)
  }

  const handleRemove = () => {
    removeInstance(conversationId, instanceId)
  }

  const virusTotalUrl = sha256
    ? `https://www.virustotal.com/gui/file/${sha256}/details`
    : null

  return (
    <div className="pt-2 max-w-sm">
      {/* App card */}
      <button
        type="button"
        onClick={installed ? handleOpen : undefined}
        disabled={busy || !installed}
        className={`flex items-center gap-3 p-3 w-full rounded-lg bg-fluux-bg/60 border border-fluux-border transition-colors text-start ${
          installed ? 'hover:bg-fluux-hover/60 cursor-pointer' : 'cursor-default'
        } ${busy ? 'opacity-70' : ''}`}
        tabIndex={installed ? 0 : -1}
      >
        <div className="size-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-purple-500/20 text-purple-500">
          {busy || extracting ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Package className="size-5" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-fluux-text truncate">
            {displayName}
          </p>
          <p className="text-xs text-fluux-muted">
            {t('chat.webxdcApp')}
            {attachment.size && ` • ${formatBytes(attachment.size)}`}
          </p>
        </div>
      </button>

      {/* Actions: VirusTotal + Install/Remove */}
      <div className="flex items-center gap-3 mt-2 px-1">
        {/* VirusTotal link */}
        {virusTotalUrl ? (
          <a
            href={virusTotalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-fluux-muted hover:text-fluux-text transition-colors"
          >
            <ExternalLink className="size-3" />
            VirusTotal
          </a>
        ) : (
          <Tooltip content={t('webxdc.hashUnavailable', 'Hash unavailable')} position="top">
            <span className="flex items-center gap-1.5 text-xs text-fluux-muted/40 cursor-not-allowed">
              <ExternalLink className="size-3" />
              VirusTotal
            </span>
          </Tooltip>
        )}

        {/* Install / Remove button */}
        {installed ? (
          <button
            type="button"
            onClick={handleRemove}
            className="text-xs text-fluux-error hover:underline"
          >
            {t('webxdc.remove', 'Remove')}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleInstall}
            disabled={extracting}
            className="text-xs text-fluux-brand hover:underline disabled:opacity-50"
          >
            {extracting ? t('common.loading', 'Loading...') : t('webxdc.install', 'Install App')}
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- WebxdcAttachment.test.tsx`
Expected: All tests PASS

- [ ] **Step 5: Write test for Install/Remove buttons**

Add to `WebxdcAttachment.test.tsx`:

```typescript
  it('shows Install button when not installed', () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    
    useWebxdcPanelStore.mockReturnValue({
      manifestCache: new Map([[mockAttachment.url, { name: 'Test App', sha256: 'hash123', extractedAt: Date.now() }]]),
      cacheManifest: vi.fn(),
      isInstalled: vi.fn(() => false),
      installApp: vi.fn(),
    })
    
    render(<WebxdcAttachment attachment={mockAttachment} conversationId={conversationId} />)
    
    expect(screen.getByText('Install App')).toBeInTheDocument()
  })

  it('shows Remove button when installed', () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    
    useWebxdcPanelStore.mockReturnValue({
      manifestCache: new Map([[mockAttachment.url, { name: 'Test App', sha256: 'hash123', extractedAt: Date.now() }]]),
      cacheManifest: vi.fn(),
      isInstalled: vi.fn(() => true),
      removeInstance: vi.fn(),
    })
    
    render(<WebxdcAttachment attachment={mockAttachment} conversationId={conversationId} />)
    
    expect(screen.getByText('Remove')).toBeInTheDocument()
  })

  it('calls installApp when Install clicked', async () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    const mockInstallApp = vi.fn()
    
    useWebxdcPanelStore.mockReturnValue({
      manifestCache: new Map([[mockAttachment.url, { name: 'Test App', sha256: 'hash123', extractedAt: Date.now() }]]),
      cacheManifest: vi.fn(),
      isInstalled: vi.fn(() => false),
      installApp: mockInstallApp,
    })
    
    render(<WebxdcAttachment attachment={mockAttachment} conversationId={conversationId} />)
    
    const installBtn = screen.getByText('Install App')
    await userEvent.click(installBtn)
    
    expect(mockInstallApp).toHaveBeenCalledWith(
      conversationId,
      expect.stringContaining('room@conference.example.com:'),
      mockAttachment
    )
  })

  it('shows VirusTotal link with hash', () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    
    useWebxdcPanelStore.mockReturnValue({
      manifestCache: new Map([[mockAttachment.url, { name: 'Test App', sha256: 'abc123def456', extractedAt: Date.now() }]]),
      cacheManifest: vi.fn(),
      isInstalled: vi.fn(() => false),
      installApp: vi.fn(),
    })
    
    render(<WebxdcAttachment attachment={mockAttachment} conversationId={conversationId} />)
    
    const link = screen.getByText('VirusTotal').closest('a')
    expect(link).toHaveAttribute('href', 'https://www.virustotal.com/gui/file/abc123def456/details')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('disables VirusTotal link when hash unavailable', () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    
    useWebxdcPanelStore.mockReturnValue({
      manifestCache: new Map([[mockAttachment.url, { name: 'Test App', sha256: '', extractedAt: Date.now() }]]),
      cacheManifest: vi.fn(),
      isInstalled: vi.fn(() => false),
      installApp: vi.fn(),
    })
    
    render(<WebxdcAttachment attachment={mockAttachment} conversationId={conversationId} />)
    
    const link = screen.getByText('VirusTotal').closest('span')
    expect(link).toHaveClass('cursor-not-allowed')
  })
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- WebxdcAttachment.test.tsx`
Expected: All tests PASS

- [ ] **Step 7: Commit WebxdcAttachment enhancements**

```bash
git add apps/fluux/src/components/WebxdcAttachment.tsx apps/fluux/src/components/WebxdcAttachment.test.tsx
git commit -m "feat(webxdc): enhance attachment card with manifest and install

Show manifest name instead of filename
Add background manifest extraction and SHA256 hashing
Add VirusTotal link for security transparency
Add Install/Remove buttons for panel integration

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 4: WebxdcAppPanel Component

**Files:**
- Create: `apps/fluux/src/components/WebxdcAppPanel.tsx`
- Create: `apps/fluux/src/components/WebxdcAppPanel.test.tsx`

**Interfaces:**
- Consumes:
  - `useWebxdcPanelStore` from `@/stores/webxdcPanelStore`
  - `openWebxdcWindow` from `@/utils/webxdc/webxdcWindow`
  - `useVirtualizer` from `@tanstack/react-virtual`
- Produces: `WebxdcAppPanel({ conversationId, onClose, fullScreen? })` component

- [ ] **Step 1: Write failing test for empty state**

Create `apps/fluux/src/components/WebxdcAppPanel.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WebxdcAppPanel } from './WebxdcAppPanel'

// Mock dependencies
vi.mock('@/stores/webxdcPanelStore', () => ({
  useWebxdcPanelStore: vi.fn(),
}))

vi.mock('@/utils/webxdc/webxdcWindow', () => ({
  openWebxdcWindow: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('WebxdcAppPanel', () => {
  const mockOnClose = vi.fn()
  const conversationId = 'room@conference.example.com'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders empty state when no apps installed', () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    
    useWebxdcPanelStore.mockReturnValue({
      getInstalledApps: vi.fn(() => []),
      manifestCache: new Map(),
    })
    
    render(<WebxdcAppPanel conversationId={conversationId} onClose={mockOnClose} />)
    
    expect(screen.getByText('webxdc.noAppsInstalled')).toBeInTheDocument()
    expect(screen.getByText('webxdc.installFromAttachments')).toBeInTheDocument()
  })

  it('shows panel header with title and close button', () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    
    useWebxdcPanelStore.mockReturnValue({
      getInstalledApps: vi.fn(() => []),
      manifestCache: new Map(),
    })
    
    render(<WebxdcAppPanel conversationId={conversationId} onClose={mockOnClose} />)
    
    expect(screen.getByText('webxdc.apps')).toBeInTheDocument()
    expect(screen.getByLabelText('webxdc.closePanel')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- WebxdcAppPanel.test.tsx`
Expected: FAIL with "Cannot find module './WebxdcAppPanel'"

- [ ] **Step 3: Create WebxdcAppPanel with empty state**

Create `apps/fluux/src/components/WebxdcAppPanel.tsx`:

```typescript
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { X, ArrowLeft, Package } from 'lucide-react'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'
import { Tooltip } from './Tooltip'

export interface WebxdcAppPanelProps {
  conversationId: string
  onClose: () => void
  fullScreen?: boolean
}

export function WebxdcAppPanel({ conversationId, onClose, fullScreen = false }: WebxdcAppPanelProps) {
  const { t } = useTranslation()
  const { getInstalledApps } = useWebxdcPanelStore()
  
  const apps = getInstalledApps(conversationId)
  
  return (
    <div className={`${fullScreen ? 'w-full h-full' : 'w-64 border-s border-fluux-bg'} flex flex-col bg-fluux-chat`}>
      {/* Panel header */}
      <div className="h-14 px-4 flex items-center justify-between border-b border-fluux-bg">
        {fullScreen ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors"
              aria-label={t('webxdc.back')}
            >
              <ArrowLeft className="size-5 rtl-mirror" />
            </button>
            <h3 className="font-semibold text-fluux-text">{t('webxdc.apps')}</h3>
          </div>
        ) : (
          <>
            <h3 className="font-semibold text-fluux-text">{t('webxdc.apps')}</h3>
            <Tooltip content={t('webxdc.closePanel')} position="left">
              <button
                type="button"
                onClick={onClose}
                aria-label={t('webxdc.closePanel')}
                className="p-1 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors tap-target"
              >
                <X className="size-4" />
              </button>
            </Tooltip>
          </>
        )}
      </div>

      {/* App list */}
      <div className="flex-1 overflow-y-auto">
        {apps.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <Package className="size-12 mx-auto mb-3 text-fluux-muted/40" />
            <p className="text-sm font-medium text-fluux-text mb-1">
              {t('webxdc.noAppsInstalled')}
            </p>
            <p className="text-xs text-fluux-muted">
              {t('webxdc.installFromAttachments')}
            </p>
          </div>
        ) : (
          <div>App list rendering...</div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- WebxdcAppPanel.test.tsx`
Expected: Empty state tests PASS

- [ ] **Step 5: Write failing test for app list rendering**

Add to `WebxdcAppPanel.test.tsx`:

```typescript
  it('renders installed apps', () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    
    const mockApps = [
      {
        appName: 'Tic Tac Toe',
        icon: 'icon.png',
        instances: [
          {
            instanceId: 'room@conference.example.com:uuid1',
            attachmentUrl: 'https://example.com/app1.xdc',
            messageId: 'msg1',
            installedAt: Date.now(),
            conversationId,
            attachment: { url: 'https://example.com/app1.xdc', name: 'app.xdc', mime: 'application/xdc' },
          },
        ],
      },
      {
        appName: 'Chess',
        instances: [
          {
            instanceId: 'room@conference.example.com:uuid2',
            attachmentUrl: 'https://example.com/chess.xdc',
            messageId: 'msg2',
            installedAt: Date.now() - 1000,
            conversationId,
            attachment: { url: 'https://example.com/chess.xdc', name: 'chess.xdc', mime: 'application/xdc' },
          },
        ],
      },
    ]
    
    useWebxdcPanelStore.mockReturnValue({
      getInstalledApps: vi.fn(() => mockApps),
      manifestCache: new Map(),
    })
    
    render(<WebxdcAppPanel conversationId={conversationId} onClose={mockOnClose} />)
    
    expect(screen.getByText('Tic Tac Toe')).toBeInTheDocument()
    expect(screen.getByText('Chess')).toBeInTheDocument()
  })

  it('shows instance count badge for multiple instances', () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    
    const mockApps = [
      {
        appName: 'Tic Tac Toe',
        instances: [
          { instanceId: 'id1', attachmentUrl: 'url1', messageId: 'msg1', installedAt: Date.now(), conversationId, attachment: {} },
          { instanceId: 'id2', attachmentUrl: 'url2', messageId: 'msg2', installedAt: Date.now(), conversationId, attachment: {} },
          { instanceId: 'id3', attachmentUrl: 'url3', messageId: 'msg3', installedAt: Date.now(), conversationId, attachment: {} },
        ],
      },
    ]
    
    useWebxdcPanelStore.mockReturnValue({
      getInstalledApps: vi.fn(() => mockApps),
      manifestCache: new Map(),
    })
    
    render(<WebxdcAppPanel conversationId={conversationId} onClose={mockOnClose} />)
    
    expect(screen.getByText('(3)')).toBeInTheDocument()
  })

  it('hides count badge for single instance', () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    
    const mockApps = [
      {
        appName: 'Tic Tac Toe',
        instances: [
          { instanceId: 'id1', attachmentUrl: 'url1', messageId: 'msg1', installedAt: Date.now(), conversationId, attachment: {} },
        ],
      },
    ]
    
    useWebxdcPanelStore.mockReturnValue({
      getInstalledApps: vi.fn(() => mockApps),
      manifestCache: new Map(),
    })
    
    render(<WebxdcAppPanel conversationId={conversationId} onClose={mockOnClose} />)
    
    expect(screen.queryByText(/\(\d+\)/)).not.toBeInTheDocument()
  })
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- WebxdcAppPanel.test.tsx`
Expected: App rendering tests FAIL

- [ ] **Step 7: Implement app list rendering**

Update `WebxdcAppPanel.tsx`:

```typescript
import { useState } from 'react'
import { MoreVertical, Package as PackageIcon } from 'lucide-react'
import { openWebxdcWindow } from '@/utils/webxdc/webxdcWindow'
import type { WebxdcAppGroup } from '@/stores/webxdcPanelStore'

export function WebxdcAppPanel({ conversationId, onClose, fullScreen = false }: WebxdcAppPanelProps) {
  const { t } = useTranslation()
  const { getInstalledApps, removeApp, createNewInstance } = useWebxdcPanelStore()
  
  const apps = getInstalledApps(conversationId)
  const scrollRef = useRef<HTMLDivElement>(null)
  
  const virtualizer = useVirtualizer({
    count: apps.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 5,
  })

  const handleOpenApp = async (group: WebxdcAppGroup) => {
    // Get most recent instance
    const sorted = [...group.instances].sort((a, b) => b.installedAt - a.installedAt)
    const mostRecent = sorted[0]
    
    if (!mostRecent) return
    
    try {
      await openWebxdcWindow(mostRecent.attachment, conversationId)
    } catch (error) {
      console.error('[webxdc] Failed to open app:', error)
    }
  }

  return (
    <div className={`${fullScreen ? 'w-full h-full' : 'w-64 border-s border-fluux-bg'} flex flex-col bg-fluux-chat`}>
      {/* ... header same as before ... */}

      {/* App list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {apps.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <PackageIcon className="size-12 mx-auto mb-3 text-fluux-muted/40" />
            <p className="text-sm font-medium text-fluux-text mb-1">
              {t('webxdc.noAppsInstalled')}
            </p>
            <p className="text-xs text-fluux-muted">
              {t('webxdc.installFromAttachments')}
            </p>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const group = apps[virtualRow.index]
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <AppGroupItem
                    group={group}
                    conversationId={conversationId}
                    onOpen={() => handleOpenApp(group)}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function AppGroupItem({
  group,
  conversationId,
  onOpen,
}: {
  group: WebxdcAppGroup
  conversationId: string
  onOpen: () => void
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  
  const hasMultiple = group.instances.length > 1

  return (
    <div className="px-4 py-2 border-b border-fluux-bg/50">
      <div className="flex items-center gap-3">
        {/* App icon */}
        <div className="size-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-purple-500/20 text-purple-500">
          <PackageIcon className="size-5" />
        </div>

        {/* App name + count */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fluux-text truncate">
              {group.appName}
            </span>
            {hasMultiple && (
              <span className="text-xs text-fluux-muted">
                ({group.instances.length})
              </span>
            )}
          </div>
        </div>

        {/* Kebab menu */}
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          className="p-1 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors"
          aria-label={t('common.more')}
        >
          <MoreVertical className="size-4" />
        </button>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-3 mt-2">
        <button
          type="button"
          onClick={onOpen}
          className="text-xs text-fluux-brand hover:underline font-medium"
        >
          {t('webxdc.open')}
        </button>
        {hasMultiple && (
          <button
            type="button"
            className="text-xs text-fluux-muted hover:text-fluux-text hover:underline"
          >
            {t('webxdc.viewAll')}
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- WebxdcAppPanel.test.tsx`
Expected: All app rendering tests PASS

- [ ] **Step 9: Write test for Open button**

Add to `WebxdcAppPanel.test.tsx`:

```typescript
  it('opens most recent instance when Open clicked', async () => {
    const { useWebxdcPanelStore } = require('@/stores/webxdcPanelStore')
    const { openWebxdcWindow } = require('@/utils/webxdc/webxdcWindow')
    
    const oldInstance = {
      instanceId: 'old',
      attachmentUrl: 'url1',
      messageId: 'msg1',
      installedAt: Date.now() - 10000,
      conversationId,
      attachment: { url: 'url1', name: 'old.xdc', mime: 'application/xdc' },
    }
    
    const newInstance = {
      instanceId: 'new',
      attachmentUrl: 'url2',
      messageId: 'msg2',
      installedAt: Date.now(),
      conversationId,
      attachment: { url: 'url2', name: 'new.xdc', mime: 'application/xdc' },
    }
    
    const mockApps = [
      {
        appName: 'Test App',
        instances: [oldInstance, newInstance], // Unsorted
      },
    ]
    
    useWebxdcPanelStore.mockReturnValue({
      getInstalledApps: vi.fn(() => mockApps),
      manifestCache: new Map(),
    })
    
    render(<WebxdcAppPanel conversationId={conversationId} onClose={mockOnClose} />)
    
    const openBtn = screen.getByText('webxdc.open')
    await userEvent.click(openBtn)
    
    expect(openWebxdcWindow).toHaveBeenCalledWith(newInstance.attachment, conversationId)
  })
```

- [ ] **Step 10: Run test to verify Open button works**

Run: `npm test -- WebxdcAppPanel.test.tsx`
Expected: Open button test PASS

- [ ] **Step 11: Implement kebab menu actions (Reset, Remove)**

Update `AppGroupItem` in `WebxdcAppPanel.tsx`:

```typescript
function AppGroupItem({
  group,
  conversationId,
  onOpen,
}: {
  group: WebxdcAppGroup
  conversationId: string
  onOpen: () => void
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  
  const { removeApp, createNewInstance } = useWebxdcPanelStore()
  
  const hasMultiple = group.instances.length > 1
  
  // Get most recent instance for reset
  const mostRecent = [...group.instances].sort((a, b) => b.installedAt - a.installedAt)[0]

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  const handleReset = async () => {
    setMenuOpen(false)
    setBusy(true)
    try {
      await createNewInstance(conversationId, group.appName, mostRecent.instanceId)
    } catch (error) {
      console.error('[webxdc] Failed to create new instance:', error)
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = () => {
    setMenuOpen(false)
    removeApp(conversationId, group.appName)
  }

  return (
    <div className="px-4 py-2 border-b border-fluux-bg/50">
      <div className="flex items-center gap-3">
        {/* ... icon and name same as before ... */}

        {/* Kebab menu */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-1 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors"
            aria-label={t('common.more')}
          >
            <MoreVertical className="size-4" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-48 rounded-lg fluux-popover py-1 z-50">
              <button
                type="button"
                onClick={handleReset}
                disabled={busy}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-fluux-text hover:bg-fluux-hover transition-colors disabled:opacity-50"
              >
                {t('webxdc.reset')}
              </button>
              <button
                type="button"
                onClick={handleRemove}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-fluux-error hover:bg-fluux-hover transition-colors"
              >
                {t('webxdc.remove')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-3 mt-2">
        <button
          type="button"
          onClick={onOpen}
          disabled={busy}
          className="text-xs text-fluux-brand hover:underline font-medium disabled:opacity-50"
        >
          {t('webxdc.open')}
        </button>
        {hasMultiple && (
          <button
            type="button"
            className="text-xs text-fluux-muted hover:text-fluux-text hover:underline"
          >
            {t('webxdc.viewAll')}
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 12: Add useEffect import**

Update imports in `WebxdcAppPanel.tsx`:

```typescript
import { useRef, useState, useEffect } from 'react'
```

- [ ] **Step 13: Commit WebxdcAppPanel implementation**

```bash
git add apps/fluux/src/components/WebxdcAppPanel.tsx apps/fluux/src/components/WebxdcAppPanel.test.tsx
git commit -m "feat(webxdc): add WebxdcAppPanel component

Right-side panel for managing webxdc apps:
- Virtualized app list grouped by name
- Instance count badges
- Open (most recent), Reset, Remove actions
- Empty state with instructions

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 5: ChatHeader and RoomHeader Integration

**Files:**
- Modify: `apps/fluux/src/components/ChatHeader.tsx`
- Modify: `apps/fluux/src/components/RoomHeader.tsx` (find the file, structure is similar)
- Modify: `apps/fluux/src/components/ChatView.tsx`
- Modify: `apps/fluux/src/components/RoomView.tsx`

**Interfaces:**
- Consumes:
  - `useWebxdcPanelStore` from `@/stores/webxdcPanelStore`
  - `WebxdcAppPanel` component
  - `inlineClass`, `kebabClass` from existing header utilities
- Produces: Toggle button in headers, panel integration in views

- [ ] **Step 1: Add webxdc toggle to ChatHeader**

Open `apps/fluux/src/components/ChatHeader.tsx` and add after the search button (around line 73):

```typescript
import { Package } from 'lucide-react'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'

// Inside ChatHeader function, after existing hooks:
const { setPanelOpen, isPanelOpen } = useWebxdcPanelStore()
const webxdcPanelOpen = isPanelOpen(jid)

// In overflowEntries array, after search entry:
overflowEntries.push({
  kind: 'action',
  key: 'webxdc',
  label: t('chat.showWebxdcApps', 'Show Webxdc Apps'),
  icon: Package,
  onSelect: () => setPanelOpen(jid, !webxdcPanelOpen),
  kebabClassName: kebabClass('webxdc'),
})

// In the trailing action cluster, after the search inline button:
<div className={inlineClass('webxdc')}>
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

- [ ] **Step 2: Add webxdc panel to ChatView**

Open `apps/fluux/src/components/ChatView.tsx` and add panel rendering:

Find the layout structure and add the panel after the main chat area:

```typescript
import { WebxdcAppPanel } from './WebxdcAppPanel'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'

// Inside ChatView function:
const { isPanelOpen, setPanelOpen } = useWebxdcPanelStore()
const webxdcPanelOpen = isPanelOpen(conversationId)

// In the JSX, add after MessageComposer:
{webxdcPanelOpen && (
  <WebxdcAppPanel
    conversationId={conversationId}
    onClose={() => setPanelOpen(conversationId, false)}
  />
)}
```

- [ ] **Step 3: Test ChatHeader toggle button**

Add test to `apps/fluux/src/components/ChatHeader.test.tsx`:

```typescript
  it('shows webxdc apps toggle button', () => {
    vi.mock('@/stores/webxdcPanelStore', () => ({
      useWebxdcPanelStore: () => ({
        setPanelOpen: vi.fn(),
        isPanelOpen: () => false,
      }),
    }))
    
    render(
      <ChatHeader
        name="Alice"
        type="chat"
        jid="alice@example.com"
      />
    )
    
    const toggleBtn = screen.getByLabelText(/show.*webxdc/i)
    expect(toggleBtn).toBeInTheDocument()
  })

  it('toggles panel when webxdc button clicked', async () => {
    const mockSetPanelOpen = vi.fn()
    
    vi.mock('@/stores/webxdcPanelStore', () => ({
      useWebxdcPanelStore: () => ({
        setPanelOpen: mockSetPanelOpen,
        isPanelOpen: () => false,
      }),
    }))
    
    render(
      <ChatHeader
        name="Alice"
        type="chat"
        jid="alice@example.com"
      />
    )
    
    const toggleBtn = screen.getByLabelText(/show.*webxdc/i)
    await userEvent.click(toggleBtn)
    
    expect(mockSetPanelOpen).toHaveBeenCalledWith('alice@example.com', true)
  })
```

- [ ] **Step 4: Run ChatHeader tests**

Run: `npm test -- ChatHeader.test.tsx`
Expected: All tests PASS

- [ ] **Step 5: Add similar changes to RoomHeader**

Open `apps/fluux/src/components/RoomHeader.tsx` and add the same webxdc toggle button pattern (structure is similar to ChatHeader, find the notification settings button area and add after it).

Find where the occupant toggle button is (around line 200-250), and add the webxdc toggle nearby:

```typescript
import { Package } from 'lucide-react'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'

// After existing hooks:
const { setPanelOpen, isPanelOpen } = useWebxdcPanelStore()
const webxdcPanelOpen = isPanelOpen(room.jid)

// Add toggle button in the header actions area, similar to occupant toggle
```

- [ ] **Step 6: Add webxdc panel to RoomView**

Open `apps/fluux/src/components/RoomView.tsx` and add panel rendering similar to ChatView, conditionally rendered based on panel state.

- [ ] **Step 7: Test RoomHeader integration**

Add similar tests to RoomHeader.test.tsx for the webxdc toggle button.

- [ ] **Step 8: Run all header tests**

Run: `npm test -- Header.test.tsx`
Expected: All header tests PASS

- [ ] **Step 9: Commit header integration**

```bash
git add apps/fluux/src/components/ChatHeader.tsx apps/fluux/src/components/RoomHeader.tsx apps/fluux/src/components/ChatView.tsx apps/fluux/src/components/RoomView.tsx apps/fluux/src/components/*.test.tsx
git commit -m "feat(webxdc): integrate app panel toggle in chat/room headers

Add Package icon toggle button in ChatHeader and RoomHeader
Panel collapses to overflow menu on narrow widths
Wire up panel state to ChatView and RoomView

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 6: Integration Tests and Final Polish

**Files:**
- Create: `apps/fluux/src/components/__tests__/webxdc-integration.test.tsx`
- Modify: `apps/fluux/src/i18n/en.json` (add translation keys)

**Interfaces:**
- Consumes: All previous tasks
- Produces: End-to-end integration tests

- [ ] **Step 1: Add translation keys**

Open `apps/fluux/src/i18n/en.json` and add under appropriate sections:

```json
{
  "chat": {
    "showWebxdcApps": "Show Webxdc Apps",
    "hideWebxdcApps": "Hide Webxdc Apps"
  },
  "webxdc": {
    "apps": "Webxdc Apps",
    "noAppsInstalled": "No installed apps",
    "installFromAttachments": "Install apps from attachments in this conversation",
    "install": "Install App",
    "remove": "Remove",
    "open": "Open",
    "reset": "Reset",
    "viewAll": "View All",
    "closePanel": "Close panel",
    "hashUnavailable": "Hash unavailable",
    "back": "Back"
  }
}
```

- [ ] **Step 2: Write install → open → reset integration test**

Create `apps/fluux/src/components/__tests__/webxdc-integration.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WebxdcAttachment } from '../WebxdcAttachment'
import { WebxdcAppPanel } from '../WebxdcAppPanel'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'

// Integration test: Install → Panel shows → Open → Reset
describe('Webxdc Integration', () => {
  const mockAttachment = {
    url: 'https://example.com/tictactoe.xdc',
    name: 'tictactoe.xdc',
    mime: 'application/xdc',
    size: 1024,
  }

  const conversationId = 'room@conference.example.com'

  beforeEach(() => {
    localStorage.clear()
    useWebxdcPanelStore.setState({
      manifestCache: new Map(),
      installations: new Map(),
    })
    
    vi.clearAllMocks()
  })

  it('full workflow: install → panel shows → open → reset', async () => {
    const { invoke } = require('@tauri-apps/api/core')
    const { openWebxdcWindow } = require('@/utils/webxdc/webxdcWindow')
    
    // Mock Tauri commands
    invoke.mockImplementation((cmd) => {
      if (cmd === 'webxdc_extract_manifest') {
        return Promise.resolve({ name: 'Tic Tac Toe', icon: 'icon.png' })
      }
      if (cmd === 'webxdc_compute_hash') {
        return Promise.resolve({ sha256: 'abc123' })
      }
      if (cmd === 'webxdc_create_new_instance') {
        return Promise.resolve({ instance_id: 'room@conference.example.com:uuid-new' })
      }
      return Promise.reject(new Error('Unknown command'))
    })
    
    const { rerender } = render(
      <div>
        <WebxdcAttachment attachment={mockAttachment} conversationId={conversationId} />
        <WebxdcAppPanel conversationId={conversationId} onClose={vi.fn()} />
      </div>
    )
    
    // Wait for manifest extraction
    await waitFor(() => {
      expect(screen.getByText('Tic Tac Toe')).toBeInTheDocument()
    })
    
    // Click Install
    const installBtn = screen.getByText('Install App')
    await userEvent.click(installBtn)
    
    // Verify app appears in panel
    expect(screen.getAllByText('Tic Tac Toe')).toHaveLength(2) // Attachment + Panel
    
    // Verify Install button changed to Remove
    expect(screen.getByText('Remove')).toBeInTheDocument()
    
    // Click Open in panel
    const openBtn = screen.getByText('Open')
    await userEvent.click(openBtn)
    
    expect(openWebxdcWindow).toHaveBeenCalled()
    
    // Open kebab menu and click Reset
    const kebabBtn = screen.getByLabelText(/more/i)
    await userEvent.click(kebabBtn)
    
    const resetBtn = screen.getByText('Reset')
    await userEvent.click(resetBtn)
    
    // Verify new instance created
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('webxdc_create_new_instance', expect.any(Object))
    })
    
    // Verify instance count increased
    expect(screen.getByText('(2)')).toBeInTheDocument()
  })

  it('persistence: state survives page reload', async () => {
    const { invoke } = require('@tauri-apps/api/core')
    
    invoke.mockImplementation((cmd) => {
      if (cmd === 'webxdc_extract_manifest') {
        return Promise.resolve({ name: 'Chess' })
      }
      if (cmd === 'webxdc_compute_hash') {
        return Promise.resolve({ sha256: 'def456' })
      }
      return Promise.reject(new Error('Unknown command'))
    })
    
    // Install app
    render(<WebxdcAttachment attachment={mockAttachment} conversationId={conversationId} />)
    
    await waitFor(() => {
      expect(screen.getByText('Chess')).toBeInTheDocument()
    })
    
    const installBtn = screen.getByText('Install App')
    await userEvent.click(installBtn)
    
    // Simulate page reload: create new store instance from localStorage
    const stored = localStorage.getItem('webxdc-installations')
    expect(stored).toBeDefined()
    
    // Clear store state and reload from localStorage
    useWebxdcPanelStore.setState({
      manifestCache: new Map(),
      installations: new Map(),
    })
    
    // Re-initialize store (triggers loadInstallations)
    const { getInstalledApps } = useWebxdcPanelStore.getState()
    const apps = getInstalledApps(conversationId)
    
    expect(apps).toHaveLength(1)
    expect(apps[0].appName).toBe('Chess')
  })
})
```

- [ ] **Step 3: Run integration tests**

Run: `npm test -- webxdc-integration.test.tsx`
Expected: All integration tests PASS

- [ ] **Step 4: Write error recovery test**

Add to `webxdc-integration.test.tsx`:

```typescript
  it('handles stale instance gracefully', async () => {
    const { invoke } = require('@tauri-apps/api/core')
    const { openWebxdcWindow } = require('@/utils/webxdc/webxdcWindow')
    
    // Install an app
    invoke.mockResolvedValue({ name: 'Test App', sha256: 'hash' })
    
    const { installApp } = useWebxdcPanelStore.getState()
    installApp(conversationId, 'room@conference.example.com:stale', mockAttachment)
    
    render(<WebxdcAppPanel conversationId={conversationId} onClose={vi.fn()} />)
    
    // Mock openWebxdcWindow to fail (instance not found)
    openWebxdcWindow.mockRejectedValue(new Error('Instance not found'))
    
    const openBtn = screen.getByText('Open')
    await userEvent.click(openBtn)
    
    // Verify error is caught (no crash)
    await waitFor(() => {
      expect(openWebxdcWindow).toHaveBeenCalled()
    })
    
    // Panel should still be functional
    expect(screen.getByText('Test App')).toBeInTheDocument()
  })
```

- [ ] **Step 5: Run error recovery test**

Run: `npm test -- webxdc-integration.test.tsx`
Expected: Error recovery test PASS

- [ ] **Step 6: Run all tests to verify nothing broke**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 7: Build the app to verify Rust compiles**

Run from repository root:
```bash
cd apps/fluux
npm run tauri build -- --debug
```

Expected: Build succeeds, no Rust or TypeScript compilation errors

- [ ] **Step 8: Commit integration tests and translations**

```bash
git add apps/fluux/src/components/__tests__/webxdc-integration.test.tsx apps/fluux/src/i18n/en.json
git commit -m "test(webxdc): add integration tests and translations

End-to-end tests for install → open → reset flow
Persistence and error recovery tests
Add all webxdc-related translation keys

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Final commit and push**

```bash
git log --oneline -10
git push origin feature/webxdc
```

Expected: All commits pushed successfully

---

## Implementation Complete

All tasks completed. The webxdc app instance panel is now fully implemented with:

✅ Tauri backend commands for manifest extraction and hashing
✅ Zustand store with localStorage persistence
✅ Enhanced WebxdcAttachment with Install/Remove buttons and VirusTotal links
✅ WebxdcAppPanel with virtualized app list and actions
✅ ChatHeader and RoomHeader integration with toggle buttons
✅ Comprehensive unit and integration tests
✅ TDD workflow with tests written before implementation
