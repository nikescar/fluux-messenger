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
