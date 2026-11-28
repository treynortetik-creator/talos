// Ownership passes to WP6. Shared by WP4, WP6 and WP7: every `*.spec.ts` under `apps/web/test/**` runs here, so nobody has
// to edit this file to get CI to pick up a spec. Vitest files are `*.test.ts(x)`, so the two never mix.
//   iphone / pixel / desktop   everything
// (The chromium-media project, Chromium with a fake microphone for test/voice, went with voice input: archived 2026-11-19,
// tag archive/voice-2026-11-19, docs/archived/voice.md.)
// The app is served in fake mode (`VITE_FAKE=1`, the in-memory client) from a production build, so specs need no relay.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
import { WEB_PREVIEW_HOST, webPreviewPort } from './test/helpers/pw-port'

// PW_PORT lets a second checkout run beside this one; never reuse whatever happens to be on the port. A CI slot's own port is
// refused outside a slot run (test/helpers/pw-port.ts).
const PORT = webPreviewPort()
const ORIGIN = `http://${WEB_PREVIEW_HOST}:${PORT}` // IPv4 on purpose: see WEB_PREVIEW_HOST
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
// `@mac-only` marks a test that exercises something Linux browsers do not do (Chromium's synthetic touch scroll, WebKit's
// media playback): every run here includes it; a Linux runner (Titan's WSL gate) passes --grep-invert @mac-only, so the
// macOS runs keep covering it.

export default defineConfig({
  testDir: 'test',
  testMatch: '**/*.spec.ts',
  // Builds `dist/` for the relay-backed specs (test/relay/**), which serve the production bundle from a per-test harness.
  globalSetup: fileURLToPath(new URL('./test/helpers/global-setup.ts', import.meta.url)),
  fullyParallel: true,
  // No retries, in CI or by hand: a failed test fails (the owner's rule; scripts/ci-no-retries.test.ts).
  retries: 0,
  reporter: [['list'], ...(process.env.CI_FLAKE_FILE ? [['../../scripts/ci-flake-playwright.ts'] as const] : [])],
  use: { baseURL: ORIGIN },
  // The fake-mode app is a production build served by `vite preview` (no dev-server dependency optimisation, no dev
  // service worker), so specs are deterministic on a cold CI runner.
  webServer: [
    {
      command: `pnpm exec vite build --outDir dist-fake --emptyOutDir && pnpm exec vite preview --outDir dist-fake --host ${WEB_PREVIEW_HOST} --port ${PORT} --strictPort`,
      url: ORIGIN,
      env: { VITE_FAKE: '1' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 15'] } }, // WebKit
    // The narrowest phone the app supports (an iPhone SE, 320 pt): the approval sheet's spec runs here (and in the others)
    {
      name: 'iphone-se',
      testMatch: '**/cards/permission-sheet.spec.ts',
      use: { ...devices['iPhone SE'], viewport: { width: 320, height: 568 } },
    },
    { name: 'pixel', use: { ...devices['Pixel 8'], launchOptions: { args: chromiumArgs } } }, // Chromium
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: { args: chromiumArgs },
      },
    },
  ],
})
