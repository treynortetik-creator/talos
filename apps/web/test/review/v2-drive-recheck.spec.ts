// Re-check 2026-10-30 of PR #43 at ced3060, harness copied from v2-drive-review.spec.ts. Adversarial review of PR #43 (V2 WP-V3, driving mode, web). Every test here drives the real web client in fake mode
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
  // A clip whose download never answers (LTE dead zone, black-holed TCP): no error, no end, play() never settles.
  await page.route('**/media/md_hang*', () => new Promise(() => {}))
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

const replySpeech = (page: Page) =>
  probe(page, (p) => p.spoken.filter((s) => !/waiting for an approval/.test(s.text)).map((s) => s.text))

async function startOnDrive(page: Page) {
  await page.goto('/drive')
  await page.getByRole('button', { name: 'Start driving' }).click()
  await expect(page.getByTestId('drive-status')).toBeVisible()
}

// In WebKit, requests that pass through the PWA service worker bypass page.route: block it so the media stubs are hit.
test.use({ serviceWorkers: 'block' })

// Never, in any test below: a card resolved from /drive.
test.afterEach(async ({ page }) => {
  const resolved = await page
    .evaluate(() => (window as unknown as { __talos?: Fake }).__talos?.sent.filter((f) => f.type === 'card.resolve'))
    .catch(() => [])
  expect(resolved ?? []).toEqual([])
})

// ---- RC1: a clip that never loads silences everything (the speaker gate counts it as playing) ------------------------
test('RC1: a voice clip whose download hangs does not silence the phone voice for every later reply', async ({
  page,
}) => {
  await instrument(page)
  await page.clock.install()
  await startOnDrive(page)
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4W1', text: 'First.' })
  await pushAgent(page, voice('m_01JBF3V7Q8K2M4N6P8R0S2T4W2', 'm_01JBF3V7Q8K2M4N6P8R0S2T4W1', 'md_hang1'))
  // A second reply with no clip at all (TTS failed on the Mac): its 20 s phone-voice backup must still speak.
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4W3', text: 'Second.' })
  for (let i = 0; i < 12; i++) {
    await page.clock.runFor(5_000)
    await page.waitForTimeout(50)
  }
  const said = await replySpeech(page)
  expect(said, 'one hung clip kept the phone silent for 60 s (busy() counts current+armed as playing)').toContain(
    'Second.',
  )
})

test('RC1 control: the same replies with a clip that fails fast (404) do get the phone voice', async ({ page }) => {
  await instrument(page)
  await page.clock.install()
  await startOnDrive(page)
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4Y1', text: 'First.' })
  await pushAgent(page, voice('m_01JBF3V7Q8K2M4N6P8R0S2T4Y2', 'm_01JBF3V7Q8K2M4N6P8R0S2T4Y1', 'md_bad9'))
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4Y3', text: 'Second.' })
  for (let i = 0; i < 12; i++) {
    await page.clock.runFor(5_000)
    await page.waitForTimeout(50)
  }
  expect(await replySpeech(page)).toContain('Second.')
})

// ---- RC2: a clip starts while the phone voice is still reading another reply -----------------------------------------
test('RC2: a new voice clip never plays on top of the phone voice reading an earlier reply', async ({ page }) => {
  await instrument(page)
  await page.clock.install()
  await startOnDrive(page)
  // Reply A has no clip: at 20 s the phone voice starts reading it (the stub stays "speaking", like a long reply).
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4X1', text: 'A long answer that takes a minute to read.' })
  await page.clock.runFor(21_000)
  expect(await replySpeech(page)).toEqual(['A long answer that takes a minute to read.'])
  // Reply B (another thread, a schedule result) arrives with its clip while A is still being read.
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4X2', thread_id: 'inbox', text: 'Inbox reply.' })
  await pushAgent(page, voice('m_01JBF3V7Q8K2M4N6P8R0S2T4X3', 'm_01JBF3V7Q8K2M4N6P8R0S2T4X2', 'md_okX', 'inbox'))
  await page.clock.runFor(500)
  await page.waitForTimeout(800)
  const r = await probe(page, (p) => ({
    played: p.audioPlayTargets.some((a) => /md_okX/.test(a.src)),
    stillSpeaking: (window.speechSynthesis as unknown as { speaking: boolean }).speaking,
  }))
  expect(r.played && r.stillSpeaking, 'two voices at once: the clip plays over the phone voice').toBe(false)
})

// ---- RC3: Talk live from /drive has no way to end the call on /drive ---------------------------------------------------
test('RC3: after Talk live on /drive, the call can be ended from /drive', async ({ page }) => {
  await instrument(page)
  // Hold the call in "connecting" (the relay is slow to answer the SDP offer): the mic is already open by then.
  await page.route('**/api/voice/**', () => new Promise(() => {}))
  await page.addInitScript(() => {
    const md = navigator.mediaDevices
    const gum = md.getUserMedia.bind(md)
    ;(window as unknown as { __mic: number }).__mic = 0
    md.getUserMedia = (c?: MediaStreamConstraints) => {
      ;(window as unknown as { __mic: number }).__mic++
      return gum(c)
    }
  })
  await startOnDrive(page)
  const live = page.getByRole('button', { name: 'Talk live' })
  await expect(live).toBeVisible()
  await live.click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __mic: number }).__mic)).toBeGreaterThan(0)
  // The call is connecting (the mic is open). Somewhere on the driving screen there must be a way to hang up.
  await expect(
    page.getByTestId('drive-screen').getByRole('button', { name: /end( the)? call|hang up/i }),
    'no End call control on /drive, and the CallBar behind it is inert',
  ).toBeVisible({ timeout: 3_000 })
})

test('RC3b: Exit from /drive during a live call hangs it up too', async ({ page }) => {
  await instrument(page)
  await page.route('**/api/voice/**', () => new Promise(() => {}))
  await startOnDrive(page)
  await page.getByRole('button', { name: 'Talk live' }).click()
  const end = page.getByTestId('drive-screen').getByRole('button', { name: 'End call' })
  await expect(end).toBeVisible()
  expect((await end.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(95)
  await page.getByRole('button', { name: 'Exit' }).click()
  await expect(page.getByTestId('drive-screen')).toHaveCount(0)
  // Back on /drive (driving off): no call is left running behind it.
  await page.evaluate(() => {
    history.pushState({}, '', '/drive')
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await page.getByRole('button', { name: 'Start driving' }).click()
  await expect(page.getByRole('button', { name: 'Talk live' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'End call' })).toHaveCount(0)
})
