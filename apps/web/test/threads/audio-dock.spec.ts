// D37: audio follows him out of the thread. Real production build, real relay harness, real <audio> (silent WAV, so
// nothing is audible). Leaving the thread is a client-side route change: the same page, no reload.
import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import { newId } from '@talos-app/protocol'
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

const dock = (page: Page) => page.locator('#talos-audio-dock')
const state = (page: Page) =>
  dock(page).evaluate((a: HTMLAudioElement) => ({
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
  await expect(page.getByText(/Your Mac is offline/)).toBeVisible()
  const { mkFrame } = await import('@talos-app/testkit')
  harness.relay.sendToApps(
    mkFrame('presence', { bridge_online: true, last_seen: new Date().toISOString(), queue_depth: 0 }),
  )
  await expect(page.getByText(/Your Mac is offline/)).toHaveCount(0)
}

test('a long note keeps playing and keeps its place after he leaves the thread; a reload resumes it', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context, '/t/general')
  await online(harness, page)
  const files = new Map<string, Buffer>()
  await serveRanges(page, files)
  const id = note(harness, files, 60)
  const row = page.getByTestId('voice-note')
  await expect(row).toBeVisible()
  await expect(page.getByTestId('now-playing')).toHaveCount(0) // nothing loaded, no pill

  await row.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(async () => (await state(page)).t, { timeout: 15_000 }).toBeGreaterThan(1.2)

  await goHome(page)
  const pill = page.getByTestId('now-playing')
  await expect(pill).toBeVisible()
  const t1 = (await state(page)).t
  await expect.poll(async () => (await state(page)).t, { timeout: 15_000 }).toBeGreaterThan(t1 + 0.5)
  expect((await state(page)).paused).toBe(false) // still playing, no thread mounted

  // the pill pauses; the spot is saved at once
  await pill.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect.poll(async () => (await state(page)).paused).toBe(true)
  const spot = (await saved(page)).find((e) => e[0] === id)?.[1] ?? 0
  expect(spot).toBeGreaterThan(1)

  // tap the title: back in the thread, the row is a view of the same player
  await pill.getByTestId('now-playing-open').click()
  await expect(page).toHaveURL(/\/t\/general$/)
  await expect(page.getByTestId('voice-note').getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  // reload: nothing is loaded any more, and play picks up where he left it
  await page.reload()
  await expect(page.getByTestId('now-playing')).toHaveCount(0)
  await online(harness, page)
  await page.getByTestId('voice-note').getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(async () => (await state(page)).t, { timeout: 15_000 }).toBeGreaterThan(spot - 0.5)
  expect((await state(page)).t).toBeLessThan(spot + 10)
})

test('the next note plays after he has left the thread', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context, '/t/general')
  await online(harness, page)
  const files = new Map<string, Buffer>()
  await serveRanges(page, files)
  note(harness, files, 3)
  const second = note(harness, files, 20)
  await expect(page.getByTestId('voice-note')).toHaveCount(2)
  await page.getByTestId('voice-note').first().getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(async () => (await state(page)).t, { timeout: 15_000 }).toBeGreaterThan(0.3)
  await goHome(page)
  // the first note ends on its own; no row exists to hand over to the second
  await expect.poll(async () => (await state(page)).src, { timeout: 20_000 }).toContain(second)
  await expect.poll(async () => (await state(page)).paused, { timeout: 10_000 }).toBe(false)
  await expect(page.getByTestId('now-playing')).toBeVisible()
})

test('a note that will not load says so in the pill after he has left the thread', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context, '/t/general')
  await online(harness, page)
  note(harness, new Map(), 10, null) // the relay has no such file
  const row = page.getByTestId('voice-note')
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Play', exact: true }).click()
  await goHome(page)
  await expect(page.getByTestId('now-playing-failed')).toBeVisible({ timeout: 10_000 })
})
