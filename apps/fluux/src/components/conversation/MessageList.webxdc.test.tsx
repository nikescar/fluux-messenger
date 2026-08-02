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
    // Message is in DOM but hidden with `hidden` attribute (CSS-based hiding preserves scroll calculations)
    const hiddenMessageRow = screen.getByText('[WebXDC Update: moved]').closest('[data-message-id]')
    expect(hiddenMessageRow).toBeInTheDocument()
    expect(hiddenMessageRow).toHaveAttribute('hidden')
  })

  it('hides webxdc update messages by body pattern (fallback for old persisted messages)', () => {
    useWebxdcPanelStore.getState().setHideUpdateMessages('alice@example.com', true)

    const messages = [
      message({ id: 'm1', body: 'Hello there' }),
      // Old message without isWebxdcUpdate property (persisted before the field was added)
      message({ id: 'm2', body: '[WebXDC Update: moved]' }),
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
    // Message is in DOM but hidden with `hidden` attribute (CSS-based hiding preserves scroll calculations)
    const hiddenMessageRow = screen.getByText('[WebXDC Update: moved]').closest('[data-message-id]')
    expect(hiddenMessageRow).toBeInTheDocument()
    expect(hiddenMessageRow).toHaveAttribute('hidden')
  })
})
