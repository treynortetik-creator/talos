// The TΛLOS wordmark is the brand: Cinzel Black under every theme. A theme may change --font-display (paper makes it
// Inter), and the wordmark used to follow it, so under paper its flipped V read as a plain sans lambda.
import { expect, type Page, test } from '@playwright/test'

// the desktop sidebar, where the owner saw it, in every engine (WebKit is the Mac app's web view)
test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } })

/** The fake client keeps its config in memory, so the theme goes in through the picker (as the owner picks it) and the
 *  wordmark is read without a reload. */
async function pick(page: Page, theme: string) {
  await page.goto('/settings/appearance')
  if (theme !== 'Talos') await page.getByRole('radio', { name: theme }).click()
  await expect(page.getByRole('radio', { name: theme })).toHaveAttribute('aria-checked', 'true')
  const mark = page.locator('.wordmark:visible').first()
  await expect(mark).toBeVisible()
  return mark
}

async function font(page: Page, theme: string) {
  const mark = await pick(page, theme)
  return mark.evaluate(async (el) => {
    await document.fonts.ready
    const cs = getComputedStyle(el)
    return {
      family: cs.fontFamily.split(',')[0]?.replace(/"/g, '').trim(),
      weight: cs.fontWeight,
      loaded: document.fonts.check('900 1em "Cinzel Variable"'),
    }
  })
}

for (const theme of ['Talos', 'Paper', 'Hearth']) {
  test(`the wordmark is Cinzel Black under the ${theme} theme`, async ({ page }) => {
    expect(await font(page, theme)).toEqual({ family: 'Cinzel Variable', weight: '900', loaded: true })
  })
}

test('the theme still sets the display font of headings (Paper: Inter)', async ({ page }) => {
  await pick(page, 'Paper')
  const display = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--font-display'),
  )
  expect(display).toContain('Inter')
})
