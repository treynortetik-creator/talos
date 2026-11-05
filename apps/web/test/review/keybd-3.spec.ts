// Third round of phone composer regression tests. Each one pins a confirmed Medium bug, except the
// one titled "guard", which pins behaviour that already held. The keyboard is the same
// keyboard model as keybd.spec.ts and keybd-2.spec.ts: a viewport resize (helpers/keyboard.ts). R3-01 pan 82 is gone with the pin.
import { expect, type Locator, type Page, test } from '@playwright/test'
import { card } from '../cards/harness/seed.ts'
import { keyboard } from '../helpers/keyboard.ts'

test.use({ serviceWorkers: 'block' })

type Store = { setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void }
type Talos = { store: Store }

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
const attachment = (media_id: string, kind: string, mime: string, name: string) => ({
  media_id,
  kind,
  role: 'attachment',
  mime,
  name,
  size: 200,
  sha256: '0'.repeat(64),
})
/** Waits until the thread has settled at the bottom first, so the scroll is a real one (the race in R2-03). */
async function scrollUp(tl: Locator) {
  await expect.poll(() => tl.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await tl.evaluate((el) => {
    el.scrollTop = 0
  })
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
/** What the owner actually taps at the centre of `loc`. */
const tappedAtCentre = (loc: Locator) =>
  loc.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { isIt: el === hit || el.contains(hit), what: hit?.tagName ?? 'nothing', y: [r.top, r.bottom] }
  })

test.describe('on-screen keyboard', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'iOS layout: Chromium resizes the layout viewport itself')

  test('R3-01: a low settings field (the live-call personality, the last box on Voice; Agent has no low field any more) is not left under the keyboard', async ({
    page,
  }) => {
    await page.setViewportSize(SHELL)
    await open(page, '/settings/voice')
    const field = page.getByLabel('Live-call personality')
    await expect(field).toBeVisible()
    // Rest the field low on the screen, where the owner taps it with the keyboard down.
    await field.evaluate((el) => {
      let s = el.parentElement
      while (s && !(s.scrollHeight > s.clientHeight + 1 && getComputedStyle(s).overflowY !== 'visible'))
        s = s.parentElement
      if (s) s.scrollTop += el.getBoundingClientRect().top - 656
    })
    expect((await field.boundingBox())?.y ?? 0, 'the setup: the field rests below the keyboard top').toBeGreaterThan(
      530,
    )
    await field.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }))
    await keyboard(page, 336)
    await expect(page.locator('html')).toHaveAttribute('data-kb', 'open')
    await frames(page)
    await frames(page)
    await expect(field).toBeFocused()
    const hit = await tappedAtCentre(field)
    expect(hit.isIt, `field at y ${hit.y.join('-')} is covered by ${hit.what}`).toBe(true)
  })

  test('R3-03: a new row does not snap away the card field being edited', async ({ page }) => {
    await page.setViewportSize(SHELL)
    await open(page)
    const c = card()
    const cardRow = { ...text(30, ''), id: 'm_seed_card', kind: 'card', card_id: c.id, text: undefined }
    const before = Array.from({ length: 30 }, (_, i) => long(i))
    const after = [31, 32, 33, 34].map((i) => text(i, `A short reply ${i}.`))
    await setThread(page, [...before, cardRow, ...after], [c])
    const tl = page.getByTestId('timeline')
    const row = page.locator(`[id="card-${c.id}"]`)
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    const field = page.getByLabel('Subj')
    await field.focus()
    await keyboard(page, 336)
    await expect(page.locator('html')).toHaveAttribute('data-kb', 'open')
    await frames(page)
    await frames(page)
    const height = await field.evaluate((el) => el.getBoundingClientRect().height)
    // The setup R2-04 fixed: the keyboard is up and the field being edited is fully on screen.
    await expect.poll(() => visiblePx(field, tl), { message: 'the setup: field on screen' }).toBeCloseTo(height, 0)
    // The agent replies while the owner types.
    await setThread(page, [...before, cardRow, ...after, text(35, 'A new reply arrives.')], [c])
    await expect(tl.getByText('A new reply arrives.').first()).toBeAttached()
    await frames(page)
    await expect(field).toBeFocused()
    expect(await visiblePx(field, tl), 'the focused field is still in the scroller').toBeCloseTo(height, 0)
    // The reply is not lost: the Jump pill offers it.
    await expect(page.getByTestId('jump-to-latest')).toBeVisible()
  })

  test('R3-04: an expanded page covers the composer on iPhone, which has no element fullscreen', async ({ page }) => {
    await page.setViewportSize(SHELL)
    await page.addInitScript(() => {
      // iPhone Safari, Home Screen app and shell: no element fullscreen (SandboxedFrame.tsx:43), so the fixed box is all.
      Reflect.deleteProperty(Element.prototype, 'requestFullscreen')
    })
    await page.route('**/media/md_page/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>report</body>' }),
    )
    await open(page)
    await setThread(page, [
      {
        ...text(1, 'Here is the report.'),
        attachments: [attachment('md_page', 'html', 'text/html', 'report.html')],
      },
    ])
    const box = page.getByLabel('Message', { exact: true })
    await expect(box).toBeVisible()
    await page.getByRole('button', { name: 'Expand report.html to full screen' }).click()
    await expect(page.getByRole('dialog', { name: 'report.html' })).toBeVisible()
    await frames(page)
    const hit = await tappedAtCentre(box)
    expect(hit.isIt, `the composer is on top of the overlay (hit ${hit.what})`).toBe(false)
  })

  test('R3-06 guard: landscape with the keyboard up gives the header and banners to the box', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    await open(page)
    await setThread(
      page,
      Array.from({ length: 30 }, (_, i) => long(i)),
    )
    const timeline = page.getByTestId('timeline')
    await page.getByLabel('Message', { exact: true }).focus()
    await keyboard(page, 200)
    await expect(page.locator('html')).toHaveAttribute('data-kb', 'open')
    await frames(page)
    await expect(page.getByTestId('thread-screen').locator('header')).toBeHidden()
    await expect(page.getByTestId('thread-tabs')).toBeHidden()
    // 190 px is all there is. With a 66 px header and the tabs still up the thread gets almost none of it.
    expect((await timeline.boundingBox())?.height ?? 0, 'timeline height').toBeGreaterThan(90)
  })
})

test.describe('jump to latest', () => {
  async function lateImage(page: Page) {
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
      attachments: [attachment('md_late', 'image', 'image/svg+xml', 'plan.png')],
    }
    return { tl, rows, image }
  }
  const settled = async (page: Page, tl: Locator) => {
    const img = page.getByRole('img', { name: 'plan.png' })
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await frames(page)
    await expect
      .poll(() => tl.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
        message: 'gap below the view once the image has its size',
      })
      .toBeLessThanOrEqual(1)
  }

  test('R3-02a: Jump by keyboard reaches the real bottom past a late image', async ({ page }) => {
    const { tl, rows, image } = await lateImage(page)
    await setThread(page, [...rows, image])
    await expect(page.getByTestId('jump-count')).toHaveText('1')
    await page.getByTestId('jump-to-latest').focus()
    await page.keyboard.press('Enter')
    // jump() hands focus to the scroller on purpose: this is the state the guard misreads.
    await expect(tl).toBeFocused()
    await settled(page, tl)
  })

  test('R3-02b: Jump reaches the real bottom past a late image when focus is on the scroller', async ({ page }) => {
    const { tl, rows, image } = await lateImage(page)
    await setThread(page, [...rows, image])
    await expect(page.getByTestId('jump-count')).toHaveText('1')
    await tl.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }))
    await page.getByTestId('jump-to-latest').click()
    await expect(tl).toBeFocused()
    await settled(page, tl)
  })
})
