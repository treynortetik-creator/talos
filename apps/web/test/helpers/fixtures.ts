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
  // a drop of the link or the Mac is said at once here (the app waits 30 s for an owner: lib/linkShown.ts), so the specs
  // that wait for an offline banner need no long wait
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      ;(window as unknown as { __talosLinkGraceMs: number }).__talosLinkGraceMs = 0
    })
    await use(context)
  },
})
export { expect } from '@playwright/test'
