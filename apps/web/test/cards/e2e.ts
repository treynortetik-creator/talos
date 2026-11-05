// Helpers shared by the WP7 Playwright specs. Not a spec itself (no `.spec.ts` suffix).
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

export async function open(
  page: Page,
  route = '/',
  opts: { seed?: 'full' | 'permission'; offline?: boolean } = {},
): Promise<void> {
  // Fixtures carry absolute times (card expiries, "done today"); pin "now" to the day they were written for. The clock
  // keeps running, so timers and countdowns behave normally.
  await page.clock.install({ time: new Date('2026-10-28T16:00:00.000Z') })
  const q = new URLSearchParams({ route })
  if (opts.seed) q.set('seed', opts.seed)
  if (opts.offline) q.set('offline', '1')
  await page.goto(`/test/cards/harness/index.html?${q}`)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
}

/**
 * Zero serious or critical axe violations, in light and in dark. `within` limits the scan to those regions (never turns a
 * rule off); leave it out to scan the whole page.
 */
export async function expectAxeClean(page: Page, within: string[] = []): Promise<void> {
  // Colour transitions (140 ms) would otherwise be caught mid-flight right after a scheme switch (seen on WebKit, ~25% of
  // runs). Kill them BEFORE switching the scheme, so no transition ever starts, then prove nothing is still animating.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    await page.waitForFunction(() => document.getAnimations().length === 0)
    const builder = new AxeBuilder({ page })
    for (const region of within) builder.include(region)
    const results = await builder.analyze()
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(
      bad.map((v) => `${scheme}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      `axe ${scheme}`,
    ).toEqual([])
  }
}

export function sentFrames(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => JSON.parse(JSON.stringify(window.__talos.sent)))
}
