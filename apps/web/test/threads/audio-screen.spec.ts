// Message audio and the screen it plays on. Real production build, real relay harness, real <audio> (silent WAV, so nothing is
// audible). There is no floating player: a clip plays from its message and stops when he leaves the thread (a client-side
// route change: the same page, no reload).
import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import { newId } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { expect, test } from '../helpers/fixtures.ts'
import type { Harness } from '../helpers/harness.ts'
import { agentReply, openSignedIn } from '../helpers/util.ts'

// A service worker would answer the media requests after a reload, past the Range route below.
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

/**
 * WebKit will not play media from a server that ignores `Range`, and Chromium reports an unknown length until it has the
 * whole file. The test relay answers every GET with a plain 200, so the spec serves ranges itself, from the bytes it put there.
 */
async function serveRanges(page: Page, files: Map<string, Buffer>) {
  await page.route(/\/media\/md_[0-9A-Z]{26}(\?.*)?$/, async (route) => {
    const req = route.request()
    const id = /\/media\/(md_[0-9A-Z]{26})/.exec(req.url())?.[1] ?? ''
    const bytes = files.get(id)
    if (req.method() !== 'GET' || !bytes) return route.fallback()
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

/** A voice note in the thread. `bytes: null` means the relay does not have the file. */
function note(harness: Harness, files: Map<string, Buffer>, seconds: number, bytes: Buffer | null = wav(seconds)) {
  const media_id = newId('md')
  const sha256 = createHash('sha256')
    .update(bytes ?? '')
    .digest('hex')
  if (bytes) {
    harness.relay.media.set(media_id, { bytes, sha256, mime: 'audio/wav' })
    files.set(media_id, bytes)
  }
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
          size: bytes?.length ?? 1,
          sha256,
          duration_ms: seconds * 1000,
        },
      ],
    }),
  )
  return media_id
}

/** A browser with no Media Session API (nothing outside the page could stop a clip). */
const noMediaSession = () => {
  Object.defineProperty(Navigator.prototype, 'mediaSession', { value: undefined, configurable: true })
}

const player = (page: Page) => page.locator('#talos-audio')
const state = (page: Page) =>
  player(page).evaluate((a: HTMLAudioElement) => ({
    paused: a.paused,
    t: a.currentTime,
    src: a.getAttribute('src') ?? '',
  }))
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('talos.audio.pos') ?? '[]') as Array<[string, number, number]>)

/** Leaving the thread without a reload: the router's own history. */
const goHome = async (page: Page) => {
  await page.evaluate(() => {
    history.pushState({}, '', '/')
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByTestId('thread-screen')).toHaveCount(0)
}

async function online(harness: Harness, page: Page) {
  await expect(page.getByText(/Your computer is offline/)).toBeVisible()
  const { mkFrame } = await import('@talos-app/testkit')
  harness.relay.sendToApps(
    mkFrame('presence', { bridge_online: true, last_seen: new Date().toISOString(), queue_depth: 0 }),
  )
  await expect(page.getByText(/Your computer is offline/)).toHaveCount(0)
}

test('WITH system controls (Media Session) a clip keeps playing when he leaves the thread, and its message shows Pause when he returns', async ({
  page,
  context,
  harness,
}) => {
  test.setTimeout(t(120_000))
  await openSignedIn(harness, page, context, '/t/general')
  await online(harness, page)
  const files = new Map<string, Buffer>()
  await serveRanges(page, files)
  note(harness, files, 60)
  const row = page.getByTestId('voice-note')
  await row.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(async () => (await state(page)).t, { timeout: t(15_000) }).toBeGreaterThan(1.2)
  // the lock screen / Control Center / media keys can stop it, so leaving does not
  expect(await page.evaluate(() => typeof navigator.mediaSession?.setActionHandler)).toBe('function')
  await goHome(page)
  const at = (await state(page)).t
  await expect.poll(async () => (await state(page)).t, { timeout: t(15_000) }).toBeGreaterThan(at + 0.5)
  expect((await state(page)).paused).toBe(false)
  await expect(page.getByTestId('now-playing')).toHaveCount(0) // still no floating player
  // back in the thread, the message's own button is the control
  await page.evaluate(() => {
    history.pushState({}, '', '/t/general')
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByTestId('voice-note').getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await page.getByTestId('voice-note').getByRole('button', { name: 'Pause', exact: true }).click()
  await expect.poll(async () => (await state(page)).paused).toBe(true)
})

test('WITHOUT system controls (no Media Session) a clip stops when he leaves the thread, keeps its place, and a reload resumes it', async ({
  page,
  context,
  harness,
}) => {
  test.setTimeout(t(120_000))
  await page.addInitScript(noMediaSession)
  await openSignedIn(harness, page, context, '/t/general')
  await online(harness, page)
  const files = new Map<string, Buffer>()
  await serveRanges(page, files)
  const id = note(harness, files, 60)
  const row = page.getByTestId('voice-note')
  await expect(row).toBeVisible()
  await expect(page.getByTestId('now-playing')).toHaveCount(0) // there is no floating player

  await row.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(async () => (await state(page)).t, { timeout: t(15_000) }).toBeGreaterThan(1.2)
  await expect(page.getByTestId('now-playing')).toHaveCount(0)

  await goHome(page)
  // nothing is left playing with no message on screen to stop it
  await expect.poll(async () => (await state(page)).paused).toBe(true)
  expect((await state(page)).src).toBe('')
  await expect(page.getByTestId('now-playing')).toHaveCount(0)
  const spot = (await saved(page)).find((e) => e[0] === id)?.[1] ?? 0
  expect(spot).toBeGreaterThan(1)

  // reload: play picks up where he left it
  await page.goto('/t/general')
  await online(harness, page)
  await page.getByTestId('voice-note').getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(async () => (await state(page)).t, { timeout: t(15_000) }).toBeGreaterThan(spot - 0.5)
  expect((await state(page)).t).toBeLessThan(spot + 10)
})

test('the next note plays on after the first ends, from the message list', async ({ page, context, harness }) => {
  test.setTimeout(t(120_000))
  await openSignedIn(harness, page, context, '/t/general')
  await online(harness, page)
  const files = new Map<string, Buffer>()
  await serveRanges(page, files)
  note(harness, files, 3)
  const second = note(harness, files, 20)
  await expect(page.getByTestId('voice-note')).toHaveCount(2)
  await page.getByTestId('voice-note').first().getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(async () => (await state(page)).t, { timeout: t(15_000) }).toBeGreaterThan(0.3)
  // the first note ends on its own; the second starts without another tap
  await expect.poll(async () => (await state(page)).src, { timeout: t(20_000) }).toContain(second)
  await expect.poll(async () => (await state(page)).paused, { timeout: t(10_000) }).toBe(false)
  await expect(page.getByTestId('voice-note').nth(1).getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
})

test('a note that will not load says so in its own row, not in a floating bar', async ({ page, context, harness }) => {
  test.setTimeout(t(120_000))
  await openSignedIn(harness, page, context, '/t/general')
  await online(harness, page)
  note(harness, new Map(), 10, null) // the relay has no such file
  const row = page.getByTestId('voice-note')
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByTestId('now-playing')).toHaveCount(0)
  await expect(row.getByRole('button', { name: 'Play', exact: true })).toBeVisible() // it did not start
  // the row's own status line (loading it back from the Mac, then the failure), never silence
  await expect(row.locator('[data-testid^="media-"]')).toBeVisible({ timeout: t(10_000) })
})
