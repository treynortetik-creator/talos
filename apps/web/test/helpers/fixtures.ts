import { test as base } from '@playwright/test'
import { type Harness, startHarness } from './harness.ts'

/** `harness` is a fresh relay-backed server per test; `baseURL` points at it. */
export const test = base.extend<{ harness: Harness }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  harness: async ({}, use) => {
    const h = await startHarness()
    await use(h)
    await h.stop()
  },
  baseURL: async ({ harness }, use) => {
    await use(harness.url)
  },
})
export { expect } from '@playwright/test'
