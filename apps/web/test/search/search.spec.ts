// WP-V2: the search screen and the context view in the real shell (iPhone/WebKit, Pixel, desktop), replaying the frames the
// REAL bridge captured (packages/testkit/fixtures/captured/search, via test/search/replay.ts).
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

async function open(page: Page, route = '/search', extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ route, ...extra })
  await page.goto(`/test/search/harness/index.html?${q}`)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
}
const box = (page: Page) => page.getByRole('searchbox', { name: 'Search messages' })

test('marks render and an <img> in a snippet stays text', async ({ page }) => {
  await open(page)
  await box(page).fill('release')
  await expect(page.getByTestId('hit-row').first()).toBeVisible()
  expect(await page.getByTestId('hit-row').count()).toBe(8)
  expect(await page.locator('mark').count()).toBeGreaterThan(0)
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: false })).toBeVisible()
  expect(await page.locator('[data-testid="search-results"] img').count()).toBe(0)
  await expect(page.getByText('in file name')).toBeVisible()
  await expect(page.getByText('in voice note')).toBeVisible()
})

test('a hit opens the context view; Older, Newer and Jump to latest work; the live timeline is unchanged', async ({
  page,
}) => {
  await open(page, '/t/general?m=m_00000000000000000000000130')
  const list = page.getByTestId('context-list')
  await expect(list.getByText('The needle is in this message.')).toBeVisible()
  await expect(page.getByText('Showing a past conversation')).toBeVisible()
  expect(await page.getByRole('textbox').count()).toBe(0) // no composer
  const n0 = await list.locator('[id^="ctx-"]').count()
  await page.getByRole('button', { name: 'Older' }).click()
  await expect.poll(() => list.locator('[id^="ctx-"]').count()).toBeGreaterThan(n0)
  const n1 = await list.locator('[id^="ctx-"]').count()
  await page.getByRole('button', { name: 'Newer' }).click()
  await expect.poll(() => list.locator('[id^="ctx-"]').count()).toBeGreaterThan(n1)
  const stored = await page.evaluate(() => JSON.stringify(window.__talos.store.getState().messages.general ?? []))
  expect(stored).not.toContain('needle')
  await page.getByRole('button', { name: 'Jump to latest' }).first().click()
  await expect(page.getByTestId('location')).toHaveText('/t/general')
  await expect(page.getByTestId('context-view')).toHaveCount(0)
  expect(await page.evaluate(() => JSON.stringify(window.__talos.store.getState().messages.general ?? []))).toBe(stored)
})

test('clicking a result lands on its message, at the end it says "You\'re up to date"', async ({ page }) => {
  await open(page)
  await box(page).fill('release')
  await page.getByTestId('hit-row').first().click()
  await expect(page.getByTestId('context-view')).toBeVisible()
  await expect(page.getByText("You're up to date")).toBeVisible()
})

test('Mac offline: searches messages on this device, labelled', async ({ page }) => {
  await open(page, '/search', { offline: '1' })
  await page.evaluate(() => window.__talos.sendMessage({ threadId: 'general', text: 'Bring the release balloons' }))
  await box(page).fill('balloons')
  await expect(page.getByText(/Your Mac is offline\. Showing matches from messages on this device\./)).toBeVisible()
  await expect(page.locator('mark', { hasText: 'balloons' })).toBeVisible()
})

test('building the index is announced', async ({ page }) => {
  await open(page, '/search', { capture: '07-indexing' })
  await box(page).fill('release')
  await expect(page.getByTestId('search-indexing')).toBeVisible()
})

test('axe: search and the context view are clean', async ({ page }) => {
  await open(page)
  await box(page).fill('release')
  await expect(page.getByTestId('hit-row').first()).toBeVisible()
  await expectAxeClean(page)
  await open(page, '/t/general?m=m_00000000000000000000000130')
  await expect(page.getByTestId('context-list').getByText('The needle is in this message.')).toBeVisible()
  await expectAxeClean(page)
})
