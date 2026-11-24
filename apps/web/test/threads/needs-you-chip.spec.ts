// The "N needs you" count in a thread's header (phone and desktop): a small chip that takes no row above the composer and
// scrolls to the first card that needs the owner. Real app, fake mode.
import { expect, type Locator, type Page, test } from '@playwright/test'
import { card } from '../cards/harness/seed.ts'

test.use({ serviceWorkers: 'block' })

type Talos = { store: { setState(f: (s: Record<string, unknown>) => Record<string, unknown>): void } }
const tabReachesButtons = (project: string) => project !== 'iphone'

const msg = (i: number, thread = 'general') => ({
  id: `m_seed_${thread}_${i}`,
  thread_id: thread,
  seq: 1000 + i,
  author: 'agent',
  kind: 'text',
  text: `Seeded message number ${i}. ${'It is long enough to wrap on a phone and fill the thread. '.repeat(2)}`,
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: new Date(Date.now() - (500 - i) * 1000).toISOString(),
})

/** A thread of long messages with `n` cards that need the owner, the first one far above the bottom. */
async function seed(page: Page, n: number, thread = 'general', waitUntil: 'load' | 'domcontentloaded' = 'load') {
  await page.goto(`/t/${thread}`, { waitUntil })
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  const cards = Array.from({ length: n }, (_, i) => card({ thread_id: thread, title: `Needs you ${i + 1}` }))
  const rows: unknown[] = []
  for (let i = 0; i < 25; i++) rows.push(msg(i, thread))
  cards.forEach((c, i) => {
    rows.push({ ...msg(30 + i, thread), id: `m_card_${i}`, kind: 'card', card_id: c.id, text: undefined })
    for (let j = 0; j < 12; j++) rows.push(msg(40 + i * 20 + j, thread))
  })
  await page.evaluate(
    ([r, c, t]) => {
      ;(window as unknown as { __talos: Talos }).__talos.store.setState((s) => ({
        messages: { ...(s.messages as object), [t as string]: r },
        cards: c,
      }))
    },
    [rows, cards, thread] as const,
  )
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  return cards
}
const box = async (loc: Locator) => {
  const b = await loc.boundingBox()
  if (!b) throw new Error('no box')
  return b
}
type B = { x: number; y: number; width: number; height: number }
const overlaps = (a: B, b: B) =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5

/** The header of this viewport: the phone's, or the desktop thread header. */
const headerOf = (page: Page) => page.locator('[data-testid="thread-under-search"] > header').first()

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

        test('shows the count in the header, and the old row above the composer is gone', async ({ page }) => {
          await seed(page, 2)
          const chip = page.getByTestId('needs-you-chip')
          await expect(chip).toBeVisible()
          await expect(chip).toHaveText('2')
          await expect(chip).toHaveAttribute('aria-label', '2 need you, show the first')
          const h = await box(headerOf(page))
          const c = await box(chip)
          expect(c.y).toBeGreaterThanOrEqual(h.y - 0.5)
          expect(c.y + c.height).toBeLessThanOrEqual(h.y + h.height + 0.5)
          // nothing with the old pill's words sits between the timeline and the composer
          await expect(page.getByText(/\d+ needs you$/)).toHaveCount(0)
          const tl = await box(page.getByTestId('timeline'))
          const comp = await box(page.getByTestId('composer'))
          expect(Math.abs(comp.y - (tl.y + tl.height)), 'a row sits between timeline and composer').toBeLessThanOrEqual(
            1,
          )
        })

        test('the singular reads right, and the header and timeline do not change size with a card pending', async ({
          page,
        }) => {
          await seed(page, 0)
          await expect(page.getByTestId('needs-you-chip')).toHaveCount(0)
          const h0 = await box(headerOf(page))
          const tl0 = await box(page.getByTestId('timeline'))
          await seed(page, 1)
          await expect(page.getByTestId('needs-you-chip')).toHaveAttribute('aria-label', '1 needs you, show the first')
          const h1 = await box(headerOf(page))
          const tl1 = await box(page.getByTestId('timeline'))
          expect(h1.height, 'the header grew').toBeCloseTo(h0.height, 0)
          expect(tl1.height, 'the timeline gave up room').toBeCloseTo(tl0.height, 0)
          expect(tl1.y).toBeCloseTo(tl0.y, 0)
        })

        test('the touch target is at least 44 px while the chip stays small', async ({ page }) => {
          await seed(page, 1)
          const chip = page.getByTestId('needs-you-chip')
          const b = await box(chip)
          expect(b.width).toBeGreaterThanOrEqual(43.5)
          expect(b.height).toBeGreaterThanOrEqual(43.5)
          const visible = await box(chip.locator('[data-chip-face]'))
          expect(visible.height).toBeLessThan(36)
        })

        test('tapping it scrolls the first pending card into view', async ({ page }) => {
          const cards = await seed(page, 2)
          const tl = page.getByTestId('timeline')
          const first = page.locator(`[id="card-${cards[0]?.id}"]`)
          // the thread opens at the bottom, so the first card is off screen
          await expect
            .poll(async () => (await box(first)).y + (await box(first)).height)
            .toBeLessThan((await box(tl)).y)
          await page.getByTestId('needs-you-chip').click()
          await expect
            .poll(async () => {
              const f = await box(first)
              const t = await box(tl)
              return f.y >= t.y - 1 && f.y + f.height <= t.y + t.height + 1
            })
            .toBe(true)
        })

        test('a tap while the card is still loading still lands it whole in view once it has loaded', async ({
          page,
        }) => {
          // The card's code loads on demand: until it does, the card is a short placeholder. A slow phone (or a loaded CI
          // runner) can be tapped then: the card must not be placed by the placeholder's size and then grow out of view.
          let release: () => void = () => {}
          const loaded = new Promise<void>((r) => {
            release = r
          })
          await page.route(/\/CardView[^/]*\.js(\?.*)?$/, async (route) => {
            await loaded
            await route.continue()
          })
          // the page's load event would wait for the held card code, so the page counts as open at its DOM
          const cards = await seed(page, 2, 'general', 'domcontentloaded')
          const tl = page.getByTestId('timeline')
          const first = page.locator(`[id="card-${cards[0]?.id}"]`)
          await expect(first.locator('.animate-pulse')).toHaveCount(1) // still the placeholder
          await page.getByTestId('needs-you-chip').click()
          await page.waitForTimeout(600) // the view has settled on the placeholder
          release()
          await expect(first.locator('.animate-pulse')).toHaveCount(0)
          await expect
            .poll(async () => {
              const f = await box(first)
              const t = await box(tl)
              return f.y >= t.y - 1 && f.y + f.height <= t.y + t.height + 1
            })
            .toBe(true)
        })

        test('the thread growing just after the tap does not pull the view back to the bottom', async ({ page }) => {
          // Red at 34540b43 under load: the cards' code arrived while the scroll to the card had only just begun, the
          // timeline still counted the view as at the end and followed the growth back to the bottom.
          let release: () => void = () => {}
          const loaded = new Promise<void>((r) => {
            release = r
          })
          await page.route(/\/CardView[^/]*\.js(\?.*)?$/, async (route) => {
            await loaded
            await route.continue()
          })
          const cards = await seed(page, 2, 'general', 'domcontentloaded')
          const tl = page.getByTestId('timeline')
          const first = page.locator(`[id="card-${cards[0]?.id}"]`)
          await expect(first.locator('.animate-pulse')).toHaveCount(1)
          await page.getByTestId('needs-you-chip').click()
          release() // the cards fill in at once, while a scroll begun by the tap would still be on its way
          await expect(first.locator('.animate-pulse')).toHaveCount(0)
          await page.waitForTimeout(400) // anything that followed the growth has run
          const f = await box(first)
          const t = await box(tl)
          expect(f.y, 'the card is below the top of the timeline').toBeGreaterThanOrEqual(t.y - 1)
          expect(f.y + f.height, 'the card is above the bottom of the timeline').toBeLessThanOrEqual(t.y + t.height + 1)
        })

        test('a thread with no pending card has no chip', async ({ page }) => {
          await seed(page, 0)
          await expect(page.getByTestId('needs-you-chip')).toHaveCount(0)
        })

        test('the Inbox thread has no chip', async ({ page }) => {
          await seed(page, 1, 'inbox')
          await expect(page.getByTestId('needs-you-chip')).toHaveCount(0)
        })

        test('the chip does not crowd the header buttons, and a long name truncates instead', async ({
          page,
        }, info) => {
          await seed(page, 3)
          await page.evaluate(() => {
            const s = (window as unknown as { __talos: Talos }).__talos.store
            s.setState((st) => ({
              threads: (st.threads as Array<{ id: string; name: string }>).map((t) =>
                t.id === 'general' ? { ...t, name: 'A thread with a very very long name indeed' } : t,
              ),
            }))
          })
          const chip = page.getByTestId('needs-you-chip')
          await expect(chip).toBeVisible()
          const h1 = page.locator('[data-testid="thread-screen"] h1').first()
          const c = await box(chip)
          const name = await box(h1)
          expect(overlaps(c, name), 'chip over the title').toBe(false)
          const vp = page.viewportSize()
          expect(c.x + c.width).toBeLessThanOrEqual((vp?.width ?? 0) + 0.5)
          expect(await h1.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
          const header = headerOf(page)
          for (const id of ['phone-menu-button', 'palette-button', 'session-trigger']) {
            const el = header.getByTestId(id)
            if ((await el.count()) === 0) continue
            expect(overlaps(c, await box(el)), `chip over ${id}`).toBe(false)
          }
          if (info.project.name !== 'desktop') {
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
          }
        })

        test('Tab reaches the chip and Enter scrolls to the card', async ({ page }, info) => {
          test.skip(!tabReachesButtons(info.project.name), 'iOS Safari does not Tab to buttons')
          const cards = await seed(page, 2)
          const chip = page.getByTestId('needs-you-chip')
          await chip.focus()
          await expect(chip).toBeFocused()
          await page.keyboard.press('Enter')
          const first = page.locator(`[id="card-${cards[0]?.id}"]`)
          const tl = await box(page.getByTestId('timeline'))
          await expect
            .poll(async () => {
              const f = await box(first)
              return f.y >= tl.y - 1 && f.y + f.height <= tl.y + tl.height + 1
            })
            .toBe(true)
        })
      })
    }
  })
}

test('the phone header keeps its height with the chip', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'phone header only')
  await seed(page, 0)
  const before = await box(page.getByTestId('phone-header'))
  await seed(page, 2)
  await expect(page.getByTestId('needs-you-chip')).toBeVisible()
  const after = await box(page.getByTestId('phone-header'))
  expect(after.height).toBeCloseTo(before.height, 0)
  const chip = await box(page.getByTestId('needs-you-chip'))
  expect(chip.height).toBeLessThanOrEqual(after.height + 0.5)
})

test('the desktop header carries the chip after the status area, with no phone header', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop header only')
  await seed(page, 2)
  await expect(page.getByTestId('phone-header')).toHaveCount(0)
  const header = headerOf(page)
  const chip = header.getByTestId('needs-you-chip')
  await expect(chip).toHaveText('2')
  const h1 = await box(header.locator('h1'))
  const c = await box(chip)
  expect(c.x).toBeGreaterThanOrEqual(h1.x + h1.width - 0.5)
  expect(overlaps(c, await box(header.getByRole('button', { name: /settings|menu/i }).last()))).toBe(false)
})
