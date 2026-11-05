// Stock themes in a real browser, served under the relay's production Content-Security-Policy: applying one changes the
// colours and raises no violation, and every main screen still fits a 375 px phone in both modes.
import { fileURLToPath } from 'node:url'
import { expect, type Page, type Response, test } from '@playwright/test'
import { appCsp, STOCK_THEMES } from '@talos-app/protocol'
import { build } from 'vite'

const CSP = appCsp('https://talos.example.com')
let bundle = ''

// The PWA's service worker would answer pages itself, past page.route, with no policy header (and on WebKit it hides /__theme.js).
test.use({ serviceWorkers: 'block' })

test.beforeAll(async () => {
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('../helpers/theme-entry.ts', import.meta.url)),
        formats: ['iife'],
        name: 'TalosTheme',
      },
    },
  })
  const list = Array.isArray(out) ? out : [out]
  const first = (list[0] as { output: Array<{ type: string; code?: string }> }).output.find((o) => o.type === 'chunk')
  bundle = first?.code ?? ''
  expect(bundle).toContain('applyThemeTokens')
})

/** Serves the app with the production CSP on its pages, plus the theme bundle as a script from the same origin. */
async function useProductionCsp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] }
    w.__violations = []
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__violations.push(`${e.violatedDirective} ${e.blockedURI}`),
    )
  })
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/__theme.js')
      return route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: bundle,
        headers: { 'content-security-policy': CSP },
      })
    const res = await route.fetch()
    const headers = res.headers()
    if ((headers['content-type'] ?? '').includes('text/html')) headers['content-security-policy'] = CSP
    await route.fulfill({ status: res.status(), headers, body: await res.body() })
  })
}

/** Loads the theme bundle once per page. Loading it runs the protocol package's start-up, which is not a theme's doing. */
async function load(page: Page) {
  if (await page.evaluate(() => 'TalosTheme' in window)) return
  await page.addScriptTag({ url: '/__theme.js' })
}

async function apply(page: Page, theme: unknown, mode: 'light' | 'dark') {
  await load(page)
  await page.evaluate(
    ([t, m]) => {
      document.documentElement.dataset.theme = m as string
      ;(
        window as unknown as { TalosTheme: { applyThemeTokens: (t: unknown, m: unknown) => void } }
      ).TalosTheme.applyThemeTokens(t, m)
    },
    [theme, mode],
  )
}
/** The main document must really have carried the production policy, or a "no violation" result proves nothing. */
function expectCsp(res: Response | null, path = ''): void {
  expect(res, `no response for ${path}`).not.toBeNull()
  expect(res?.headers()['content-security-policy'], `CSP header on ${path || res?.url()}`).toBe(CSP)
}
const violations = (page: Page) => page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)
const accent = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())

test.describe('stock themes under the production CSP', () => {
  test('applying each stock theme changes computed --accent and fires no violation', async ({ page }) => {
    await useProductionCsp(page)
    const res = await page.goto('/t/general')
    expectCsp(res)
    await expect(page.getByTestId('msg-agent').first()).toBeVisible()
    // The app's schema library probes eval once while parsing frames and a strict CSP reports it; that is not from a theme.
    await load(page)
    const baseline = await violations(page)
    expect(baseline.filter((v) => !v.startsWith('script-src eval'))).toEqual([])
    const before = await accent(page)
    for (const theme of STOCK_THEMES) {
      await apply(page, theme, 'dark')
      expect(await accent(page), theme.name).toBe(theme.dark['--accent'])
    }
    expect(await accent(page)).not.toBe(before)
    expect(await violations(page)).toEqual(baseline)
  })
})

const SCREENS = ['/', '/threads', '/t/general', '/schedules', '/settings', '/settings/appearance']

test.describe('stock themes at 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 } })
  for (const theme of STOCK_THEMES)
    for (const mode of ['light', 'dark'] as const)
      test(`${theme.name} ${mode}: no sideways scroll on the main screens`, async ({ page }) => {
        await useProductionCsp(page)
        for (const path of SCREENS) {
          expectCsp(await page.goto(path), path)
          await page.waitForLoadState('networkidle')
          await apply(page, theme, mode)
          const w = await page.evaluate(() => ({
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            body: document.body.scrollWidth - document.body.clientWidth,
          }))
          expect(w, `${theme.name} ${mode} ${path}`).toEqual({ page: 0, body: 0 })
        }
        expect((await violations(page)).filter((v) => !v.startsWith('script-src eval'))).toEqual([])
      })
})
