// `reply` with `voice_text` made no audio and said nothing: the agent got a plain "sent" and the owner had to ask for an mp3.
// `voice_text` always makes audio when a TTS command is set up, whatever the spoken-replies setting says (that setting only
// adds voice to replies that carry no voice_text). When no audio can be made (no TTS command, the command failed, the upload
// failed) the agent is told why in the tool result, so it can send an audio file itself. The reply text is delivered either way.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentConfigT } from '@talos-app/protocol'
import { fakeClock, t } from '@talos-app/testkit'
import { createLogger } from '../src/log.ts'
import type { TtsResult } from '../src/tts.ts'
import { advanceSteps, fixture, type Harness, startHarness, tempHome, waitFor } from './helpers.ts'

setDefaultTimeout(t(60_000)) // the slow-TTS cases step a fake clock and wait for sockets

let h: Harness
afterEach(async () => h?.stop())

const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''
const voiceOn = (c: AgentConfigT) => ({
  ...c,
  voice_notes: { ...c.voice_notes, reply_with_voice: 'always' as const },
})
const ttsOk = {
  TALOS_APP_TTS_CMD: JSON.stringify([fixture('fake-tts.sh'), 'file', '{out}', '{text}']),
  TALOS_APP_TTS_EXT: 'mp3',
}

async function delivered(body: string) {
  const f = await h.relay.expectFrame('reply', (r) => r.message.text === body, { direction: 'from_bridge' })
  return f.message
}

describe('reply with voice_text', () => {
  test('spoken replies never, TTS set up: the audio is attached and the result carries no note', async () => {
    h = await startHarness({ env: ttsOk })
    const res = await h.bridge.callTool('reply', {
      thread_id: 'general',
      text: 'full text',
      voice_text: 'short spoken',
    })
    expect(res.isError).toBeFalsy()
    expect(text(res)).not.toContain('voice_text')
    const voice = (await delivered('full text')).attachments.find((a) => a.role === 'voice_reply')
    expect(voice?.kind).toBe('audio')
    expect(new TextDecoder().decode(h.relay.media.get(voice?.media_id as string)?.bytes)).toBe(
      'FAKE-AUDIO:short spoken',
    )
  })

  test('spoken replies always, TTS set up: the audio is attached once, with no note', async () => {
    h = await startHarness({ config: voiceOn, env: ttsOk })
    const res = await h.bridge.callTool('reply', {
      thread_id: 'general',
      text: 'full text',
      voice_text: 'short spoken',
    })
    expect(res.isError).toBeFalsy()
    expect(text(res)).not.toContain('voice_text')
    const m = await delivered('full text')
    expect(m.attachments.filter((a) => a.role === 'voice_reply')).toHaveLength(1)
  })

  test.each([
    ['never', undefined],
    ['always', voiceOn],
  ] as const)(
    'spoken replies %s but no TTS command: the agent is told, and the reply still goes out',
    async (_n, config) => {
      h = await startHarness(config ? { config } : {})
      const res = await h.bridge.callTool('reply', {
        thread_id: 'general',
        text: 'full text',
        voice_text: 'short spoken',
      })
      expect(res.isError).toBeFalsy()
      expect(text(res)).toContain('voice_text made no audio')
      expect(text(res)).toContain('no TTS command configured')
      expect((await delivered('full text')).attachments).toHaveLength(0)
    },
  )

  test('the TTS command fails: the agent is told the reason', async () => {
    h = await startHarness({
      env: { TALOS_APP_TTS_CMD: JSON.stringify(['/usr/bin/false', '{out}', '{text}']), TALOS_APP_TTS_EXT: 'mp3' },
    })
    const res = await h.bridge.callTool('reply', {
      thread_id: 'general',
      text: 'full text',
      voice_text: 'short spoken',
    })
    expect(res.isError).toBeFalsy()
    expect(text(res)).toContain('voice_text made no audio')
    expect(text(res)).toContain('command failed')
    expect((await delivered('full text')).attachments).toHaveLength(0)
  })

  test('the audio cannot be uploaded: the text reply still goes out, with the note', async () => {
    // a TTS file one byte over the 50 MB cap: the bridge refuses to upload it
    h = await startHarness({
      env: {
        TALOS_APP_TTS_CMD: JSON.stringify(['/bin/sh', '-c', 'head -c 52428801 /dev/zero > "$0"', '{out}']),
        TALOS_APP_TTS_EXT: 'mp3',
      },
    })
    const res = await h.bridge.callTool('reply', {
      thread_id: 'general',
      text: 'full text',
      voice_text: 'short spoken',
    })
    expect(res.isError).toBeFalsy()
    expect(text(res)).toContain('voice_text made no audio: upload failed')
    expect((await delivered('full text')).attachments).toHaveLength(0)
  })

  test('no voice_text and spoken replies never: no audio, and the result is the plain status', async () => {
    h = await startHarness({ env: ttsOk })
    const res = await h.bridge.callTool('reply', { thread_id: 'general', text: 'full text' })
    expect(res.isError).toBeFalsy()
    expect(text(res)).not.toContain('voice_text')
    expect(text(res)).not.toContain('spoken')
    expect((await delivered('full text')).attachments).toHaveLength(0)
  })

  test('no voice_text and spoken replies always: the reply is spoken as before', async () => {
    h = await startHarness({ config: voiceOn, env: ttsOk })
    await h.bridge.callTool('reply', { thread_id: 'general', text: 'full text' })
    expect((await delivered('full text')).attachments.some((a) => a.role === 'voice_reply')).toBe(true)
  })
})

// A TTS command that hangs must not hold the text: past the wait the text goes out alone and the audio follows as one message.
describe('reply with voice_text and a slow TTS command', () => {
  /** A synthesis the test finishes by hand, one call at a time. */
  function gated() {
    const waiting: Array<(r: TtsResult) => void> = []
    const dir = tempHome('talos-late-tts-')
    const path = join(dir, 'late.mp3')
    writeFileSync(path, 'LATE-AUDIO')
    return {
      synth: () => new Promise<TtsResult>((resolve) => waiting.push(resolve)),
      started: () => waiting.length,
      audio: (): TtsResult => ({ ok: true, path, mime: 'audio/mpeg', ext: 'mp3' }),
      finish: (r: TtsResult) => waiting.shift()?.(r),
    }
  }
  const start = async (g: ReturnType<typeof gated>, speak: Record<string, unknown> = {}) => {
    const clock = fakeClock(new Date().toISOString())
    const lines: string[] = []
    h = await startHarness({
      clock,
      env: ttsOk,
      bridge: { logger: createLogger(null, 'info', (l) => lines.push(l)), speak: { synth: g.synth, ...speak } },
    })
    return { clock, lines }
  }
  const voiceFrames = () =>
    h.relay.frames.filter(
      (r) =>
        r.direction === 'from_bridge' &&
        r.frame.type === 'reply' &&
        r.frame.message.attachments.some((a) => a.role === 'voice_reply'),
    )
  const textFrames = () =>
    h.relay.frames.filter(
      (r) => r.direction === 'from_bridge' && r.frame.type === 'reply' && r.frame.message.text === 'full text',
    )
  const call = () => h.bridge.callTool('reply', { thread_id: 'general', text: 'full text', voice_text: 'short spoken' })

  test('audio done at 1 s is attached to the text message', async () => {
    const g = gated()
    const { clock } = await start(g)
    const p = call()
    await waitFor(() => g.started() === 1, 5000, 'the synthesis to start')
    await advanceSteps(clock, 1000, 1000, h.bridge.client)
    g.finish(g.audio())
    const res = await p
    expect(text(res)).not.toContain('voice_text')
    expect((await delivered('full text')).attachments.some((a) => a.role === 'voice_reply')).toBe(true)
    expect(voiceFrames()).toHaveLength(1) // the text message itself: no second one
  })

  test('audio still running at 20 s: the text goes out alone, and the audio follows as one message when it is done', async () => {
    const g = gated()
    const { clock } = await start(g)
    const p = call()
    await waitFor(() => g.started() === 1, 5000, 'the synthesis to start')
    await advanceSteps(clock, 20_000, 20_000, h.bridge.client)
    const res = await p
    expect(res.isError).toBeFalsy()
    expect(text(res)).not.toContain('made no audio') // it is still coming
    const m = await delivered('full text')
    expect(m.attachments).toHaveLength(0)
    expect(voiceFrames()).toHaveLength(0)
    await advanceSteps(clock, 10_000, 10_000, h.bridge.client) // 30 s in
    g.finish(g.audio())
    await waitFor(() => voiceFrames().length === 1, 5000, 'the audio follow-up')
    const follow = voiceFrames()[0]?.frame
    if (follow?.type !== 'reply') throw new Error('not a reply')
    expect(follow.message.reply_to).toBe(m.id)
    expect(follow.message.kind).toBe('file')
    expect(follow.message.thread_id).toBe(m.thread_id)
    expect(textFrames()).toHaveLength(1)
  })

  test('audio that fails after the cut-off is logged and sends no second message', async () => {
    const g = gated()
    const { clock, lines } = await start(g)
    const p = call()
    await waitFor(() => g.started() === 1, 5000, 'the synthesis to start')
    await advanceSteps(clock, 20_000, 20_000, h.bridge.client)
    await p
    g.finish({ ok: false, reason: 'command failed (exit 1)' })
    await waitFor(() => lines.some((l) => l.includes('command failed (exit 1)')), 5000, 'the failure to be logged')
    expect(voiceFrames()).toHaveLength(0)
    expect(textFrames()).toHaveLength(1)
  })

  test('the wait is injectable: with 5 s the text goes out at 5 s', async () => {
    const g = gated()
    const { clock } = await start(g, { replyWaitMs: 5000 })
    const p = call()
    await waitFor(() => g.started() === 1, 5000, 'the synthesis to start')
    await advanceSteps(clock, 5000, 5000, h.bridge.client)
    await p
    expect((await delivered('full text')).attachments).toHaveLength(0)
  })

  test('reply syntheses share the read-aloud limit: with one slot the second waits for the first', async () => {
    const g = gated()
    await start(g, { maxParallel: 1 })
    const first = call()
    await waitFor(() => g.started() === 1, 5000, 'the first synthesis')
    const second = h.bridge.callTool('reply', { thread_id: 'general', text: 'second', voice_text: 'two' })
    await Bun.sleep(150) // timing-ok: nothing to wait on; this shows that a second synthesis did NOT start
    expect(g.started()).toBe(1)
    g.finish(g.audio())
    await waitFor(() => g.started() === 1, 5000, 'the second synthesis, once the slot is free')
    g.finish(g.audio())
    await Promise.all([first, second])
  })
})
