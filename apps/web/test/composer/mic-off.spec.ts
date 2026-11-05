// The voice note mic is really off while dictation holds the microphone: a real tap or hold on it (pointer input at its
// coordinates, not .click(), which refuses disabled buttons) must not open a second recorder, move the composer, or send.
import { expect, type Locator, type Page, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

const PHONE = { width: 390, height: 844 }

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
    const w = window as unknown as { __gum: number }
    w.__gum = 0
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeRecorder })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          w.__gum++
          return { getTracks: () => [] }
        },
      },
    })
  })
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
})

const gum = (page: Page) => page.evaluate(() => (window as unknown as { __gum: number }).__gum)
const msgs = (page: Page) => page.locator('[data-msg-id]').count()

async function center(l: Locator) {
  const b = await l.boundingBox()
  if (!b) throw new Error('no box')
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** Real input at the mic: a touch tap where the device has touch, a short click and a long hold with the mouse. */
async function hammerMic(page: Page, touch: boolean) {
  const { x, y } = await center(page.getByTestId('mic'))
  if (touch) await page.touchscreen.tap(x, y)
  await page.mouse.click(x, y)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.waitForTimeout(450)
  await page.mouse.up()
  await page.mouse.click(x, y)
}

async function expectUntouched(page: Page, gumBefore: number, msgsBefore: number) {
  await page.waitForTimeout(300)
  expect(await gum(page), 'no second microphone request').toBe(gumBefore)
  await expect(page.getByTestId('recorder-locked')).toHaveCount(0)
  await expect(page.getByTestId('mic')).not.toHaveClass(/scale-125/)
  expect(await msgs(page), 'nothing sent').toBe(msgsBefore)
}

const states = {
  dictating: async (page: Page) => {
    await page.getByTestId('dictate').click()
    await expect(page.getByTestId('dictate-recording')).toBeVisible()
  },
  transcribing: async (page: Page) => {
    await page.route('**/api/dictate', async () => {
      await new Promise(() => {}) // never answers: stays transcribing
    })
    await page.getByTestId('dictate').click()
    await expect(page.getByTestId('dictate-recording')).toContainText(/0:0[1-9]/)
    await page.getByRole('button', { name: 'Stop dictating' }).click()
    await expect(page.getByTestId('dictate-working')).toBeVisible()
  },
  kept: async (page: Page) => {
    await page.route('**/api/dictate', (r) =>
      r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream_unreachable"}' }),
    )
    await page.getByTestId('dictate').click()
    await expect(page.getByTestId('dictate-recording')).toContainText(/0:0[1-9]/)
    await page.getByRole('button', { name: 'Stop dictating' }).click()
    await expect(page.getByTestId('dictate-failed')).toBeVisible()
  },
} as const

for (const [name, enter] of Object.entries(states)) {
  test(`${name}: a real tap or hold on the voice note mic does nothing`, async ({ page, hasTouch }) => {
    await enter(page)
    const g = await gum(page)
    const m = await msgs(page)
    await hammerMic(page, hasTouch)
    await expectUntouched(page, g, m)
    await expect(page.getByTestId('mic')).toBeDisabled()
    await expect(page.getByTestId('mic')).toHaveCSS('opacity', '0.4') // a visible off state
  })
}
