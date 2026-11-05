import { expect, test } from '@playwright/test'
import { expectAxeClean, open } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

test('Needs-you groups come in order with counts', async ({ page }) => {
  await open(page, '/', { seed: 'full' })
  const groups = page.locator('section[data-group]')
  await expect(groups.locator('h2')).toHaveText([
    /Can't verify\s+1/,
    /Needs you\s+2/,
    /Working\s+1/,
    /Done today\s+\d+/,
  ])
  // The altered card is flagged, never counted as an ordinary Needs-you row (review F5).
  await expect(page.getByTestId('count-needs_you')).toHaveText('2')
  await expect(page.getByRole('tab', { name: 'Needs you (2)' })).toBeVisible()
  await expect(page.locator('[data-group="flagged"] button[data-row-id]')).toContainText(/altered/i)
})

test('a row opens the card deep link; the FAB asks the agent', async ({ page }) => {
  await open(page, '/', { seed: 'full' })
  await page.locator('button[data-row-id]', { hasText: 'Post v0.3 release notes' }).click()
  await expect(page.getByTestId('location')).toHaveText(/^\/card\/c_/)
  await open(page, '/', { seed: 'full' })
  await page.getByRole('button', { name: 'Ask Talos' }).click()
  await expect(page.getByTestId('location')).toHaveText('/t/general')
})

test('the empty state offers to talk to the agent', async ({ page }) => {
  await open(page, '/')
  await page.evaluate(() => {
    const c = window.__talos
    c.store.setState({ ...c.store.getState(), cards: [], unread: {}, inbox: [] })
  })
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Talk to Talos' })).toBeVisible()
})

test('axe: home is clean in light and dark', async ({ page }) => {
  await open(page, '/', { seed: 'full' })
  await expectAxeClean(page)
})
