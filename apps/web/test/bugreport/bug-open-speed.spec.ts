// Report a bug opens at once (owner, 2026-11-15: on the iPhone it took 2-3 s and showed no picture, so he kept tapping). The sheet
// is up within a frame or two of the tap, with a "getting the screen" placeholder, and never waits on the capture; taps while it
// opens open nothing more. Where the browser cannot read back a drawn page (WebKit: the iPhone app, Safari, the Mac app), the
// sheet says so at once and offers Add a picture, instead of spending seconds copying the page for a picture it cannot keep.
import { expect, type Page } from '@playwright/test'
import { test } from '../helpers/ios-readback.ts'

type Talos = { store: { setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void } }

async function openThread(page: Page, n: number) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate((count) => {
    const t = (window as unknown as { __talos: Talos }).__talos
    t.store.setState((s) => ({
      messages: {
        ...((s.messages as Record<string, unknown[]>) ?? {}),
        general: Array.from({ length: count }, (_, i) => ({
          id: `m_seed_${i}`,
          thread_id: 'general',
          seq: 1000 + i,
          author: i % 2 ? 'owner' : 'agent',
          kind: 'text',
          text: `Sample message ${i}. ${'Long enough to wrap on a phone and fill the thread. '.repeat(3)}`,
          format: 'plain',
          attachments: [],
          via: 'app',
          created_at: new Date(Date.now() - (500 - i) * 1000).toISOString(),
        })),
      },
    }))
  }, n)
  await expect(page.getByTestId('timeline')).toBeVisible()
}

/**
 * From the tap to the sheet being in the page, measured inside the page: how many frames the page drew first (0: it was there
 * at once), the milliseconds (for the log only: a loaded machine stretches every frame), and what the picture was at that
 * moment ("capturing", or the Annotator's ok / failed).
 */
const timeToSheet = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ ms: number; frames: number; picture: string }>((resolve) => {
        const btn = Array.from(document.querySelectorAll('button')).find(
          (b) => b.getAttribute('aria-label') === 'Report a bug' || b.textContent?.trim() === 'Report a bug',
        ) as HTMLButtonElement
        const t0 = performance.now()
        let frames = 0
        btn.click()
        const tick = () => {
          const sheet = document.querySelector('[data-bug-reporter]')
          if (!sheet) {
            frames++
            requestAnimationFrame(tick)
            return
          }
          const picture = sheet.querySelector('[data-testid="bug-capturing"]')
            ? 'capturing'
            : (sheet.querySelector('[data-capture]')?.getAttribute('data-capture') ?? 'none')
          resolve({ ms: performance.now() - t0, frames, picture })
        }
        tick()
      }),
  )

test('one tap: the sheet is up at once, extra taps open nothing more, and the picture follows or the sheet says why', async ({
  page,
}, info) => {
  await openThread(page, 120)
  const { ms, frames, picture } = await timeToSheet(page)
  info.annotations.push({ type: 'time-to-sheet-ms', description: String(Math.round(ms)) })
  console.log(`[${info.project.name}] time to sheet: ${Math.round(ms)} ms, ${frames} frame(s), picture ${picture}`)
  // "at once" in what the page does, not in a stopwatch that load stretches (a 120-message thread under a CPU burner took
  // 200-1300 ms with the sheet still in the first frame): within a frame or two of the tap, and before the picture is
  // ready, so the sheet never waited on the capture (the 2-3 s the owner saw, 2026-11-15). Where the browser cannot read
  // the page back (WebKit), the sheet may say so in its first frame: "failed" then, never "ok".
  expect(frames).toBeLessThanOrEqual(2)
  expect(picture).not.toBe('ok')
  await expect(page.locator('[data-bug-reporter]')).toHaveCount(1)
  // the picture, or the plain "no picture" with Add a picture, settles on its own
  const pic = page.locator('[data-bug-reporter] [data-capture]')
  await expect(pic).toHaveAttribute('data-capture', /ok|failed/, { timeout: 15_000 })
  const how = await pic.getAttribute('data-capture')
  console.log(`[${info.project.name}] capture: ${how}`)
  info.annotations.push({ type: 'capture', description: String(how) })
  await expect(
    page
      .locator('[data-bug-reporter]')
      .getByRole('button', { name: how === 'ok' ? 'Use another picture' : 'Add a picture' }),
  ).toBeVisible()
})

// a 2 x 2 red PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
)

test('Add a picture: one from the photo library or a file becomes the picture to mark up', async ({ page }) => {
  await openThread(page, 5)
  await timeToSheet(page)
  const sheet = page.locator('[data-bug-reporter]')
  await expect(sheet.locator('[data-capture]')).toHaveAttribute('data-capture', /ok|failed/, { timeout: 15_000 })
  await sheet.getByTestId('bug-picture-input').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG })
  await expect(sheet.locator('[data-capture]')).toHaveAttribute('data-capture', 'ok')
  const size = await sheet.getByTestId('bug-canvas').evaluate((c) => {
    const el = c as HTMLCanvasElement
    return [el.width, el.height]
  })
  expect(size).toEqual([2, 2])
  await expect(sheet.getByRole('button', { name: 'Use another picture' })).toBeVisible()
})

test('nothing below the picture moves when it lands (a fast tap on Preview stays on Preview)', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, 'the phone layout: the picture sits above the Preview row')
  await openThread(page, 120)
  await timeToSheet(page)
  const sheet = page.locator('[data-bug-reporter]')
  const preview = sheet.getByRole('button', { name: 'Preview' })
  await expect(preview).toBeVisible()
  const before = (await preview.boundingBox())?.y ?? -1
  await expect(sheet.locator('[data-capture]')).toHaveAttribute('data-capture', /ok|failed/, { timeout: 15_000 })
  const after = (await preview.boundingBox())?.y ?? -2
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2)
})
