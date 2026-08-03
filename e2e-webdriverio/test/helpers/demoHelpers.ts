/**
 * Demo boot helper for WebDriverIO tests.
 *
 * Ported from scripts/e2e/demoBoot.ts. Navigates to demo URL and waits
 * for the app to mount and seed completely before returning.
 */

const MOUNT_BUDGET_MS = 120_000
const SEED_TIMEOUT_MS = 30_000
const POLLING_INTERVAL_MS = 250

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
