// WP1 owns this file from fan-out (spec 9, WP0 addendum). Vitest files are `*.test.ts`, Playwright specs are
// `*.spec.ts`, so the two never mix. WP2 adds its own specs here (CDP virtual authenticator, Chromium only); WP1's
// specs boot the relay in-process from `beforeAll`, so no `webServer` entry is needed.
// `PW_CHROMIUM_PATH` points at a Chromium binary when the Playwright download is unavailable (offline CI images).
import { defineConfig, devices } from '@playwright/test'

const executablePath = process.env.PW_CHROMIUM_PATH
// Under ci-local (it sets CI_FLAKE_FILE) Chromium goes straight to localhost: a proxy put in front of it on the CI Mac once failed
// page.goto with ERR_UNEXPECTED_PROXY_AUTH. WebKit takes no Chromium flags; ci-local.sh clears the proxy environment for it.
const ciChromiumArgs = process.env.CI_FLAKE_FILE ? ['--no-proxy-server'] : []

export default defineConfig({
  testDir: 'test',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  // In CI (scripts/ci-local.sh sets CI_FLAKE_FILE) a failed test runs once more; a pass then is green but logged as a flake.
  retries: process.env.CI_FLAKE_FILE ? 1 : 0,
  reporter: [['list'], ...(process.env.CI_FLAKE_FILE ? [['../../scripts/ci-flake-playwright.ts'] as const] : [])],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { ...(executablePath ? { executablePath } : {}), args: ciChromiumArgs },
      },
    },
    // The sandbox specs run in WebKit too (Safari is the iPhone's engine); the rest are Chromium-only (CDP authenticator).
    { name: 'webkit', testMatch: ['**/pages-sandbox.spec.ts'], use: { ...devices['Desktop Safari'] } },
  ],
})
