// A long thread on a slow phone: the picture of the page is given up after CAPTURE_LIMIT_MS (store.ts, 8 s) and the sheet says
// there is no picture, so Send never waits on it for long. Chromium is where this matters: it reads a drawn page back, so it
// copies the whole page, element by element (an iPhone cannot, and copies nothing: ios-readback.ts). The give-up is a timer,
// which only runs when the copy pauses: copying in slices of 40 ms lets it land, and its signal stops the copy. Before
// that, a 400-message thread at a tenth of the speed settled after 22 s (Titan, 2026-11-19); now about 9.6 s.
import { expect, type Page } from '@playwright/test'
import { test } from '../helpers/ios-readback.ts'

/** store.ts CAPTURE_LIMIT_MS: the spec runs in Node and does not import the app. */
const CAPTURE_LIMIT_MS = 8000
/**
 * What the give-up may take past its limit: the sheet's own first two frames (the timer starts after them) and the last slice,
 * at 10x slower, beside the other spec files' workers. Measured: 9.6-14.4 s from the tap (Titan, 2026-11-19); the old copy
 * took 22.4 s alone, so this bound still fails it by far, and is no stopwatch a busy machine can trip.
 */
const SLACK_MS = 10_000

async function longThread(page: Page, n: number) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate((count) => {
    const t = (
      window as unknown as { __talos: { store: { setState: (f: (s: Record<string, unknown>) => unknown) => void } } }
    ).__talos
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

test('a 400-message thread on a phone ten times slower: the picture is given up in time, and the sheet says so', async ({
  page,
  browserName,
}, info) => {
  test.skip(browserName !== 'chromium', 'Chromium copies the page (WebKit on a phone cannot: ios-readback.ts)')
  test.setTimeout(90_000)
  await longThread(page, 400)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 10 })
  try {
    const t0 = Date.now()
    await page.getByRole('button', { name: 'Report a bug' }).first().click()
    const pic = page.locator('[data-bug-reporter] [data-capture]')
    // given up, not finished: at a tenth of the speed this copy takes far longer than the limit, so "failed" in time is the
    // give-up landing (a copy that merely got faster would end "ok" and fail here)
    await expect(pic).toHaveAttribute('data-capture', 'failed', { timeout: CAPTURE_LIMIT_MS + SLACK_MS })
    const ms = Date.now() - t0
    info.annotations.push({ type: 'settled-ms', description: String(ms) })
    console.log(`[${info.project.name}] 400 messages at 10x: the picture was given up after ${ms} ms`)
    // the sheet says so, and works on without the picture: there to add one, or to send without
    const sheet = page.locator('[data-bug-reporter]')
    await expect(
      sheet.getByText("Couldn't take a picture of this screen.", { exact: false }).filter({ visible: true }),
    ).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Add a picture' })).toBeVisible()
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  }
})
