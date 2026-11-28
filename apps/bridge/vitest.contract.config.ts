import { defineConfig } from 'vitest/config'

// The testkit's bridge contract uses Vitest's describe/it, so it runs under Vitest (Node). Only the bridge process it
// spawns runs under Bun, exactly like in production. `bun test` does not pick these files up (suffix .vitest.ts).
export default defineConfig({
  test: {
    include: ['test-contract/**/*.vitest.ts'],
    // no inherited session variables, no real Chronos, a fake claude first on PATH (as test/preload.ts does for bun)
    setupFiles: ['./test-contract/vitest-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    fileParallelism: false,
  },
})
