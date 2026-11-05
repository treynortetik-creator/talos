// WP1 owns this file from fan-out (spec 9, WP0 addendum). Vitest files are `*.test.ts`, Playwright specs are
// `*.spec.ts`, so the two never mix. WP2 adds its own specs here (CDP virtual authenticator, Chromium only); WP1's
// specs boot the relay in-process from `beforeAll`, so no `webServer` entry is needed.
// `PW_CHROMIUM_PATH` points at a Chromium binary when the Playwright download is unavailable (offline CI images).
import { defineConfig, devices } from '@playwright/test'

const executablePath = process.env.PW_CHROMIUM_PATH

export default defineConfig({
  testDir: 'test',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  reporter: [['list']],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(executablePath ? { launchOptions: { executablePath } } : {}) },
    },
  ],
})
