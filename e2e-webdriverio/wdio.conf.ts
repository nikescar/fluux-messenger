import { join } from 'node:path'

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
  // Tells WDIO to optimize for a desktop Tauri app execution
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'tauri',
    },
  ],

  //
  // ========
  // Services
  // ========
  services: [
    [
      'tauri',
      {
        // Path to your compiled Tauri binary
        // Use debug build for faster iteration, release for production testing
        appPath: join(process.cwd(), 'apps', 'fluux', 'src-tauri', 'target', 'debug', 'fluux'),
      },
    ],
  ],

  //
  // ===================
  // Test Configurations
  // ===================
  logLevel: 'info',
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  framework: 'mocha',
  reporters: ['spec'],

  mochaOpts: {
    ui: 'bdd',
    timeout: 180000, // 180 seconds, matches Playwright
    retries: process.env.CI ? 2 : 0, // 0 locally, 2 in CI
  },

  //
  // =====
  // Hooks
  // =====
}
