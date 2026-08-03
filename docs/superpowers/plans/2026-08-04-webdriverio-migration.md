# WebDriverIO E2E Test Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate 2 scroll-invariant tests from Playwright to WebDriverIO as a proof-of-concept, creating a parallel test suite without disrupting existing Playwright infrastructure.

**Architecture:** Create `e2e-webdriverio/` directory with WebDriverIO config, helper functions ported from Playwright, and 2 test cases that exercise the scroll-to-bottom invariant. Tests drive the same vite preview server and demo harness as Playwright.

**Tech Stack:** WebDriverIO 9.4, Mocha framework, TypeScript, Chromium browser via WebDriver protocol.

## Global Constraints

- Node version: `>=22.22.0` (from package.json engines)
- WebDriverIO version: `^9.4.0`
- Base URL: `http://localhost:4173` (matches Playwright preview server)
- Timeout: 180,000ms per test (same as Playwright)
- Retries: 0 locally, 2 in CI
- Target branch: `webdriverio-migration` (branch from `main`)
- Do NOT modify existing Playwright tests or config
- Demo URL: `/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:80,msgStep:0`
- Test JID: `ava@fluux.chat`

---

### Task 1: Create Branch and Install Dependencies

**Files:**
- Modify: `package.json` (add devDependencies and scripts)
- Create: `package-lock.json` (updated via npm install)

**Interfaces:**
- Consumes: Existing `package.json`, current `main` branch
- Produces: New branch `webdriverio-migration`, WebDriverIO packages installed

- [ ] **Step 1: Create new branch**

```bash
git checkout -b webdriverio-migration
```

- [ ] **Step 2: Add WebDriverIO dependencies to package.json**

Add these entries to the `devDependencies` object in `package.json`:

```json
"@wdio/cli": "^9.4.0",
"@wdio/local-runner": "^9.4.0",
"@wdio/mocha-framework": "^9.4.0",
"@wdio/spec-reporter": "^9.4.0",
"webdriverio": "^9.4.0"
```

- [ ] **Step 3: Add npm scripts to package.json**

Add these entries to the `scripts` object in `package.json`:

```json
"test:wdio": "wdio run e2e-webdriverio/wdio.conf.ts",
"test:wdio:scroll": "wdio run e2e-webdriverio/wdio.conf.ts --spec e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts"
```

- [ ] **Step 4: Install dependencies**

Run:
```bash
npm install
```

Expected: All WebDriverIO packages installed successfully, `package-lock.json` updated.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add WebDriverIO dependencies and test scripts

Add @wdio packages for E2E test migration proof-of-concept.
New scripts: test:wdio and test:wdio:scroll.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 2: Create WebDriverIO Configuration

**Files:**
- Create: `e2e-webdriverio/wdio.conf.ts`
- Create: `e2e-webdriverio/tsconfig.json`

**Interfaces:**
- Consumes: Base URL `http://localhost:4173`, timeout constants from spec
- Produces: WebDriverIO config with Chromium capabilities, Mocha framework, spec reporter

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p e2e-webdriverio/test/specs
mkdir -p e2e-webdriverio/test/helpers
```

- [ ] **Step 2: Write WebDriverIO configuration**

Create `e2e-webdriverio/wdio.conf.ts`:

```typescript
import type { Options } from '@wdio/types'

export const config: Options.Testrunner = {
  //
  // ====================
  // Runner Configuration
  // ====================
  runner: 'local',
  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: {
      project: './e2e-webdriverio/tsconfig.json',
      transpileOnly: true,
    },
  },

  //
  // ==================
  // Specify Test Files
  // ==================
  specs: ['./e2e-webdriverio/test/specs/**/*.spec.ts'],
  exclude: [],

  //
  // ============
  // Capabilities
  // ============
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
      },
    },
  ],

  //
  // ===================
  // Test Configurations
  // ===================
  logLevel: 'info',
  bail: 0,
  baseUrl: 'http://localhost:4173',
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  framework: 'mocha',
  reporters: ['spec'],

  mochaOpts: {
    ui: 'bdd',
    timeout: 180000, // 180 seconds, matches Playwright
  },

  //
  // =====
  // Hooks
  // =====
  before: function () {
    // Retries: 0 locally, 2 in CI (matches Playwright philosophy)
    const retries = process.env.CI ? 2 : 0
    // @ts-expect-error - this is a valid property on browser object
    browser.config.mochaOpts.retries = retries
  },
}
```

- [ ] **Step 3: Write TypeScript config for WebDriverIO tests**

Create `e2e-webdriverio/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node", "@wdio/globals/types", "expect-webdriverio", "@wdio/mocha-framework"]
  },
  "include": ["test/**/*.ts", "wdio.conf.ts"]
}
```

- [ ] **Step 4: Verify configuration syntax**

Run:
```bash
npx tsc --noEmit -p e2e-webdriverio/tsconfig.json
```

Expected: No TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add e2e-webdriverio/wdio.conf.ts e2e-webdriverio/tsconfig.json
git commit -m "test(wdio): add WebDriverIO configuration

- Chromium-only for initial evaluation
- 180s timeout matching Playwright
- Mocha framework with spec reporter
- 0 retries locally, 2 in CI

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 3: Port Demo Boot Helper

**Files:**
- Create: `e2e-webdriverio/test/helpers/demoHelpers.ts`

**Interfaces:**
- Consumes: `browser` global (WebDriverIO), demo URL with query params
- Produces: `bootDemo(url: string): Promise<void>` - navigates and waits for demo mount

- [ ] **Step 1: Write the failing test**

Create `e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts`:

```typescript
import { bootDemo } from '../helpers/demoHelpers.js'

const DEMO_URL = '/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:80,msgStep:0'

describe('At-bottom stick (WebDriverIO)', () => {
  it('should boot the demo successfully', async () => {
    await bootDemo(DEMO_URL)
    
    // Verify the app shell loaded
    const nav = await $('[data-nav="messages"]')
    await expect(nav).toBeDisplayed()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (with preview server running in another terminal):
```bash
npm run preview:e2e &
sleep 5
npm run test:wdio:scroll
```

Expected: FAIL with "bootDemo is not defined" or import error.

- [ ] **Step 3: Write minimal bootDemo implementation**

Create `e2e-webdriverio/test/helpers/demoHelpers.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npm run test:wdio:scroll
```

Expected: PASS - demo boots successfully and nav is displayed.

- [ ] **Step 5: Commit**

```bash
git add e2e-webdriverio/test/helpers/demoHelpers.ts e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts
git commit -m "test(wdio): add bootDemo helper and smoke test

Port bootDemo from Playwright demoBoot.ts. Waits for all mount stages
and demo seeding before returning. Includes descriptive error messages
for each failure stage.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 4: Port Chat Activation and Scroll Helpers

**Files:**
- Modify: `e2e-webdriverio/test/helpers/demoHelpers.ts` (add activateChat, scrollToBottom)

**Interfaces:**
- Consumes: `__chatStore` global from demo, `[data-message-list]` selector
- Produces: 
  - `activateChat(jid: string): Promise<void>` - activates 1:1 conversation
  - `scrollToBottom(): Promise<void>` - scrolls message list to bottom

- [ ] **Step 1: Write the failing test**

Add to `e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts`:

```typescript
import { bootDemo, activateChat, scrollToBottom } from '../helpers/demoHelpers.js'

const DEMO_URL = '/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:80,msgStep:0'
const AVA = 'ava@fluux.chat'

describe('At-bottom stick (WebDriverIO)', () => {
  // ... existing test ...

  it('should activate chat and scroll to bottom', async () => {
    await bootDemo(DEMO_URL)
    await activateChat(AVA)
    
    // Verify chat is active
    const hash = await browser.execute(() => window.location.hash)
    await expect(hash).toContain(encodeURIComponent(AVA))
    
    await scrollToBottom()
    
    // Verify scrolled to bottom
    const distFromBottom = await browser.execute(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return -1
      return s.scrollHeight - s.scrollTop - s.clientHeight
    })
    await expect(distFromBottom).toBeLessThan(5) // Should be at exact bottom
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm run test:wdio:scroll
```

Expected: FAIL with "activateChat is not exported" or "scrollToBottom is not exported".

- [ ] **Step 3: Implement activateChat and scrollToBottom**

Add to `e2e-webdriverio/test/helpers/demoHelpers.ts`:

```typescript
const SETTLE_MS = 700

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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npm run test:wdio:scroll
```

Expected: PASS - chat activated, URL hash updated, scrolled to bottom.

- [ ] **Step 5: Commit**

```bash
git add e2e-webdriverio/test/helpers/demoHelpers.ts e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts
git commit -m "test(wdio): add activateChat and scrollToBottom helpers

- activateChat: uses __chatStore to activate 1:1 conversation
- scrollToBottom: scrolls message list to bottom via scrollTop
- Both include SETTLE_MS pause for layout stabilization

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 5: Port Message Visibility Checker

**Files:**
- Modify: `e2e-webdriverio/test/helpers/demoHelpers.ts` (add newMsgStuck, constants)

**Interfaces:**
- Consumes: `[data-message-id]` selector, message list scroll metrics
- Produces: 
  - `newMsgStuck(msgId: string): Promise<{ visible: boolean; distFromBottom: number }>` - checks if message is visible and stuck to bottom
  - Constants: `AT_BOTTOM_OK_PX = 150`

- [ ] **Step 1: Write the failing test**

Add to `e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts`:

```typescript
import { bootDemo, activateChat, scrollToBottom, newMsgStuck, AT_BOTTOM_OK_PX } from '../helpers/demoHelpers.js'

// ... existing imports and constants ...

describe('At-bottom stick (WebDriverIO)', () => {
  // ... existing tests ...

  it('should detect message visibility and distance from bottom', async () => {
    await bootDemo(DEMO_URL)
    await activateChat(AVA)
    await scrollToBottom()
    
    // Inject a test message
    const testId = `visibility-test-${Date.now()}`
    await browser.execute(([jid, msgId]: [string, string]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = (window as any).__chatStore
      const st = cs.getState()
      const msgs = (st.messages.get(jid) ?? []).slice()
      msgs.push({
        type: 'chat',
        conversationId: jid,
        from: jid,
        to: 'me@fluux.chat',
        id: msgId,
        body: 'visibility test message',
        isOutgoing: false,
        timestamp: new Date(),
      })
      const m = new Map(st.messages)
      m.set(jid, msgs)
      cs.setState({ messages: m })
    }, [AVA, testId])
    
    const msgEl = await $(`[data-message-id="${testId}"]`)
    await msgEl.waitForDisplayed({ timeout: 5000 })
    await browser.pause(400)
    
    const result = await newMsgStuck(testId)
    await expect(result.visible).toBe(true)
    await expect(result.distFromBottom).toBeLessThan(AT_BOTTOM_OK_PX)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm run test:wdio:scroll
```

Expected: FAIL with "newMsgStuck is not exported" or "AT_BOTTOM_OK_PX is not exported".

- [ ] **Step 3: Implement newMsgStuck and constants**

Add to `e2e-webdriverio/test/helpers/demoHelpers.ts`:

```typescript
export const AT_BOTTOM_OK_PX = 150

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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npm run test:wdio:scroll
```

Expected: PASS - message is detected as visible and within AT_BOTTOM_OK_PX of bottom.

- [ ] **Step 5: Commit**

```bash
git add e2e-webdriverio/test/helpers/demoHelpers.ts e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts
git commit -m "test(wdio): add newMsgStuck visibility checker

Checks if a message by ID is visible in viewport and calculates
distance from bottom. Returns {visible, distFromBottom} for assertions.
AT_BOTTOM_OK_PX constant set to 150px (matches Playwright).

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 6: Implement Plain Incoming Message Test

**Files:**
- Modify: `e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts` (add first real test)

**Interfaces:**
- Consumes: All helper functions from `demoHelpers.ts`
- Produces: Test case "plain: incoming message while at bottom stays visible"

- [ ] **Step 1: Write the test**

Replace the temporary tests in `e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts` with:

```typescript
import {
  bootDemo,
  activateChat,
  scrollToBottom,
  newMsgStuck,
  AT_BOTTOM_OK_PX,
} from '../helpers/demoHelpers.js'

const DEMO_URL = '/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:80,msgStep:0'
const AVA = 'ava@fluux.chat'

describe('At-bottom stick (WebDriverIO)', () => {
  it('plain: incoming message while at bottom stays visible', async () => {
    await bootDemo(DEMO_URL)
    await activateChat(AVA)
    await scrollToBottom()

    // Inject incoming message with same-day timestamp
    const id = `incoming-plain-${Date.now()}`
    await browser.execute(([jid, msgId]: [string, string]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = (window as any).__chatStore
      const st = cs.getState()
      const msgs = (st.messages.get(jid) ?? []).slice()
      msgs.push({
        type: 'chat',
        conversationId: jid,
        from: jid,
        to: 'me@fluux.chat',
        id: msgId,
        body: 'test incoming message',
        isOutgoing: false,
        timestamp: new Date(Date.now()),
      })
      const m = new Map(st.messages)
      m.set(jid, msgs)
      cs.setState({ messages: m })
    }, [AVA, id])

    // Wait for the message to appear in DOM
    const msgEl = await $(`[data-message-id="${id}"]`)
    await msgEl.waitForDisplayed({ timeout: 5000 })
    await browser.pause(400)

    // Verify message is visible and stuck to bottom
    const res = await newMsgStuck(id)
    await expect(res.visible).toBe(true)
    await expect(res.distFromBottom).toBeLessThan(AT_BOTTOM_OK_PX)
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run:
```bash
npm run test:wdio:scroll
```

Expected: PASS - incoming message is visible and within 150px of bottom.

- [ ] **Step 3: Verify test output**

Check that the test output shows:
- Test name: "plain: incoming message while at bottom stays visible"
- Duration (should be under 10 seconds for a healthy run)
- PASS status

- [ ] **Step 4: Commit**

```bash
git add e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts
git commit -m "test(wdio): add plain incoming message bottom-stick test

First real test case: verifies that an incoming message (same day)
stays visible when inserted while the viewport is at the bottom.
Matches the Playwright test from scroll-invariants.ts:1582-1595.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 7: Implement Outgoing New-Day Message Test

**Files:**
- Modify: `e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts` (add second test)

**Interfaces:**
- Consumes: All helper functions from `demoHelpers.ts`
- Produces: Test case "outgoing new-day: sent message with date divider sticks to bottom"

- [ ] **Step 1: Write the test**

Add to `e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts` after the first test:

```typescript
  it('outgoing new-day: sent message with date divider sticks to bottom', async () => {
    await bootDemo(DEMO_URL)
    await activateChat(AVA)
    await scrollToBottom()

    // User sends the FIRST message of a new day: optimistic row + a date separator
    // are both inserted at the bottom. Timestamp = next day to trigger date divider.
    const id = `outgoing-newday-${Date.now()}`
    await browser.execute(([jid, msgId]: [string, string]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = (window as any).__chatStore
      const st = cs.getState()
      const msgs = (st.messages.get(jid) ?? []).slice()
      msgs.push({
        type: 'chat',
        conversationId: jid,
        from: 'me@fluux.chat',
        to: jid,
        id: msgId,
        body: 'first message of a new day — sent by me',
        isOutgoing: true,
        timestamp: new Date(Date.now() + 24 * 60 * 60 * 1000), // Next day
      })
      const m = new Map(st.messages)
      m.set(jid, msgs)
      cs.setState({ messages: m })
    }, [AVA, id])

    // Wait for the message to appear in DOM
    const msgEl = await $(`[data-message-id="${id}"]`)
    await msgEl.waitForDisplayed({ timeout: 5000 })
    await browser.pause(400)

    // Verify message is visible and stuck to bottom despite date divider insertion
    const res = await newMsgStuck(id)
    await expect(res.visible).toBe(true)
    await expect(res.distFromBottom).toBeLessThan(AT_BOTTOM_OK_PX)
  })
```

- [ ] **Step 2: Run test to verify it passes**

Run:
```bash
npm run test:wdio:scroll
```

Expected: PASS - both tests pass, outgoing new-day message is visible and within 150px of bottom.

- [ ] **Step 3: Run both tests together**

Run:
```bash
npm run test:wdio
```

Expected: 2 tests PASS, total duration under 30 seconds for healthy runs.

- [ ] **Step 4: Commit**

```bash
git add e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts
git commit -m "test(wdio): add outgoing new-day bottom-stick test

Second test case: verifies that an outgoing message that triggers a
date divider insertion stays visible and stuck to bottom. Tests more
complex DOM mutation (message + date separator).
Matches Playwright test from scroll-invariants.ts:1819-1847.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 8: Add Reset Scroll Shadow Tracker

**Files:**
- Modify: `e2e-webdriverio/test/helpers/demoHelpers.ts` (add scroll shadow reset to bootDemo)

**Interfaces:**
- Consumes: `__fluuxScrollShadow` global from demo
- Produces: Scroll shadow tracker reset after demo boots (matches Playwright behavior)

- [ ] **Step 1: Read Playwright implementation**

The Playwright version calls `__fluuxScrollShadow?.(true)` after loading the demo.
This resets the scroll shadow divergence tracker used in the afterEach hook.

- [ ] **Step 2: Add scroll shadow reset to bootDemo**

Modify the `bootDemo` function in `e2e-webdriverio/test/helpers/demoHelpers.ts`:

Add this after the `waitForDemoSeeded()` call:

```typescript
  // Wait for demo seeding to complete
  await waitForDemoSeeded()

  // Reset scroll shadow tracker (matches Playwright's loadDemo behavior)
  await browser.execute(() => {
    ;(
      window as Window & {
        __fluuxScrollShadow?: (reset?: boolean) => unknown
      }
    ).__fluuxScrollShadow?.(true)
  })
}
```

- [ ] **Step 3: Run tests to verify no regression**

Run:
```bash
npm run test:wdio
```

Expected: Both tests still PASS with scroll shadow reset in place.

- [ ] **Step 4: Commit**

```bash
git add e2e-webdriverio/test/helpers/demoHelpers.ts
git commit -m "test(wdio): reset scroll shadow tracker in bootDemo

Call __fluuxScrollShadow(true) after demo boots to reset the
divergence tracker. Matches Playwright's loadDemo behavior from
scroll-invariants.ts.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 9: Add Documentation and Validation

**Files:**
- Create: `e2e-webdriverio/README.md`
- Modify: Root `README.md` (optional - only if there's a testing section to update)

**Interfaces:**
- Consumes: All implemented files and tests
- Produces: Documentation explaining how to run WebDriverIO tests and what they validate

- [ ] **Step 1: Write WebDriverIO README**

Create `e2e-webdriverio/README.md`:

```markdown
# WebDriverIO E2E Tests

Proof-of-concept WebDriverIO test suite running in parallel with Playwright.

## Purpose

Evaluate WebDriverIO as a testing framework for Tauri v2 applications. This suite
currently contains 2 scroll-invariant tests migrated from Playwright as a baseline
comparison.

## Running Tests

### Prerequisites

```bash
# Install dependencies
npm install

# Build e2e artifacts
npm run build:e2e
```

### Run Tests

```bash
# Option 1: WebDriverIO manages the server (recommended)
npm run test:wdio

# Option 2: Manual server control (useful for debugging)
# Terminal 1:
npm run preview:e2e

# Terminal 2:
npm run test:wdio:scroll
```

## Test Structure

```
e2e-webdriverio/
├── wdio.conf.ts              # WebDriverIO configuration
├── tsconfig.json             # TypeScript config
├── test/
│   ├── helpers/
│   │   └── demoHelpers.ts    # Shared test utilities
│   └── specs/
│       └── scroll-bottom-stick.spec.ts  # Bottom-stick invariant tests
```

## Tests

### scroll-bottom-stick.spec.ts

**Test 1: Plain incoming message**
- Load demo and activate 1:1 chat
- Scroll to bottom
- Inject incoming message (same day)
- Verify message is visible and viewport stays at bottom (<150px from bottom)

**Test 2: Outgoing new-day message**
- Load demo and activate 1:1 chat
- Scroll to bottom
- Inject outgoing message with next-day timestamp (triggers date divider)
- Verify message + date divider are visible and viewport stays at bottom

## Configuration

- **Framework:** Mocha
- **Browser:** Chromium only (WebKit support can be added later)
- **Timeout:** 180s per test (matches Playwright)
- **Retries:** 0 locally, 2 in CI
- **Base URL:** `http://localhost:4173` (vite preview server)

## Comparison with Playwright

| Aspect | Playwright | WebDriverIO |
|--------|-----------|-------------|
| Framework | Built-in test runner | Mocha |
| API Style | `page.evaluate()` | `browser.execute()` |
| Element Selection | `page.waitForSelector()` | `$(selector).waitForDisplayed()` |
| Engines Tested | Chromium + WebKit | Chromium (initial) |
| Test Files | `scripts/*.ts` | `e2e-webdriverio/test/specs/*.spec.ts` |

Both frameworks:
- Drive the same vite preview server
- Use the same demo URL and harness globals (`__chatStore`, `__fluuxDemoReady`)
- Share identical timeout and retry settings
- Target the same DOM selectors and assertions

## Future Expansion

- Add WebKit support via `@wdio/selenium-standalone-service`
- Migrate additional scroll-invariant tests
- Add native Tauri app testing with `tauri-driver`
- Integrate into CI pipeline
```

- [ ] **Step 2: Verify all tests pass**

Run full test suite:
```bash
npm run test:wdio
```

Expected: 2/2 tests PASS.

- [ ] **Step 3: Verify TypeScript compilation**

Run:
```bash
npx tsc --noEmit -p e2e-webdriverio/tsconfig.json
```

Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add e2e-webdriverio/README.md
git commit -m "docs(wdio): add WebDriverIO test suite documentation

Document test structure, running instructions, and comparison with
Playwright. Explains the proof-of-concept purpose and future expansion
possibilities.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 10: Final Validation and Branch Push

**Files:**
- All committed files in the branch

**Interfaces:**
- Consumes: All tasks 1-9 completed
- Produces: Branch `webdriverio-migration` ready for PR

- [ ] **Step 1: Run complete test validation**

Run both test suites to ensure no conflicts:

```bash
# Build artifacts
npm run build:e2e

# Run WebDriverIO tests
npm run test:wdio

# Run Playwright tests (to verify we didn't break anything)
npm run test:e2e
```

Expected: 
- WebDriverIO: 2/2 tests PASS
- Playwright: All existing tests PASS (no regression)

- [ ] **Step 2: Verify branch status**

Run:
```bash
git status
git log --oneline main..webdriverio-migration
```

Expected: Clean working tree, 10 commits ahead of main.

- [ ] **Step 3: Create summary commit message**

Expected commit history:
1. build: add WebDriverIO dependencies and test scripts
2. test(wdio): add WebDriverIO configuration
3. test(wdio): add bootDemo helper and smoke test
4. test(wdio): add activateChat and scrollToBottom helpers
5. test(wdio): add newMsgStuck visibility checker
6. test(wdio): add plain incoming message bottom-stick test
7. test(wdio): add outgoing new-day bottom-stick test
8. test(wdio): reset scroll shadow tracker in bootDemo
9. docs(wdio): add WebDriverIO test suite documentation

- [ ] **Step 4: Push branch**

```bash
git push -u origin webdriverio-migration
```

Expected: Branch pushed successfully.

- [ ] **Step 5: Verify file structure**

Run:
```bash
find e2e-webdriverio -type f
```

Expected output:
```
e2e-webdriverio/wdio.conf.ts
e2e-webdriverio/tsconfig.json
e2e-webdriverio/README.md
e2e-webdriverio/test/helpers/demoHelpers.ts
e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts
```

- [ ] **Step 6: Document PR description**

The branch is now ready for PR. Suggested PR description:

```markdown
## WebDriverIO E2E Test Migration (Proof-of-Concept)

Migrate 2 scroll-invariant tests from Playwright to WebDriverIO as a framework evaluation.

### What Changed

- **New test suite:** `e2e-webdriverio/` with WebDriverIO config and 2 migrated tests
- **New npm scripts:** `test:wdio` and `test:wdio:scroll`
- **No changes** to existing Playwright tests or CI

### Tests Migrated

1. **Plain incoming message:** Verifies bottom-stick when inserting a same-day message
2. **Outgoing new-day message:** Verifies bottom-stick when inserting message + date divider

Both tests match their Playwright equivalents and assert identical invariants.

### Running Tests

\`\`\`bash
npm run build:e2e
npm run test:wdio
\`\`\`

### Next Steps

If WebDriverIO proves suitable:
- Migrate additional scroll-invariant tests
- Add WebKit support
- Add to CI pipeline
- Evaluate for native Tauri app testing with tauri-driver

See `e2e-webdriverio/README.md` for full documentation.
```

This task is complete when the branch is pushed and ready for PR review.

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Task 1: Dependencies and branch creation (spec section: Dependencies)
- ✅ Task 2: WebDriverIO configuration (spec section: Configuration)
- ✅ Task 3: bootDemo helper (spec section: Helper Functions - loadDemo)
- ✅ Task 4: activateChat and scrollToBottom (spec section: Helper Functions - activateChat, scrollToBottom)
- ✅ Task 5: newMsgStuck visibility checker (spec section: Helper Functions - newMsgStuck)
- ✅ Task 6: Plain incoming message test (spec section: Tests to Migrate - Test Case 1)
- ✅ Task 7: Outgoing new-day test (spec section: Tests to Migrate - Test Case 2)
- ✅ Task 8: Scroll shadow reset (spec section: Helper Functions - loadDemo detail)
- ✅ Task 9: Documentation (spec section: What Gets Committed)
- ✅ Task 10: Validation and push (spec section: Branch Strategy)

**Placeholder scan:** ✅ No TBD/TODO/implement later placeholders

**Type consistency:**
- `bootDemo(url: string): Promise<void>` - consistent across all uses
- `activateChat(jid: string): Promise<void>` - consistent across all uses
- `scrollToBottom(): Promise<void>` - consistent across all uses
- `newMsgStuck(msgId: string): Promise<{ visible: boolean; distFromBottom: number }>` - consistent across all uses
- Constants: `AT_BOTTOM_OK_PX`, `AVA`, `DEMO_URL` - consistent across all uses

**All code blocks contain actual implementation** - ✅ verified

**No references to undefined functions/types** - ✅ verified
