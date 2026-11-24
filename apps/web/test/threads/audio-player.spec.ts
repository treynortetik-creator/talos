// Message audio plays from the message's own player and nowhere else (the floating now-playing bar is gone). These specs
// drive the real production build with a real <audio> (silent WAV) and assert real element state: paused, currentTime,
// src, playbackRate, and the button the owner sees. They run on the WebKit [iphone] project, where the bug reports came from.
import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import { newId } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { expect, test } from '../helpers/fixtures.ts'
import type { Harness } from '../helpers/harness.ts'
import { agentReply, openSignedIn } from '../helpers/util.ts'

// A service worker would answer the media requests past the Range route below.
test.use({ serviceWorkers: 'block' })

/** 8 kHz, 8-bit mono silence. */
function wav(seconds: number): Buffer {
  const n = 8000 * seconds
  const b = Buffer.alloc(44 + n, 128)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(8000, 24)
  b.writeUInt32LE(8000, 28)
  b.writeUInt16LE(1, 32)
  b.writeUInt16LE(8, 34)
  b.write('data', 36)
  b.writeUInt32LE(n, 40)
  return b
}

/** The test relay answers every GET with a plain 200 and WebKit will not play that, so serve Range like the real relay does. */
async function serveRanges(page: Page, files: Map<string, Buffer>, delayMs = 0) {
  await page.route(/\/media\/md_[0-9A-Z]{26}(\?.*)?$/, async (route) => {
    const req = route.request()
    const id = /\/media\/(md_[0-9A-Z]{26})/.exec(req.url())?.[1] ?? ''
    const bytes = files.get(id)
    if (req.method() !== 'GET' || !bytes) return route.fallback()
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers().range ?? '')
    const start = m?.[1] ? Number(m[1]) : 0
    const end = m?.[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1
    return route.fulfill({
      status: m ? 206 : 200,
      headers: {
        'content-type': 'audio/wav',
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        ...(m ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}),
      },
      body: bytes.subarray(start, end + 1),
    })
  })
}

function note(harness: Harness, files: Map<string, Buffer>, seconds: number): string {
  const media_id = newId('md')
  const bytes = wav(seconds)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  harness.relay.media.set(media_id, { bytes, sha256, mime: 'audio/wav' })
  files.set(media_id, bytes)
  harness.relay.sendToApps(
    agentReply({
      text: '',
      attachments: [
        {
          media_id,
          kind: 'voice_note',
          role: 'attachment',
          mime: 'audio/wav',
          name: `${media_id}.wav`,
          size: bytes.length,
          sha256,
          duration_ms: seconds * 1000,
        },
      ],
    }),
  )
  return media_id
}

type El = { paused: boolean; t: number; src: string; rate: number }
/** Every <audio> in the page. Probes (never played) are paused at 0, so they never look like playback. */
const els = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('audio')].map((a) => ({
      paused: a.paused,
      t: a.currentTime,
      src: a.getAttribute('src') ?? '',
      rate: a.playbackRate,
    })),
  ) as Promise<El[]>
const running = async (page: Page) => (await els(page)).filter((e) => !e.paused)
/** The one element that is playing, or null. More than one is itself a failure. */
async function playingSrc(page: Page): Promise<string | null> {
  const r = await running(page)
  expect(r.length).toBeLessThanOrEqual(1)
  return r[0]?.src ?? null
}
const timeOf = async (page: Page, id: string) =>
  Math.max(0, ...(await els(page)).filter((e) => e.src.includes(id)).map((e) => e.t))

async function setup(
  harness: Harness,
  page: Page,
  context: Parameters<typeof openSignedIn>[2],
  notes = 2,
  delayMs = 0,
) {
  await openSignedIn(harness, page, context, '/t/general')
  await expect(page.getByText(/Your computer is offline/)).toBeVisible()
  const { mkFrame } = await import('@talos-app/testkit')
  harness.relay.sendToApps(
    mkFrame('presence', { bridge_online: true, last_seen: new Date().toISOString(), queue_depth: 0 }),
  )
  await expect(page.getByText(/Your computer is offline/)).toHaveCount(0)
  const files = new Map<string, Buffer>()
  await serveRanges(page, files, delayMs)
  const ids = Array.from({ length: notes }, () => note(harness, files, 30))
  await expect(page.getByTestId('voice-note')).toHaveCount(notes)
  const rows = page.getByTestId('voice-note')
  return {
    ids,
    row: (i: number) => rows.nth(i),
    play: (i: number) => rows.nth(i).getByRole('button', { name: 'Play', exact: true }),
    pause: (i: number) => rows.nth(i).getByRole('button', { name: 'Pause', exact: true }),
  }
}

test('no floating now-playing bar, ever, while a clip plays', async ({ page, context, harness }) => {
  test.setTimeout(t(120_000))
  const s = await setup(harness, page, context, 1)
  await s.play(0).click()
  await expect.poll(() => timeOf(page, s.ids[0] as string), { timeout: t(15_000) }).toBeGreaterThan(0.5)
  await expect(page.getByTestId('now-playing')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Now playing' })).toHaveCount(0)
  // one Pause button on screen: the message's own
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(1)
})

test('play, pause, play again: five times, the clip moves each time and the button follows', async ({
  page,
  context,
  harness,
}) => {
  test.setTimeout(t(120_000))
  const s = await setup(harness, page, context, 1)
  const a = s.ids[0] as string
  let last = -1
  for (let i = 0; i < 5; i++) {
    await s.play(0).click()
    await expect(s.pause(0)).toBeVisible()
    await expect
      .poll(() => timeOf(page, a), { timeout: t(15_000), message: `round ${i}: currentTime advances` })
      .toBeGreaterThan(last + 0.3)
    expect(await playingSrc(page)).toContain(a)
    await s.pause(0).click()
    await expect(s.play(0)).toBeVisible()
    await expect.poll(async () => (await running(page)).length, { message: `round ${i}: paused for real` }).toBe(0)
    last = await timeOf(page, a)
  }
})

test('play A, then B, then A: only one plays, the other row shows Play, and A resumes', async ({
  page,
  context,
  harness,
}) => {
  test.setTimeout(t(120_000))
  const s = await setup(harness, page, context, 2)
  const [a, b] = s.ids as [string, string]
  await s.play(0).click()
  await expect.poll(() => timeOf(page, a), { timeout: t(15_000) }).toBeGreaterThan(0.5)

  await s.play(1).click()
  await expect.poll(async () => await playingSrc(page), { timeout: t(15_000) }).toContain(b)
  await expect.poll(() => timeOf(page, b), { timeout: t(15_000) }).toBeGreaterThan(0.3)
  await expect(s.pause(1)).toBeVisible()
  await expect(s.play(0)).toBeVisible() // A's own button is back to Play

  const aWas = await timeOf(page, a)
  await s.play(0).click()
  await expect.poll(async () => await playingSrc(page), { timeout: t(15_000) }).toContain(a)
  await expect.poll(() => timeOf(page, a), { timeout: t(15_000) }).toBeGreaterThan(aWas + 0.3)
  await expect(s.play(1)).toBeVisible()
})

test('2x stays 2x through pause, play and a second file', async ({ page, context, harness }) => {
  test.setTimeout(t(120_000))
  const s = await setup(harness, page, context, 2)
  const [a, b] = s.ids as [string, string]
  const speed = s.row(0).getByRole('button', { name: /Playback speed/ })
  for (let i = 0; i < 4; i++) await speed.click()
  await expect(speed).toHaveText('2×')

  await s.play(0).click()
  await expect.poll(async () => (await running(page))[0]?.rate, { timeout: t(15_000) }).toBe(2)
  await s.pause(0).click()
  await s.play(0).click()
  await expect.poll(() => timeOf(page, a), { timeout: t(15_000) }).toBeGreaterThan(0.5)
  expect((await running(page))[0]?.rate).toBe(2)

  await s.play(1).click()
  await expect.poll(async () => await playingSrc(page), { timeout: t(15_000) }).toContain(b)
  await expect.poll(async () => (await running(page))[0]?.rate).toBe(2)
  await expect(s.row(1).getByRole('button', { name: /Playback speed/ })).toHaveText('2×')
})

test('the page going to the background and coming back leaves play and pause working', async ({
  page,
  context,
  harness,
}) => {
  test.setTimeout(t(120_000))
  const s = await setup(harness, page, context, 1)
  const a = s.ids[0] as string
  await s.play(0).click()
  await expect.poll(() => timeOf(page, a), { timeout: t(15_000) }).toBeGreaterThan(0.5)
  const hide = async (state: 'hidden' | 'visible') =>
    page.evaluate((v) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => v === 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      if (v === 'hidden') dispatchEvent(new Event('pagehide'))
      else dispatchEvent(new Event('pageshow'))
    }, state)
  await hide('hidden')
  await hide('visible')
  // either it kept playing or the button says Play: the button and the element must agree
  const isPlaying = (await running(page)).length === 1
  await expect(isPlaying ? s.pause(0) : s.play(0)).toBeVisible()

  if (isPlaying) await s.pause(0).click()
  await expect(s.play(0)).toBeVisible()
  await expect.poll(async () => (await running(page)).length).toBe(0)
  const before = await timeOf(page, a)
  await s.play(0).click()
  await expect.poll(() => timeOf(page, a), { timeout: t(15_000) }).toBeGreaterThan(before + 0.3)
  await expect(s.pause(0)).toBeVisible()
})

test('slow network: tap play, pause before it loads, play again, then another file', async ({
  page,
  context,
  harness,
}) => {
  test.setTimeout(t(120_000))
  const s = await setup(harness, page, context, 3, 600)
  const [a, b] = s.ids as [string, string]
  await s.play(0).click()
  await s.pause(0).click()
  await s.play(0).click()
  await expect.poll(() => timeOf(page, a), { timeout: t(20_000) }).toBeGreaterThan(0.5)
  expect(await playingSrc(page)).toContain(a)
  await s.play(1).click()
  await s.pause(1).click()
  await s.play(1).click()
  await expect.poll(() => timeOf(page, b), { timeout: t(20_000) }).toBeGreaterThan(0.5)
  expect(await playingSrc(page)).toContain(b)
  await expect(s.play(0)).toBeVisible()
})

test('a thread of notes holds no probe media elements once each has its length', async ({ page, context, harness }) => {
  test.setTimeout(t(120_000))
  const s = await setup(harness, page, context, 6)
  // every row had a probe; each lets go of its file after answering, so only the shared player element remains
  await expect.poll(() => page.locator('audio[data-probe]').count(), { timeout: t(15_000) }).toBe(0)
  const withFile = await page.evaluate(
    () => [...document.querySelectorAll('audio')].filter((a) => a.hasAttribute('src')).length,
  )
  expect(withFile).toBe(0)
  // and the lengths are still on the rows
  await expect(s.row(0)).toContainText('0:30')
  await s.play(3).click()
  await expect.poll(() => timeOf(page, s.ids[3] as string), { timeout: t(15_000) }).toBeGreaterThan(0.3)
  expect((await running(page)).length).toBe(1)
})

test('pause the instant it starts, then play again: eight times, it always moves', async ({
  page,
  context,
  harness,
}) => {
  test.setTimeout(t(120_000))
  // WebKit can take a pause in the first instants of a clip and then sit at 0:00 "playing" for good; one run in five did on
  // origin/main. Eight rounds make a miss near-certain without the restart (the spec is not flaky with it: a stuck start is
  // restarted by the player within a couple of seconds).
  const s = await setup(harness, page, context, 1)
  const a = s.ids[0] as string
  for (let i = 0; i < 8; i++) {
    await s.play(0).click()
    await expect(s.pause(0)).toBeVisible()
    await s.pause(0).click()
    await expect(s.play(0)).toBeVisible()
    await s.play(0).click()
    await expect(s.pause(0)).toBeVisible()
    // WebKit may report a position up to a second earlier after a restart than the one it paused at: measure from here
    const from = await timeOf(page, a)
    await expect
      .poll(() => timeOf(page, a), { timeout: t(20_000), message: `round ${i}: the clip moves after pause and play` })
      .toBeGreaterThan(from + 0.4)
    await s.pause(0).click()
    await expect.poll(async () => (await running(page)).length).toBe(0)
  }
})
