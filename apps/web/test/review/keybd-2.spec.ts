// Second round of phone composer regression tests. Each one pins a confirmed High or Medium bug. The keyboard is a viewport
// resize, as in keybd.spec.ts (helpers/keyboard.ts).
import { expect, type Locator, type Page, test } from '@playwright/test'
import { card } from '../cards/harness/seed.ts'
import { keyboard, visible } from '../helpers/keyboard.ts'

test.use({ serviceWorkers: 'block' })

type Store = { setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void }
type Talos = { store: Store; uploadMedia: (b: Blob, m: { name: string }) => Promise<unknown> }

const SHELL = { width: 393, height: 852 } // iPhone 15 in the Capacitor shell: no Safari toolbars.

const frames = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
async function open(page: Page, path = '/t/general') {
  await page.goto(path)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
}
const text = (i: number, body: string) => ({
  id: `m_seed_${i}`,
  thread_id: 'general',
  seq: 1000 + i,
  author: 'agent',
  kind: 'text',
  text: body,
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: new Date(Date.now() - (500 - i) * 1000).toISOString(),
})
const long = (i: number) =>
  text(i, `Seeded message number ${i}. ${'It is long enough to wrap on a phone and fill the thread. '.repeat(2)}`)
const setThread = (page: Page, rows: unknown[], cards?: unknown[]) =>
  page.evaluate(
    ([r, c]) => {
      const st = (window as unknown as { __talos: Talos }).__talos.store
      st.setState((s) => ({
        messages: { ...(s.messages as object), general: r },
        ...(c ? { cards: c } : {}),
      }))
    },
    [rows, cards ?? null],
  )
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: Buffer.from('x') })
/** Waits until the thread has settled at the bottom first, so the scroll is a real one (the race in R2-03). */
async function scrollUp(tl: Locator) {
  await expect.poll(() => tl.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await tl.evaluate((el) => {
    el.scrollTop = 0
  })
}

async function aboveKeyboard(loc: Locator, page: Page, label: string) {
  const b = await loc.boundingBox()
  expect(b, `${label} has a box`).not.toBeNull()
  const v = await visible(page)
  expect(b?.y ?? -1, `${label} top`).toBeGreaterThanOrEqual(v.top - 0.5)
  expect((b?.y ?? 0) + (b?.height ?? 0), `${label} bottom above the keyboard`).toBeLessThanOrEqual(v.bottom + 0.5)
}

/** Pixels of `item` not clipped by the scroller `area`. */
async function visiblePx(item: Locator, area: Locator) {
  const s = await area.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom }
  })
  return item.evaluate((el, a) => {
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(r.bottom, a.bottom) - Math.max(r.top, a.top))
  }, s)
}

test.describe('on-screen keyboard', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'iOS layout: Chromium resizes the layout viewport itself')

  test('R2-01: a field iOS panned into view stays above the keyboard once the app is pinned', async ({ page }) => {
    await page.setViewportSize(SHELL)
    await open(page, '/schedules/new')
    const field = page.getByLabel('What to do')
    await field.focus()
    // 336 px of keyboard leaves 516 px. iOS pans 82 px so the 210 px tall box ends just above it. The pin must keep it there.
    await keyboard(page, 336)
    await expect(page.locator('html')).toHaveAttribute('data-kb', 'open')
    await frames(page)
    await aboveKeyboard(field, page, 'prompt box')
  })

  test('R2-04: opening the keyboard does not scroll away the card field being edited', async ({ page }) => {
    await page.setViewportSize(SHELL)
    await open(page)
    const c = card()
    const cardRow = { ...text(30, ''), id: 'm_seed_card', kind: 'card', card_id: c.id, text: undefined }
    const after = [31, 32, 33, 34].map((i) => text(i, `A short reply ${i}.`))
    await setThread(page, [...Array.from({ length: 30 }, (_, i) => long(i)), cardRow, ...after], [c])
    const tl = page.getByTestId('timeline')
    const row = page.locator(`[id="card-${c.id}"]`)
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    const field = page.getByLabel('Subj')
    await field.focus()
    const height = await field.evaluate((el) => el.getBoundingClientRect().height)
    // The setup that matters: stuck to the bottom, field fully on screen, and further from the end than the keyboard leaves.
    await expect.poll(() => visiblePx(field, tl)).toBeCloseTo(height, 0)
    await keyboard(page, 336)
    await expect(page.locator('html')).toHaveAttribute('data-kb', 'open')
    await frames(page)
    await expect(field).toBeFocused()
    expect(await visiblePx(field, tl), 'the focused field is still in the scroller').toBeCloseTo(height, 0)
  })
})

test.describe('photo chips, keyboard down', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 600, 'phone width: desktop fits four chips on one row')

  async function fourPhotosLastFails(page: Page) {
    await open(page)
    await page.evaluate(() => {
      const t = (window as unknown as { __talos: Talos }).__talos
      const real = t.uploadMedia.bind(t)
      t.uploadMedia = (b, m) => (m.name === 'IMG_8103.png' ? Promise.reject(new Error('nope')) : real(b, m))
    })
    const names = ['IMG_8100.png', 'IMG_8101.png', 'IMG_8102.png', 'IMG_8103.png']
    await page.getByTestId('pick-photos').setInputFiles(names.map(png))
    const composer = page.getByTestId('composer')
    await expect(composer.getByText("Couldn't upload")).toHaveCount(1)
    return composer
  }

  test('R2-02a: a failed upload is on screen without the owner having to scroll the chip list', async ({ page }) => {
    const composer = await fourPhotosLastFails(page)
    await expect(page.locator('html')).not.toHaveAttribute('data-kb', /.*/)
    await frames(page)
    const failed = composer.getByRole('listitem').filter({ hasText: "Couldn't upload" })
    expect(await visiblePx(failed, composer.getByRole('list'))).toBeGreaterThan(0)
  })

  test('R2-02b: Send does not drop a failed photo without a word', async ({ page }) => {
    const composer = await fourPhotosLastFails(page)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(composer.getByText('IMG_8100.png')).toHaveCount(0)
    const kept = await composer.getByText('IMG_8103.png').count()
    const warned = await composer.getByRole('alert').or(composer.getByTestId('composer-note')).count()
    expect(kept + warned, 'the failed chip stays, or the composer says it was left behind').toBeGreaterThan(0)
  })
})

test.describe('jump to latest', () => {
  test('R2-05: the jump button does not paint over an open sheet', async ({ page }) => {
    await open(page)
    await setThread(
      page,
      Array.from({ length: 40 }, (_, i) => long(i)),
    )
    const tl = page.getByTestId('timeline')
    await scrollUp(tl)
    const jump = page.getByTestId('jump-to-latest')
    await expect(jump).toBeVisible()
    await page.getByTestId('session-trigger').click()
    await expect(page.getByTestId('session-sheet')).toBeVisible()
    await frames(page)
    // A modal sheet sets pointer-events:none on body, so a plain hit test skips the button whatever is painted. With the
    // button hit-testable again, elementFromPoint returns the topmost painted element: the sheet or its overlay, if correct.
    const onTop = await jump.evaluate((el) => {
      ;(el as HTMLElement).style.pointerEvents = 'auto'
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return el.contains(hit)
    })
    expect(onTop, 'the jump button is painted above the sheet').toBe(false)
  })

  test('R2-06: Jump ends at the real bottom when the newest row is an image still loading', async ({ page }) => {
    // Attachments carry no width or height, so a lazy image has no size until it loads.
    await page.route('**/media/md_late*', async (route) => {
      await new Promise((r) => setTimeout(r, 300))
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640"/></svg>',
      })
    })
    await open(page)
    const rows = Array.from({ length: 40 }, (_, i) => long(i))
    await setThread(page, rows)
    const tl = page.getByTestId('timeline')
    await scrollUp(tl)
    await expect(page.getByTestId('jump-to-latest')).toBeVisible()
    const image = {
      ...text(40, ''),
      id: 'm_seed_image',
      attachments: [
        {
          media_id: 'md_late',
          kind: 'image',
          role: 'attachment',
          mime: 'image/svg+xml',
          name: 'plan.png',
          size: 200,
          sha256: '0'.repeat(64),
        },
      ],
    }
    await setThread(page, [...rows, image])
    await expect(page.getByTestId('jump-count')).toHaveText('1')
    await page.getByTestId('jump-to-latest').click()
    const img = page.getByRole('img', { name: 'plan.png' })
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await frames(page)
    await expect
      .poll(() => tl.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
        message: 'gap below the view once the image has its size',
      })
      .toBeLessThanOrEqual(1)
  })
})
