// `pnpm test` inside this package: the same files as the protocol project in the root vitest.config.ts. test-browser/ holds
// Playwright specs (owner signatures, hashes and enrollment binding in real browsers), run by `pnpm test:browser` in CI, never by
// vitest.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { testTimeout: 30_000, include: ['test/**/*.test.ts'], exclude: ['test-browser/**', 'node_modules/**'] },
})
