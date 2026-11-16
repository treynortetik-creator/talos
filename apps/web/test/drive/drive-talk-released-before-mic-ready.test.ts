// Driving mode's Talk button, let go before the microphone is ready (a quick tap, or a slow getUserMedia): the recording
// must end and the screen must go back to Ready. `beginTalk` is still waiting for the recorder when `endTalk` runs; when
// the recorder arrives, `beginTalk` writes the handle back into `this.recording` AFTER `endTalk` cleared it.
import { AgentConfig } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import type { RecorderHandle } from '../../src/features/composer/recorder.ts'
import { DriveController } from '../../src/features/drive/controller.ts'
import { createVoiceQueue } from '../../src/features/drive/queue.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

const NOW = Date.parse('2026-10-28T16:00:00.000Z')

class FakeAudio extends EventTarget {
  src = ''
  currentTime = 0
  duration = Number.NaN
  paused = true
  playbackRate = 1
  defaultPlaybackRate = 1
  load() {}
  play() {
    this.paused = false
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  }
  pause() {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
}

function setup() {
  const client = createFakeClient({ now: () => NOW })
  const queue = createVoiceQueue({ audio: new FakeAudio() as unknown as HTMLAudioElement, speed: () => 1 })
  let started = 0
  let stopped = 0
  let grant: (h: RecorderHandle) => void = () => {}
  let refuse: (e: unknown) => void = () => {}
  const handle = (): RecorderHandle => ({
    // A stray tap: far under the 400 ms a voice note needs.
    stop: async () => {
      stopped++
      return { blob: new Blob(['x']), mime: 'audio/webm', durationMs: 120, waveform: '', endedByItself: false }
    },
    cancel: () => {
      stopped++
    },
    pause: () => {},
    resume: () => {},
    snapshot: async () => new Blob([]),
    elapsedMs: () => 120,
    endedByItself: () => false,
  })
  const drive = new DriveController({
    client,
    queue,
    speech: { speak: () => {}, cancel: () => {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    fallbackEnabled: () => true,
    // The microphone takes a moment (the permission prompt, the audio route): the handle arrives when `grant` is called.
    recorder: () => {
      started++
      return new Promise<RecorderHandle>((resolve, reject) => {
        grant = resolve
        refuse = reject
      })
    },
    audioSession: { set: () => {} },
    loadThread: () => 'general',
    saveThread: () => {},
  })
  drive.claim()
  drive.watch()
  client.store.setState((s) => ({
    ...s,
    config: AgentConfig.parse({
      ...s.config,
      voice_notes: { ...s.config?.voice_notes, driving_until: new Date(Date.now() + 3600_000).toISOString() },
    }),
  }))
  return {
    drive,
    grant: () => grant(handle()),
    deny: () => refuse(new DOMException('Permission denied', 'NotAllowedError')),
    counts: () => ({ started, stopped }),
  }
}

describe('driving mode: Talk let go before the microphone is ready', () => {
  it('goes back to Ready instead of staying on Listening', async () => {
    const t = setup()
    expect(t.drive.store.getState().active).toBe(true)
    const begin = t.drive.beginTalk() // finger down
    const end = t.drive.endTalk(true) // finger up, the microphone has not answered yet
    t.grant()
    await Promise.all([begin, end])
    expect(t.counts()).toEqual({ started: 1, stopped: 1 }) // the recorder that arrived late was stopped
    // Nothing is recording any more: the screen must not say "Listening…".
    expect(t.drive.store.getState().status).toBe('ready')
  })

  it('lets the next press record again', async () => {
    const t = setup()
    const begin = t.drive.beginTalk()
    const end = t.drive.endTalk(true)
    t.grant()
    await Promise.all([begin, end])
    // Second press: a new recording must start (the first one is over).
    void t.drive.beginTalk()
    expect(t.counts().started).toBe(2)
  })

  it('does not throw when the microphone is refused after the finger is already up (the permission prompt)', async () => {
    const t = setup()
    const begin = t.drive.beginTalk() // finger down: the browser asks for the microphone
    const end = t.drive.endTalk(true) // finger up, to answer the prompt
    t.deny() // "Don't allow"
    await begin
    // beginTalk already said "Couldn't record"; endTalk has nothing to stop and must end quietly, not reject (the screen
    // calls it with `void`, so a rejection becomes an unhandled rejection and an automatic problem report).
    await expect(end.then(() => 'ended quietly')).resolves.toBe('ended quietly')
  })
})
