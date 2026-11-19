// A send must never start the mic or a live call. When the box empties, the mic and "Start a live call" take Send's place, the
// call button exactly where Send was: a second press of one Send (a double tap, a touch registered twice, a quick re-tap) used to
// start a call, which asks for the microphone ("pressing Send starts dictation", the owner, 2026-11-19). Every project.
import { expect, type Page, test } from '@playwright/test'
import { SEND_GUARD_MS } from '../../src/features/composer/sendGuard.ts'

test.use({ serviceWorkers: 'block' })

const box = (page: Page) => page.getByLabel('Message', { exact: true })
const send = (page: Page) => page.getByRole('button', { name: 'Send', exact: true })

/** Records each press that REACHED a button (document, bubbling: one swallowed on its way is not seen) and each mic request. */
async function open(page: Page) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(() => {
    const w = window as unknown as {
      __reached: string[]
      __mic: number
      __sentAt: number
      __downs: number[]
      __busyMs: number
    }
    w.__reached = []
    w.__mic = 0
    w.__downs = []
    w.__busyMs = 0
    // every press as the finger made it, before anything can swallow it
    window.addEventListener('pointerdown', (e) => w.__downs.push(e.timeStamp), { capture: true })
    document.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement | null)?.closest?.('button')
      if (!b) return
      const label = b.getAttribute('aria-label') ?? ''
      w.__reached.push(label)
      if (label !== 'Send') return
      w.__sentAt = e.timeStamp
      // a phone too busy to handle the next tap for a while (load, a slow phone): the page does nothing else meanwhile
      const ms = w.__busyMs
      if (ms > 0)
        setTimeout(() => {
          const end = performance.now() + ms
          while (performance.now() < end) {}
        }, 0)
    })
    if (navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async () => {
        w.__mic++
        throw new DOMException('no microphone in this test', 'NotAllowedError')
      }
  })
}
const seen = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __reached: string[]; __mic: number; __sentAt: number; __downs: number[] }
    // how long after the Send press the last press began, by the events' own times
    return { reached: w.__reached, mic: w.__mic, gap: (w.__downs.at(-1) ?? 0) - w.__sentAt }
  })
const atSpot = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('button')?.getAttribute('aria-label'), [x, y])

/** Fills the box and returns the middle of Send. */
async function ready(page: Page) {
  await open(page)
  await box(page).fill('hello')
  const b = await send(page).boundingBox()
  if (!b) throw new Error('no Send')
  return [b.x + b.width / 2, b.y + b.height / 2] as const
}

async function pressAt(page: Page, isMobile: boolean, x: number, y: number) {
  if (isMobile) await page.touchscreen.tap(x, y)
  else await page.mouse.click(x, y)
}

// The gap is the test's wait after the first press; what counts is the gap the page saw between the two presses (their own
// timestamps), which load can stretch. Under the moment, nothing reaches either button. Past it, load made this a different
// case (a press after a freeze: the busy-page case below), and only the first press is checked.
for (const gap of [0, 80, 200, 400]) {
  test(`a second press on Send's spot ${gap} ms after the send reaches neither the call nor the mic`, async ({
    page,
    isMobile,
  }) => {
    const [x, y] = await ready(page)
    await pressAt(page, isMobile, x, y)
    await page.waitForTimeout(gap)
    await pressAt(page, isMobile, x, y)
    await expect(box(page)).toHaveValue('') // sent
    // the spot holds the call button (the cause): a press there is what used to start a call
    await expect.poll(() => atSpot(page, x, y)).toBe('Start a live call')
    await page.waitForTimeout(500)
    const s = await seen(page)
    if (s.gap < SEND_GUARD_MS) {
      expect(s.reached).toEqual(['Send'])
      expect(s.mic).toBe(0)
    } else {
      test.info().annotations.push({ type: 'load', description: `the presses were ${Math.round(s.gap)} ms apart` })
      expect(s.reached[0]).toBe('Send')
    }
  })
}

// Red at 18695c5e under load (~65): the moment was timed from the re-render and the second press judged by the clock when it
// was finally handled, so a tap that waited in the queue got through. Here the page is busy for 1.2 s right after the send:
// the second press, made 150 ms after the first, is handled only after that.
test('a second press made during the send but handled late, on a busy page, reaches neither', async ({
  page,
  isMobile,
}) => {
  const [x, y] = await ready(page)
  await page.evaluate(() => {
    ;(window as unknown as { __busyMs: number }).__busyMs = 1200
  })
  const first = Date.now()
  await pressAt(page, isMobile, x, y)
  await page.waitForTimeout(150)
  // the second press is made here (test clock: WebKit as Playwright drives it stamps a press only when the page handles it)
  const second = Date.now()
  await pressAt(page, isMobile, x, y)
  await expect(box(page)).toHaveValue('')
  await expect.poll(() => atSpot(page, x, y)).toBe('Start a live call')
  await page.waitForTimeout(300)
  const s = await seen(page)
  if (second - first >= SEND_GUARD_MS) {
    // load on the test's side delayed the second press itself past the moment: not this case
    test.info().annotations.push({ type: 'load', description: `the second press was made ${second - first} ms after` })
    return
  }
  expect(s.reached).toEqual(['Send'])
  expect(s.mic).toBe(0)
})

test('a key on the call button just after the send reaches nothing; a moment later it works', async ({
  page,
  isMobile,
}, info) => {
  test.skip(info.project.name === 'iphone', 'iOS Safari does not focus buttons from the keyboard')
  const [x, y] = await ready(page)
  const call = page.getByRole('button', { name: 'Start a live call', exact: true })
  const sentAt = Date.now()
  await pressAt(page, isMobile, x, y)
  await call.focus()
  const keyAt = Date.now()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  const s = await seen(page)
  if (keyAt - sentAt >= SEND_GUARD_MS) {
    test.info().annotations.push({ type: 'load', description: `the key came ${keyAt - sentAt} ms after the send` })
  } else {
    expect(s.reached).toEqual(['Send'])
    expect(s.mic).toBe(0)
  }
  await page.waitForTimeout(3200)
  await call.focus()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await seen(page)).reached.at(-1)).toBe('Start a live call')
})

// Past the moment and the few seconds the page watches for freezes, so load on the page cannot hold the press back
test('after the moment has passed, the call button works as before', async ({ page, isMobile }) => {
  const [x, y] = await ready(page)
  await pressAt(page, isMobile, x, y)
  await expect(box(page)).toHaveValue('')
  await page.waitForTimeout(3200)
  await pressAt(page, isMobile, x, y)
  await expect.poll(async () => (await seen(page)).reached).toEqual(['Send', 'Start a live call'])
})

test('Enter or Space on a focused Send leaves focus in the box, so a second key reaches neither button', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'iphone', 'iOS Safari does not Tab to buttons')
  for (const key of ['Enter', ' ']) {
    await open(page)
    await box(page).fill('hello')
    await send(page).focus()
    await page.keyboard.press(key)
    await expect(box(page)).toHaveValue('')
    await expect(box(page)).toBeFocused()
    await page.keyboard.press(key)
    await page.waitForTimeout(300)
    const s = await seen(page)
    expect(s.reached, key).toEqual(['Send'])
    expect(s.mic, key).toBe(0)
  }
})
