import { defineConfig } from '@playwright/test'

// Browser round trips for the isomorphic crypto (owner signatures, hashes, enrollment binding).
// Run: pnpm --filter @talos-app/protocol test:browser   (needs `playwright install chromium webkit` once)
export default defineConfig({
  testDir: 'test-browser',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
})
