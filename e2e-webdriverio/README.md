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

# Build the Tauri app (debug mode for faster iteration)
npm run tauri:dev
# OR build release version for production-like testing:
# npm run tauri:build
```

**Important:** The Tauri app must be built before running tests. The tests launch the compiled binary at `apps/fluux/src-tauri/target/debug/fluux`.

### Run Tests

```bash
# Run all WebDriverIO tests (launches Tauri app automatically)
npm run test:wdio:scroll
```

The `@wdio/tauri-service` automatically:
1. Launches the Tauri desktop app binary
2. Connects via WebDriver protocol
3. Runs tests against the native app
4. Closes the app when tests complete

No separate server needed - the Tauri app is the test target.

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
- **Target:** Tauri desktop app (native WebView)
- **Service:** `@wdio/tauri-service` (drives the compiled Tauri binary)
- **Timeout:** 180s per test (matches Playwright)
- **Retries:** 0 locally, 2 in CI
- **Binary:** `apps/fluux/src-tauri/target/debug/fluux`

**Note:** The Tauri service launches the native desktop app instead of a browser. Tests run against the real application environment.

## Comparison with Playwright

| Aspect | Playwright | WebDriverIO + Tauri |
|--------|-----------|---------------------|
| Framework | Built-in test runner | Mocha |
| API Style | `page.evaluate()` | `browser.execute()` |
| Element Selection | `page.waitForSelector()` | `$(selector).waitForDisplayed()` |
| Target | Web demo (browser) | **Native Tauri app** |
| Engine | Chromium + WebKit | **Native WebView** (platform-specific) |
| Test Files | `scripts/*.ts` | `e2e-webdriverio/test/specs/*.spec.ts` |

**Key Difference:**
- **Playwright**: Tests the web demo in a browser
- **WebDriverIO**: Tests the **actual desktop application** users run

Both frameworks:
- Use the same harness globals (`__chatStore`, `__fluuxDemoReady`)
- Share identical timeout and retry settings
- Target the same DOM selectors and assertions
- Verify the same scroll-to-bottom invariants

## Future Expansion

- Add WebKit support via `@wdio/selenium-standalone-service`
- Migrate additional scroll-invariant tests
- Add native Tauri app testing with `tauri-driver`
- Integrate into CI pipeline
