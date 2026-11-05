// Adversarial review of PR #43 (V2 WP-V3, driving mode, web). Every test here drives the real web client in fake mode
// (VITE_FAKE=1) through the same seams as test/drive/drive.spec.ts: the fake client's store, the signed frames it
// records, the real /drive screen, the real queue and its one <audio data-testid="drive-audio">. Browser APIs Playwright
// cannot exercise (speechSynthesis, MediaRecorder, Wake Lock, Media Session) are replaced by recording stubs.
// Each test names the finding it proves (F-numbers).
import { expect, type Page, test } from '@playwright/test'

type Fake = {
  sent: Array<Record<string, unknown>>
  failNextPatchWith(code: string): void
  patchConfig(patch: unknown, opts?: unknown): Promise<void>
  store: {
    setState(fn: (s: Record<string, unknown>) => Record<string, unknown>): void
    getState(): Record<string, unknown>
  }
}
type Probe = {
  spoken: Array<{ text: string; audioPlaying: boolean; recording: boolean; at: number }>
  speechCancels: number
  speechPauses: number
  audioContexts: number
  audioPlayTargets: HTMLMediaElement[]
  recording: boolean
  wake: { granted: number; released: number }
  msHandlers: Record<string, (() => void) | null>
}
const probe = <T>(page: Page, fn: (p: Probe, t: Fake) => T) =>
  page.evaluate(`(${fn.toString()})(window.__probe, window.__talos)`) as Promise<T>

/** 8 kHz 8-bit silence. */
function wav(seconds: number): Buffer {
  const n = 8000 * seconds
  const b = Buffer.alloc(44 + n, 0x80)
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

/** Recording stubs for every browser API driving mode touches. Installed before the app loads. */
async function instrument(page: Page, opts: { wakeGrantMs?: number } = {}) {
  await page.route('**/media/md_bad*', (r) => r.fulfill({ status: 404, body: 'gone' }))
  // WebKit loads media with Range requests; answering them with a plain 200 makes the load fail now and then (error
  // code 4) under CI load. A real server answers 206, so the stub does too.
  await page.route('**/media/md_ok*', (r) => {
    const body = wav(4)
    const m = /bytes=(\d*)-(\d*)/.exec(r.request().headers().range ?? '')
    if (!m) return r.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'Accept-Ranges': 'bytes' }, body })
    const start = m[1] ? Number(m[1]) : 0
    const end = Math.min(m[2] ? Number(m[2]) : body.length - 1, body.length - 1)
    return r.fulfill({
      status: 206,
      contentType: 'audio/wav',
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` },
      body: body.subarray(start, end + 1),
    })
  })
  await page.addInitScript(
    ({ wakeGrantMs }) => {
      const p = {
        spoken: [] as Array<{ text: string; audioPlaying: boolean; recording: boolean; at: number }>,
        speechCancels: 0,
        speechPauses: 0,
        audioContexts: 0,
        audioPlayTargets: [] as HTMLMediaElement[],
        recording: false,
        wake: { granted: 0, released: 0 },
        msHandlers: {} as Record<string, (() => void) | null>,
      }
      ;(window as unknown as { __probe: typeof p }).__probe = p
      const driveAudioPlaying = () => {
        const a = document.querySelector('[data-testid="drive-audio"]') as HTMLAudioElement | null
        return !!a && !a.paused && !a.ended
      }
      // speechSynthesis: records what was said and what else was going on at that moment.
      class U {
        text: string
        constructor(t: string) {
          this.text = t
        }
      }
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: U, configurable: true })
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          speaking: false,
          speak(u: { text: string }) {
            p.spoken.push({ text: u.text, audioPlaying: driveAudioPlaying(), recording: p.recording, at: Date.now() })
            this.speaking = true
          },
          cancel() {
            p.speechCancels++
            this.speaking = false
          },
          pause() {
            p.speechPauses++
          },
          resume() {},
        },
      })
      // Web Audio: count every AudioContext, real or webkit-prefixed.
      class FakeCtx {
        constructor() {
          p.audioContexts++
        }
        createAnalyser() {
          return { fftSize: 512, getByteTimeDomainData() {} }
        }
        createMediaStreamSource() {
          return { connect() {} }
        }
        close() {
          return Promise.resolve()
        }
      }
      Object.defineProperty(window, 'AudioContext', { value: FakeCtx, configurable: true, writable: true })
      Object.defineProperty(window, 'webkitAudioContext', { value: FakeCtx, configurable: true, writable: true })
      // Every element play() is called on.
      const play = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        if (this instanceof HTMLAudioElement) p.audioPlayTargets.push(this)
        return play.call(this)
      }
      // Microphone + MediaRecorder (engine-independent).
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => new MediaStream() },
      })
      class FakeRecorder {
        static isTypeSupported(m: string) {
          return m === 'audio/mp4'
        }
        state = 'inactive'
        ondataavailable: ((e: { data: Blob }) => void) | null = null
        onstop: ((e: Event) => void) | null = null
        onerror: (() => void) | null = null
        addEventListener() {}
        start() {
          this.state = 'recording'
          p.recording = true
        }
        stop() {
          this.state = 'inactive'
          p.recording = false
          setTimeout(() => {
            this.ondataavailable?.({ data: new Blob([new Uint8Array(2000)], { type: 'audio/mp4' }) })
            this.onstop?.(new Event('stop'))
          }, 0)
        }
        pause() {}
        resume() {}
        requestData() {}
      }
      Object.defineProperty(window, 'MediaRecorder', { value: FakeRecorder, configurable: true, writable: true })
      // Wake Lock that takes `wakeGrantMs` to be granted (iOS can be slow while the page settles).
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          request: () =>
            new Promise((resolve) =>
              setTimeout(() => {
                p.wake.granted++
                let done = false
                resolve({
                  release() {
                    if (!done) p.wake.released++
                    done = true
                    return Promise.resolve()
                  },
                })
              }, wakeGrantMs),
            ),
        },
      })
      // Media Session: keep the handlers so a test can press the lock-screen / car buttons.
      Object.defineProperty(navigator, 'mediaSession', {
        configurable: true,
        value: {
          metadata: null,
          setActionHandler(a: string, fn: (() => void) | null) {
            p.msHandlers[a] = fn
          },
        },
      })
    },
    { wakeGrantMs: opts.wakeGrantMs ?? 10 },
  )
}

const pushAgent = (page: Page, partial: Record<string, unknown>) =>
  page.evaluate((m) => {
    const t = (window as unknown as { __talos: Fake }).__talos
    t.store.setState((s) => {
      const messages = s.messages as Record<string, unknown[]>
      const thread = (m.thread_id as string) ?? 'general'
      const msg = {
        thread_id: thread,
        author: 'agent',
        kind: 'text',
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: new Date().toISOString(),
        ...m,
      }
      const list = [...(messages[thread] ?? [])]
      if (m.__prepend) list.unshift(msg)
      else list.push(msg)
      return { ...s, messages: { ...messages, [thread]: list } }
    })
  }, partial)

const voice = (id: string, replyTo: string, media: string, thread = 'general') => ({
  id,
  thread_id: thread,
  kind: 'voice_note',
  reply_to: replyTo,
  attachments: [
    {
      media_id: media,
      kind: 'audio',
      role: 'voice_reply',
      mime: 'audio/wav',
      name: 'reply.wav',
      size: 1000,
      sha256: 'a'.repeat(64),
      duration_ms: 4000,
    },
  ],
})

/** What another device (or a config.sync from the Mac) does to driving_until: rev+1, new value. */
const setUntilFromElsewhere = (page: Page, until: string | null) =>
  page.evaluate((u) => {
    const t = (window as unknown as { __talos: Fake }).__talos
    t.store.setState((s) => {
      const c = s.config as { rev: number; voice_notes: Record<string, unknown> }
      return { ...s, config: { ...c, rev: c.rev + 1, voice_notes: { ...c.voice_notes, driving_until: u } } }
    })
  }, until)

const audio = (page: Page) => page.getByTestId('drive-audio')
const audioSrc = (page: Page) => audio(page).evaluate((a: HTMLAudioElement) => a.src)
const audioPaused = (page: Page) => audio(page).evaluate((a: HTMLAudioElement) => a.paused)
const replySpeech = (page: Page) =>
  probe(page, (p) => p.spoken.filter((s) => !/waiting for an approval/.test(s.text)).map((s) => s.text))

async function startOnDrive(page: Page) {
  await page.goto('/drive')
  await page.getByRole('button', { name: 'Start driving' }).click()
  await expect(page.getByTestId('drive-status')).toBeVisible()
}

/** Holds the talk button (pointer down) and returns a release function. */
async function holdTalk(page: Page) {
  const box = await page.getByTestId('drive-talk').boundingBox()
  if (!box) throw new Error('no talk button')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  return () => page.mouse.up()
}

// The PWA service worker has a fetch handler; in WebKit, requests that pass through it bypass page.route, so the media
// stubs above were never hit on iphone (the preview server answered /media/* with index.html, error code 4) and F1, F4
// and F9 failed there for a harness reason. Blocking the worker keeps every request on the stubs. (Re-check 2026-10-30.)
test.use({ serviceWorkers: 'block' })

// Never, in any test below: a card resolved from /drive.
test.afterEach(async ({ page }) => {
  const resolved = await page
    .evaluate(() => (window as unknown as { __talos?: Fake }).__talos?.sent.filter((f) => f.type === 'card.resolve'))
    .catch(() => [])
  expect(resolved ?? []).toEqual([])
})

// ---- F1: one failed clip wedges the queue ---------------------------------------------------------------------------
test('F1: a voice clip that fails to load does not silence every reply after it', async ({ page }) => {
  await instrument(page)
  await startOnDrive(page)
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4F1', text: 'First.' })
  await pushAgent(page, voice('m_01JBF3V7Q8K2M4N6P8R0S2T4F2', 'm_01JBF3V7Q8K2M4N6P8R0S2T4F1', 'md_bad1'))
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4F3', text: 'Second.' })
  await pushAgent(page, voice('m_01JBF3V7Q8K2M4N6P8R0S2T4F4', 'm_01JBF3V7Q8K2M4N6P8R0S2T4F3', 'md_ok2'))
  // The second reply must be heard without anyone looking at the screen to press Skip.
  await expect.poll(() => audioSrc(page), { timeout: 8_000 }).toMatch(/md_ok2/)
  await expect.poll(() => audioPaused(page), { timeout: 8_000 }).toBe(false)
})

// ---- F2: the 20 s phone-voice fallback and a late clip both speak ---------------------------------------------------
test('F2a: a voice clip that arrives after the phone voice already read the reply is not played on top of it', async ({
  page,
}) => {
  await instrument(page)
  await page.clock.install()
  await startOnDrive(page)
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4G1', text: 'Done. Three sections.' })
  await page.clock.runFor(21_000)
  expect(await replySpeech(page)).toEqual(['Done. Three sections.'])
  // TTS on the Mac was slow: the clip lands 2 s later, while the phone is still talking.
  await pushAgent(page, voice('m_01JBF3V7Q8K2M4N6P8R0S2T4G2', 'm_01JBF3V7Q8K2M4N6P8R0S2T4G1', 'md_ok3'))
  await page.clock.runFor(500)
  await page.waitForTimeout(500)
  // Either never played, or the phone voice was cancelled first: never both at once.
  const played = await probe(page, (p) => p.audioPlayTargets.some((a) => /md_ok3/.test(a.src)))
  const cancels = await probe(page, (p) => p.speechCancels)
  expect(played && cancels === 0, 'the same reply is spoken twice, the second over the first').toBe(false)
})

test("F2b: a late clip for one thread does not cancel another thread's phone-voice fallback", async ({ page }) => {
  await instrument(page)
  await page.clock.install()
  await startOnDrive(page)
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4H1', text: 'General reply.' })
  await page.clock.runFor(21_000) // fallback reads it
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4H2', thread_id: 'inbox', text: 'Inbox reply.' })
  await page.clock.runFor(1_000)
  // The general reply's clip finally arrives (reply_to the first text, already spoken).
  await pushAgent(page, voice('m_01JBF3V7Q8K2M4N6P8R0S2T4H3', 'm_01JBF3V7Q8K2M4N6P8R0S2T4H1', 'md_ok4'))
  await page.clock.runFor(30_000)
  expect(await replySpeech(page)).toContain('Inbox reply.')
})

// ---- F3: speech ignores recording and playing audio -----------------------------------------------------------------
test('F3a: the phone voice never speaks while the owner is holding Talk (recording pauses playback)', async ({
  page,
}) => {
  await instrument(page)
  await page.clock.install()
  await startOnDrive(page)
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4J1', text: 'Long answer coming.' })
  await page.clock.runFor(15_000)
  const release = await holdTalk(page)
  await expect(page.getByTestId('drive-status')).toContainText('Listening')
  await page.clock.runFor(8_000) // the 20 s fallback comes due mid-sentence
  const during = await probe(page, (p) => p.spoken.filter((s) => s.recording).map((s) => s.text))
  await release()
  expect(during, 'speechSynthesis talked into the microphone').toEqual([])
})

test('F3b: starting to talk stops the phone voice that is already speaking', async ({ page }) => {
  await instrument(page)
  await page.clock.install()
  await startOnDrive(page)
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4J2', text: 'A long spoken fallback.' })
  await page.clock.runFor(21_000)
  expect(await replySpeech(page)).toEqual(['A long spoken fallback.'])
  const before = await probe(page, (p) => p.speechCancels + p.speechPauses)
  const release = await holdTalk(page)
  await expect(page.getByTestId('drive-status')).toContainText('Listening')
  const after = await probe(page, (p) => p.speechCancels + p.speechPauses)
  await release()
  expect(after, 'speechSynthesis kept talking over the recording').toBeGreaterThan(before)
})

test('F3c: a card announcement never talks over a voice reply that is playing', async ({ page }) => {
  await instrument(page)
  await startOnDrive(page)
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4K1', text: 'Reply.' })
  await pushAgent(page, voice('m_01JBF3V7Q8K2M4N6P8R0S2T4K2', 'm_01JBF3V7Q8K2M4N6P8R0S2T4K1', 'md_ok5'))
  await expect.poll(() => audioPaused(page)).toBe(false)
  await page.evaluate(() => {
    const t = (window as unknown as { __talos: Fake }).__talos
    t.store.setState((s) => {
      const cards = s.cards as Array<Record<string, unknown>>
      const c = { ...(cards[0] as Record<string, unknown>), id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4K3', state: 'pending' }
      return { ...s, cards: [...cards, c] }
    })
  })
  await expect(page.getByTestId('drive-cards')).toContainText('2 cards')
  const overlaps = await probe(page, (p) => p.spoken.filter((s) => s.audioPlaying).map((s) => s.text))
  expect(overlaps, 'speechSynthesis and the reply clip at the same time').toEqual([])
})

// ---- F4: Web Audio sneaks in through the recorder; one element only for playback ------------------------------------
test('F4: /drive plays every clip on the one shared element and never creates an AudioContext', async ({ page }) => {
  await instrument(page)
  await startOnDrive(page)
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4L1', text: 'One.' })
  await pushAgent(page, voice('m_01JBF3V7Q8K2M4N6P8R0S2T4L2', 'm_01JBF3V7Q8K2M4N6P8R0S2T4L1', 'md_ok6'))
  await expect.poll(() => audioPaused(page)).toBe(false)
  const release = await holdTalk(page)
  await expect(page.getByTestId('drive-status')).toContainText('Listening')
  await page.waitForTimeout(600)
  await release()
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4L3', text: 'Two.' })
  await pushAgent(page, voice('m_01JBF3V7Q8K2M4N6P8R0S2T4L4', 'm_01JBF3V7Q8K2M4N6P8R0S2T4L3', 'md_ok7'))
  await page.getByRole('button', { name: 'Next reply' }).click()
  await expect.poll(() => audioSrc(page)).toMatch(/md_ok7/)
  const r = await probe(page, (p) => ({
    elements: new Set(p.audioPlayTargets).size,
    allDrive: p.audioPlayTargets.every((a) => a.getAttribute('data-testid') === 'drive-audio'),
    contexts: p.audioContexts,
  }))
  expect(r.elements).toBe(1)
  expect(r.allDrive).toBe(true)
  expect(r.contexts, 'the hold-to-talk recorder opens an AudioContext (WebKit 291892)').toBe(0)
})

// ---- F5: a manual pause is never forgotten -------------------------------------------------------------------------
test('F5: after a manual Pause, driving off and on again, the next reply autoplays', async ({ page }) => {
  await instrument(page)
  await startOnDrive(page)
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4M1', text: 'A.' })
  await pushAgent(page, voice('m_01JBF3V7Q8K2M4N6P8R0S2T4M2', 'm_01JBF3V7Q8K2M4N6P8R0S2T4M1', 'md_ok8'))
  await expect.poll(() => audioPaused(page)).toBe(false)
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect.poll(() => audioPaused(page)).toBe(true)
  // Driving turned off and on again (another device, or Settings).
  await setUntilFromElsewhere(page, null)
  await expect(page.getByRole('button', { name: 'Start driving' })).toBeVisible()
  await setUntilFromElsewhere(page, new Date(Date.now() + 2 * 3600_000).toISOString())
  await expect(page.getByTestId('drive-status')).toBeVisible()
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4M3', text: 'B.' })
  await pushAgent(page, voice('m_01JBF3V7Q8K2M4N6P8R0S2T4M4', 'm_01JBF3V7Q8K2M4N6P8R0S2T4M3', 'md_ok9'))
  await expect.poll(() => audioSrc(page), { timeout: 5_000 }).toMatch(/md_ok9/)
  await expect.poll(() => audioPaused(page), { timeout: 5_000 }).toBe(false)
})

// ---- F6: history that loads later is spoken ------------------------------------------------------------------------
test('F6: an old message that loads after driving began (history.page) is never spoken or played', async ({ page }) => {
  await instrument(page)
  await page.clock.install()
  await startOnDrive(page)
  // What socketClient's history.page does: upsert older messages, sorted by seq, into the thread.
  await pushAgent(page, {
    __prepend: true,
    id: 'm_01JBF3V7Q8K2M4N6P8R0S2T400',
    seq: 0,
    text: 'Old reply from last week.',
    created_at: '2026-10-20T15:00:00.000Z',
  })
  await page.clock.runFor(21_000)
  expect(await replySpeech(page)).toEqual([])
})

// ---- F7: driving on, app relaunched / not on /drive ----------------------------------------------------------------
// Re-check 2026-10-30, owner-reversible scope call (review item Q): only the device that is driving reads aloud, i.e.
// the one whose tap turned driving on or that has /drive open; a relaunch keeps that if driving_until is still the
// window it claimed. The original F7 ("turned on elsewhere" also speaks) is split in two to pin both halves.
test('F7: driving is on and this phone was the one driving (PWA relaunched onto Home): replies are still read', async ({
  page,
}) => {
  await instrument(page)
  await page.clock.install()
  const until = new Date(Date.now() + 2 * 3600_000).toISOString()
  await page.addInitScript((u) => localStorage.setItem('talos.drive.local', String(Date.parse(u))), until)
  await page.goto('/')
  await setUntilFromElsewhere(page, until)
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4N1', text: 'You have a reply.' })
  await page.clock.runFor(21_000)
  expect(await replySpeech(page)).toEqual(['You have a reply.'])
})

test('F7 scope: driving turned on from another device, /drive never opened here: this device stays silent until /drive opens', async ({
  page,
}) => {
  await instrument(page)
  await page.clock.install()
  await page.goto('/')
  await setUntilFromElsewhere(page, new Date(Date.now() + 2 * 3600_000).toISOString())
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4N2', text: 'For the phone in the car.' })
  await page.clock.runFor(21_000)
  expect(await replySpeech(page)).toEqual([])
  // Opening /drive here makes this the driving device: the next reply is read.
  await page.evaluate(() => {
    history.pushState({}, '', '/drive')
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByTestId('drive-status')).toBeVisible()
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4N3', text: 'Now this one.' })
  await page.clock.runFor(21_000)
  expect(await replySpeech(page)).toEqual(['Now this one.'])
})

// ---- F8: re-extend resurrects driving that another device turned off -----------------------------------------------
test('F8: a /drive re-extend that hits config_conflict because driving was turned off elsewhere does not turn it back on', async ({
  page,
}) => {
  await instrument(page)
  await page.clock.install()
  await startOnDrive(page)
  await setUntilFromElsewhere(page, new Date(Date.now() + 29 * 60_000).toISOString())
  // The next patch (the re-extend) races the other device: its config.sync (driving off) lands first, so the patch
  // fails with config_conflict, exactly what the relay does on a stale base_rev.
  await page.evaluate(() => {
    const t = (window as unknown as { __talos: Fake }).__talos
    const orig = t.patchConfig.bind(t)
    let first = true
    t.patchConfig = async (patch, o) => {
      if (first) {
        first = false
        t.store.setState((s) => {
          const c = s.config as { rev: number; voice_notes: Record<string, unknown> }
          return { ...s, config: { ...c, rev: c.rev + 1, voice_notes: { ...c.voice_notes, driving_until: null } } }
        })
        t.failNextPatchWith('config_conflict')
      }
      return orig(patch, o)
    }
  })
  await page.clock.runFor(31_000) // the 30 s re-extend tick
  await page.clock.runFor(1_000) // waitForNewRev (600 ms) and the retry
  await page.waitForTimeout(300)
  const until = await page.evaluate(
    () =>
      (
        (window as unknown as { __talos: Fake }).__talos.store.getState().config as {
          voice_notes: { driving_until: unknown }
        }
      ).voice_notes.driving_until,
  )
  expect(until, 'driving was switched back on after another device turned it off').toBeNull()
})

// ---- F9: lock-screen / car buttons ---------------------------------------------------------------------------------
test('F9: the Media Session "pause" action never starts playback (and "play" never stops it)', async ({ page }) => {
  await instrument(page)
  await startOnDrive(page)
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4P1', text: 'Reply.' })
  await pushAgent(page, voice('m_01JBF3V7Q8K2M4N6P8R0S2T4P2', 'm_01JBF3V7Q8K2M4N6P8R0S2T4P1', 'md_okA'))
  await expect.poll(() => audioPaused(page)).toBe(false)
  await probe(page, (p) => p.msHandlers.play?.()) // car sends "play" on connect while it is already playing
  await page.waitForTimeout(200)
  expect(await audioPaused(page), '"play" paused the reply').toBe(false)
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect.poll(() => audioPaused(page)).toBe(true)
  await probe(page, (p) => p.msHandlers.pause?.())
  await page.waitForTimeout(200)
  expect(await audioPaused(page), '"pause" started the reply').toBe(true)
})

// ---- F10: wake-lock leak -------------------------------------------------------------------------------------------
test('F10: every screen wake lock granted on /drive is released after leaving /drive', async ({ page }) => {
  await instrument(page, { wakeGrantMs: 2_000 })
  await startOnDrive(page)
  await page.waitForTimeout(300)
  // Leave by navigation (driving stays on, as the PR intends).
  await page.evaluate(() => {
    window.history.pushState({}, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByTestId('drive-screen')).toHaveCount(0)
  await page.waitForTimeout(2_500)
  const w = await probe(page, (p) => p.wake)
  expect(w.granted).toBeGreaterThan(0)
  expect(w.released, 'a lock granted after the 1.5 s race timeout is never released').toBe(w.granted)
})

// ---- F11: landscape car mount --------------------------------------------------------------------------------------
test('F11: in a landscape car mount every /drive control is on screen (no scroll exists to reach it)', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'desktop', 'phone sizes only')
  await instrument(page)
  const v = page.viewportSize() ?? { width: 390, height: 844 }
  await page.setViewportSize({ width: Math.max(v.width, v.height), height: Math.min(v.width, v.height) })
  await startOnDrive(page)
  await expect(page.getByTestId('drive-cards')).toBeVisible()
  const off = await page.evaluate(() => {
    const vh = window.innerHeight
    return [...document.querySelectorAll<HTMLElement>('[data-testid="drive-screen"] button')]
      .map((b) => ({ name: b.getAttribute('aria-label') ?? b.textContent?.trim(), r: b.getBoundingClientRect() }))
      .filter((b) => b.r.bottom > vh + 0.5 || b.r.top < -0.5)
      .map((b) => `${b.name} (${Math.round(b.r.top)}-${Math.round(b.r.bottom)} of ${vh})`)
  })
  expect(off, 'controls clipped off screen').toEqual([])
})

// ---- F12: focus escapes the overlay to the hidden app underneath ---------------------------------------------------
test('F12: keyboard / VoiceOver focus never leaves the /drive screen for the hidden app behind it', async ({
  page,
}) => {
  await instrument(page)
  await startOnDrive(page)
  const escaped: string[] = []
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab')
    const where = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null
      if (!a || a === document.body) return null
      return a.closest('[data-testid="drive-screen"]')
        ? null
        : (a.getAttribute('aria-label') ?? a.textContent?.trim() ?? a.tagName)
    })
    if (where) escaped.push(where)
  }
  expect(escaped).toEqual([])
})

// ---- F13 (spec gap): parked with /drive on screen ------------------------------------------------------------------
test('F13 SPEC GAP: parked with /drive left on screen, driving mode still ends (2 h expiry not defeated forever)', async ({
  page,
}) => {
  await instrument(page)
  await page.clock.install()
  await startOnDrive(page)
  // 13 hours, 10 minutes at a time (each step fires the 30 s re-extend tick once).
  for (let i = 0; i < 78; i++) await page.clock.fastForward(10 * 60_000)
  await page.waitForTimeout(300)
  const until = await page.evaluate(
    () =>
      (
        (window as unknown as { __talos: Fake }).__talos.store.getState().config as {
          voice_notes: { driving_until: string | null }
        }
      ).voice_notes.driving_until,
  )
  const stillOn = until !== null && Date.parse(until) > (await page.evaluate(() => Date.now()))
  expect(stillOn, 'the 30-min re-extend + held wake lock keep driving on indefinitely').toBe(false)
})

// ---- F14: Settings switch after expiry ------------------------------------------------------------------------------
test('F14: the Settings switch turns itself off when the 2 h are up', async ({ page }) => {
  await instrument(page)
  await page.clock.install()
  await page.goto('/settings/voice')
  const sw = page.getByRole('switch', { name: 'Driving mode' })
  await sw.click()
  await expect(sw).toBeChecked()
  await page.clock.fastForward(2 * 3600_000 + 60_000)
  await page.clock.runFor(1_000)
  await expect(sw).not.toBeChecked({ timeout: 2_000 })
})
