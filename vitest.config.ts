import { defineConfig } from 'vitest/config'

// Spec 2 names `vitest.workspace.ts`; Vitest 3.2+ replaced workspace files with `test.projects`
// (see "Spec calls made" in the WP0 PR). The bridge is excluded: it runs under `bun test`.
// Every project gets the same 30 s test budget: the testkit's positive waits scale 3x (TALOS_TEST_WAIT_SCALE), so the runner's 5 s
// default would end a test before its own wait could report anything.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'protocol', root: 'packages/protocol', testTimeout: 30_000, include: ['test/**/*.test.ts'] } },
      { test: { name: 'testkit', root: 'packages/testkit', testTimeout: 30_000, include: ['test/**/*.test.ts'] } },
      {
        test: {
          name: 'integrations',
          root: 'packages/integrations',
          testTimeout: 30_000,
          include: ['test/**/*.test.ts'],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'relay',
          root: 'apps/relay',
          testTimeout: 30_000,
          include: ['test/**/*.test.ts'],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'web',
          root: 'apps/web',
          testTimeout: 30_000,
          environment: 'jsdom',
          setupFiles: ['test/setup-clock.ts'],
          include: ['test/**/*.test.{ts,tsx}'],
          passWithNoTests: true,
        },
      },
      { test: { name: 'mobile', root: 'apps/mobile', testTimeout: 30_000, include: ['test/**/*.test.ts'] } },
      { test: { name: 'scripts', root: 'scripts', testTimeout: 30_000, include: ['**/*.test.ts'] } },
    ],
  },
})
