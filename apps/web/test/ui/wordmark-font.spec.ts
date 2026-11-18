// Themes change colours only: the TΛLOS wordmark is the same vector, at the same size, under every stock theme, and a
// thread header, an empty-state title and body text keep the font family, weight and size they have under Talos.
import { expect, type Page, test } from '@playwright/test'
import { STOCK_THEME_IDS, STOCK_THEMES } from '@talos-app/protocol'
import { WORDMARK_PATH, WORDMARK_VIEWBOX } from '../../src/ui/wordmark-path.ts'

// the desktop sidebar, where the owner saw it, in every engine (WebKit is the Mac app's web view)
test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } })

const LABEL: Record<(typeof STOCK_THEME_IDS)[number], string> = {
  talos: 'Talos',
  paper: 'Paper',
  hearth: 'Hearth',
  iris: 'Iris',
  harbor: 'Harbor',
}

/** The fake client keeps its config in memory, so pages are reached without a reload (a reload drops the pick). */
async function go(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState(null, '', p)
    dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await page.waitForLoadState('networkidle')
}

/** The theme goes in through the picker, as the owner picks it. */
async function pick(page: Page, theme: string) {
  await go(page, '/settings/appearance')
  if (theme !== 'Talos') await page.getByRole('radio', { name: theme }).click()
  await expect(page.getByRole('radio', { name: theme })).toHaveAttribute('aria-checked', 'true')
}

const fontOf = (el: Element) => {
  const cs = getComputedStyle(el)
  return { family: cs.fontFamily, weight: cs.fontWeight, size: cs.fontSize }
}

/** The picked theme must really be on <html> (its accent, inline), or empty for Talos: a reverted pick cannot pass as Talos. */
async function expectPicked(page: Page, id: (typeof STOCK_THEME_IDS)[number]) {
  const dark = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const t = STOCK_THEMES.find((x) => x.name === id)
  const want = id === 'talos' ? '' : (t?.[dark ? 'dark' : 'light']['--accent'] ?? 'missing')
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))).toBe(want)
}

/** The wordmark's drawing and size, and the family, weight and size of body text, a thread header and an empty-state title. */
async function fonts(page: Page, id: (typeof STOCK_THEME_IDS)[number]) {
  await expectPicked(page, id)
  await expect(page.locator('.wordmark:visible').first()).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const wordmark = await page
    .locator('.wordmark:visible svg')
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { d: el.querySelector('path')?.getAttribute('d'), width: r.width, height: r.height }
    })
  const body = await page.evaluate(() => {
    const cs = getComputedStyle(document.body)
    return { family: cs.fontFamily, weight: cs.fontWeight, size: cs.fontSize }
  })
  await go(page, '/t/general')
  const header = page.locator('h1.font-display', { hasText: 'General' }).first()
  await expect(header).toBeVisible()
  const thread = await header.evaluate(fontOf)
  await go(page, '/')
  const empty = page.getByTestId('home-empty').locator('p.font-display', { hasText: 'Nothing needs you' })
  await expect(empty).toBeVisible()
  const emptyTitle = await empty.evaluate(fontOf)
  await expectPicked(page, id)
  return { wordmark, body, thread, emptyTitle }
}

for (const id of STOCK_THEME_IDS) {
  const theme = LABEL[id]
  test(`the wordmark is the brand vector under the ${theme} theme`, async ({ page }) => {
    await page.goto('/settings/appearance')
    await pick(page, theme)
    const svg = page.locator('.wordmark:visible svg').first()
    await expect(svg).toHaveAttribute('viewBox', WORDMARK_VIEWBOX)
    expect(await svg.locator('path').getAttribute('d')).toBe(WORDMARK_PATH) // no font involved: nothing a theme can swap
  })

  test(`the ${theme} theme leaves the family, weight and size of every text as under Talos`, async ({ page }) => {
    await page.goto('/settings/appearance')
    await pick(page, 'Talos')
    const talos = await fonts(page, 'talos')
    await pick(page, theme)
    expect(await fonts(page, id)).toEqual(talos)
  })
}
