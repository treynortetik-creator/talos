// Phone composer regression tests (keyboard, + menu, jump to latest). Each test pins a confirmed bug. The keyboard is stubbed
// the same way as test/shell/phone-chat.spec.ts: the keyboard is a viewport resize (native resize mode), see helpers/keyboard.ts.
// BUG-1 and BUG-4 are gone with the visual-viewport pin they tested.
import { expect, type Locator, type Page, test } from '@playwright/test'
import { keyboard, visible } from '../helpers/keyboard.ts'

type Store = { setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void }

const inside = async (loc: Locator, page: Page, label: string) => {
  const b = await loc.boundingBox()
  expect(b, `${label} has a box`).not.toBeNull()
  const v = await visible(page)
  expect(b?.y ?? -1, `${label} top`).toBeGreaterThanOrEqual(v.top - 0.5)
  expect((b?.y ?? 0) + (b?.height ?? 0), `${label} bottom above the keyboard`).toBeLessThanOrEqual(v.bottom + 0.5)
}
async function open(page: Page, path = '/t/general') {
  await page.goto(path)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
}
const seed = (page: Page, n: number) =>
  page.evaluate((count) => {
    const st = (window as unknown as { __talos: { store: Store } }).__talos.store
    const mk = (i: number) => ({
      id: `m_seed_${i}`,
      thread_id: 'general',
      seq: 1000 + i,
      author: 'agent',
      kind: 'text',
      text: `Seeded message number ${i}. ${'It is long enough to wrap on a phone and fill the thread. '.repeat(2)}`,
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: new Date(Date.now() - (500 - i) * 1000).toISOString(),
    })
    st.setState((s) => ({
      messages: {
        ...(s.messages as object),
        general: Array.from({ length: count }, (_, k) => mk(k)),
      },
    }))
  }, n)
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: Buffer.from('x') })
const box = (page: Page) => page.getByLabel('Message', { exact: true })
const atBottom = (tl: Locator) => tl.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80)

test.describe('on-screen keyboard', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'iOS layout: Chromium resizes the layout viewport itself')

  test('BUG-3: the jump button goes away when the keyboard closes and the thread fits again', async ({ page }) => {
    await open(page)
    const tl = page.getByTestId('timeline')
    // A thread that fits with the keyboard down and overflows with it up.
    // Measure the rows themselves: scrollHeight is never below clientHeight, so it cannot tell a short thread from a
    // full one. The keyboard takes 222px off the scroller (469 to 247): the content must overflow that by more than the
    // 80px near-bottom band, yet still fit the full scroller.
    for (let n = 1; n < 30; n++) {
      await seed(page, n)
      const [rows, ch] = await tl.evaluate((el) => [
        Array.from(el.children).reduce((h, c) => h + (c as HTMLElement).offsetHeight, 0),
        el.clientHeight,
      ])
      if ((rows as number) > (ch as number) - 222 + 100) break
    }
    await keyboard(page, 336)
    // Let the scroller shrink and the observer run first: scrolling to 0 before that is no scroll at all.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    await tl.evaluate((el) => {
      el.scrollTop = 0
    })
    await expect(page.getByTestId('jump-to-latest')).toBeVisible()
    await keyboard(page, 0)
    await expect.poll(() => tl.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)
    await expect(page.getByTestId('jump-to-latest')).toHaveCount(0)
  })

  test('BUG-5: the bottom nav does not ride on top of the keyboard on screens with a text field', async ({ page }) => {
    await open(page, '/search')
    await page.getByLabel('Search messages').focus()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
    await keyboard(page, 336)
    await expect(page.locator('html')).toHaveAttribute('data-kb', 'open')
    // Before the PR the bar sat behind the keyboard. Now it takes its height plus the home-indicator inset, above it.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
  })

  test('BUG-7a: ten photo chips leave the box above the keyboard (Safari tab, 393 x 659)', async ({ page }) => {
    await open(page)
    await seed(page, 30)
    await page
      .getByTestId('pick-photos')
      .setInputFiles(Array.from({ length: 10 }, (_, i) => png(`IMG_81${String(i).padStart(2, '0')}.png`)))
    await expect(page.getByText('IMG_8109.png')).toBeVisible()
    await keyboard(page, 336)
    // The cap on the chip list hangs on this flag, which the app sets a couple of frames after the resize.
    await expect(page.locator('html')).toHaveAttribute('data-kb', 'open')
    await inside(box(page), page, 'message box')
  })

  test('BUG-7b: landscape, Mac offline, one chip: the box stays above the keyboard', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    await open(page)
    await seed(page, 30)
    await page.evaluate(() => {
      const st = (window as unknown as { __talos: { store: Store } }).__talos.store
      st.setState((s) => ({ presence: { ...(s.presence as object), bridge_online: false } }))
    })
    await page.getByTestId('pick-photos').setInputFiles([png('IMG_8114.png')])
    await expect(page.getByText('IMG_8114.png')).toBeVisible()
    await keyboard(page, 200)
    await expect(page.locator('html')).toHaveAttribute('data-kb', 'open')
    await inside(box(page), page, 'message box')
  })

  test('BUG-8: the slash picker is not cut off at the top above the keyboard', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    await open(page)
    await box(page).fill('/')
    await keyboard(page, 200)
    await expect(page.locator('html')).toHaveAttribute('data-kb', 'open')
    await inside(page.getByTestId('slash-picker').getByRole('option').first(), page, 'first command')
  })
})

test.describe('jump to latest', () => {
  test('BUG-2: jumping leaves focus in the message box (losing it drops the keyboard)', async ({ page }) => {
    await open(page)
    await seed(page, 40)
    const tl = page.getByTestId('timeline')
    await expect.poll(() => atBottom(tl)).toBe(true)
    await tl.evaluate((el) => {
      el.scrollTop = 0
    })
    await box(page).fill('half a thought')
    await box(page).focus()
    await page.getByTestId('jump-to-latest').click()
    await expect.poll(() => atBottom(tl)).toBe(true)
    await expect(box(page)).toBeFocused()
  })
})
