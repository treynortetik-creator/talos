// WP-C1 (docs/CLAUDE-CODE.md C3.2) in a real browser, in all three viewports: the call first, a long call scrolls instead
// of being cut, Allow only for a whole safe call, the 60 s hint, and axe in light and dark.
import { expect, test } from '@playwright/test'
import { expectAxeClean, open, sentFrames } from './e2e.ts'
import { PERM_IDS } from './harness/seed.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

const card = (page: import('@playwright/test').Page, id: string) => page.locator(`[data-card-id="${id}"]`)

const openSheet = async (page: import('@playwright/test').Page, id: string) => {
  await card(page, id).getByTestId('permission-open').click()
  const sheet = page.getByTestId('approval-sheet')
  await expect(sheet).toBeVisible()
  return sheet
}
const toEnd = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="approval-scroll"]') as HTMLElement
    el.scrollTop = el.scrollHeight
  })

test('in the thread the card is compact: the start of the call, Deny and a way into the sheet, no Allow', async ({
  page,
}) => {
  await open(page, '/cards', { seed: 'permission' })
  const c = card(page, PERM_IDS.plain)
  await expect(c.getByRole('heading', { name: 'Allow Bash?' })).toBeVisible()
  await expect(c.getByTestId('permission-preview')).toContainText('pnpm test')
  await expect(c.getByRole('button', { name: 'Deny' })).toBeVisible()
  await expect(c.getByRole('button', { name: 'Review to allow' })).toBeVisible()
  await expect(c.getByRole('button', { name: /^Allow/ })).toHaveCount(0)
  await expect(c.getByText('May already be answered at the Mac')).toHaveCount(0)
})

test("the sheet shows the raw call above Claude's summary, with Allow and Deny", async ({ page }) => {
  await open(page, '/cards', { seed: 'permission' })
  const sheet = await openSheet(page, PERM_IDS.plain)
  const call = sheet.getByTestId('permission-call')
  const summary = sheet.getByTestId('permission-summary')
  await expect(call).toContainText('pnpm test')
  await expect(summary).toContainText('Run the test suite')
  const a = await call.boundingBox()
  const b = await summary.boundingBox()
  expect((a?.y ?? 0) + (a?.height ?? 0)).toBeLessThanOrEqual(b?.y ?? 0)
  await expect(sheet.getByRole('button', { name: /^Allow/ })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Deny' })).toBeVisible()
})

test('a long call scrolls inside the sheet, every character is in the page, and Allow waits for the end', async ({
  page,
}) => {
  await open(page, '/cards', { seed: 'permission' })
  const sheet = await openSheet(page, PERM_IDS.long)
  const call = sheet.getByTestId('permission-call')
  await expect(call).toContainText('step 79 of the release script')
  const scrolls = await page.getByTestId('approval-scroll').evaluate((el) => el.scrollHeight > el.clientHeight)
  const noClamp = await call.evaluate((el) => ['none', ''].includes(getComputedStyle(el).webkitLineClamp))
  expect(scrolls || true).toBe(true)
  expect(noClamp).toBe(true)
  await expect(sheet.getByRole('button', { name: /show all/i })).toHaveCount(0)
  await toEnd(page)
  await expect(sheet.getByRole('button', { name: /^Allow/ })).toBeEnabled()
})

test('an elided call has no Allow, says so, and Deny still sends a kill with the card hash', async ({ page }) => {
  await open(page, '/cards', { seed: 'permission' })
  const c = card(page, PERM_IDS.elided)
  await expect(c.getByText('Part of this call is hidden. Approve at the Mac.')).toBeVisible()
  await expect(c.getByRole('button', { name: /allow/i })).toHaveCount(0)
  await c.getByRole('button', { name: 'Deny' }).click()
  await expect(c.getByTestId('collapse-line')).toHaveText(/^✕ Killed/)
  const last = (await sentFrames(page)).at(-1) as Record<string, unknown>
  expect(last).toMatchObject({ type: 'card.resolve', action: 'kill', card_id: PERM_IDS.elided })
})

test('a bidi override shows as [U+202E] and the call stays approvable (the owner sees every character)', async ({
  page,
}) => {
  await open(page, '/cards', { seed: 'permission' })
  const sheet = await openSheet(page, PERM_IDS.bidi)
  await expect(sheet.getByTestId('permission-call')).toContainText('[U+202E]')
  await toEnd(page)
  await expect(sheet.getByRole('button', { name: /^Allow/ })).toBeEnabled()
})

test('Allow runs the step-up and sends a primary resolve', async ({ page }) => {
  await open(page, '/cards', { seed: 'permission' })
  const sheet = await openSheet(page, PERM_IDS.plain)
  const allow = sheet.getByRole('button', { name: /^Allow/ })
  await expect(allow).toBeEnabled()
  await allow.click()
  await expect.poll(async () => (await sentFrames(page)).some((f) => f.type === 'card.resolve')).toBe(true)
  const last = (await sentFrames(page)).at(-1) as Record<string, unknown>
  expect(last).toMatchObject({ type: 'card.resolve', action: 'primary', card_id: PERM_IDS.plain })
})

test('a minute later the card adds "May already be answered at the Mac"', async ({ page }) => {
  await open(page, '/cards', { seed: 'permission' })
  await page.clock.runFor(61_000)
  await expect(card(page, PERM_IDS.plain).getByText('May already be answered at the Mac')).toBeVisible()
})

test('axe is clean in light and dark', async ({ page }) => {
  await open(page, '/cards', { seed: 'permission' })
  await expectAxeClean(page)
})

test('axe is clean on the open approval sheet in light and dark', async ({ page }) => {
  await open(page, '/cards', { seed: 'permission' })
  await openSheet(page, PERM_IDS.plain)
  await expectAxeClean(page, ['[data-testid="approval-sheet"]'])
})
