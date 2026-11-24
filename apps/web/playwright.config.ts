// Ownership passes to WP6. Shared by WP4, WP6 and WP7: every `*.spec.ts` under `apps/web/test/**` runs here, so nobody has
// to edit this file to get CI to pick up a spec. Vitest files are `*.test.ts(x)`, so the two never mix.
//   iphone / pixel / desktop   everything
// (The chromium-media project, Chromium with a fake microphone for test/voice, went with voice input: archived 2026-11-19,
// tag archive/voice-2026-11-19, docs/archived/voice.md.)
// The app is served in fake mode (`VITE_FAKE=1`, the in-memory client) from a production build, so specs need no relay.
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
import { WEB_PREVIEW_HOST, webPreviewPort } from './test/helpers/pw-port'

// PW_PORT lets a second checkout run beside this one; never reuse whatever happens to be on the port. A CI slot's own port is
// refused outside a slot run (test/helpers/pw-port.ts).
const PORT = webPreviewPort()
const ORIGIN = `http://${WEB_PREVIEW_HOST}:${PORT}` // IPv4 on purpose: see WEB_PREVIEW_HOST
// Under ci-local (it sets CI_FLAKE_FILE) Chromium goes straight to localhost: a proxy put in front of it on the CI Mac once failed
// page.goto with ERR_UNEXPECTED_PROXY_AUTH. WebKit takes no Chromium flags; ci-local.sh clears the proxy environment for it.
const ciChromiumArgs = process.env.CI_FLAKE_FILE ? ['--no-proxy-server'] : []
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
    { name: 'pixel', use: { ...devices['Pixel 8'], launchOptions: { args: ciChromiumArgs } } }, // Chromium
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: { args: ciChromiumArgs },
      },
    },
  ],
})
