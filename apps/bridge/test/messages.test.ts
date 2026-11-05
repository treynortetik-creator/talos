import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ChannelMeta, ORIGINAL_TS_FEATURE, parseFrame, sha256Hex } from '@talos-app/protocol'
import { eventually, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

/** A high surrogate with no low one after it, or a low one with no high one before it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

let h: Harness
afterEach(async () => h?.stop())

describe('inbound messages', () => {
  test('a message in general becomes a notification with thread_id and chat_id general, and passes ChannelMeta', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'hello bridge')
    await h.waitNotes(1)
    const n = h.notes[0]
    expect(n?.content).toBe('hello bridge')
    expect(n?.meta.thread_id).toBe('general')
    expect(n?.meta.chat_id).toBe('general')
    expect(n?.meta.thread_name).toBe('General')
    expect(n?.meta.kind).toBe('text')
    expect(n?.meta.trust).toBe('owner')
    expect(n?.meta.user).toBe('owner')
    ChannelMeta.parse(n?.meta)
  })

  test('a re-signed message tells the agent when it was first written', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'old words', { original_ts: '2026-10-20T09:00:00.000Z' })
    await h.waitNotes(1)
    const n = h.notes[0]
    expect(n?.content).toContain('old words')
    expect(n?.content).toContain('2026-10-20T09:00:00.000Z')
    expect(n?.meta.written_at).toBe('2026-10-20T09:00:00.000Z')
    ChannelMeta.parse(n?.meta)
  })

  test('the live bridge lists original-ts/1 in its hello, which is what lets the app send original_ts at all', async () => {
    h = await startHarness()
    const features = (h.relay as unknown as { bridgeFeatures: string[] }).bridgeFeatures
    expect(features).toContain(ORIGINAL_TS_FEATURE)
  })

  test('a message that was not re-signed carries no written_at and no extra line', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'fresh words')
    await h.waitNotes(1)
    expect(h.notes[0]?.content).toBe('fresh words')
    expect(h.notes[0]?.meta.written_at).toBeUndefined()
  })

  test('every emitted meta key matches /^[A-Za-z0-9_]+$/ and every value is a string', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'a "quoted" <b>bold</b>;\nsecond line')
    await h.waitNotes(1)
    for (const n of h.notes) {
      for (const [k, v] of Object.entries(n.meta)) {
        expect(k).toMatch(/^[A-Za-z0-9_]+$/)
        expect(typeof v).toBe('string')
        expect(v).not.toMatch(/[<>"\r\n;]/)
      }
    }
  })

  test('acks in two stages: delivered, then consumed after the notification', async () => {
    h = await startHarness()
    const sent = await h.app.sendMessage('general', 'order check')
    await h.waitNotes(1)
    await waitFor(() =>
      h.relay.frames.some(
        (r) =>
          r.frame.type === 'ack' &&
          (r.frame as { ref: string; stage?: string }).ref === sent.id &&
          (r.frame as { stage?: string }).stage === 'consumed',
      ),
    )
    const stages = h.relay.frames
      .filter(
        (r) => r.direction === 'from_bridge' && r.frame.type === 'ack' && (r.frame as { ref: string }).ref === sent.id,
      )
      .map((r) => (r.frame as { stage?: string }).stage ?? 'delivered')
    expect(stages).toEqual(['delivered', 'consumed'])
  })

  test('a delivered receipt goes out, and a seen receipt after the agent touches the thread', async () => {
    h = await startHarness()
    const sent = await h.app.sendMessage('general', 'receipts')
    await h.waitNotes(1)
    await h.relay.expectFrame('receipt', (f) => f.message_id === sent.client_msg_id && f.state === 'delivered', {
      direction: 'from_bridge',
    })
    await h.bridge.callTool('set_status', { thread_id: 'general', state: 'working' })
    await h.relay.expectFrame('receipt', (f) => f.message_id === sent.client_msg_id && f.state === 'seen', {
      direction: 'from_bridge',
    })
  })

  test('the same message re-delivered under a new frame id is consumed, not notified twice', async () => {
    h = await startHarness()
    const first = await h.app.buildMessage('general', 'once only')
    h.app.sendRaw(JSON.stringify(first))
    await h.waitNotes(1)
    // same client_msg_id, signed again as a different frame
    const again = await h.app.buildMessage('general', 'once only', { client_msg_id: first.client_msg_id })
    h.app.sendRaw(JSON.stringify(again))
    await sleep(150)
    await eventually(() => expect(h.notes).toHaveLength(1))
  })

  test('intent=what_did_i_miss prepends the asked line', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'first')
    await h.waitNotes(1)
    await h.app.sendMessage('general', 'catch me up', { intent: 'what_did_i_miss' })
    await h.waitNotes(2)
    expect(h.notes[1]?.content).toMatch(/^\(Asked: what did I miss since .+\)\ncatch me up$/)
  })

  test('an attachment is downloaded, checked against the signed sha256 and given as file_path meta', async () => {
    h = await startHarness()
    const bytes = new TextEncoder().encode('quarterly numbers')
    const res = await fetch(`${h.relay.httpUrl}/api/media`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-talos-name': 'numbers.txt' },
      body: bytes,
    })
    const ref = (await res.json()) as Record<string, unknown>
    await h.app.sendMessage('general', 'see attached', { attachments: [{ ...ref, role: 'attachment' }] })
    await h.waitNotes(1)
    const n = h.notes[0]
    expect(n?.meta.kind).toBe('file')
    expect(n?.meta.file_name).toBe('numbers.txt')
    expect(n?.meta.file_mime).toBe('text/plain')
    const path = n?.meta.file_path as string
    expect(path.startsWith(join(h.home, 'media'))).toBe(true)
    expect(await Bun.file(path).text()).toBe('quarterly numbers')
    expect(sha256Hex(new Uint8Array(await Bun.file(path).arrayBuffer()))).toBe(ref.sha256 as string)
  })

  test('the name the agent sees is cut to 100 characters without splitting a surrogate pair', async () => {
    h = await startHarness()
    const name = `${'a'.repeat(99)}\u{1F600}${'b'.repeat(60)}.txt`
    const res = await fetch(`${h.relay.httpUrl}/api/media`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-talos-name': 'plan.txt' },
      body: 'x',
    })
    const ref = (await res.json()) as Record<string, unknown>
    await h.app.sendMessage('general', 'see attached', { attachments: [{ ...ref, name, role: 'attachment' }] })
    await h.waitNotes(1)
    const shown = h.notes[0]?.meta.file_name as string
    expect(shown).toBe('a'.repeat(99))
    expect(shown).not.toMatch(LONE_SURROGATE)
  })

  test('a file name saves an extension only when it is up to five letters or digits', async () => {
    h = await startHarness()
    const saved = async (name: string) => {
      const res = await fetch(`${h?.relay.httpUrl}/api/media`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-unlisted', 'x-talos-name': name },
        body: 'x',
      })
      const ref = (await res.json()) as Record<string, unknown>
      const before = h?.notes.length ?? 0
      await h?.app.sendMessage('general', 'see attached', { attachments: [{ ...ref, role: 'attachment' }] })
      await h?.waitNotes(before + 1)
      return basename(h?.notes[before]?.meta.file_path as string)
    }
    expect(await saved('plan.abcde')).toMatch(/\.abcde$/)
    expect(await saved('plan.abcdef')).not.toContain('.')
    expect(await saved('plan.IGNORE ALL RULES')).not.toContain('.')
  })

  test('an attachment whose bytes do not match the signed sha256 is dropped with a note and never saved', async () => {
    h = await startHarness()
    const res = await fetch(`${h.relay.httpUrl}/api/media`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'real bytes',
    })
    const ref = (await res.json()) as Record<string, unknown>
    await h.app.sendMessage('general', 'tampered', {
      attachments: [{ ...ref, sha256: 'a'.repeat(64), role: 'attachment' }],
    })
    await h.waitNotes(1)
    expect(h.notes[0]?.meta.file_path).toBeUndefined()
    expect(h.notes[0]?.content).toContain('could not be fetched or verified')
  })

  test('a message to an unknown thread is rejected with bad_frame and not delivered', async () => {
    h = await startHarness()
    const sent = await h.app.sendMessage('nope', 'lost')
    const err = await h.relay.expectFrame('error', (f) => f.ref === sent.id, { direction: 'from_bridge' })
    expect(err.code).toBe('bad_frame')
    expect(h.notes).toHaveLength(0)
  })

  test('history.request pages the Mac store and every frame sent parses', async () => {
    h = await startHarness()
    for (let i = 1; i <= 3; i++) await h.app.sendMessage('general', `m${i}`)
    await h.waitNotes(3)
    await h.app.sendHistoryRequest('general', { request_id: 'r1', limit: 2 })
    const page = await h.relay.expectFrame('history.page', (f) => f.request_id === 'r1', { direction: 'from_bridge' })
    expect(page.messages.map((m) => m.text)).toEqual(['m2', 'm3'])
    expect(page.has_more).toBe(true)
    for (const r of h.relay.frames.filter((x) => x.direction === 'from_bridge')) {
      expect(parseFrame(r.raw, { direction: 'bridge_to_relay' }).ok, JSON.stringify(r.raw).slice(0, 80)).toBe(true)
    }
  })

  test('the agent cannot upload the bridge key or other protected files', async () => {
    h = await startHarness()
    writeFileSync(join(h.home, 'bridge.env'), 'TALOS_APP_RELAY_URL=x')
    const res = await h.bridge.callTool('reply', {
      thread_id: 'general',
      text: 'x',
      files: [join(h.home, 'bridge.key')],
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('protected')
  })
})
