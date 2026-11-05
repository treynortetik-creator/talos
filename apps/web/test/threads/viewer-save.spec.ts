import { expect, type Page, test } from '@playwright/test'

// Fake mode (VITE_FAKE=1). Audit L15: the image viewer has Download (browser) / Share (iPhone shell). It is a real link to the
// file under its own name: a browser downloads it; in an iPhone shell of an older build the navigation lands on relay /media/,
// which the shell opens in its native viewer (MediaPolicy.classify sends images there; unit-tested in BridgeGuard); a current
// shell build gets the native share message instead (attachment-share.spec).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

// headDelayMs holds the media gate's HEAD check, to put the viewer in its "Checking…" state on purpose.
async function openViewer(page: Page, headStatus = 200, headDelayMs = 0) {
  await page.route('**/media/**', async (r) => {
    if (r.request().method() !== 'HEAD') return r.fulfill({ status: 200, contentType: 'image/png', body: PNG })
    if (headDelayMs) await new Promise((done) => setTimeout(done, headDelayMs))
    return r.fulfill({ status: headStatus, body: '' })
  })
  await page.goto('/t/general')
  await page.getByRole('button', { name: 'Attach' }).click()
  await page.locator('input[type=file][accept="image/*"]:not([capture])').setInputFiles({
    name: 'ramp.png',
    mimeType: 'image/png',
    buffer: PNG,
  })
  await page.getByRole('button', { name: 'Send' }).click()
  const thumb = page.getByRole('button', { name: 'Open image ramp.png' })
  await expect(thumb).toBeVisible()
  await thumb.click()
  await expect(page.getByTestId('image-viewer')).toBeVisible()
}

test('the viewer offers Download / Share: a thumb tall, inside the screen, and saves the file under its own name', async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    if (matchMedia('(pointer: coarse)').matches) {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
      Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {} })
    }
  })
  await openViewer(page)
  const save = page.getByTestId('viewer-save')
  await expect(save).toHaveText(info.project.name === 'desktop' ? 'Download' : 'Share')
  await expect(save).toHaveAttribute('href', /\/media\/md_[0-9A-Z]+/)
  await expect(save).toHaveAttribute('download', 'ramp.png')
  const box = (await save.boundingBox()) as { x: number; y: number; width: number; height: number }
  const vp = page.viewportSize() as { width: number; height: number }
  expect(box.height).toBeGreaterThanOrEqual(43)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  if (info.project.name === 'desktop') {
    const [download] = await Promise.all([page.waitForEvent('download'), save.click()])
    expect(download.suggestedFilename()).toBe('ramp.png')
  }
})

test('when the relay dropped the image the viewer offers to fetch it instead of a link that lands on a 410', async ({
  page,
}) => {
  await openViewer(page, 410)
  const save = page.getByTestId('viewer-save')
  await expect(save).toHaveText('Get ramp.png')
  await expect(save).not.toHaveAttribute('href', /.*/)
})

test('by keyboard: Tab reaches Save, Escape closes the viewer and focus goes back to the thumbnail', async ({
  page,
}) => {
  // The media gate checks the file with a HEAD before it turns Save from a disabled "Checking…" button into the real link; a
  // disabled button is not in the tab order. Hold the check open for a moment so that state is always on screen first, then
  // wait for the link itself (its href), not just for something with the test id, before walking the real tab order.
  await openViewer(page, 200, 400)
  const save = page.getByTestId('viewer-save')
  await expect(save).toBeDisabled()
  await expect(save).toHaveAttribute('href', /\/media\/md_[0-9A-Z]+/)
  let reached = false
  for (let i = 0; i < 4 && !reached; i++) {
    await page.keyboard.press('Tab')
    reached = await save.evaluate((el) => el === document.activeElement)
  }
  expect(reached, 'Tab reached Save within 4 presses').toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('image-viewer')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open image ramp.png' })).toBeFocused()
})

test('inside the iPhone shell the control says Share, keeps its /media link, and posts the native message', async ({
  page,
}) => {
  await page.addInitScript(() => {
    ;(window as unknown as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {},
    }
    ;(window as unknown as Record<string, unknown>).__posted = []
    ;(window as unknown as Record<string, unknown>).webkit = {
      messageHandlers: {
        talosShareMedia: {
          postMessage: (m: unknown) => (window as unknown as { __posted: unknown[] }).__posted.push(m),
        },
      },
    }
  })
  await openViewer(page)
  await expect(page.getByTestId('viewer-save')).toHaveText('Share')
  await expect(page.getByTestId('viewer-save')).toHaveAttribute('href', /\/media\/md_/)
  await expect(page.getByTestId('viewer-save')).toHaveAttribute('download', 'ramp.png')
  await page.getByTestId('viewer-save').click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted))
    .toEqual([{ path: expect.stringMatching(/^\/media\/md_[0-9A-Z]+$/), name: 'ramp.png', mime: 'image/png' }])
})

test('an older iPhone shell (no native handler) keeps the plain /media link, which its native viewer opens', async ({
  page,
}) => {
  await page.addInitScript(() => {
    ;(window as unknown as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {},
    }
  })
  await openViewer(page)
  await expect(page.getByTestId('viewer-save')).toHaveAttribute('href', /\/media\/md_/)
  await expect(page.getByTestId('viewer-save')).toHaveText('Open')
})

for (const scheme of ['light', 'dark'] as const) {
  test(`Save is readable on the dark backdrop in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await openViewer(page)
    await expect(page.getByTestId('viewer-save')).toHaveAttribute('href', /\/media\//)
    const colors = await page.getByTestId('viewer-save').evaluate((el) => {
      const s = getComputedStyle(el)
      return { color: s.color, bg: s.backgroundColor }
    })
    expect(colors.color).toBe('rgb(255, 255, 255)')
    expect(colors.bg).not.toBe('rgba(0, 0, 0, 0)')
  })
}
