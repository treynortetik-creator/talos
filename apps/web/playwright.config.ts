// Ownership passes to WP6. Shared by WP4, WP6 and WP7: every `*.spec.ts` under `apps/web/test/**` runs here, so nobody has
// to edit this file to get CI to pick up a spec. Vitest files are `*.test.ts(x)`, so the two never mix.
//   iphone / pixel / desktop   everything except test/voice
//   chromium-media             only test/voice (WP4): Chromium with a fake microphone
// The app is served in fake mode (`VITE_FAKE=1`, the in-memory client) from a production build, so specs need no relay.
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
import { webPreviewPort } from './test/helpers/pw-port'

// PW_PORT lets a second checkout run beside this one; never reuse whatever happens to be on the port. A CI slot's own port is
// refused outside a slot run (test/helpers/pw-port.ts).
const PORT = webPreviewPort()
const voice = '**/voice/**'

export default defineConfig({
  testDir: 'test',
  testMatch: '**/*.spec.ts',
  // Builds `dist/` for the relay-backed specs (test/relay/**), which serve the production bundle from a per-test harness.
  globalSetup: fileURLToPath(new URL('./test/helpers/global-setup.ts', import.meta.url)),
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}` },
  // The fake-mode app is a production build served by `vite preview` (no dev-server dependency optimisation, no dev
  // service worker), so specs are deterministic on a cold CI runner.
  webServer: [
    {
      command: `pnpm exec vite build --outDir dist-fake --emptyOutDir && pnpm exec vite preview --outDir dist-fake --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      env: { VITE_FAKE: '1' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: 'iphone', testIgnore: voice, use: { ...devices['iPhone 15'] } }, // WebKit
    // The narrowest phone the app supports (an iPhone SE, 320 pt): the approval sheet's spec runs here (and in the others)
    {
      name: 'iphone-se',
      testMatch: '**/cards/permission-sheet.spec.ts',
      use: { ...devices['iPhone SE'], viewport: { width: 320, height: 568 } },
    },
    { name: 'pixel', testIgnore: voice, use: { ...devices['Pixel 8'] } }, // Chromium
    {
      name: 'desktop',
      testIgnore: voice,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'chromium-media',
      testMatch: '**/voice/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
      },
    },
  ],
})
