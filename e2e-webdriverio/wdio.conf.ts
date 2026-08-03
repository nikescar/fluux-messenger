export const config = {
  //
  // ====================
  // Runner Configuration
  // ====================
  runner: 'local',

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
