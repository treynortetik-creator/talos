// One-tap dictation in the real app (fake mode) at phone width, in both themes, by keyboard, with the failed and kept states.
// The recorder and microphone are stand-ins (a browser here has no microphone); the page, the buttons, focus and layout are real.
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

const PHONE = { width: 390, height: 844 }

// The service worker would keep the POST that page.route is meant to answer.
test.use({ serviceWorkers: 'block' })

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(PHONE)
  await page.addInitScript(() => {
    class FakeRecorder {
      static isTypeSupported = () => true
      state = 'inactive'
      ondataavailable: ((e: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      addEventListener() {}
      start() {
        this.state = 'recording'
      }
      requestData() {}
      pause() {}
      resume() {}
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['audio-bytes'], { type: 'audio/webm' }) })
        queueMicrotask(() => this.onstop?.())
      }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeRecorder })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    })
  })
})

async function open(page: Page, colorScheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme })
  await page.goto('/t/general')
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  await page.evaluate(() => {
    const s = (window as unknown as { __talosSession: { setState(p: unknown): void } }).__talosSession
    s.setState({
      status: 'authed',
      me: {
        device_pinned: true,
        has_passkey: true,
        rp_id: 'x',
        version: '1',
        bridge_online: true,
        dictate: { available: true },
      },
    })
  })
  await expect(page.getByTestId('dictate')).toBeVisible()
}

const activeLabel = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement
    return a ? (a.getAttribute('aria-label') ?? a.textContent ?? a.tagName) : 'none'
  })

/** Records for a moment (until the timer shows more than the stray-tap limit) and taps stop. */
async function recordAndStop(page: Page) {
  await page.getByTestId('dictate').click()
  await expect(page.getByTestId('dictate-recording')).toContainText(/0:0[1-9]/)
  await page.getByRole('button', { name: 'Stop dictating' }).click()
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`${colorScheme}: the three voice buttons are distinct, whole, and fit at 390 px`, async ({ page }, info) => {
    await open(page, colorScheme)
    const names = ['Dictate', 'Record a voice note', 'Start a live call']
    // The live-call button is a lazy chunk (Suspense, no fallback), so it can mount after the other two and shift them left.
    // Reading the boxes one at a time across that mount made two of them look stacked. Wait for all three, then measure
    // only once two reads a frame apart agree.
    for (const n of names) await expect(page.getByRole('button', { name: n })).toBeVisible()
    const readBoxes = () =>
      Promise.all(names.map((n) => page.getByRole('button', { name: n }).boundingBox())).then((bs) =>
        JSON.stringify(bs),
      )
    await expect
      .poll(
        async () => {
          const a = await readBoxes()
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
          return a === (await readBoxes())
        },
        { message: 'the three voice buttons settle' },
      )
      .toBe(true)
    const boxes = []
    for (const n of names) {
      const b = await page.getByRole('button', { name: n }).boundingBox()
      expect(b, n).not.toBeNull()
      boxes.push(b as NonNullable<typeof b>)
    }
    for (const b of boxes) {
      expect(b.width).toBeGreaterThanOrEqual(40)
      expect(b.height).toBeGreaterThanOrEqual(40)
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width)
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i] as (typeof boxes)[0]
        const b = boxes[j] as (typeof boxes)[0]
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(
          true,
        )
      }
    await page.screenshot({
      path: info.outputPath(`buttons-${colorScheme}.png`),
      clip: { x: 0, y: PHONE.height - 140, ...{ width: 390, height: 140 } },
    })
    await expectAxeClean(page)
  })

  test(`${colorScheme}: a failed dictation keeps the recording, focus lands on Try again, and the other buttons are off`, async ({
    page,
  }, info) => {
    await open(page, colorScheme)
    await page.route('**/api/dictate', (r) =>
      r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream_unreachable"}' }),
    )
    await recordAndStop(page)
    const strip = page.getByTestId('dictate-failed')
    await expect(strip).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeFocused()
    expect(await activeLabel(page)).toBe('Try again')
    for (const n of ['Dictate', 'Record a voice note', 'Start a live call'])
      await expect(page.getByRole('button', { name: n })).toBeDisabled()
    const s = await strip.boundingBox()
    expect(s?.x).toBeGreaterThanOrEqual(0)
    expect((s?.x ?? 0) + (s?.width ?? 0)).toBeLessThanOrEqual(PHONE.width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width)
    await page.screenshot({ path: info.outputPath(`failed-${colorScheme}.png`) })
    await expectAxeClean(page)
    await page.getByRole('button', { name: 'Discard' }).click()
    await expect(strip).toBeHidden()
    await expect(page.getByRole('button', { name: 'Dictate' })).toBeEnabled()
  })
}

test('by keyboard: Enter starts and stops, the words land at the end, and focus ends in the box on a computer, not on touch', async ({
  page,
}) => {
  await open(page, 'light')
  await page.route('**/api/dictate', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"text":"spoken words"}' }),
  )
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill('typed first')
  await page.getByTestId('dictate').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('dictate-recording')).toContainText(/0:0[1-9]/)
  await page.getByRole('button', { name: 'Stop dictating' }).focus()
  await page.keyboard.press('Enter')
  await expect(box).toHaveValue('typed first spoken words')
  // The composer's rule: the refocus is skipped on touch (Safari, Home Screen), where it can pop the keyboard.
  const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (touch) await expect(box).not.toBeFocused()
  else await expect(box).toBeFocused()
  await expect(page.getByTestId('dictate-done')).toBeVisible()
  await box.fill('')
  await expect(page.getByTestId('dictate-done')).toBeHidden()
})

test('loading: the working line shows while the relay is slow, and the buttons are off', async ({ page }) => {
  await open(page, 'light')
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  await page.route('**/api/dictate', async (r) => {
    await gate
    await r.fulfill({ status: 200, contentType: 'application/json', body: '{"text":"late"}' })
  })
  await recordAndStop(page)
  await expect(page.getByTestId('dictate-working')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start a live call' })).toBeDisabled()
  release()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('late')
})
