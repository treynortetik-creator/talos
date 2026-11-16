import { defineConfig } from 'vitest/config'

// TALOS_TEST_TIME_FACTOR (scripts/gate.sh: 3 on a machine with 4 cores or fewer; default 1) scales every project's test and hook
// budget: a slow machine runs the same tests, it only needs longer for each (packages/testkit/src/time-factor.ts)
const F = (() => {
  const n = Number(process.env.TALOS_TEST_TIME_FACTOR)
  return Number.isFinite(n) && n >= 1 ? n : 1
})()
const TEST_MS = 30_000 * F
const HOOK_MS = 10_000 * F

// Spec 2 names `vitest.workspace.ts`; Vitest 3.2+ replaced workspace files with `test.projects`
// (see "Spec calls made" in the WP0 PR). The bridge is excluded: it runs under `bun test`.
// Every project gets the same 30 s test budget: the testkit's positive waits scale 3x (TALOS_TEST_WAIT_SCALE), so the runner's 5 s
// default would end a test before its own wait could report anything.
export default defineConfig({
  test: {
    // every temp folder of the run in one that the run removes (#161)
    globalSetup: ['./vitest.run-tmp.ts'],
    projects: [
      {
        test: {
          name: 'protocol',
          root: 'packages/protocol',
          testTimeout: TEST_MS,
          hookTimeout: HOOK_MS,
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'testkit',
          root: 'packages/testkit',
          testTimeout: TEST_MS,
          hookTimeout: HOOK_MS,
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integrations',
          root: 'packages/integrations',
          testTimeout: TEST_MS,
          hookTimeout: HOOK_MS,
          include: ['test/**/*.test.ts'],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'relay',
          root: 'apps/relay',
          testTimeout: TEST_MS,
          hookTimeout: HOOK_MS,
          include: ['test/**/*.test.ts'],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'web',
          root: 'apps/web',
          testTimeout: TEST_MS,
          hookTimeout: HOOK_MS,
          environment: 'jsdom',
          setupFiles: ['test/setup-clock.ts'],
          include: ['test/**/*.test.{ts,tsx}'],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'mobile',
          root: 'apps/mobile',
          testTimeout: TEST_MS,
          hookTimeout: HOOK_MS,
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'scripts',
          root: 'scripts',
          testTimeout: TEST_MS,
          hookTimeout: HOOK_MS,
          include: ['**/*.test.ts'],
          // the shared heavy lock's variables never reach a test (scripts/test-env-clean.ts)
          setupFiles: ['./test-env-clean.ts'],
        },
      },
    ],
  },
})
