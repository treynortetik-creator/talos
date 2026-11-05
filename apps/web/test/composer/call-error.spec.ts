// The failed-call line in the real app (fake mode), at phone width, with the keyboard up, in both themes. The microphone
// is refused so the real call button produces a real error. The line must never sit on the working row or its Stop
// button, and it must go away.
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { keyboard } from '../helpers/keyboard.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

type Fake = {
  sent: Array<Record<string, unknown>>
  store: { setState(p: unknown): void; getState(): { statuses: Record<string, unknown> } }
  session: { patch(p: Record<string, unknown>): void }
}
const fake = <T>(page: Page, fn: (t: Fake) => T) => page.evaluate(`(${fn.toString()})(window.__talos)`) as Promise<T>

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const md = {
      getUserMedia: () => Promise.reject(Object.assign(new Error('refused'), { name: 'NotAllowedError' })),
    }
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: md })
  })
})

// Only the `iphone` project is WebKit, which does not Tab onto buttons by default on macOS.
const tabReachesButtons = (project: string) => project !== 'iphone'

async function working(page: Page) {
  await page.goto('/t/general')
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  await fake(page, (t) => {
    t.store.setState({
      ...t.store.getState(),
      statuses: { general: { thread_id: 'general', state: 'working', since: new Date().toISOString() } },
    })
    t.session.patch({ busy: true, turn_id: 'turn_7' })
  })
  const row = page.getByTestId('working-row')
  await expect(row.getByRole('button', { name: 'Stop' })).toBeVisible()
}

const box = async (loc: ReturnType<Page['locator']>) => {
  const b = await loc.boundingBox()
  if (!b) throw new Error('no box')
  return b
}
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

for (const colorScheme of ['light', 'dark'] as const) {
  test(`${colorScheme}: the error never covers the working row or Stop, with the keyboard up, and Stop still works`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme })
    await working(page)
    await keyboard(page, 300)
    await page.getByRole('button', { name: 'Start a live call' }).click()
    const line = page.getByTestId('call-error')
    await expect(line).toBeVisible()
    await expect(line).toContainText('Allow the microphone to start a call.')

    const row = page.getByTestId('working-row')
    const stop = row.getByRole('button', { name: 'Stop' })
    const [l, r, s] = [await box(line), await box(row), await box(stop)]
    expect(overlaps(l, r), 'error line on the working row').toBe(false)
    expect(overlaps(l, s), 'error line on Stop').toBe(false)
    // nothing is on top of Stop at its centre
    const top = await stop.evaluate((el) => {
      const b = el.getBoundingClientRect()
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === el
    })
    expect(top, 'something covers Stop').toBe(true)
    // the line itself is inside the visible window
    const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    expect(l.x).toBeGreaterThanOrEqual(0)
    expect(l.x + l.width).toBeLessThanOrEqual(vp.w)
    expect(l.y + l.height).toBeLessThanOrEqual(vp.h)

    await expectAxeClean(page)
    await stop.click()
    await expect.poll(() => fake(page, (t) => t.sent.filter((f) => f.action === 'stop').length)).toBe(1)
  })
}

test('tapping the line dismisses it and leaves focus in the box (the keyboard stays up)', async ({ page }) => {
  await working(page)
  await page.getByRole('button', { name: 'Start a live call' }).click()
  const line = page.getByTestId('call-error')
  await expect(line).toBeVisible()
  const box = page.locator('.composer-box')
  await box.click()
  await box.fill('half a thought')
  await line.getByRole('button').click()
  await expect(line).toHaveCount(0)
  await expect(box).toBeFocused()
  await expect(box).toHaveValue('half a thought')
})

test('by keyboard: Tab reaches the line, Enter dismisses it, focus is not lost', async ({ page }, info) => {
  await page.goto('/t/general')
  await page.getByRole('button', { name: 'Start a live call' }).focus()
  await page.keyboard.press('Enter')
  const line = page.getByTestId('call-error')
  await expect(line).toBeVisible()
  const dismiss = line.getByRole('button')
  if (tabReachesButtons(info.project.name)) {
    // focus was dropped when the composer swapped to the call bar and back; walk the page with Tab until the line has it
    let reached = false
    for (let i = 0; i < 25 && !reached; i++) {
      await page.keyboard.press('Tab')
      reached = await dismiss.evaluate((el) => el === document.activeElement)
    }
    expect(reached, 'Tab never reached the error line').toBe(true)
  } else {
    // WebKit on macOS skips buttons when tabbing (a Safari setting, not the app): focus the line directly, then it must
    // still be a real button that Enter activates.
    await dismiss.focus()
    await expect(dismiss).toBeFocused()
  }
  await page.keyboard.press('Enter')
  await expect(line).toHaveCount(0)
  const where = await page.evaluate(
    () => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
  )
  expect(where, 'focus fell to the page').not.toBe('BODY')
  await expect(page.getByRole('button', { name: 'Start a live call' })).toBeFocused()
})

test('by keyboard: Space also dismisses the line after focusing it directly', async ({ page }) => {
  await page.goto('/t/general')
  await page.getByRole('button', { name: 'Start a live call' }).focus()
  await page.keyboard.press('Enter')
  const line = page.getByTestId('call-error')
  await expect(line).toBeVisible()
  await line.getByRole('button').focus()
  await page.keyboard.press('Space')
  await expect(line).toHaveCount(0)
})

test('the error fades by itself', async ({ page }) => {
  await page.clock.install()
  await page.goto('/t/general')
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  await page.getByRole('button', { name: 'Start a live call' }).click()
  await expect(page.getByTestId('call-error')).toBeVisible()
  await page.clock.runFor(11_000)
  await expect(page.getByTestId('call-error')).toHaveCount(0)
})

test('a long error wraps inside the phone width instead of running off the screen', async ({ page }) => {
  await page.goto('/t/general')
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  // the daily-cap message comes from the relay and can be any length
  await page.route('**/api/voice/session', (route) =>
    route.fulfill({
      status: 429,
      json: { message: `Today's live-voice limit is used up. ${'Come back tomorrow. '.repeat(8)}` },
    }),
  )
  // getUserMedia must succeed to reach the relay
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve(new MediaStream()) },
    })
  })
  await page.getByRole('button', { name: 'Start a live call' }).click()
  const line = page.getByTestId('call-error')
  await expect(line).toContainText('Come back tomorrow.')
  const l = await box(line)
  const vp = await page.evaluate(() => window.innerWidth)
  expect(l.x).toBeGreaterThanOrEqual(0)
  expect(l.x + l.width).toBeLessThanOrEqual(vp)
})
