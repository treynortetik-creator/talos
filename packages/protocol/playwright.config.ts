import { defineConfig } from '@playwright/test'

// Under ci-local (it sets CI_FLAKE_FILE) Chromium goes straight to localhost: a proxy put in front of it on the CI Mac once failed
// page.goto with ERR_UNEXPECTED_PROXY_AUTH. WebKit takes no Chromium flags; ci-local.sh clears the proxy environment for it.
const ciChromiumArgs = process.env.CI_FLAKE_FILE ? ['--no-proxy-server'] : []

// Browser round trips for the isomorphic crypto (owner signatures, hashes, enrollment binding).
// Run: pnpm --filter @talos-app/protocol test:browser   (needs `playwright install chromium webkit` once)
export default defineConfig({
  testDir: 'test-browser',
  timeout: 30_000,
  fullyParallel: true,
  // No retries, in CI or by hand: a failed test fails (the owner's rule; scripts/ci-no-retries.test.ts).
  retries: 0,
  reporter: [['list'], ...(process.env.CI_FLAKE_FILE ? [['../../scripts/ci-flake-playwright.ts'] as const] : [])],
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: { args: ciChromiumArgs } } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
})
