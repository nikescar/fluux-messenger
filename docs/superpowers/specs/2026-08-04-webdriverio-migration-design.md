# WebDriverIO E2E Test Migration Design

**Date:** 2026-08-04  
**Author:** Claude Sonnet 4.5  
**Status:** Approved

## Overview

Migrate 2 specific scroll-invariant tests from Playwright to WebDriverIO as a proof-of-concept for evaluating WebDriverIO's suitability for Tauri v2 application testing. The migration creates a parallel test suite without disrupting existing Playwright tests.

## Goals

1. Port 2 bottom-stick scroll tests to WebDriverIO
2. Demonstrate WebDriverIO can drive the same demo harness as Playwright
3. Evaluate WebDriverIO as a potential alternative for Tauri E2E testing
4. Keep the existing Playwright suite fully functional

## Non-Goals

- Full migration of all Playwright tests (only 2 tests)
- Native Tauri app testing via tauri-driver (web-based demo only)
- CI/CD integration (optional, can be added later)
- WebKit support (Chromium only for initial evaluation)

## Architecture

### Directory Structure

```
fluux-messenger/
├── e2e-webdriverio/              # New WebDriverIO test suite
│   ├── wdio.conf.ts              # WebDriverIO configuration
│   ├── test/
│   │   ├── helpers/
│   │   │   └── demoHelpers.ts    # Ported helper functions
│   │   └── specs/
│   │       └── scroll-bottom-stick.spec.ts  # 2 migrated tests
│   └── tsconfig.json             # TypeScript config for tests
├── scripts/                       # Existing Playwright tests (UNCHANGED)
│   ├── scroll-invariants.ts
│   ├── composer-geometry.ts
│   └── anomaly-smoke.ts
├── playwright.e2e.config.ts      # Existing config (UNCHANGED)
└── package.json                   # Add WebDriverIO dependencies
```

### Test Execution Flow

1. WebDriverIO starts or reuses the vite preview server at `http://localhost:4173`
2. Tests navigate to demo URL: `/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:80,msgStep:0`
3. Uses the same demo harness and `__chatStore` global seams as Playwright
4. Runs in Chromium browser via W3C WebDriver protocol
5. Reuses existing build artifacts from `npm run build:e2e`

**Why this approach:**  
Parallel setup allows side-by-side comparison of Playwright vs WebDriverIO without risk to the existing test infrastructure. If WebDriverIO proves unsuitable, we delete the branch. If it proves better, we can incrementally migrate more tests.

**How to apply:**  
Use this architecture for initial evaluation. Do not replace Playwright until WebDriverIO proves itself across multiple test scenarios.

## Dependencies

### New devDependencies

```json
{
  "@wdio/cli": "^9.4.0",
  "@wdio/local-runner": "^9.4.0",
  "@wdio/mocha-framework": "^9.4.0",
  "@wdio/spec-reporter": "^9.4.0",
  "webdriverio": "^9.4.0"
}
```

### New npm Scripts

```json
{
  "test:wdio": "wdio run e2e-webdriverio/wdio.conf.ts",
  "test:wdio:scroll": "wdio run e2e-webdriverio/wdio.conf.ts --spec e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts"
}
```

## Configuration (`e2e-webdriverio/wdio.conf.ts`)

### Key Settings

- **Runner:** `@wdio/local-runner` (parallel execution disabled for consistency)
- **Base URL:** `http://localhost:4173` (matches Playwright preview server)
- **Timeout:** 180,000ms (same as Playwright - accommodates slow CI runners)
- **Framework:** Mocha (familiar assertion style)
- **Reporters:** `spec` (CLI output)
- **Retries:** 0 locally, 2 in CI (matches Playwright philosophy)

### Browser Capabilities

```typescript
capabilities: [{
  browserName: 'chrome',
  'goog:chromeOptions': {
    args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage']
  }
}]
```

**Why Chromium-only:**  
The original Playwright tests run on both Chromium and WebKit to catch engine-specific layout differences. For this initial migration, we start with Chromium only to validate the core framework. WebKit support can be added later via `@wdio/selenium-standalone-service` if needed.

### Server Management

The config checks if `http://localhost:4173` is reachable. If not running, it executes:
```bash
npm run build:e2e && npm run preview:e2e
```

This reuses the exact same build process as Playwright, ensuring both frameworks test identical artifacts.

**How to apply:**  
Keep server startup logic simple - check connection, start if needed, fail fast if unreachable. No custom server wrapper needed.

## Tests to Migrate

### Source File
`scripts/scroll-invariants.ts` (lines 1582-1595 and 1819-1847)

### Test Cases

#### 1. Plain Incoming Message
**Test:** "plain: incoming message (same day) while at bottom stays visible"  
**Steps:**
1. Load demo and activate 1:1 chat with `ava@fluux.chat`
2. Scroll message list to bottom
3. Inject incoming message via `__chatStore` manipulation (same-day timestamp)
4. Wait for message DOM element to appear
5. Assert message is visible in viewport
6. Assert `distanceFromBottom < 150px` (AT_BOTTOM_OK_PX)

#### 2. Outgoing New-Day Message
**Test:** "outgoing new-day: a sent message that inserts a date divider sticks to the bottom"  
**Steps:**
1. Load demo and activate 1:1 chat with `ava@fluux.chat`
2. Scroll message list to bottom
3. Inject outgoing message with next-day timestamp (triggers date separator insertion)
4. Wait for message DOM element to appear
5. Assert message is visible in viewport
6. Assert `distanceFromBottom < 150px`

**Why these tests:**  
They exercise the same scroll-to-bottom invariant with two different complexity levels:
- Test 1: Simple message insertion (baseline)
- Test 2: Message + date divider insertion (DOM mutation complexity)

Both are self-contained and don't require extensive setup, making them ideal for framework evaluation.

## Helper Functions to Port

### 1. `loadDemo()`
```typescript
async function loadDemo(url: string): Promise<void>
```
- Navigate to demo URL
- Wait for demo boot to complete (uses existing `bootDemo` logic)
- Reset scroll shadow tracker via `__fluuxScrollShadow?.(true)`

### 2. `activateChat()`
```typescript
async function activateChat(jid: string): Promise<void>
```
- Call `__chatStore.getState().activateConversation(jid)` via `browser.execute()`
- Poll `__chatStore.getState().activeConversationId` until it matches JID
- Set `window.location.hash` to `#/messages/{jid}`
- Wait for `[data-message-list]` selector to appear
- Pause for `SETTLE_MS` (700ms)

### 3. `scrollToBottom()`
```typescript
async function scrollToBottom(): Promise<void>
```
- Query `[data-message-list]` element
- Set `scrollTop = scrollHeight` via `browser.execute()`
- Pause for `SETTLE_MS`

### 4. `newMsgStuck()`
```typescript
async function newMsgStuck(msgId: string): Promise<{ visible: boolean; distFromBottom: number }>
```
- Query message element by `[data-message-id="${msgId}"]`
- Calculate visibility (element bounds vs scrollport bounds)
- Calculate `distanceFromBottom = scrollHeight - scrollTop - clientHeight`
- Return object with both metrics

### Constants
```typescript
const SETTLE_MS = 700
const AT_BOTTOM_OK_PX = 150
const AVA = 'ava@fluux.chat'
```

## Playwright → WebDriverIO API Mappings

| Playwright | WebDriverIO | Notes |
|------------|-------------|-------|
| `page.evaluate(fn)` | `browser.execute(fn)` | Execute JS in browser context |
| `page.evaluate(fn, arg)` | `browser.execute(fn, arg)` | Pass arguments to browser context |
| `page.waitForSelector(sel)` | `$(sel).waitForDisplayed()` | Wait for element visibility |
| `page.waitForTimeout(ms)` | `browser.pause(ms)` | Fixed-duration wait |
| `page.waitForFunction(fn)` | `browser.waitUntil(() => browser.execute(fn))` | Poll until condition true |
| `expect(val).toBe(x)` | `expect(val).toBe(x)` | Same assertion style (Mocha) |
| `expect(val).toBeLessThan(x)` | `expect(val).toBeLessThan(x)` | Same assertion |

## Test Structure

```typescript
describe('At-bottom stick (WebDriverIO)', () => {
  const AVA = 'ava@fluux.chat'
  
  it('plain: incoming message while at bottom stays visible', async () => {
    await loadDemo()
    await activateChat(AVA)
    await scrollToBottom()
    
    const id = `incoming-plain-${Date.now()}`
    await browser.execute(([jid, msgId]) => {
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
    
    await $(`[data-message-id="${id}"]`).waitForDisplayed({ timeout: 5000 })
    await browser.pause(400)
    
    const res = await newMsgStuck(id)
    expect(res.visible).toBe(true)
    expect(res.distFromBottom).toBeLessThan(AT_BOTTOM_OK_PX)
  })
  
  it('outgoing new-day: sent message with date divider sticks to bottom', async () => {
    // Similar structure with next-day timestamp
  })
})
```

## Branch Strategy

- **Branch name:** `webdriverio-migration`
- **Branch from:** `main`
- **Merge strategy:** PR for review, squash merge after approval

## What Gets Committed

1. **Modified:**
   - `package.json` (new dependencies + scripts)
   - `package-lock.json` (lockfile update)

2. **New files:**
   - `e2e-webdriverio/wdio.conf.ts`
   - `e2e-webdriverio/test/helpers/demoHelpers.ts`
   - `e2e-webdriverio/test/specs/scroll-bottom-stick.spec.ts`
   - `e2e-webdriverio/tsconfig.json`

3. **Unchanged:**
   - All `scripts/` Playwright tests
   - `playwright.e2e.config.ts`
   - CI workflows (`.github/workflows/`)

## Testing & Validation

### Local Testing Flow

```bash
# 1. Install dependencies
npm install

# 2. Build e2e artifacts
npm run build:e2e

# 3. Start preview server (one terminal)
npm run preview:e2e

# 4. Run WebDriverIO tests (another terminal)
npm run test:wdio
```

### Success Criteria

- [ ] Both migrated tests pass locally
- [ ] Tests produce identical assertions as Playwright versions
- [ ] Helper functions work correctly (chat activation, scroll, assertions)
- [ ] Clear error messages if demo fails to boot
- [ ] Code is documented and reviewable

### Error Handling

- WebDriverIO fails fast if server at `localhost:4173` is unreachable
- Tests timeout after 180s (same as Playwright)
- Clear error if `__chatStore` global is missing (indicates wrong URL or boot failure)
- Assertion failures show both expected and actual values

## CI Integration (Optional)

**Not included in initial PR.**  

If WebDriverIO proves valuable, add a new GitHub Actions job:

```yaml
webdriverio-tests:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '22.22.0'
    - run: npm ci
    - run: npm run build:e2e
    - run: npm run test:wdio
    - uses: actions/upload-artifact@v4
      if: failure()
      with:
        name: wdio-logs
        path: e2e-webdriverio/logs/
```

**Why defer CI integration:**  
Validate WebDriverIO works locally first. Adding to CI too early creates noise if the framework needs tuning.

**How to apply:**  
Only add CI after at least 5-10 tests are migrated and stable locally.

## Future Expansion (Out of Scope)

These are **NOT** part of this initial migration:

1. **WebKit support:** Add via `@wdio/selenium-standalone-service`
2. **Native Tauri testing:** Install `tauri-driver` and configure WebDriverIO to launch the compiled Tauri binary
3. **Full test suite migration:** Migrate remaining scroll-invariants, composer-geometry, and anomaly-smoke tests
4. **Parallel execution:** Enable WebDriverIO's parallel runner for faster CI
5. **Visual regression:** Add `@wdio/visual-service` for screenshot comparison

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| WebDriverIO doesn't support demo harness globals | Validate `__chatStore` access in first test; fail fast if unavailable |
| Tests are slower than Playwright | Measure execution time; acceptable if within 2x of Playwright |
| Framework is harder to debug | Use `browser.debug()` breakpoints and verbose logging |
| Dependencies conflict with existing tooling | Isolated to `e2e-webdriverio/` directory; no shared config |

## Decision Points

### Why WebDriverIO instead of Selenium directly?

WebDriverIO provides a higher-level API than raw Selenium, with better TypeScript support and built-in test runner integration. It's the recommended framework in Tauri's official documentation.

### Why Mocha instead of Jasmine/Jest?

Mocha is WebDriverIO's default and integrates seamlessly. The assertion style (`expect().toBe()`) matches what the team already uses in Playwright tests.

### Why not use tauri-driver immediately?

We're testing the web demo layer first. If WebDriverIO works well here, we can add native Tauri testing later. Starting with the web demo reduces variables during evaluation.

## Success Metrics

After this PR merges, we should be able to answer:

- ✅ Can WebDriverIO drive the same demo as Playwright?
- ✅ Are the helper functions reusable across tests?
- ✅ Is the API ergonomic for our test patterns?
- ✅ Does it run reliably on developer machines?

If all answers are yes, expand the migration. If no, document why and stick with Playwright.

## References

- [Tauri v2 WebDriver Testing Guide](https://v2.tauri.app/develop/tests/)
- [WebDriverIO Documentation](https://webdriver.io/docs/gettingstarted)
- [Existing Playwright Config](../../../playwright.e2e.config.ts)
- [Scroll Invariants Source](../../../scripts/scroll-invariants.ts)
