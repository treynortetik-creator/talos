// End-to-end suite (spec 10.3): the built relay + the built web app + the real bridge behind FakeClaude. Chromium only:
// the virtual authenticator is a Chromium feature. Each test starts its own stack on its own port
// and temp folders. By default the tests run one after another. E2E_WORKERS=n (scripts/ci-local.sh) spreads them over n
// worker processes: the relay runs inside the worker and its auth state is per process, so workers never share it.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const workers = Number(process.env.E2E_WORKERS) || 1
// Under ci-local (it sets CI_FLAKE_FILE) Chromium goes straight to localhost: a proxy put in front of it on the CI Mac once failed
// page.goto with ERR_UNEXPECTED_PROXY_AUTH. WebKit takes no Chromium flags; ci-local.sh clears the proxy environment for it.
// Chromium on macOS hands notifications to the real Notification Center, so a push or Notification spec put banners on the
// owner's desktop. NativeNotifications off keeps the Notification and push APIs working inside the test browser.
// Playwright launches Chromium with its own `--disable-features=<list>` (PaintHolding, HttpsUpgrades, ...) and Chromium keeps only
// the LAST of a repeated switch, so a second switch from here would switch those defaults back on. Playwright has no option to
// add to its list and does not export it, so read it from playwright-core and send ONE merged switch. Any more features of
// ours join `ours`. scripts/ci-flake-reporters.test.ts reads the real launch argv and fails if either list loses a feature.
function disableFeatures(...ours: string[]) {
  // pnpm: playwright-core is a dependency of playwright, which is a dependency of @playwright/test
  const fromTest = createRequire(createRequire(import.meta.url).resolve('@playwright/test'))
  const core = createRequire(fromTest.resolve('playwright')).resolve('playwright-core/lib/coreBundle')
  const source = readFileSync(core, 'utf8')
  const list = /disabledFeatures = \[([\s\S]*?)\]\.filter\(Boolean\)/.exec(source)?.[1]
  const theirs = [...(list ?? '').replace(/\/\/.*$/gm, '').matchAll(/"(\w+)"/g)].map((m) => m[1])
  if (theirs.length === 0) throw new Error(`playwright-core's disabledFeatures list was not found in ${core}`)
  return `--disable-features=${[...new Set([...theirs, ...ours])].join(',')}`
}
const chromiumArgs = [
  ...(process.env.CI_FLAKE_FILE ? ['--no-proxy-server'] : []),
  disableFeatures('NativeNotifications'),
]

export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.ts',
  globalSetup: fileURLToPath(new URL('./harness/global-setup.ts', import.meta.url)),
  fullyParallel: workers > 1,
  workers,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // No retries, in CI or by hand: a failed test fails (the owner's rule; scripts/ci-no-retries.test.ts).
  retries: 0,
  reporter: [['list'], ...(process.env.CI_FLAKE_FILE ? [['../scripts/ci-flake-playwright.ts'] as const] : [])],
  use: {
    ...devices['Desktop Chrome'],
    launchOptions: { args: chromiumArgs },
    trace: 'retain-on-failure',
  },
})
