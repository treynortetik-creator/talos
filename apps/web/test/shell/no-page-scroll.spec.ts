import { expect, test } from '@playwright/test'

// The page itself must never scroll: the shell is locked to the viewport and only inner regions scroll.
// Regression: the Timeline's `sr-only` live region (position:absolute, no positioned ancestor) sat at the bottom of a long
// thread and stretched the document, so wheeling over the gap beside the thread scrolled the page past the app.
const routes = ['/t/general', '/threads', '/', '/schedules', '/settings']

async function pageIsLocked(page: import('@playwright/test').Page) {
  const m = await page.evaluate(() => ({
    sh: (document.scrollingElement as HTMLElement).scrollHeight,
    ih: innerHeight,
  }))
  expect(m.sh).toBeLessThanOrEqual(m.ih)
}

async function longThreadStaysLocked(page: import('@playwright/test').Page, desktop: boolean) {
  await page.goto('/t/general')
  const box = page.getByRole('textbox', { name: 'Message' })
  for (let i = 0; i < 25; i++) {
    await box.fill(`message number ${i} `.repeat(12))
    await box.press('Enter')
  }
  await expect(page.getByText('message number 24').first()).toBeVisible()
  await pageIsLocked(page)
  if (desktop) {
    await page.mouse.move(330, 300)
    await page.mouse.wheel(0, 3000)
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  } else {
    await page.evaluate(() => window.scrollTo(0, 5000))
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  }
}

// Each size is its own test at its own viewport (desktop: the project's 1440x900 here, 1280x720 below), never a
// page.setViewportSize() mid-test: on Chromium that resizes the real browser window (see review-scroll.spec.ts).
test('a long thread does not stretch the page; wheel over the gap does not scroll it', async ({ page }, info) => {
  await longThreadStaysLocked(page, info.project.name === 'desktop')
})

test.describe('@1280x720', () => {
  test.use({ viewport: { width: 1280, height: 720 } })
  test('a long thread does not stretch the page; wheel over the gap does not scroll it', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop size')
    await longThreadStaysLocked(page, true)
  })
})

for (const route of routes) {
  test(`page is viewport-locked: ${route}`, async ({ page }) => {
    await page.goto(route)
    await page.waitForLoadState('networkidle')
    await pageIsLocked(page)
  })
}
