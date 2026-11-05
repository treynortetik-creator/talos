// WP-V3: what /drive does with incoming replies: queue voice, fall back to the phone's voice after 20 s, count cards.
import { AgentConfig, type MessageT } from '@talos-app/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { DriveController } from '../../src/features/drive/controller.ts'
import { createVoiceQueue } from '../../src/features/drive/queue.ts'
import { createFakeClient, type FakeClient } from '../../src/lib/fakeClient.ts'

const NOW = Date.parse('2026-10-28T16:00:00.000Z')
let n = 0
const id = () => `m_01JBF3V7Q8K2M4N6P8R0S2T4${String(n++).padStart(2, '0')}`

class Audio extends EventTarget {
  src = ''
  currentTime = 0
  duration = Number.NaN
  paused = true
  playbackRate = 1
  defaultPlaybackRate = 1
  failNext = false
  failAlways = false
  load() {}
  play() {
    if ((this.failNext || (this.failAlways && this.src.includes('bad'))) && !this.src.startsWith('data:')) {
      this.failNext = false
      return Promise.reject(new DOMException('bad clip', 'NotSupportedError'))
    }
    this.paused = false
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  }
  pause() {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
}

type Timer = { fn: () => void; at: number; h: number }
function setup(
  opts: { fallback?: boolean; cards?: boolean; heard?: { seq: number; until: number }; remote?: boolean } = {},
) {
  const client: FakeClient = createFakeClient({ now: () => NOW })
  if (!opts.cards) client.store.setState((s) => ({ ...s, cards: [] }))
  const timers: Timer[] = []
  let clock = 0
  let h = 0
  const spoken: string[] = []
  let cancelCount = 0
  const sessions: string[] = []
  const audio = new Audio()
  let drive!: DriveController
  const queue = createVoiceQueue({
    audio: audio as unknown as HTMLAudioElement,
    speed: () => 1,
    onStart: (i) => drive.onClipStart(i),
    onFail: (i) => drive.onClipFail(i),
  })
  drive = new DriveController({
    client,
    queue,
    speech: {
      speak: (t) => void spoken.push(t),
      cancel: () => {
        cancelCount += 1
      },
    },
    persist: {
      loadHeard: () => opts.heard ?? null,
      saveHeard: () => {},
      loadTouch: () => null,
      saveTouch: () => {},
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, at: clock + ms, h: ++h })
      return h
    },
    clearTimeout: (x) => {
      const i = timers.findIndex((t) => t.h === x)
      if (i >= 0) timers.splice(i, 1)
    },
    fallbackEnabled: () => opts.fallback ?? true,
    recorder: async () => ({
      stop: async () => ({
        blob: new Blob(['x'], { type: 'audio/webm' }),
        mime: 'audio/webm',
        durationMs: 1500,
        waveform: '',
        endedByItself: false,
      }),
      cancel: () => {},
      pause: () => {},
      resume: () => {},
      snapshot: async () => new Blob([]),
      elapsedMs: () => 1500,
      endedByItself: () => false,
    }),
    audioSession: { set: (t) => void sessions.push(t) },
    loadThread: () => 'general',
    saveThread: () => {},
  })
  // This device is the one driving (its tap turns driving on), unless a test says otherwise.
  if (!opts.remote) drive.claim()
  const advance = (ms: number) => {
    clock += ms
    for (const t of [...timers].filter((x) => x.at <= clock)) {
      timers.splice(timers.indexOf(t), 1)
      t.fn()
    }
  }
  const drivingOn = () =>
    client.store.setState((s) => ({
      ...s,
      config: AgentConfig.parse({
        ...s.config,
        voice_notes: { ...s.config?.voice_notes, driving_until: new Date(NOW + 3600_000).toISOString() },
      }),
    }))
  const push = (m: Partial<MessageT>) =>
    client.store.setState((s) => {
      const msg = {
        id: id(),
        thread_id: 'general',
        author: 'agent',
        kind: 'text',
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: new Date(NOW).toISOString(),
        ...m,
      } as MessageT
      return { ...s, messages: { ...s.messages, [msg.thread_id]: [...(s.messages[msg.thread_id] ?? []), msg] } }
    })
  return { client, drive, queue, spoken, sessions, cancels: () => cancelCount, advance, drivingOn, push, audio }
}
const voiceAtt = (mediaId: string) => ({
  media_id: mediaId,
  kind: 'audio' as const,
  role: 'voice_reply' as const,
  mime: 'audio/ogg',
  name: 'reply.ogg',
  size: 10,
  sha256: 'a'.repeat(64),
  duration_ms: 3000,
})

describe('DriveController', () => {
  beforeEach(() => {
    n = 0
  })

  it('does nothing while driving is off', () => {
    const t = setup()
    t.drive.watch()
    t.push({ text: 'hello there' })
    t.advance(60_000)
    expect(t.spoken).toEqual([])
  })

  it('history that was already there when driving began is not spoken or played', () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    t.advance(60_000)
    expect(t.spoken).toEqual([])
    expect(t.queue.store.getState().current).toBeNull()
  })

  it('a voice follow-up from any thread is queued, and cancels the 20 s fallback for its text', async () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    await t.queue.unlock()
    const textId = id()
    t.push({ id: textId, text: 'Done. Three sections.' })
    t.advance(10_000)
    t.push({
      thread_id: 'inbox',
      kind: 'voice_note',
      attachments: [voiceAtt('md_01JBF3V7Q8K2M4N6P8R0S2T4AA')],
      reply_to: textId,
    })
    t.advance(30_000)
    expect(t.spoken).toEqual([])
    expect(t.queue.store.getState().current?.url).toBe('/media/md_01JBF3V7Q8K2M4N6P8R0S2T4AA')
  })

  it('no voice within 20 s: the phone reads the plain text aloud', () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    t.push({ text: '**Done.** See `x.ts`.' })
    t.advance(19_000)
    expect(t.spoken).toEqual([])
    t.advance(2_000)
    expect(t.spoken).toEqual(['Done. See x.ts.'])
  })

  it('a code-heavy reply is replaced by "Details are in the thread."', () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    t.push({ text: '```\na\nb\nc\nd\n```\nok' })
    t.advance(21_000)
    expect(t.spoken).toEqual(['Details are in the thread.'])
  })

  it('the fallback is off when the setting is off', () => {
    const t = setup({ fallback: false })
    t.drive.watch()
    t.drivingOn()
    t.push({ text: 'hello' })
    t.advance(60_000)
    expect(t.spoken).toEqual([])
  })

  it('a pending card is counted and spoken once, never approved', () => {
    const t = setup({ cards: true })
    t.drive.watch()
    t.drivingOn()
    expect(t.client.store.getState().cards.some((c) => c.state === 'pending')).toBe(true)
    expect(t.drive.store.getState().cardsWaiting).toBe(1)
    t.client.store.setState((s) => ({ ...s, lastSeq: s.lastSeq + 1 }))
    t.client.store.setState((s) => ({ ...s, lastSeq: s.lastSeq + 1 }))
    expect(t.spoken.filter((x) => /is waiting for an approval/.test(x))).toHaveLength(1)
    expect(t.client.sent.filter((f) => f.type === 'card.resolve')).toEqual([])
  })

  it('turning driving off clears the queue and the timers', () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    t.push({ text: 'hello' })
    t.client.store.setState((s) => ({
      ...s,
      config: s.config ? { ...s.config, voice_notes: { ...s.config.voice_notes, driving_until: null } } : s.config,
    }))
    t.advance(60_000)
    expect(t.spoken).toEqual([])
  })

  it('talking: recording pauses playback and switches the audio session; sending shows Thinking', async () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    await t.queue.unlock()
    t.push({ kind: 'voice_note', attachments: [voiceAtt('md_01JBF3V7Q8K2M4N6P8R0S2T4AB')] })
    expect(t.queue.store.getState().playing).toBe(true)
    await t.drive.beginTalk()
    expect(t.queue.store.getState().playing).toBe(false)
    expect(t.drive.store.getState().status).toBe('listening')
    expect(t.sessions.at(-1)).toBe('play-and-record')
    await t.drive.endTalk(true)
    expect(t.sessions.at(-1)).toBe('playback')
    expect(t.client.sent.some((f) => f.type === 'voice_note' && f.thread_id === 'general')).toBe(true)
    // The old reply picks up where it stopped.
    expect(t.queue.store.getState().playing).toBe(true)
    expect(t.drive.store.getState().status).toBe('speaking')
  })

  it('after a question with nothing playing the status is Thinking until the agent answers', async () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    await t.drive.beginTalk()
    await t.drive.endTalk(true)
    expect(t.drive.store.getState().status).toBe('thinking')
    t.push({ text: 'Done.' })
    expect(t.drive.store.getState().status).toBe('ready')
  })

  it('history with a seq at or below the one seen at activation is never spoken', () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    t.push({ seq: 0, text: 'Old reply.', created_at: '2026-10-20T15:00:00.000Z' })
    t.advance(60_000)
    expect(t.spoken).toEqual([])
  })

  it('a reply with a higher seq is live', () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    t.push({ seq: 50, text: 'New.' })
    t.advance(21_000)
    expect(t.spoken).toEqual(['New.'])
  })

  it('a clip that arrives after the phone read the reply is dropped', async () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    await t.queue.unlock()
    const textId = id()
    t.push({ id: textId, text: 'Done.' })
    t.advance(21_000)
    t.push({ kind: 'voice_note', attachments: [voiceAtt('md_01JBF3V7Q8K2M4N6P8R0S2T4AC')], reply_to: textId })
    expect(t.queue.store.getState().current).toBeNull()
  })

  it("one reply's clip never cancels another reply's backup", async () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    await t.queue.unlock()
    const a = id()
    const b = id()
    t.push({ id: a, thread_id: 'general', text: 'General.' })
    t.push({ id: b, thread_id: 'inbox', text: 'Inbox.' })
    t.push({ kind: 'voice_note', attachments: [voiceAtt('md_01JBF3V7Q8K2M4N6P8R0S2T4AD')], reply_to: a })
    await new Promise((r) => setTimeout(r, 0))
    t.advance(21_000)
    expect(t.spoken).toEqual([]) // General's clip is playing: Inbox's backup waits its turn, it is not cancelled
    t.audio.paused = true
    t.audio.dispatchEvent(new Event('ended'))
    t.advance(2_000)
    expect(t.spoken).toEqual(['Inbox.'])
  })

  it('the phone voice waits while Talk is held and never starts one while a clip plays', async () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    t.push({ text: 'Hello.' })
    await t.drive.beginTalk()
    t.advance(25_000)
    expect(t.spoken).toEqual([])
    await t.drive.endTalk(false)
    t.advance(2_000)
    expect(t.spoken).toEqual(['Hello.'])
  })

  it('starting to talk cancels speech that is already going', async () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    await t.drive.beginTalk()
    expect(t.cancels()).toBe(1)
  })

  it('a clip that fails is skipped with a spoken note, and its text is still read by the phone', async () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    await t.queue.unlock()
    const textId = id()
    t.push({ id: textId, text: 'Reply text.' })
    t.audio.failAlways = true
    t.push({ kind: 'voice_note', attachments: [voiceAtt('md_bad_AE')], reply_to: textId })
    await new Promise((r) => setTimeout(r, 400))
    t.advance(2_000)
    expect(t.spoken.some((x) => /Couldn't play that reply/.test(x))).toBe(true)
    t.advance(21_000)
    expect(t.spoken).toContain('Reply text.')
  })

  it('relaunched mid-drive: replies after the last handled seq are played', async () => {
    const saved = { seq: 5, until: Date.now() + 3600_000 }
    const t = setup({ heard: saved })
    t.drive.watch()
    t.push({ seq: 6, text: 'Missed one.' })
    t.drivingOn()
    t.advance(21_000)
    expect(t.spoken).toEqual(['Missed one.'])
  })
  it('another device is the one driving: replies are shown, never read or played here', async () => {
    const t = setup({ remote: true, cards: true })
    t.drive.watch()
    t.drivingOn()
    await t.queue.unlock()
    const textId = id()
    t.push({ id: textId, text: 'Not for this device.' })
    t.push({ kind: 'voice_note', attachments: [voiceAtt('md_01JBF3V7Q8K2M4N6P8R0S2T4AF')], reply_to: textId })
    t.advance(30_000)
    expect(t.spoken).toEqual([])
    expect(t.queue.store.getState().current).toBeNull()
    expect(t.drive.isLocal()).toBe(false)
    expect(t.drive.store.getState().line).toBe('')
  })

  it('opening /drive on a device makes it the one driving: replies from then on are read', () => {
    const t = setup({ remote: true })
    t.drive.watch()
    t.drivingOn()
    t.push({ text: 'Before.' })
    t.drive.setScreenOpen(true)
    expect(t.drive.isLocal()).toBe(true)
    t.push({ text: 'After.' })
    t.advance(21_000)
    expect(t.spoken).toEqual(['After.'])
  })

  it('a live call holds the queue and the phone voice until it ends, and cancels speech when it starts', () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    t.push({ text: 'During the call.' })
    const before = t.cancels()
    t.drive.setOnCall(true)
    expect(t.cancels()).toBe(before + 1)
    t.advance(30_000)
    expect(t.spoken).toEqual([])
    t.drive.setOnCall(false)
    t.advance(2_000)
    expect(t.spoken).toEqual(['During the call.'])
  })

  it('a clip that breaks after it started gets its text read by the phone (its backup had been cancelled)', async () => {
    const t = setup()
    t.drive.watch()
    t.drivingOn()
    await t.queue.unlock()
    const textId = id()
    t.push({ id: textId, text: 'Broke mid-clip.' })
    t.push({ kind: 'voice_note', attachments: [voiceAtt('md_01JBF3V7Q8K2M4N6P8R0S2T4AG')], reply_to: textId })
    await new Promise((r) => setTimeout(r, 0))
    const cur = t.queue.store.getState().current
    if (!cur) throw new Error('no clip')
    t.queue.skip() // the queue moved on; report the failure the way the queue does after a mid-clip stall
    t.drive.onClipFail(cur, { started: true })
    t.advance(2_000)
    expect(t.spoken).toEqual(['Broke mid-clip.'])
  })
})
