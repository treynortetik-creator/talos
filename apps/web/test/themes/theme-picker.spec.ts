// Every stock theme, in light and dark, on the real fake-mode build under the production CSP (service worker blocked,
// as in themes.spec.ts): threads, a thread with an owner bubble, and Settings at 375 px with no sideways scroll and no
// securitypolicyviolation. The owner bubble and the phone top band must take the theme's colours, not Talos browns.
import { expect, type Page, test } from '@playwright/test'
import { appCsp, STOCK_THEMES } from '@talos-app/protocol'

const CSP = appCsp('https://talos.example.com')
test.use({ serviceWorkers: 'block' })

async function withCsp(page: Page, theme: string, mode: 'light' | 'dark') {
  await page.addInitScript(
    ([t, m]) => {
      const w = window as unknown as { __violations: string[] }
      w.__violations = []
      document.addEventListener('securitypolicyviolation', (e) =>
        w.__violations.push(`${e.violatedDirective} ${e.blockedURI}`),
      )
      try {
        localStorage.setItem('talos-theme', m as string)
      } catch {}
    },
    [theme, mode],
  )
  await page.route('**/*', async (route) => {
    // A request can outlive the test (the page is closing): the response is then disposed, and that is not a failure.
    try {
      const res = await route.fetch()
      const headers = res.headers()
      if ((headers['content-type'] ?? '').includes('text/html')) headers['content-security-policy'] = CSP
      await route.fulfill({ status: res.status(), headers, body: await res.body() })
    } catch {
      await route.abort().catch(() => {})
    }
  })
}
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})
/** The fake client keeps its config in memory, so a theme goes in through the app's own config path and pages are
 *  reached without reloading (a reload would start a fresh config). */
async function chooseThroughConfig(page: Page, theme: string) {
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(
    (t) =>
      (window as unknown as { __talos: { patchConfig: (p: unknown) => Promise<void> } }).__talos.patchConfig({
        theme: t,
      }),
    theme,
  )
}
async function go(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState(null, '', p)
    dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await page.waitForLoadState('networkidle')
}
const violations = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __violations: string[] }).__violations.filter((v) => !v.startsWith('script-src eval')),
  )
const css = (page: Page, sel: string, prop: string) =>
  page
    .locator(sel)
    .first()
    .evaluate(
      (el, p) =>
        getComputedStyle(el)
          .getPropertyValue(p as string)
          .trim(),
      prop,
    )
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
/** #rrggbb as the browser reports a colour: rgb(r, g, b). */
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ')})`

for (const theme of STOCK_THEMES)
  for (const mode of ['light', 'dark'] as const)
    test.describe(`${theme.name} ${mode}`, () => {
      test.use({ viewport: { width: 375, height: 812 } })

      test('threads, a thread with an owner bubble, and settings fit the phone and raise no violation', async ({
        page,
      }) => {
        await withCsp(page, theme.name, mode)
        const set = theme[mode] as Record<string, string>
        await page.goto('/threads')
        if (theme.name !== 'talos') await chooseThroughConfig(page, theme.name)
        await expect(page.locator('html')).toHaveCSS('--accent', set['--accent'] as string)
        expect(await sideways(page)).toBe(0)

        await go(page, '/t/general')
        const box = page.getByLabel('Message', { exact: true })
        await box.pressSequentially('hello from the owner')
        await page.getByRole('button', { name: 'Send', exact: true }).click()
        const bubble = page.getByTestId('msg-owner').first()
        await expect(bubble).toBeVisible()
        const bubbleEl = bubble.locator('.figure-ground').first()
        await expect(bubbleEl).toHaveCSS('background-color', rgb(set['--figure-bg'] as string))
        await expect(bubbleEl).toHaveCSS('color', rgb(set['--figure-text'] as string))
        expect(await sideways(page)).toBe(0)

        for (const path of ['/settings', '/settings/appearance']) {
          await go(page, path)
          expect(await sideways(page), path).toBe(0)
        }
        await expect(page.getByRole('radiogroup', { name: 'Colour theme' })).toBeVisible()
        expect(await violations(page)).toEqual([])
      })
    })

test.describe('picker in the browser', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('choosing Paper changes the page colours at once and Default theme restores talos', async ({ page }) => {
    await withCsp(page, 'talos', 'light')
    await page.goto('/settings/appearance')
    const talosBg = await css(page, 'html', '--bg')
    const paper = STOCK_THEMES.find((t) => t.name === 'paper') as (typeof STOCK_THEMES)[number]
    await page.getByRole('radio', { name: 'Paper' }).click()
    await expect(page.locator('html')).toHaveCSS('--bg', paper.light['--bg'])
    await expect(page.locator('body')).toHaveCSS('background-color', rgb(paper.light['--bg']))
    await page.getByRole('button', { name: 'Default theme' }).click()
    await expect(page.locator('html')).toHaveCSS('--bg', talosBg)
    expect(await violations(page)).toEqual([])
  })

  test('?theme=default shows talos and leaves a clean address', async ({ page }) => {
    await withCsp(page, 'talos', 'light')
    await page.goto('/settings/appearance?theme=default&x=1')
    expect(new URL(page.url()).search).toBe('?x=1')
    await expect(page.locator('html')).toHaveCSS('--bg', '#f3e6cf')
  })
})

test.describe('Mac offline at phone width', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('the pick stays, a quiet note says it applies later, and nothing scrolls sideways', async ({ page }) => {
    await withCsp(page, 'talos', 'light')
    await page.goto('/settings/appearance')
    await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
    await page.evaluate(() =>
      (window as unknown as { __talos: { failNextPatchWith: (c: string) => void } }).__talos.failNextPatchWith(
        'mac_offline',
      ),
    )
    await page.getByRole('radio', { name: 'Paper' }).click()
    const note = page
      .getByRole('status')
      .filter({ hasText: 'Saved. It applies on your other devices when your Mac is back.' })
    await expect(note).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: /Mac/ })).toHaveCount(0)
    await expect(page.getByRole('radio', { name: 'Paper' })).toHaveAttribute('aria-checked', 'true')
    expect(await sideways(page)).toBe(0)
  })
})
