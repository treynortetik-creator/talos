// The phone header is black in both themes, and the needs-you dot there is the only visible cue (the words are screen-reader
// only). The light theme's darker --warn is 2.6:1 on that black, so .frieze re-scopes it. Measured in a real browser from
// the colours the engine computed for the real header, not from the stylesheet text.
import { expect, type Page, test } from '@playwright/test'

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 768

test.beforeEach(({ page }) => test.skip(!isPhone(page), 'phone layout only'))

for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme, reducedMotion: 'reduce' })

    test(`the needs-you dot is at least 4.5:1 on the black header (${scheme} theme)`, async ({ page }) => {
      await page.goto('/t/general')
      await expect(page.getByTestId('phone-header')).toBeVisible()
      // The fake client's store is the one the header reads; this is the status frame's own effect on it.
      await page.evaluate(() => {
        type Store = { setState(fn: (s: { statuses: object }) => object): void }
        const c = (window as never as { __talos: { store: Store } }).__talos
        c.store.setState((s) => ({
          ...s,
          statuses: {
            ...s.statuses,
            general: { thread_id: 'general', state: 'needs_you', since: new Date().toISOString() },
          },
        }))
      })
      const status = page.getByTestId('phone-status')
      await expect(status).toContainText('Needs you')
      const measured = await page.evaluate(() => {
        const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => {
            const c = (v as number) / 255
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
          }
          return 0.2126 * f(r as number) + 0.7152 * f(g as number) + 0.0722 * f(b as number)
        }
        const dot = document.querySelector('[data-testid="phone-status"] svg') as SVGElement
        const header = document.querySelector('[data-testid="phone-header"]') as HTMLElement
        const fg = rgb(getComputedStyle(dot).color)
        const bg = rgb(getComputedStyle(header).backgroundColor)
        const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number]
        return { fg, bg, ratio: (hi + 0.05) / (lo + 0.05) }
      })
      expect(measured.fg.length).toBe(3)
      expect(measured.ratio, JSON.stringify(measured)).toBeGreaterThanOrEqual(4.5)
    })
  })
}
