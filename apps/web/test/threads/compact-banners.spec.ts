// The thread's state banners fold into one compact line with a More button (owner: maximum room on a phone). Real app, fake
// mode: a spec sets the connection and the Mac's presence the way the socket would, and measures what the owner sees.
import { expect, type Locator, type Page, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

type Talos = {
  reconnect: () => void
  store: { setState(f: (s: { presence: Record<string, unknown> }) => Record<string, unknown>): void }
}
const LINE_MAX = 48 // one line: min-h-11 (44 px) plus a border
const box = async (loc: Locator) => {
  const b = await loc.boundingBox()
  if (!b) throw new Error('no box')
  return b
}

async function open(page: Page) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  await page.evaluate(() => {
    const t = (window as unknown as { __talos: Talos & { calls?: number } }).__talos
    t.calls = 0
    t.reconnect = () => {
      t.calls = (t.calls ?? 0) + 1
    }
  })
}
const set = (page: Page, patch: Record<string, unknown>, presence?: Record<string, unknown>) =>
  page.evaluate(
    ([p, pr]) => {
      ;(window as unknown as { __talos: Talos }).__talos.store.setState((s) => ({
        ...p,
        ...(pr ? { presence: { ...s.presence, ...pr } } : {}),
      }))
    },
    [patch, presence] as const,
  )
const macGone = (page: Page, extra: Record<string, unknown> = {}) =>
  set(
    page,
    { connection: 'online' },
    {
      bridge_online: false,
      last_seen: new Date(Date.now() - 30_000).toISOString(),
      ...extra,
    },
  )
const reconnects = (page: Page) =>
  page.evaluate(() => (window as unknown as { __talos: { calls: number } }).__talos.calls)
const timeline = (page: Page) => page.getByTestId('timeline')
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const cause = (page: Page) => page.getByTestId('mac-banner').locator('span.truncate')

const sizes = [
  { name: 'default size', viewport: null },
  { name: '320px phone', viewport: { width: 320, height: 568 } },
] as const

for (const size of sizes) {
  test.describe(size.name, () => {
    if (size.viewport) test.use({ viewport: size.viewport })

    for (const colorScheme of ['light', 'dark'] as const) {
      test.describe(colorScheme, () => {
        test.beforeEach(async ({ page }) => {
          await page.emulateMedia({ colorScheme })
        })

        test('no banner, no row: nothing takes the room', async ({ page }) => {
          await open(page)
          await expect(page.getByTestId('mac-banner')).toHaveCount(0)
          await expect(page.getByRole('button', { name: /^(More|Less)/ })).toHaveCount(0)
          await expect(page.getByText(/is offline/)).toHaveCount(0)
        })

        test('one banner is one line, and the timeline keeps the rest', async ({ page }) => {
          await open(page)
          const before = await box(timeline(page))
          await macGone(page)
          const row = page.getByTestId('mac-banner')
          await expect(row).toBeVisible()
          expect((await box(row)).height).toBeLessThanOrEqual(LINE_MAX)
          await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible()
          // the next step is folded away
          await expect(page.getByText(/comes back on its own/)).toBeHidden()
          await expect
            .poll(async () => before.height - (await box(timeline(page))).height)
            .toBeLessThanOrEqual(LINE_MAX)
          expect(await overflowX(page)).toBeLessThanOrEqual(0)
          // both themes: a real background and readable text, not the page's own
          const colors = await row.evaluate((el) => {
            const bg = getComputedStyle(el.parentElement as HTMLElement).backgroundColor
            return { bg, fg: getComputedStyle(el).color }
          })
          expect(colors.bg).not.toBe('rgba(0, 0, 0, 0)')
          expect(colors.bg).not.toBe(colors.fg)
        })

        test('two banners are still one line, More (2) opens both, Less folds them', async ({ page }) => {
          await open(page)
          await macGone(page)
          await set(page, { deviceId: 'd_test', devicePinned: false })
          const more = page.getByRole('button', { name: 'More (2)' })
          await expect(more).toBeVisible()
          await expect(more).toHaveAttribute('aria-expanded', 'false')
          const line = page.getByRole('status').filter({ has: more })
          expect((await box(line)).height).toBeLessThanOrEqual(LINE_MAX)
          await expect(page.getByText('Waiting for your Mac to confirm this device.')).toBeVisible()
          await expect(page.getByTestId('mac-banner')).toHaveCount(0)
          await more.click()
          const less = page.getByRole('button', { name: 'Less' })
          await expect(less).toHaveAttribute('aria-expanded', 'true')
          await expect(page.getByText('Waiting for your Mac to confirm this device.')).toBeVisible()
          await expect(page.getByText(/talos-app enroll/)).toBeVisible()
          await expect(page.getByText(/Your Mac is offline \(last seen/)).toBeVisible()
          await expect(page.getByText(/comes back on its own/)).toBeVisible()
          await expect(page.getByTestId('mac-banner')).toHaveCount(1)
          expect(await overflowX(page)).toBeLessThanOrEqual(0)
          await less.click()
          await expect(page.getByText(/talos-app enroll/)).toBeHidden()
          await expect(page.getByText(/comes back on its own/)).toBeHidden()
          await expect(page.getByRole('button', { name: 'More (2)' })).toBeVisible()
        })

        test('More and Less work by keyboard and keep focus', async ({ page }) => {
          await open(page)
          await macGone(page)
          const more = page.getByRole('button', { name: 'More', exact: true })
          await more.focus()
          await expect(more).toBeFocused()
          await page.keyboard.press('Enter')
          const less = page.getByRole('button', { name: 'Less' })
          await expect(less).toBeFocused()
          await expect(page.getByText(/comes back on its own/)).toBeVisible()
          await page.keyboard.press('Space')
          await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused()
          await expect(page.getByText(/comes back on its own/)).toBeHidden()
        })

        test('Retry stays one tap on the compact line', async ({ page }) => {
          await open(page)
          await set(page, { connection: 'offline' })
          await expect(page.getByText("You're offline. Messages will send when you're back.")).toBeVisible()
          const retry = page.getByRole('button', { name: 'Retry', exact: true })
          expect((await box(page.getByRole('status').filter({ has: retry }))).height).toBeLessThanOrEqual(LINE_MAX)
          await retry.click()
          expect(await reconnects(page)).toBe(1)
          await set(page, { connection: 'unreachable' })
          await page.getByRole('button', { name: 'Retry now' }).click()
          expect(await reconnects(page)).toBe(2)
        })

        test('a long cause is cut with an ellipsis, never wraps, and never sits under More', async ({ page }) => {
          await open(page)
          await macGone(page, { superseded: true })
          const row = page.getByTestId('mac-banner')
          await expect(row).toContainText(/took your (Mac|PC|computer)'s place/)
          expect((await box(row)).height).toBeLessThanOrEqual(LINE_MAX)
          const c = cause(page)
          const cut = await c.evaluate((el) => ({
            truncated: el.scrollWidth > el.clientWidth,
            ellipsis: getComputedStyle(el).textOverflow,
            nowrap: getComputedStyle(el).whiteSpace,
          }))
          // always one line with an ellipsis ready; on a phone-width screen this cause is longer than the line and is cut
          // (a wide desktop window can show it whole: the superseded cause got shorter on 2026-11-20)
          expect({ ellipsis: cut.ellipsis, nowrap: cut.nowrap }).toEqual({ ellipsis: 'ellipsis', nowrap: 'nowrap' })
          if ((page.viewportSize()?.width ?? 0) < 600) expect(cut.truncated).toBe(true)
          const cb = await box(c)
          const mb = await box(page.getByRole('button', { name: 'More', exact: true }))
          expect(cb.x + cb.width).toBeLessThanOrEqual(mb.x + 0.5)
          expect(await overflowX(page)).toBeLessThanOrEqual(0)
          // nothing is lost: the whole cause is one tap away
          await page.getByRole('button', { name: 'More', exact: true }).click()
          await expect(page.getByText(/that computer has gone too\./)).toBeVisible()
        })
      })
    }
  })
}
