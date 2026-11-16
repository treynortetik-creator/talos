// A reply banner (the app's toast) is drawn above sheets. On a wide screen it is centred and no wider than a phone, so it
// never sits over the corner where a right-hand sheet keeps its close button: with a banner up, that corner is the sheet's.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'

test.use({ bypassCSP: true, serviceWorkers: 'block' })
const SHOTS = process.env.SHOT_DIR

/** An unread reply lands in another thread: the tap-to-jump banner comes up. */
async function raiseBanner(page: Page, id = 'm_01JBF3V7Q8K2M4N6P8R0S9ZZZY') {
  await page.evaluate((id) => {
    // biome-ignore lint/suspicious/noExplicitAny: the fake client's store, read as the page has it
    const w = window as unknown as { __talos: { store: { getState: () => any; setState: (s: any) => void } } }
    const s = w.__talos.store.getState()
    // biome-ignore lint/suspicious/noExplicitAny: as above
    const other = s.threads.find((t: any) => t.id !== 'general' && t.notify === 'all' && !t.archived)
    const msg = {
      id,
      thread_id: other.id,
      author: 'agent',
      kind: 'text',
      text: 'A reply in another thread',
      format: 'plain',
      attachments: [],
      via: 'app',
      seq: 998,
      created_at: new Date().toISOString(),
    }
    w.__talos.store.setState({
      ...s,
      messages: { ...s.messages, [other.id]: [...(s.messages[other.id] ?? []), msg] },
      unread: { ...s.unread, [other.id]: (s.unread[other.id] ?? 0) + 1 },
    })
  }, id)
}

for (const width of [1440, 1024, 800])
  test.describe('wide screens', () => {
    test.beforeEach(({ isMobile }) => test.skip(isMobile, 'right-hand sheets are a wide-screen layout'))
    test(`with a reply banner up, a right-hand sheet's corner is still the sheet's (${width} px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/t/general')
      await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
      await page.getByTestId('thread-settings-trigger').click()
      await page.getByTestId('thread-settings-open').click()
      const sheet = page.locator(
        '[role="dialog"]:has([data-testid="thread-settings"]), [role="dialog"][data-testid="thread-settings"]',
      )
      await expect(sheet).toBeVisible()
      await raiseBanner(page)
      const banner = page.getByTestId('thread-banner')
      await expect(banner).toBeVisible()
      await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
      // the sheet's top-right corner, where a sheet keeps its close button: clear of the banner, and the sheet's own there
      const b = await banner.boundingBox()
      const sh = await sheet.boundingBox()
      if (!b || !sh) throw new Error('no layout')
      const corner = { x: sh.x + sh.width - 56, y: sh.y, width: 56, height: 56 }
      const overlap =
        b.x < corner.x + corner.width &&
        corner.x < b.x + b.width &&
        b.y < corner.y + corner.height &&
        corner.y < b.y + b.height
      expect(overlap, `banner ${JSON.stringify(b)} vs the sheet's corner ${JSON.stringify(corner)}`).toBe(false)
      const inSheet = await page.evaluate(
        ([x, y]) => Boolean(document.elementFromPoint(x as number, y as number)?.closest('[role="dialog"]')),
        [corner.x + 28, corner.y + 28],
      )
      expect(inSheet, 'what is at the corner belongs to the sheet').toBe(true)
      if (SHOTS && width === 1440) {
        mkdirSync(SHOTS, { recursive: true })
        await page.screenshot({ path: join(SHOTS, 'desktop-banner-with-sheet.png') })
      }
    })
  })

test('at phone width the banner still opens its thread on a tap, and Dismiss closes it', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the phone layout')
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await raiseBanner(page)
  const banner = page.getByTestId('thread-banner')
  await expect(banner).toBeVisible()
  const b = await banner.boundingBox()
  const vw = page.viewportSize()?.width ?? 0
  expect(b && b.width).toBeGreaterThan(vw - 40) // as wide as the phone, as before
  await banner.getByRole('button', { name: 'Dismiss' }).click()
  await expect(banner).toHaveCount(0)
  await raiseBanner(page, 'm_01JBF3V7Q8K2M4N6P8R0S9ZZZX')
  await expect(banner).toBeVisible()
  await page.getByTestId('thread-banner-open').click()
  await expect(page).not.toHaveURL(/\/t\/general$/)
  await expect(banner).toHaveCount(0)
})
