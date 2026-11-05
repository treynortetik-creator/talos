import { deflateSync } from 'node:zlib'
import { expect, type Page, test } from '@playwright/test'

// Fake mode (VITE_FAKE=1). Screenshots land in test/threads/shots/<project>-viewer-*.png for the PR.
const shot = (name: string, project: string) => `test/threads/shots/${project}-viewer-${name}.png`

function crc32(buf: Buffer) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** 600x400 PNG: diagonal colour ramp with a dark grid, so zoom and pan are visible in a screenshot. */
function png(w = 600, h = 400) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      const grid = x % 50 === 0 || y % 50 === 0
      raw[o] = grid ? 20 : (x * 255) / w
      raw[o + 1] = grid ? 20 : (y * 255) / h
      raw[o + 2] = grid ? 20 : 180
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.writeUInt8(8, 8)
  ihdr.writeUInt8(2, 9)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function openImage(page: Page) {
  await page.route('**/media/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png() }))
  await page.goto('/t/general')
  await page.getByRole('button', { name: 'Attach' }).click()
  await page.locator('input[type=file][accept="image/*"]:not([capture])').setInputFiles({
    name: 'ramp.png',
    mimeType: 'image/png',
    buffer: png(),
  })
  await page.getByRole('button', { name: 'Send' }).click()
  const thumb = page.getByRole('button', { name: 'Open image ramp.png' })
  await expect(thumb).toBeVisible()
  await expect(thumb.locator('img')).toHaveJSProperty('complete', true)
  const inline = (await thumb.locator('img').boundingBox()) as { width: number; height: number }
  await thumb.click()
  const img = page.getByTestId('image-viewer').locator('img')
  await expect(img).toHaveAttribute('data-zoom', '1')
  return { thumb, img, inline }
}
const zoomOf = async (page: Page) =>
  Number(await page.getByTestId('image-viewer').locator('img').getAttribute('data-zoom'))
const stage = (page: Page) => page.getByTestId('image-stage')

test('opens fitted to ~92% of the viewport, far larger than the inline image', async ({ page }, info) => {
  const { img, inline } = await openImage(page)
  const vp = page.viewportSize() as { width: number; height: number }
  const box = (await img.boundingBox()) as { x: number; y: number; width: number; height: number }
  // At least 2x the inline thumbnail, or as much of the screen as 92% allows on a phone; never smaller than inline.
  expect(box.width).toBeGreaterThan(inline.width)
  expect(box.width).toBeGreaterThanOrEqual(Math.min(inline.width * 2, vp.width * 0.9) - 1)
  expect(box.height).toBeGreaterThan(inline.height)
  const fitW = box.width / vp.width
  const fitH = box.height / vp.height
  expect(Math.max(fitW, fitH)).toBeGreaterThan(0.9)
  expect(Math.max(fitW, fitH)).toBeLessThan(0.93)
  expect(Math.abs(box.width / box.height - 1.5)).toBeLessThan(0.02) // aspect kept
  await page.screenshot({ path: shot('fit', info.project.name) })
})

test('wheel zooms about the cursor, clamps at fit and 8x, ctrl+wheel (pinch) zooms, drag pans', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'mouse wheel and drag')
  const { img } = await openImage(page)
  const b0 = (await img.boundingBox()) as { x: number; y: number; width: number; height: number }
  const cursor = { x: b0.x + b0.width * 0.75, y: b0.y + b0.height * 0.25 }
  // The image point under the cursor, in image-fraction terms, must not move while zooming.
  await page.mouse.move(cursor.x, cursor.y)
  await page.mouse.wheel(0, -400)
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(1.5)
  const b1 = (await img.boundingBox()) as typeof b0
  expect((cursor.x - b1.x) / b1.width).toBeCloseTo(0.75, 1)
  expect((cursor.y - b1.y) / b1.height).toBeCloseTo(0.25, 1)
  await page.screenshot({ path: shot('wheel-zoomed', info.project.name) })
  // pinch gesture on a trackpad arrives as wheel + ctrlKey
  const before = await zoomOf(page)
  await stage(page).evaluate((el) =>
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -30,
        ctrlKey: true,
        clientX: 700,
        clientY: 400,
        bubbles: true,
        cancelable: true,
      }),
    ),
  )
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(before)
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -2000)
  await expect.poll(() => zoomOf(page)).toBe(8)
  // drag pans
  const p0 = (await img.boundingBox()) as typeof b0
  await page.mouse.move(700, 400)
  await page.mouse.down()
  await page.mouse.move(640, 360, { steps: 5 })
  await page.mouse.up()
  const p1 = (await img.boundingBox()) as typeof b0
  expect(Math.round(p1.x - p0.x)).toBe(-60)
  expect(Math.round(p1.y - p0.y)).toBe(-40)
  await expect(page.getByTestId('image-viewer')).toBeVisible() // a drag never closes it
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 3000)
  await expect.poll(() => zoomOf(page)).toBe(1)
})

test('double-click toggles fit and 2x; keys + - 0; Escape closes and returns focus to the image', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'mouse and keyboard')
  const { thumb, img } = await openImage(page)
  await img.dblclick()
  await expect.poll(() => zoomOf(page)).toBe(2)
  await img.dblclick()
  await expect.poll(() => zoomOf(page)).toBe(1)
  await page.keyboard.press('+')
  await expect.poll(() => zoomOf(page)).toBeCloseTo(1.25, 2)
  await page.keyboard.press('-')
  await expect.poll(() => zoomOf(page)).toBe(1)
  await page.keyboard.press('+')
  await page.keyboard.press('+')
  await page.keyboard.press('0')
  await expect.poll(() => zoomOf(page)).toBe(1)
  // focus stays trapped inside the dialog
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('image-viewer')).toHaveCount(0)
  await expect(thumb).toBeFocused()
})

test('click outside the image closes it', async ({ page }) => {
  test.skip(page.viewportSize()?.width === undefined, '')
  await openImage(page)
  await stage(page).click({ position: { x: 5, y: 300 } })
  await expect(page.getByTestId('image-viewer')).toHaveCount(0)
})

test('touch: pinch zooms and pans, double-tap toggles, page behind does not scroll, tap outside closes', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'desktop', 'touch projects')
  const { img } = await openImage(page)
  const vp = page.viewportSize() as { width: number; height: number }
  const cx = vp.width / 2
  const cy = vp.height / 2
  // Fake touch ids that no browser reserves. Id 1 is WebKit's real mouse pointer, which Playwright parks on the thumbnail: a
  // trusted pointermove with id 1 landing mid-gesture overwrote the fake finger in the viewer's pointer map (pinch 1.07, pan clamped to 0).
  const FINGER_1 = 11
  const FINGER_2 = 12
  const FINGER_3 = 13
  const fire = (type: string, id: number, x: number, y: number) =>
    stage(page).evaluate(
      (el, a) =>
        el.dispatchEvent(
          new PointerEvent(a.type, {
            pointerId: a.id,
            pointerType: 'touch',
            clientX: a.x,
            clientY: a.y,
            bubbles: true,
            cancelable: true,
            isPrimary: a.primary,
          }),
        ),
      { type, id, x, y, primary: id === FINGER_1 },
    )
  await fire('pointerdown', FINGER_1, cx - 40, cy)
  await fire('pointerdown', FINGER_2, cx + 40, cy)
  await fire('pointermove', FINGER_1, cx - 100, cy)
  await fire('pointermove', FINGER_2, cx + 100, cy)
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(2)
  await page.screenshot({ path: shot('pinch', info.project.name) })
  await fire('pointerup', FINGER_1, cx - 100, cy)
  await fire('pointerup', FINGER_2, cx + 100, cy)
  // one finger pans the zoomed image
  const a = (await img.boundingBox()) as { x: number; y: number }
  await fire('pointerdown', FINGER_3, cx, cy)
  await fire('pointermove', FINGER_3, cx - 30, cy - 20)
  await fire('pointerup', FINGER_3, cx - 30, cy - 20)
  const b = (await img.boundingBox()) as { x: number; y: number }
  expect(Math.round(b.x - a.x)).toBe(-30)
  // double-tap on the image returns to fit
  await img.evaluate((el) => {
    const mk = (t: string) =>
      new PointerEvent(t, { pointerId: 9, pointerType: 'touch', clientX: 200, clientY: 300, bubbles: true })
    for (let i = 0; i < 2; i++) {
      el.dispatchEvent(mk('pointerdown'))
      el.dispatchEvent(mk('pointerup'))
    }
  })
  await expect.poll(() => zoomOf(page)).toBe(1)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  await stage(page).click({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('image-viewer')).toHaveCount(0)
})

test('reduced motion: no transform transition', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one project is enough')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const { img } = await openImage(page)
  await img.dblclick()
  await expect.poll(() => zoomOf(page)).toBe(2)
  expect(await img.evaluate((el) => (el as HTMLElement).style.transition)).toMatch(/none/)
})
