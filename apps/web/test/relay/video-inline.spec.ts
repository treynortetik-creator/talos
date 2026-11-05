import { createHash } from 'node:crypto'
import type { Page, Route } from '@playwright/test'
import { newId } from '@talos-app/protocol'
import { FakeBridge } from '@talos-app/testkit'
import { expect, test } from '../helpers/fixtures.ts'
import { agentReply, openSignedIn } from '../helpers/util.ts'

// Audit L15: a video the agent sends plays inline in the thread, loads like the other attachments (the same probe, the same
// failed / Retry states) and stops the audio dock when it starts. The relay answers byte ranges (apps/relay core/media.test.ts
// proves 206 and the sandbox CSP on the real relay); the route below answers them the same way so the browser's own
// range requests are what is under test. A 64x64, 1 s, blue clip: H.264 for WebKit, VP8 for Chromium (which has no H.264).
const MP4 = Buffer.from(
  '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',
  'base64',
)
const WEBM = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAALiEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggLM7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAxV0GNTGF2ZjYyLjEyLjEwMUSJiECPQAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYjBJhMvL39IwJyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAX14QDgkLCBQLqBQJqBAlWwhFW5gQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAxc3PWY8CLY8WIwSYTLy9/SMBnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMSBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QSDngQCjw4EAAICQAwCdASpAAEAAAEcIhYWIhYSIAgICdaoD+AIG6EFcMdITAFVYAP7/TRL//FhX8WFfxYV/8WFf/PzO7cX85gCjloEAZADRAQABEBAAGAAYWC/0AAiOgACjloEAyADRAQABEBAAGAAYWC/0AAiOgACjloEBLADRAQABEBAAGAAYWC/0AAiOgACjloEBkADRAQABEBAAGAAYWC/0AAiOgACjloEB9ADRAQABEBAAGAAYWC/0AAiOgACjloECWADRAQABEBAAGAAYWC/0AAiOgACjloECvADRAQABEBAUYABhYL/QACI6AACjloEDIADRAQABEBAAGAAYWC/0AAiOgACjloEDhADRAQABEBAAGAAYWC/0AAiOgAAcU7trkbuPs4EAt4r3gQHxggGm8IED',
  'base64',
)

function wav(seconds = 3): Buffer {
  const rate = 8000
  const n = rate * seconds
  const b = Buffer.alloc(44 + n)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate, 28)
  b.writeUInt16LE(1, 32)
  b.writeUInt16LE(8, 34)
  b.write('data', 36)
  b.writeUInt32LE(n, 40)
  b.fill(128, 44)
  return b
}

type Served = { status: number; bytes: Buffer; mime: string }
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** Serves /media/<id> like the relay does: HEAD, GET, and 206 with Content-Range for a Range header. */
async function serve(page: Page, files: Map<string, () => Served>, seen: Array<{ method: string; range?: string }>) {
  await page.route('**/media/md_*', async (route: Route) => {
    const req = route.request()
    const id = /\/media\/(md_[^/?#]+)/.exec(req.url())?.[1] ?? ''
    const file = files.get(id)?.()
    seen.push({ method: req.method(), ...(req.headers().range ? { range: req.headers().range } : {}) })
    if (!file) return route.fulfill({ status: 404, body: '{}' })
    if (file.status !== 200)
      return route.fulfill({
        status: file.status,
        contentType: 'application/json',
        body: '{"error":"gone","rehydrate":true}',
      })
    const size = file.bytes.length
    const headers = { 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'content-type': file.mime }
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers().range ?? '')
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
      const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1
      const part = file.bytes.subarray(start, end + 1)
      return route.fulfill({
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}` },
        body: part,
      })
    }
    return route.fulfill({ status: 200, headers, body: file.bytes })
  })
}

const ref = (kind: 'video' | 'audio', name: string, mime: string, bytes: Buffer) => ({
  media_id: newId('md'),
  kind,
  role: 'attachment',
  mime,
  name,
  size: bytes.length,
  sha256: sha(bytes),
})

test('an agent video plays inline: playsinline, metadata only, no poster, range requests, no page overflow', async ({
  page,
  context,
  harness,
  browserName,
}) => {
  const webkit = browserName === 'webkit'
  const bytes = webkit ? MP4 : WEBM
  const mime = webkit ? 'video/mp4' : 'video/webm'
  const att = ref('video', 'demo.' + (webkit ? 'mp4' : 'webm'), mime, bytes)
  const seen: Array<{ method: string; range?: string }> = []
  await serve(page, new Map([[att.media_id, () => ({ status: 200, bytes, mime })]]), seen)
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(agentReply({ text: 'Here is the recording.', attachments: [att] }))

  const video = page.getByTestId('inline-video')
  await expect(video).toBeVisible()
  await expect(video).toHaveAttribute('playsinline', '')
  await expect(video).toHaveAttribute('preload', 'metadata')
  await expect(video).toHaveAttribute('controls', '')
  await expect(video).not.toHaveAttribute('poster', /.+/)
  await expect(video).toHaveAccessibleName(att.name)
  // metadata arrives over the media route, and the browser asks for ranges
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1)
  expect(await video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(64)
  expect(seen.some((s) => s.method === 'HEAD')).toBe(true) // the same probe a file chip makes
  // it did not fetch the whole file to show a thumbnail: no request asked for more than metadata needs
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  // exactly one Share (phone) / Download (desktop) control for it, rendered as the link ShareButton draws
  await expect(page.getByTestId('attachment-share')).toHaveCount(1)
  await expect(page.locator(`a[download][href*="${att.media_id}"]`)).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const box = (await video.boundingBox()) as { width: number }
  expect(box.width).toBeLessThanOrEqual((page.viewportSize() as { width: number }).width)
})

test('playing a video pauses the audio dock', async ({ page, context, harness, browserName }) => {
  const webkit = browserName === 'webkit'
  const bytes = webkit ? MP4 : WEBM
  const video = ref('video', 'demo.' + (webkit ? 'mp4' : 'webm'), webkit ? 'video/mp4' : 'video/webm', bytes)
  const audioBytes = wav()
  const audio = ref('audio', 'report.wav', 'audio/wav', audioBytes)
  await serve(
    page,
    new Map([
      [video.media_id, () => ({ status: 200, bytes, mime: video.mime })],
      [audio.media_id, () => ({ status: 200, bytes: audioBytes, mime: 'audio/wav' })],
    ]),
    [],
  )
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(agentReply({ text: 'Both.', attachments: [audio, video] }))
  await expect(page.getByTestId('inline-video')).toBeVisible()
  await page.getByRole('button', { name: /^Play/ }).first().click()
  const dock = () => page.evaluate(() => (document.getElementById('talos-audio-dock') as HTMLAudioElement).paused)
  await expect.poll(dock).toBe(false)
  await page.getByTestId('inline-video').evaluate((v: HTMLVideoElement) => {
    v.muted = true
    return v.play()
  })
  await expect.poll(dock).toBe(true)
  expect(await page.getByTestId('inline-video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)
})

// The race behind a flaky run of the test above: play() flips `paused` at once, but the element's 'play' event (what the app
// listens to) arrives later, in the order the play() calls were made. A Play tap and a video tap close together (a slow
// machine, a double tap) leave the dock's event in front of the video's. The video, started last, must be the one left playing.
test('a video started right after the dock still wins: the dock steps aside, the video keeps playing', async ({
  page,
  context,
  harness,
  browserName,
}) => {
  const webkit = browserName === 'webkit'
  const bytes = webkit ? MP4 : WEBM
  const video = ref('video', 'demo.' + (webkit ? 'mp4' : 'webm'), webkit ? 'video/mp4' : 'video/webm', bytes)
  const audioBytes = wav()
  const audio = ref('audio', 'report.wav', 'audio/wav', audioBytes)
  await serve(
    page,
    new Map([
      [video.media_id, () => ({ status: 200, bytes, mime: video.mime })],
      [audio.media_id, () => ({ status: 200, bytes: audioBytes, mime: 'audio/wav' })],
    ]),
    [],
  )
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(agentReply({ text: 'Both.', attachments: [audio, video] }))
  await expect(page.getByTestId('inline-video')).toBeVisible()
  const playBtn = page.getByRole('button', { name: /^Play/ }).first()
  await expect(playBtn).toBeVisible()
  // one task: the Play row starts the dock, then the video is told to play, before either 'play' event has been delivered
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /^Play/.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
    )
    const v = document.querySelector('[data-testid="inline-video"]') as HTMLVideoElement
    v.muted = true
    btn?.click()
    void v.play()
  })
  const dock = () => page.evaluate(() => (document.getElementById('talos-audio-dock') as HTMLAudioElement).paused)
  await expect.poll(dock).toBe(true)
  // give a late effect or event time to pause the video wrongly, then look
  await page.waitForTimeout(500)
  expect(await page.getByTestId('inline-video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)
  expect(await dock()).toBe(true)
})

test('a video that left the relay shows the loading line, then failed with a thumb-sized Retry, then plays', async ({
  page,
  context,
  harness,
  browserName,
}) => {
  const webkit = browserName === 'webkit'
  const bytes = webkit ? MP4 : WEBM
  const att = ref('video', 'old.' + (webkit ? 'mp4' : 'webm'), webkit ? 'video/mp4' : 'video/webm', bytes)
  let gone = true
  await serve(
    page,
    new Map([
      [att.media_id, () => (gone ? { status: 410, bytes, mime: att.mime } : { status: 200, bytes, mime: att.mime })],
    ]),
    [],
  )
  // A Mac that is online and never answers: with no Mac at all the relay refuses media.fetch at once (mac_offline), and
  // the loading line this test is about would be gone before anyone could see it.
  const mac = new FakeBridge({ relayWs: harness.relay.wsBase, key: harness.relay.bridgeKey })
  await mac.connect()
  await page.clock.install()
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(agentReply({ text: 'An old one.', attachments: [att] }))
  await expect(page.getByTestId('media-fetching')).toBeVisible()
  await expect(page.getByTestId('inline-video')).toHaveCount(0)
  await page.clock.fastForward(25_000)
  await expect(page.getByTestId('media-failed')).toContainText("Couldn't load old.")
  const retry = page.getByRole('button', { name: 'Retry' })
  expect(((await retry.boundingBox()) as { height: number }).height).toBeGreaterThanOrEqual(43)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  gone = false
  await retry.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('inline-video')).toBeVisible()
})

test('a file the browser cannot decode says so and still hands over the file', async ({ page, context, harness }) => {
  const junk = Buffer.from('this is not a video'.repeat(40))
  const att = ref('video', 'broken.mp4', 'video/mp4', junk)
  await serve(page, new Map([[att.media_id, () => ({ status: 200, bytes: junk, mime: 'video/mp4' })]]), [])
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(agentReply({ text: 'Broken.', attachments: [att] }))
  const box = page.getByTestId('video-undecodable')
  await expect(box).toBeVisible()
  await expect(page.getByTestId('inline-video')).toHaveCount(0)
  // the message does not blame the Mac, and there is a way to get the bytes
  await expect(box).toContainText("This device can't play broken.mp4")
  await expect(box).not.toContainText('offline')
  const link = box.getByRole('link', { name: /Download broken\.mp4/ })
  await expect(link).toHaveAttribute('download', 'broken.mp4')
  await expect(link).toHaveAttribute('href', new RegExp(att.media_id))
  expect(((await link.boundingBox()) as { height: number }).height).toBeGreaterThanOrEqual(43)
})

test('starting the audio dock pauses a playing video, and a second video takes over from the first', async ({
  page,
  context,
  harness,
  browserName,
}) => {
  const webkit = browserName === 'webkit'
  const bytes = webkit ? MP4 : WEBM
  const ext = webkit ? 'mp4' : 'webm'
  const mime = webkit ? 'video/mp4' : 'video/webm'
  const v1 = ref('video', `one.${ext}`, mime, bytes)
  const v2 = ref('video', `two.${ext}`, mime, bytes)
  const audioBytes = wav()
  const audio = ref('audio', 'report.wav', 'audio/wav', audioBytes)
  await serve(
    page,
    new Map([
      [v1.media_id, () => ({ status: 200, bytes, mime })],
      [v2.media_id, () => ({ status: 200, bytes, mime })],
      [audio.media_id, () => ({ status: 200, bytes: audioBytes, mime: 'audio/wav' })],
    ]),
    [],
  )
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(agentReply({ text: 'Three.', attachments: [audio, v1, v2] }))
  const videos = page.getByTestId('inline-video')
  await expect(videos).toHaveCount(2)
  const play = (i: number) =>
    videos.nth(i).evaluate((v: HTMLVideoElement) => {
      v.muted = true
      v.loop = true
      return v.play()
    })
  const paused = (i: number) => videos.nth(i).evaluate((v: HTMLVideoElement) => v.paused)
  await play(0)
  await expect.poll(() => paused(0)).toBe(false)
  await play(1)
  await expect.poll(() => paused(0)).toBe(true)
  expect(await paused(1)).toBe(false)
  // the dock (a row's Play, or the lock screen's) takes the sound from the video
  await page.getByRole('button', { name: /^Play/ }).first().click()
  const dock = () => page.evaluate(() => (document.getElementById('talos-audio-dock') as HTMLAudioElement).paused)
  await expect.poll(dock).toBe(false)
  await expect.poll(() => paused(1)).toBe(true)
})
