import { expect, test } from '@playwright/test'
import { expectAxeClean, open, sentFrames } from './e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

// O2: an expired card says "Ask again". One tap sends one ordinary owner message that names the card; no card frame. Runs on
// the iPhone, Pixel and desktop projects (phone width, keyboard, both themes). A real iPhone is not proven by this.

const expiredCard = (page: import('@playwright/test').Page, title: string) =>
  page.locator('article', { hasText: title }).first()

for (const title of ['State expired', 'Expired draft']) {
  test(`"${title}": Ask again sends one message naming the card and nothing else`, async ({ page }) => {
    await open(page, '/cards', { seed: 'full' })
    const article = expiredCard(page, title)
    const ask = article.getByRole('button', { name: 'Ask again' })
    await expect(ask).toBeVisible()
    const box = await ask.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44) // a thumb-sized target
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const before = (await sentFrames(page)).length
    await ask.click()
    await expect(article.getByTestId('ask-again-status')).toContainText('Asked')
    await expect(article.getByRole('button', { name: 'Ask again' })).toHaveCount(0)
    const frames = (await sentFrames(page)).slice(before)
    expect(frames.map((f) => f.type)).toEqual(['message'])
    expect(String(frames[0]?.text)).toMatch(/^Please ask me again about card \S+\. It expired before I saw it\.$/)
    expect(String(frames[0]?.text)).not.toContain(title) // an agent-written title never rides in the owner's words
    await expectAxeClean(page)
  })
}

test('a live card and a decided card have no Ask again; it works from the keyboard', async ({ page }) => {
  await open(page, '/cards', { seed: 'full' })
  for (const title of ['State done', 'State killed', 'State superseded'])
    await expect(expiredCard(page, title).getByRole('button', { name: 'Ask again' })).toHaveCount(0)
  const article = expiredCard(page, 'State expired')
  await article.getByRole('button', { name: 'Ask again' }).focus()
  await page.keyboard.press('Enter')
  await expect(article.getByTestId('ask-again-status')).toContainText('Asked')
})
