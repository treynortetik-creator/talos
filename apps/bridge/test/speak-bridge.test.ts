// Read aloud through the real Bridge: a signed `speak.request` from a (fake) app over the (fake) relay reaches SpeakService,
// the audio is uploaded as media on the relay, and `speak.result` comes back for the same request_id. Refusals (an unpinned
// device, a revoked one, a replayed frame, another thread's message) get no audio and no text. The voice command is a stub that
// writes a few bytes; nothing is spoken.
import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type MessageT, newId, newUlid } from '@talos-app/protocol'
import { FakeApp, mkFrame } from '@talos-app/testkit'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const TTS = JSON.stringify(['say', '-o', '{out}', '{text}'])
async function start(env: Record<string, string> = { TALOS_APP_TTS_CMD: TTS }) {
  h = await startHarness({
    env,
    bridge: {
      speak: {
        graceMs: 50,
        synth: async (_e, p) => {
          const file = join(p.media, `tts-${newId('m').slice(2)}.mp3`)
          writeFileSync(file, 'ID3-fake-audio')
          return { ok: true, path: file, ext: 'mp3', mime: 'audio/mpeg' }
        },
      },
    },
  })
  return h
}
const agentMsg = (x: Harness, text: string, thread = 'general'): MessageT => {
  const m = {
    id: newId('m'),
    thread_id: thread,
    author: 'agent',
    kind: 'text',
    text,
    format: 'markdown',
    created_at: new Date().toISOString(),
  } as unknown as MessageT
  x.bridge.ctx.store.addMessage(m)
  return m
}
const results = (x: Harness, requestId: string) =>
  x.app.rec.frames.filter(
    (r) => r.direction === 'in' && r.raw.type === 'speak.result' && r.raw.request_id === requestId,
  )
const errors = (x: Harness, ref: string) =>
  x.app.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'error' && r.raw.ref === ref)

async function askAs(app: FakeApp, m: { id: string; thread_id: string }, fresh = true) {
  const f = await app.sign({
    ...mkFrame('speak.request'),
    request_id: newUlid(),
    message_id: m.id,
    thread_id: m.thread_id,
    fresh,
  })
  app.send(f)
  return f
}

describe('speak.request through the real Bridge', () => {
  test('a signed ask for an agent message comes back ready with media the relay holds', async () => {
    const x = await start()
    const m = agentMsg(x, 'The report is finished and saved in your notes folder.')
    const f = await askAs(x.app, m)
    await waitFor(() => results(x, f.request_id as string).length > 0, 5000, 'speak.result')
    const raw = (
      results(x, f.request_id as string)[0] as unknown as { raw: { state: string; media: { media_id: string } } }
    ).raw
    expect(raw.state).toBe('ready')
    expect(x.relay.media.has(raw.media.media_id)).toBe(true)
  })

  test('a Mac with no voice command says so in words (no_tts), not "ready"', async () => {
    const x = await start({})
    const m = agentMsg(x, 'The report is finished and saved in your notes folder.')
    const f = await askAs(x.app, m)
    await waitFor(() => results(x, f.request_id as string).length > 0, 5000, 'speak.result')
    const raw = (results(x, f.request_id as string)[0] as { raw: Record<string, unknown> }).raw
    expect(raw).toMatchObject({ state: 'failed', reason: 'no_tts' })
    expect(String(raw.message)).toContain('TALOS_APP_TTS_CMD')
  })

  test("another thread's message id with the wrong thread is not found, and nothing is uploaded", async () => {
    const x = await start()
    const m = agentMsg(x, 'A private note from the plans thread, for plans only.', 'plans')
    const f = await askAs(x.app, { id: m.id, thread_id: 'general' })
    await waitFor(() => results(x, f.request_id as string).length > 0, 5000, 'speak.result')
    const raw = (results(x, f.request_id as string)[0] as { raw: Record<string, unknown> }).raw
    expect(raw).toMatchObject({ state: 'failed', reason: 'not_found' })
    expect(x.relay.media.size).toBe(0)
  })

  test('an unpinned device, a revoked device and a replayed frame get an error and no audio', async () => {
    const x = await start()
    const m = agentMsg(x, 'The report is finished and saved in your notes folder.')
    // replay: the same signed bytes twice
    const f = await x.app.sign({
      ...mkFrame('speak.request'),
      request_id: newUlid(),
      message_id: m.id,
      thread_id: m.thread_id,
      fresh: true,
    })
    const bytes = JSON.stringify(f)
    x.app.sendRaw(bytes)
    await waitFor(() => results(x, f.request_id as string).length > 0, 5000, 'first answer')
    x.app.sendRaw(bytes)
    await waitFor(() => errors(x, f.id as string).length > 0, 5000, 'replay refused')
    expect(results(x, f.request_id as string)).toHaveLength(1)
    // unpinned
    const rogue = new FakeApp({ relayWs: x.relay.wsBase })
    await rogue.connect()
    const before = x.relay.media.size
    const g = await askAs(rogue, m)
    await waitFor(
      () => rogue.rec.frames.some((r) => r.direction === 'in' && r.raw.type === 'error' && r.raw.ref === g.id),
      5000,
      'rogue refused',
    )
    expect(rogue.rec.frames.some((r) => r.raw.type === 'speak.result')).toBe(false)
    await rogue.close()
    // revoked
    x.bridge.ctx.devices.revoke(x.app.device.deviceId, new Date().toISOString())
    const k = await askAs(x.app, m)
    await waitFor(() => errors(x, k.id as string).length > 0, 5000, 'revoked refused')
    await sleep(100)
    expect(results(x, k.request_id as string)).toHaveLength(0)
    expect(x.relay.media.size).toBe(before)
  })
})
