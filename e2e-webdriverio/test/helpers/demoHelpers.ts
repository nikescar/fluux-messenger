/**
 * Demo boot helper for WebDriverIO tests.
 *
 * Ported from scripts/e2e/demoBoot.ts. Navigates to demo URL and waits
 * for the app to mount and seed completely before returning.
 */

const MOUNT_BUDGET_MS = 120_000
const SEED_TIMEOUT_MS = 30_000
const POLLING_INTERVAL_MS = 250
const SETTLE_MS = 700

export const AT_BOTTOM_OK_PX = 150

/** Ordered milestones between "navigation started" and "the app is usable". */
const MOUNT_STAGES = [
  {
    name: 'document parsed',
    detail: 'the HTML response never finished parsing — a server or network stall',
    probe: () => document.readyState !== 'loading',
  },
  {
    name: 'mount node present',
    detail: 'index/demo HTML loaded but #root is absent — wrong document served',
    probe: () => document.getElementById('root') !== null,
  },
  {
    name: 'React rendered into #root',
    detail: 'the bundle loaded but never produced a first paint — a module-eval throw, or a render loop',
    probe: () => (document.getElementById('root')?.childElementCount ?? 0) > 0,
  },
  {
    name: 'app shell visible',
    detail: 'React rendered something, but the nav never appeared — an app-level stall, not a boot one',
    probe: () => document.querySelector('[data-nav="messages"]') !== null,
  },
] as const

/**
 * Navigate to a demo URL and wait for it to mount and seed completely.
 */
export async function bootDemo(url: string): Promise<void> {
  const startTime = Date.now()
  const deadline = startTime + MOUNT_BUDGET_MS

  // Navigate to the URL
  await browser.url(url)

  // Wait for each mount stage in order
  for (const stage of MOUNT_STAGES) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error(
        `Demo boot timed out before stage "${stage.name}". ` +
          `Likely meaning: ${stage.detail}`
      )
    }

    try {
      await browser.waitUntil(
        async () => {
          const result = await browser.execute(stage.probe)
          return result === true
        },
        {
          timeout: remainingMs,
          interval: POLLING_INTERVAL_MS,
          timeoutMsg: `Demo boot stalled at stage "${stage.name}". ${stage.detail}`,
        }
      )
    } catch (error) {
      const elapsed = Date.now() - startTime
      throw new Error(
        `Demo boot failed at stage "${stage.name}" after ${Math.round(elapsed / 1000)}s. ` +
          `${stage.detail}. Original error: ${error}`
      )
    }
  }

  // Wait for demo seeding to complete
  await waitForDemoSeeded()
}

/**
 * Wait for the demo's stress seeding to actually complete.
 *
 * demo.tsx sets `__fluuxDemoReady` once runStressScenario's last
 * scheduled event has been emitted.
 */
async function waitForDemoSeeded(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const ready = await browser.execute(() => {
        return (window as Window & { __fluuxDemoReady?: boolean }).__fluuxDemoReady === true
      })
      return ready
    },
    {
      timeout: SEED_TIMEOUT_MS,
      interval: POLLING_INTERVAL_MS,
      timeoutMsg: 'Demo seeding never completed (__fluuxDemoReady never became true)',
    }
  )
}

/**
 * Activate a 1:1 conversation through the real store + route.
 *
 * Uses the __chatStore global that demo.tsx exposes for test harnesses.
 */
export async function activateChat(jid: string): Promise<void> {
  // Activate the conversation via the store
  await browser.execute((j: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window as any).__chatStore?.getState?.()?.activateConversation(j)
  }, jid)

  // Wait for the store to reflect the active conversation
  await browser.waitUntil(
    async () => {
      const activeJid = await browser.execute((j: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (window as any).__chatStore?.getState?.()?.activeConversationId === j
      }, jid)
      return activeJid
    },
    {
      timeout: 10_000,
      timeoutMsg: `Chat ${jid} never became active in __chatStore`,
    }
  )

  // Update the route hash
  await browser.execute((j: string) => {
    window.location.hash = '#/messages/' + encodeURIComponent(j)
  }, jid)

  // Wait for the message list to appear
  const messageList = await $('[data-message-list]')
  await messageList.waitForDisplayed({ timeout: 10_000 })

  // Settle time for any animations or layout shifts
  await browser.pause(SETTLE_MS)
}

/**
 * Scroll the message list to the bottom.
 */
export async function scrollToBottom(): Promise<void> {
  await browser.execute(() => {
    const s = document.querySelector('[data-message-list]') as HTMLElement | null
    if (s) s.scrollTop = s.scrollHeight
  })
  await browser.pause(SETTLE_MS)
}

/**
 * Check if a message is visible in the viewport and measure distance from bottom.
 *
 * Returns visibility status and distance from bottom in pixels. Used to verify
 * that new messages stick to the bottom of the scroll container.
 */
export async function newMsgStuck(
  msgId: string
): Promise<{ visible: boolean; distFromBottom: number }> {
  const result = await browser.execute((id: string) => {
    const s = document.querySelector('[data-message-list]') as HTMLElement | null
    if (!s) return { visible: false, distFromBottom: -1 }

    const el = s.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null
    const sRect = s.getBoundingClientRect()

    const visible =
      !!el &&
      (() => {
        const r = el.getBoundingClientRect()
        // Element is visible if it's within the scrollport bounds (with some tolerance)
        return r.top >= sRect.top - 5 && r.bottom <= sRect.bottom + 120
      })()

    const distFromBottom = Math.round(s.scrollHeight - s.scrollTop - s.clientHeight)

    return { visible, distFromBottom }
  }, msgId)

  return result
}
