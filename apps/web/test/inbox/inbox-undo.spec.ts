// Audit D35 in a real browser at phone, tablet and desktop widths: swipe Done, Undo, and the Done view with Restore.
import { expect, test } from '@playwright/test'
import { expectAxeClean, open } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

async function swipeRight(page: import('@playwright/test').Page, name: RegExp) {
  const row = page.getByRole('button', { name }).first()
  const box = await row.boundingBox()
  if (!box) throw new Error('row not laid out')
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 20, y)
  await page.mouse.down()
  await page.mouse.move(box.x + 80, y, { steps: 5 })
  await page.mouse.move(box.x + 160, y, { steps: 5 })
  await page.mouse.up()
}
const states = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.__talos.store.getState().inbox.map((i) => i.state))

test('Done then Undo puts the item back, and the strip fits the screen', async ({ page }) => {
  await open(page, '/t/inbox', { seed: 'full' })
  const before = (await states(page)).filter((s) => s === 'done').length
  await swipeRight(page, /Review requested/)
  const strip = page.getByTestId('inbox-undo')
  await expect(strip).toBeVisible()
  await expect(strip).toContainText('Marked done')
  const box = await strip.boundingBox()
  const vw = page.viewportSize()?.width ?? 0
  expect(box && box.x >= 0 && box.x + box.width <= vw).toBe(true) // no sideways scroll at phone width
  expect((await states(page)).filter((s) => s === 'done').length).toBe(before + 1)
  await strip.getByRole('button', { name: 'Undo' }).click()
  await expect(strip).toBeHidden()
  expect((await states(page)).filter((s) => s === 'done').length).toBe(before)
})

test('the Done view lists the finished item and Restore returns it', async ({ page }) => {
  await open(page, '/t/inbox', { seed: 'full' })
  await swipeRight(page, /Review requested/)
  await page.getByRole('tab', { name: 'Done' }).click()
  const list = page.getByRole('list', { name: 'Done' })
  await expect(list.getByText('Review requested')).toBeVisible()
  await list.getByRole('button', { name: /^Restore Review requested/ }).click()
  await expect(list).toBeHidden()
  await expect(page.getByTestId('done-empty')).toBeVisible()
  await page.getByRole('tab', { name: /^Priority/ }).click()
  await expect(page.getByRole('button', { name: /Review requested/ }).first()).toBeVisible()
})

test('axe: the Done view and the Undo strip are clean', async ({ page }) => {
  await open(page, '/t/inbox', { seed: 'full' })
  await swipeRight(page, /Review requested/)
  await expectAxeClean(page)
  await page.getByRole('tab', { name: 'Done' }).click()
  await expectAxeClean(page)
})
