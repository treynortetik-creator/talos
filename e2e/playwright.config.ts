// End-to-end suite (spec 10.3): the built relay + the built web app + the real bridge behind FakeClaude. Chromium only:
// the virtual authenticator and the fake microphone are Chromium features. Each test starts its own stack on its own port
// and temp folders. By default the tests run one after another. E2E_WORKERS=n (scripts/ci-local.sh) spreads them over n
// worker processes: the relay runs inside the worker and its auth state is per process, so workers never share it.
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const workers = Number(process.env.E2E_WORKERS) || 1

export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.ts',
  globalSetup: fileURLToPath(new URL('./harness/global-setup.ts', import.meta.url)),
  fullyParallel: workers > 1,
  workers,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    permissions: ['microphone'],
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
    trace: 'retain-on-failure',
  },
})
