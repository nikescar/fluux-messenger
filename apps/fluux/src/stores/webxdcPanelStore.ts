import { create } from 'zustand'
import type { FileAttachment } from '@fluux/sdk'
import { invoke } from '@tauri-apps/api/core'
import { connectionStore } from '@fluux/sdk/stores'

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
  messageTimestamp?: number // When the message with this attachment was sent
  conversationId: string
  attachment: FileAttachment
  lastLaunchedAt?: number
  lastClosedAt?: number
  unreadCount: number
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
  hideUpdateMessages: boolean
}

interface WebxdcPanelStore {
  manifestCache: Map<string, ManifestCacheEntry>
  installations: Map<string, ConversationInstallations>

  cacheManifest: (url: string, data: { name: string; icon?: string; sha256: string }) => void
  installApp: (conversationId: string, instanceId: string, attachment: FileAttachment, messageTimestamp?: number) => void
  removeApp: (conversationId: string, appName: string) => void
  removeInstance: (conversationId: string, instanceId: string) => void
  createNewInstance: (conversationId: string, appName: string, baseInstanceId: string) => Promise<string>
  setPanelOpen: (conversationId: string, open: boolean) => void
  isInstalled: (conversationId: string, instanceId: string) => boolean
  getAppGroup: (conversationId: string, appName: string) => WebxdcAppGroup | undefined
  getInstalledApps: (conversationId: string) => WebxdcAppGroup[]
  isPanelOpen: (conversationId: string) => boolean
  removeConversation: (conversationId: string) => void
  setHideUpdateMessages: (conversationId: string, hide: boolean) => void
  getHideUpdateMessages: (conversationId: string) => boolean
  incrementUnread: (instanceId: string, senderId: string) => void
  clearUnread: (instanceId: string) => void
  getAppGroupUnread: (conversationId: string, appName: string) => number
  getTotalUnread: (conversationId: string) => number
  recordLaunch: (conversationId: string, instanceId: string) => void
  recordClose: (instanceId: string, closedAt: number) => void
  getInstanceUnread: (instanceId: string) => number
}

const MANIFEST_CACHE_KEY = 'webxdc-manifest-cache'
const INSTALLATIONS_KEY = 'webxdc-installations-v2'
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

    const data: [string, { apps: [string, WebxdcAppGroup][]; panelOpen: boolean; hideUpdateMessages?: boolean }][] = JSON.parse(stored)

    // Reconstruct nested Maps
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

// Debounce localStorage saves to avoid blocking the main thread
let saveTimeout: ReturnType<typeof setTimeout> | null = null
let pendingSave: Map<string, ConversationInstallations> | null = null

function saveInstallationsImmediate(installations: Map<string, ConversationInstallations>) {
  try {
    // Convert nested Maps to arrays for JSON serialization
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

function saveInstallations(installations: Map<string, ConversationInstallations>) {
  // Store the latest state
  pendingSave = installations

  // Clear existing timeout
  if (saveTimeout !== null) {
    clearTimeout(saveTimeout)
  }

  // Debounce: save after 100ms of inactivity
  saveTimeout = setTimeout(() => {
    if (pendingSave) {
      saveInstallationsImmediate(pendingSave)
      pendingSave = null
    }
    saveTimeout = null
  }, 100)
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

  installApp: (conversationId, instanceId, attachment, messageTimestamp) => {
    set((state) => {
      const installations = new Map(state.installations)

      // Get or create conversation installations
      let convData = installations.get(conversationId)
      if (!convData) {
        convData = { apps: new Map(), panelOpen: false, hideUpdateMessages: false }
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
        // Update icon from cache (may have been extracted after the group was first created)
        group = { ...group, icon, instances: [...group.instances] }
      }

      // Add instance
      group.instances.push({
        instanceId,
        attachmentUrl: attachment.url,
        messageId: '', // Will be set by caller if needed
        installedAt: Date.now(),
        messageTimestamp,
        conversationId,
        attachment,
        unreadCount: 0,
      })

      apps.set(appName, group)
      convData = { ...convData, apps }
      installations.set(conversationId, convData)

      saveInstallations(installations)
      return { installations }
    })
  },

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

  setPanelOpen: (conversationId, open) => {
    set((state) => {
      const installations = new Map(state.installations)

      let convData = installations.get(conversationId)
      if (!convData) {
        convData = { apps: new Map(), panelOpen: false, hideUpdateMessages: false }
      }

      convData = { ...convData, panelOpen: open }
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

  incrementUnread: (instanceId, senderId) => {
    set((state) => {
      // Get current user JID from connectionStore
      const currentUserJID = connectionStore.getState().jid
      if (!currentUserJID) {
        console.warn('[webxdc-panel] Cannot check sender: current user JID unavailable')
        return state
      }

      // Skip if sender is empty
      if (!senderId) {
        console.warn('[webxdc-panel] Skipping unread increment: sender is empty')
        return state
      }

      // Extract bare JID from sender (remove resource)
      const senderBareJID = senderId.split('/')[0]

      // Filter out self-sent messages
      if (senderBareJID === currentUserJID) {
        return state
      }

      const installations = new Map(state.installations)
      let updated = false

      // Find instance across all conversations
      for (const [conversationId, convData] of installations.entries()) {
        const apps = new Map(convData.apps)

        for (const [appName, group] of apps.entries()) {
          const instanceIndex = group.instances.findIndex(inst => inst.instanceId === instanceId)

          if (instanceIndex !== -1) {
            const updatedInstances = [...group.instances]
            updatedInstances[instanceIndex] = {
              ...updatedInstances[instanceIndex],
              unreadCount: updatedInstances[instanceIndex].unreadCount + 1,
            }
            apps.set(appName, { ...group, instances: updatedInstances })
            installations.set(conversationId, { ...convData, apps })
            updated = true
            break
          }
        }

        if (updated) break
      }

      if (!updated) {
        console.warn('[webxdc-panel] Instance not found for unread increment:', instanceId)
        return state
      }

      saveInstallations(installations)
      return { installations }
    })
  },

  clearUnread: (instanceId) => {
    set((state) => {
      const installations = new Map(state.installations)
      let updated = false

      for (const [conversationId, convData] of installations.entries()) {
        const apps = new Map(convData.apps)

        for (const [appName, group] of apps.entries()) {
          const instanceIndex = group.instances.findIndex(inst => inst.instanceId === instanceId)

          if (instanceIndex !== -1) {
            const updatedInstances = [...group.instances]
            updatedInstances[instanceIndex] = {
              ...updatedInstances[instanceIndex],
              unreadCount: 0,
            }
            apps.set(appName, { ...group, instances: updatedInstances })
            installations.set(conversationId, { ...convData, apps })
            updated = true
            break
          }
        }

        if (updated) break
      }

      if (!updated) return state

      saveInstallations(installations)
      return { installations }
    })
  },

  getAppGroupUnread: (conversationId, appName) => {
    const convData = get().installations.get(conversationId)
    if (!convData) return 0

    const group = convData.apps.get(appName)
    if (!group) return 0

    return group.instances.reduce((sum, inst) => sum + inst.unreadCount, 0)
  },

  getTotalUnread: (conversationId) => {
    const convData = get().installations.get(conversationId)
    if (!convData) return 0
    let total = 0
    for (const group of convData.apps.values()) {
      total += group.instances.reduce((sum, inst) => sum + inst.unreadCount, 0)
    }
    return total
  },

  recordLaunch: (conversationId, instanceId) => {
    set((state) => {
      const installations = new Map(state.installations)
      const convData = installations.get(conversationId)
      if (!convData) return state

      const apps = new Map(convData.apps)
      let updated = false

      for (const [appName, group] of apps.entries()) {
        const instanceIndex = group.instances.findIndex(inst => inst.instanceId === instanceId)
        if (instanceIndex !== -1) {
          const updatedInstances = [...group.instances]
          updatedInstances[instanceIndex] = {
            ...updatedInstances[instanceIndex],
            lastLaunchedAt: Date.now(),
          }
          apps.set(appName, { ...group, instances: updatedInstances })
          updated = true
          break
        }
      }

      if (!updated) return state

      installations.set(conversationId, { ...convData, apps })
      saveInstallations(installations)
      return { installations }
    })
  },

  recordClose: (instanceId, closedAt) => {
    set((state) => {
      const installations = new Map(state.installations)
      let updated = false

      for (const [conversationId, convData] of installations.entries()) {
        const apps = new Map(convData.apps)

        for (const [appName, group] of apps.entries()) {
          const instanceIndex = group.instances.findIndex(inst => inst.instanceId === instanceId)
          if (instanceIndex !== -1) {
            const updatedInstances = [...group.instances]
            updatedInstances[instanceIndex] = {
              ...updatedInstances[instanceIndex],
              lastClosedAt: closedAt,
            }
            apps.set(appName, { ...group, instances: updatedInstances })
            installations.set(conversationId, { ...convData, apps })
            updated = true
            break
          }
        }

        if (updated) break
      }

      if (!updated) return state

      saveInstallations(installations)
      return { installations }
    })
  },

  getInstanceUnread: (instanceId) => {
    const installations = get().installations

    for (const convData of installations.values()) {
      for (const group of convData.apps.values()) {
        const instance = group.instances.find(inst => inst.instanceId === instanceId)
        if (instance) {
          return instance.unreadCount
        }
      }
    }

    return 0
  },
}))

// Expose store for e2e tests and debugging in development builds
if (import.meta.env.DEV) {
  ;(window as Window & { __webxdcPanelStore?: typeof useWebxdcPanelStore }).__webxdcPanelStore = useWebxdcPanelStore
}
