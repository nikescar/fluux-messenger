import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WebxdcAppPanel } from './WebxdcAppPanel'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'
import { connectionStore } from '@fluux/sdk/stores'
import { getInstanceId } from '@/utils/webxdc/instanceId'
import type { FileAttachment } from '@fluux/sdk'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: string) => d ?? k }) }))
vi.mock('@/utils/webxdc/webxdcWindow')

// Render-all @tanstack mock: every row mounts so it's assertable in jsdom (which reports
// zero client size, so the real virtualizer would otherwise compute an empty viewport).
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index, key: index, start: index * 72, end: index * 72 + 72, size: 72, lane: 0,
      })),
    getTotalSize: () => opts.count * 72,
    measureElement: () => {},
  }),
}))

function makeAttachment(url: string): FileAttachment {
  return { url, name: 'app.xdc', mediaType: 'application/webxdc+zip', size: 1024 }
}

describe('WebxdcAppPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    connectionStore.setState({ jid: 'currentuser@example.com' })
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

  it('toggles hideUpdateMessages via the header checkbox', () => {
    render(<WebxdcAppPanel conversationId="room@conference.example.com" onClose={vi.fn()} />)

    const checkbox = screen.getByRole('checkbox', { name: 'Hide update messages' })
    expect(checkbox).not.toBeChecked()

    checkbox.click()

    expect(useWebxdcPanelStore.getState().getHideUpdateMessages('room@conference.example.com')).toBe(true)
    expect(checkbox).toBeChecked()
  })

  it('renders an unread badge on the app icon when unreadCount > 0', () => {
    useWebxdcPanelStore.getState().installApp('room@conference.example.com', 'instance-1', makeAttachment('https://example.com/app.xdc'))
    useWebxdcPanelStore.getState().incrementUnread('instance-1', 'other@example.com/resource')
    useWebxdcPanelStore.getState().incrementUnread('instance-1', 'other@example.com/resource')

    render(<WebxdcAppPanel conversationId="room@conference.example.com" onClose={vi.fn()} />)

    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('clears the unread badge when the app is opened', async () => {
    const attachment = makeAttachment('https://example.com/app.xdc')
    const conversationId = 'room@conference.example.com'
    const instanceId = getInstanceId(conversationId, attachment.url)

    useWebxdcPanelStore.getState().installApp(conversationId, instanceId, attachment)
    useWebxdcPanelStore.getState().incrementUnread(instanceId, 'other@example.com/resource')

    // Mock openWebxdcWindow to call clearUnread
    const { openWebxdcWindow } = await import('@/utils/webxdc/webxdcWindow')
    vi.mocked(openWebxdcWindow).mockImplementation(async () => {
      useWebxdcPanelStore.getState().clearUnread(instanceId)
    })

    render(<WebxdcAppPanel conversationId={conversationId} onClose={vi.fn()} />)

    const button = screen.getByRole('button', { name: /app\.xdc/i })
    await button.click()

    expect(useWebxdcPanelStore.getState().getInstanceUnread(instanceId)).toBe(0)
  })

  it('updates app icon when manifest is cached after installation', () => {
    // Scenario: app installed before manifest extraction completed
    useWebxdcPanelStore.getState().installApp('room@conference.example.com', 'instance-1', makeAttachment('https://example.com/app.xdc'))

    // Verify no icon initially
    expect(useWebxdcPanelStore.getState().getAppGroup('room@conference.example.com', 'app.xdc')?.icon).toBeUndefined()

    // Manifest extraction completes and icon is cached
    useWebxdcPanelStore.getState().cacheManifest('https://example.com/app.xdc', {
      name: 'app.xdc',
      icon: 'data:image/png;base64,iVBORw0KGgo=',
      sha256: 'abc',
    })

    // Install another instance of the same app (or reinstall)
    useWebxdcPanelStore.getState().installApp('room@conference.example.com', 'instance-2', makeAttachment('https://example.com/app.xdc'))

    // Icon should now be updated on the app group
    expect(useWebxdcPanelStore.getState().getAppGroup('room@conference.example.com', 'app.xdc')?.icon).toBe('data:image/png;base64,iVBORw0KGgo=')
  })
})
