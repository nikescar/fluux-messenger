import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WebxdcAttachment } from './WebxdcAttachment'
import type { FileAttachment } from '@fluux/sdk'

const { openWebxdcWindowSpy } = vi.hoisted(() => ({
  openWebxdcWindowSpy: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@/utils/webxdc/webxdcWindow', () => ({
  openWebxdcWindow: (...args: unknown[]) => openWebxdcWindowSpy(...args),
}))

function makeAttachment(): FileAttachment {
  return {
    url: 'https://example.com/app.xdc',
    name: 'app.xdc',
    mediaType: 'application/webxdc+zip',
    size: 1024,
  }
}

describe('WebxdcAttachment', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { useWebxdcPanelStore } = await import('@/stores/webxdcPanelStore')
    useWebxdcPanelStore.setState({ manifestCache: new Map(), installations: new Map() })
  })

  it('opens the webxdc window with the conversation the message actually belongs to', async () => {
    const { useWebxdcPanelStore } = await import('@/stores/webxdcPanelStore')
    const { getInstanceId } = await import('@/utils/webxdc/instanceId')
    // The card is only clickable once installed — install it first so the click can fire.
    useWebxdcPanelStore.getState().installApp(
      'alice@example.com',
      getInstanceId('alice@example.com', makeAttachment().url),
      makeAttachment(),
    )

    render(<WebxdcAttachment attachment={makeAttachment()} conversationId="alice@example.com" />)

    // The card is always the first button; the Install/Remove action is the second.
    fireEvent.click(screen.getAllByRole('button')[0])

    await waitFor(() => {
      expect(openWebxdcWindowSpy).toHaveBeenCalledWith(makeAttachment(), 'alice@example.com')
    })
  })

  it('uses the room JID as conversationId for a group conversation', async () => {
    const { useWebxdcPanelStore } = await import('@/stores/webxdcPanelStore')
    const { getInstanceId } = await import('@/utils/webxdc/instanceId')
    useWebxdcPanelStore.getState().installApp(
      'room@conference.example.com',
      getInstanceId('room@conference.example.com', makeAttachment().url),
      makeAttachment(),
    )

    render(<WebxdcAttachment attachment={makeAttachment()} conversationId="room@conference.example.com" />)

    fireEvent.click(screen.getAllByRole('button')[0])

    await waitFor(() => {
      expect(openWebxdcWindowSpy).toHaveBeenCalledWith(makeAttachment(), 'room@conference.example.com')
    })
  })

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

  it('opens the webxdc panel when install button is clicked', async () => {
    const { useWebxdcPanelStore } = await import('@/stores/webxdcPanelStore')

    // Pre-cache the manifest so the component isn't in extracting state
    useWebxdcPanelStore.getState().cacheManifest('https://example.com/app.xdc', {
      name: 'Test App',
      sha256: 'abc',
    })

    render(<WebxdcAttachment attachment={makeAttachment()} conversationId="alice@example.com" />)

    // Wait for install button to appear (after extracting completes)
    const installButton = await screen.findByText('webxdc.install')
    fireEvent.click(installButton)

    // Wait for async install to complete (extraction + store update)
    await new Promise(resolve => setTimeout(resolve, 200))

    // Panel should now be open
    expect(useWebxdcPanelStore.getState().isPanelOpen('alice@example.com')).toBe(true)
  })
})
