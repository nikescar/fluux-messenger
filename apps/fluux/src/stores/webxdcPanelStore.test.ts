import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useWebxdcPanelStore } from './webxdcPanelStore'
import { connectionStore } from '@fluux/sdk/stores'

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
      const { cacheManifest } = useWebxdcPanelStore.getState()

      cacheManifest('https://example.com/app.xdc', {
        name: 'Tic Tac Toe',
        icon: 'icon.png',
        sha256: 'abc123',
      })

      const { manifestCache } = useWebxdcPanelStore.getState()
      const entry = manifestCache.get('https://example.com/app.xdc')
      expect(entry).toBeDefined()
      expect(entry?.name).toBe('Tic Tac Toe')
      expect(entry?.icon).toBe('icon.png')
      expect(entry?.sha256).toBe('abc123')
      expect(entry?.extractedAt).toBeGreaterThan(0)
    })

    it('updates existing manifest entry', () => {
      const { cacheManifest } = useWebxdcPanelStore.getState()

      cacheManifest('https://example.com/app.xdc', {
        name: 'Old Name',
        sha256: 'old',
      })

      cacheManifest('https://example.com/app.xdc', {
        name: 'New Name',
        sha256: 'new',
      })

      const { manifestCache } = useWebxdcPanelStore.getState()
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

  describe('hideUpdateMessages', () => {
    it('defaults to false for a conversation with no installations', () => {
      const { getHideUpdateMessages } = useWebxdcPanelStore.getState()
      expect(getHideUpdateMessages('room@conference.example.com')).toBe(false)
    })

    it('sets and reads back the toggle for a conversation', () => {
      const { setHideUpdateMessages } = useWebxdcPanelStore.getState()

      setHideUpdateMessages('room@conference.example.com', true)

      expect(useWebxdcPanelStore.getState().getHideUpdateMessages('room@conference.example.com')).toBe(true)
    })

    it('does not affect other conversations', () => {
      const { setHideUpdateMessages, getHideUpdateMessages } = useWebxdcPanelStore.getState()

      setHideUpdateMessages('room@conference.example.com', true)

      expect(getHideUpdateMessages('other@conference.example.com')).toBe(false)
    })

    it('persists to localStorage', async () => {
      const { setHideUpdateMessages } = useWebxdcPanelStore.getState()

      setHideUpdateMessages('room@conference.example.com', true)

      // Wait for debounced save to complete
      await new Promise(resolve => setTimeout(resolve, 150))

      const stored = JSON.parse(localStorage.getItem('webxdc-installations-v2')!)
      const [, convData] = stored.find(([id]: [string, unknown]) => id === 'room@conference.example.com')
      expect(convData.hideUpdateMessages).toBe(true)
    })
  })

  describe('unread tracking', () => {
    beforeEach(() => {
      connectionStore.setState({ jid: 'currentuser@example.com' })
    })

    function install(conversationId: string, instanceId: string, url: string, name = 'app.xdc') {
      const { installApp } = useWebxdcPanelStore.getState()
      installApp(conversationId, instanceId, {
        url,
        name,
        mediaType: 'application/webxdc+zip',
        size: 1024,
      } as any)
    }

    it('increments unread on the app group matching the attachment URL', () => {
      install('room@conference.example.com', 'instance-1', 'https://example.com/app.xdc')
      const { incrementUnread } = useWebxdcPanelStore.getState()

      incrementUnread('instance-1', 'other@example.com/resource')
      incrementUnread('instance-1', 'other@example.com/resource')

      const group = useWebxdcPanelStore.getState().getAppGroup('room@conference.example.com', 'app.xdc')
      // Check instance unread instead of group unread
      expect(group?.instances[0]?.unreadCount).toBe(2)
    })

    it('is a no-op when no installed instance matches the URL', () => {
      const { incrementUnread } = useWebxdcPanelStore.getState()

      incrementUnread('unknown-instance', 'other@example.com/resource')

      expect(useWebxdcPanelStore.getState().installations.get('room@conference.example.com')).toBeUndefined()
    })

    it('clears unread for an app group', () => {
      install('room@conference.example.com', 'instance-1', 'https://example.com/app.xdc')
      const { incrementUnread, clearUnread } = useWebxdcPanelStore.getState()
      incrementUnread('instance-1', 'other@example.com/resource')

      clearUnread('instance-1')

      const group = useWebxdcPanelStore.getState().getAppGroup('room@conference.example.com', 'app.xdc')
      // Check instance unread instead of group unread
      expect(group?.instances[0]?.unreadCount).toBe(0)
    })

    it('sums unread across app groups for getTotalUnread', () => {
      install('room@conference.example.com', 'instance-1', 'https://example.com/app1.xdc', 'app1.xdc')
      install('room@conference.example.com', 'instance-2', 'https://example.com/app2.xdc', 'app2.xdc')
      const { incrementUnread } = useWebxdcPanelStore.getState()

      incrementUnread('instance-1', 'other@example.com/resource')
      incrementUnread('instance-2', 'other@example.com/resource')
      incrementUnread('instance-2', 'other@example.com/resource')

      expect(useWebxdcPanelStore.getState().getTotalUnread('room@conference.example.com')).toBe(3)
    })

    it('getTotalUnread returns 0 for a conversation with no installations', () => {
      expect(useWebxdcPanelStore.getState().getTotalUnread('nobody@example.com')).toBe(0)
    })
  })

  describe('removeConversation', () => {
    beforeEach(() => {
      connectionStore.setState({ jid: 'currentuser@example.com' })
    })

    it('removes all webxdc data when conversation is deleted', () => {
      // Install apps and set state
      const { installApp, setHideUpdateMessages, incrementUnread, setPanelOpen, removeConversation } = useWebxdcPanelStore.getState()
      installApp('room@conference.example.com', 'instance-1', {
        url: 'https://example.com/app.xdc',
        name: 'app.xdc',
        mediaType: 'application/webxdc+zip',
        size: 1024,
      } as any)
      setHideUpdateMessages('room@conference.example.com', true)
      setPanelOpen('room@conference.example.com', true)
      incrementUnread('instance-1', 'other@example.com/resource')

      // Verify state exists
      expect(useWebxdcPanelStore.getState().getInstalledApps('room@conference.example.com')).toHaveLength(1)
      expect(useWebxdcPanelStore.getState().getHideUpdateMessages('room@conference.example.com')).toBe(true)
      expect(useWebxdcPanelStore.getState().isPanelOpen('room@conference.example.com')).toBe(true)

      // Delete conversation
      removeConversation('room@conference.example.com')

      // All webxdc data should be gone
      expect(useWebxdcPanelStore.getState().getInstalledApps('room@conference.example.com')).toHaveLength(0)
      expect(useWebxdcPanelStore.getState().getHideUpdateMessages('room@conference.example.com')).toBe(false)
      expect(useWebxdcPanelStore.getState().isPanelOpen('room@conference.example.com')).toBe(false)
      expect(useWebxdcPanelStore.getState().getTotalUnread('room@conference.example.com')).toBe(0)
    })
  })

  describe('WebxdcInstance interface', () => {
    it('instances support lifecycle and unread tracking fields', () => {
      const { installApp } = useWebxdcPanelStore.getState()

      const attachment = {
        url: 'https://example.com/app.xdc',
        name: 'Test App',
        mimeType: 'application/xdc',
        size: 1024,
      }

      installApp('user@example.com', 'user@example.com:https://example.com/app.xdc', attachment)

      const { installations } = useWebxdcPanelStore.getState()
      const convData = installations.get('user@example.com')
      const appGroup = convData?.apps.get('Test App')
      const instance = appGroup?.instances[0]

      expect(instance).toBeDefined()
      expect(instance?.unreadCount).toBe(0)
      expect(instance?.lastLaunchedAt).toBeUndefined()
      expect(instance?.lastClosedAt).toBeUndefined()
    })
  })

  describe('recordLaunch', () => {
    it('updates lastLaunchedAt timestamp', () => {
      const { installApp, recordLaunch } = useWebxdcPanelStore.getState()

      const attachment = {
        url: 'https://example.com/app.xdc',
        name: 'Test App',
        mimeType: 'application/xdc',
        size: 1024,
      }

      const instanceId = 'user@example.com:https://example.com/app.xdc'
      installApp('user@example.com', instanceId, attachment)

      const beforeTime = Date.now()
      recordLaunch('user@example.com', instanceId)
      const afterTime = Date.now()

      const { installations } = useWebxdcPanelStore.getState()
      const instance = installations.get('user@example.com')?.apps.get('Test App')?.instances[0]

      expect(instance?.lastLaunchedAt).toBeGreaterThanOrEqual(beforeTime)
      expect(instance?.lastLaunchedAt).toBeLessThanOrEqual(afterTime)
    })
  })

  describe('recordClose', () => {
    it('updates lastClosedAt timestamp', () => {
      const { installApp, recordClose } = useWebxdcPanelStore.getState()

      const attachment = {
        url: 'https://example.com/app.xdc',
        name: 'Test App',
        mimeType: 'application/xdc',
        size: 1024,
      }

      const instanceId = 'user@example.com:https://example.com/app.xdc'
      installApp('user@example.com', instanceId, attachment)

      const closeTime = Date.now()
      recordClose(instanceId, closeTime)

      const { installations } = useWebxdcPanelStore.getState()
      const instance = installations.get('user@example.com')?.apps.get('Test App')?.instances[0]

      expect(instance?.lastClosedAt).toBe(closeTime)
    })
  })

  describe('getInstanceUnread', () => {
    it('returns unread count for specific instance', () => {
      const { installApp, getInstanceUnread } = useWebxdcPanelStore.getState()

      const attachment = {
        url: 'https://example.com/app.xdc',
        name: 'Test App',
        mimeType: 'application/xdc',
        size: 1024,
      }

      const instanceId = 'user@example.com:https://example.com/app.xdc'
      installApp('user@example.com', instanceId, attachment)

      const count = getInstanceUnread(instanceId)
      expect(count).toBe(0)
    })

    it('returns 0 for unknown instance', () => {
      const { getInstanceUnread } = useWebxdcPanelStore.getState()

      const count = getInstanceUnread('unknown:https://example.com/unknown.xdc')
      expect(count).toBe(0)
    })
  })

  describe('incrementUnread with sender filtering', () => {
    beforeEach(() => {
      // Set current user JID in connectionStore
      connectionStore.setState({ jid: 'user@example.com' })
    })

    it('increments unread for messages from other users', () => {
      const { installApp, incrementUnread } = useWebxdcPanelStore.getState()

      const attachment = {
        url: 'https://example.com/app.xdc',
        name: 'Test App',
        mimeType: 'application/xdc',
        size: 1024,
      }

      const instanceId = 'user@example.com:https://example.com/app.xdc'
      installApp('user@example.com', instanceId, attachment)

      incrementUnread(instanceId, 'other@example.com/resource')

      const { installations } = useWebxdcPanelStore.getState()
      const instance = installations.get('user@example.com')?.apps.get('Test App')?.instances[0]

      expect(instance?.unreadCount).toBe(1)
    })

    it('does not increment unread for self-sent messages', () => {
      const { installApp, incrementUnread } = useWebxdcPanelStore.getState()

      const attachment = {
        url: 'https://example.com/app.xdc',
        name: 'Test App',
        mimeType: 'application/xdc',
        size: 1024,
      }

      const instanceId = 'user@example.com:https://example.com/app.xdc'
      installApp('user@example.com', instanceId, attachment)

      incrementUnread(instanceId, 'user@example.com/resource')

      const { installations } = useWebxdcPanelStore.getState()
      const instance = installations.get('user@example.com')?.apps.get('Test App')?.instances[0]

      expect(instance?.unreadCount).toBe(0)
    })

    it('handles missing sender gracefully', () => {
      const { installApp, incrementUnread } = useWebxdcPanelStore.getState()

      const attachment = {
        url: 'https://example.com/app.xdc',
        name: 'Test App',
        mimeType: 'application/xdc',
        size: 1024,
      }

      const instanceId = 'user@example.com:https://example.com/app.xdc'
      installApp('user@example.com', instanceId, attachment)

      incrementUnread(instanceId, '')

      const { installations } = useWebxdcPanelStore.getState()
      const instance = installations.get('user@example.com')?.apps.get('Test App')?.instances[0]

      expect(instance?.unreadCount).toBe(0)
    })
  })
})
