// End-to-end suite (spec 10.3): the built relay + the built web app + the real bridge behind FakeClaude. Chromium only:
// the virtual authenticator and the fake microphone are Chromium features. Each test starts its own stack on its own port
// and temp folders. By default the tests run one after another. E2E_WORKERS=n (scripts/ci-local.sh) spreads them over n
// worker processes: the relay runs inside the worker and its auth state is per process, so workers never share it.
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const workers = Number(process.env.E2E_WORKERS) || 1
// Under ci-local (it sets CI_FLAKE_FILE) Chromium goes straight to localhost: a proxy put in front of it on the CI Mac once failed
// page.goto with ERR_UNEXPECTED_PROXY_AUTH. WebKit takes no Chromium flags; ci-local.sh clears the proxy environment for it.
const ciChromiumArgs = process.env.CI_FLAKE_FILE ? ['--no-proxy-server'] : []

export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.ts',
  globalSetup: fileURLToPath(new URL('./harness/global-setup.ts', import.meta.url)),
  fullyParallel: workers > 1,
  workers,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // In CI (scripts/ci-local.sh sets CI_FLAKE_FILE) a failed test runs once more; a pass then is green but logged as a flake.
  retries: process.env.CI_FLAKE_FILE ? 1 : 0,
  reporter: [['list'], ...(process.env.CI_FLAKE_FILE ? [['../scripts/ci-flake-playwright.ts'] as const] : [])],
  use: {
    ...devices['Desktop Chrome'],
    permissions: ['microphone'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...ciChromiumArgs],
    },
    trace: 'retain-on-failure',
  },
})
