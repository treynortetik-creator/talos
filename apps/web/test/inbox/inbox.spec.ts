import { expect, test } from '@playwright/test'
import { expectAxeClean, open } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

test('tabs show counts and the rows of each tab', async ({ page }) => {
  await open(page, '/t/inbox', { seed: 'full' })
  await expect(page.getByRole('tab', { name: /^Priority \(\d+\)$/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Other (1)' })).toBeVisible()
  await page.getByRole('tab', { name: 'Other (1)' }).click()
  await expect(page.getByText('A low priority post')).toBeVisible()
})

test('swiping a row right marks it done', async ({ page }) => {
  await open(page, '/t/inbox', { seed: 'full' })
  const before = await page.evaluate(
    () => window.__talos.store.getState().inbox.filter((i) => i.state === 'new' && i.priority !== 'low').length,
  )
  const row = page.getByRole('button', { name: /Review requested/ }).first()
  const box = await row.boundingBox()
  if (!box) throw new Error('row not laid out')
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 20, y)
  await page.mouse.down()
  await page.mouse.move(box.x + 80, y, { steps: 5 })
  await page.mouse.move(box.x + 160, y, { steps: 5 })
  await page.mouse.up()
  await expect(page.getByRole('tab', { name: `Priority (${before - 1})` })).toBeVisible()
  const done = await page.evaluate(() => window.__talos.store.getState().inbox.filter((i) => i.state === 'done').length)
  expect(done).toBe(1)
})

test('an event title with <img onerror> and markdown renders as literal text', async ({ page }) => {
  await open(page, '/t/inbox', { seed: 'full' })
  const literal = '<img src=x onerror="window.__xss=1"> **bold** [x](javascript:window.__xss=1)'
  await expect(page.getByText(literal)).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  await expect(page.locator('main img, main script, main strong, main a[href^="javascript"]')).toHaveCount(0)
})

test('the item sheet shows plain text and the Done / Snooze / Ask actions', async ({ page }) => {
  await open(page, '/t/inbox', { seed: 'full' })
  await page.getByText(/<img src=x/).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByTestId('item-summary')).toContainText('<script>window.__xss=1</script> a *summary*')
  await expect(sheet.getByRole('button', { name: 'Done' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Snooze' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Ask Talos' })).toBeVisible()
  await expect(sheet.locator('a[href]')).toHaveCount(0) // this item has no url
})

test('the truncated notice shows', async ({ page }) => {
  await open(page, '/t/inbox', { seed: 'full' })
  await page.evaluate(() => window.__talos.store.setState({ ...window.__talos.store.getState(), inboxTruncated: true }))
  await expect(page.getByText('Some mail was skipped: more than 200 messages arrived at once.')).toBeVisible()
})

test('axe: inbox is clean in light and dark', async ({ page }) => {
  await open(page, '/t/inbox', { seed: 'full' })
  await expectAxeClean(page)
})
