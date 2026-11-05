import { afterEach, describe, expect, test } from 'bun:test'
import { challengeHostOk } from '../src/handshake.ts'
import {
  backlogNotification,
  cardActionNotification,
  cleanMeta,
  fileMeta,
  shareItemNotification,
  textNotification,
} from '../src/notify.ts'
import { backoffMs } from '../src/relay-client.ts'
import { ChannelMeta, loadFrameFixturesForTests } from './fixtures-protocol.ts'
import { eventually, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

describe('notification meta', () => {
  test('cleanMeta stringifies, drops undefined, replaces <>"; and newlines with _, and refuses hyphenated keys', () => {
    expect(cleanMeta({ a: 'x"y<z>;\r\nq', n: 5, t: true, u: undefined })).toEqual({
      a: 'x_y_z____q',
      n: '5',
      t: 'true',
    })
    expect(() => cleanMeta({ 'bad-key': 'x' })).toThrow()
    expect(() => cleanMeta({ 'bad key': 'x' })).toThrow()
  })

  test('a thread name with quotes, angle brackets, semicolons and newlines is sanitized in every meta value', async () => {
    h = await startHarness({
      config: (c) => ({
        ...c,
        threads: c.threads.map((t) => (t.id === 'general' ? { ...t, name: 'Ops "<b>x</b>";\nz' } : t)),
      }),
    })
    await h.app.sendMessage('general', 'hi')
    await h.waitNotes(1)
    expect(h.notes[0]?.meta.thread_name).toBe('Ops __b_x_/b____z')
    for (const v of Object.values(h.notes[0]?.meta ?? {})) expect(v).not.toMatch(/[<>"\r\n;]/)
    ChannelMeta.parse(h.notes[0]?.meta)
  })

  test('file meta uses file_path, file_path_2 ... file_path_10 and only the first file names mime and name', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ path: `/m/${i}`, mime: `m/${i}`, name: `n${i}` }))
    const m = fileMeta(files)
    expect(Object.keys(m)).toEqual([
      'file_path',
      ...Array.from({ length: 9 }, (_, i) => `file_path_${i + 2}`),
      'file_mime',
      'file_name',
    ])
    expect(m.file_mime).toBe('m/0')
  })

  test('files past the tenth are named in the text of a message, a backlog and a share, so no path is lost', () => {
    const thread = { id: 'general', name: 'General' }
    const files = Array.from({ length: 13 }, (_, i) => ({
      path: `/inbox/f${i + 1}.bin`,
      mime: 'a/b',
      name: `n${i + 1}`,
    }))
    const meta = (n: { meta: Record<string, string | undefined> }) => Object.values(n.meta)
    const seen = (n: { content: string; meta: Record<string, string | undefined> }) =>
      files.filter((f) => n.content.includes(f.path) || meta(n).includes(f.path)).length
    const text = textNotification({ thread, messageId: 'm_1', ts: '2026-10-28T10:00:00.000Z', text: 'look', files })
    const backlog = backlogNotification({
      items: [{ thread, messageId: 'm_1', at: '2026-10-28T10:00:00.000Z', text: 'look' }],
      offlineMs: 20 * 60_000,
      defaultThread: thread,
      ts: '2026-10-28T10:20:00.000Z',
      files,
    })
    const share = shareItemNotification({
      thread,
      frame: {
        token_label: 'Shortcut',
        share_id: 's_1',
        message: { id: 'm_1', created_at: '2026-10-28T10:00:00.000Z', text: '', share_content: {} },
      } as never,
      files,
    })
    for (const n of [text, backlog, share]) {
      expect(seen(n)).toBe(13)
      for (const f of files.slice(10)) expect(n.content).toContain(f.path)
      expect(ChannelMeta.safeParse(n.meta).success).toBe(true)
    }
    // ten or fewer: nothing added
    expect(
      textNotification({ thread, messageId: 'm_1', ts: 't', text: 'look', files: files.slice(0, 10) }).content,
    ).toBe('look')
  })

  test('every builder emits only valid meta (ChannelMeta passes)', () => {
    const thread = { id: 'general', name: 'General' }
    const n1 = textNotification({
      thread,
      messageId: 'm_1',
      ts: '2026-10-28T00:00:00.000Z',
      text: 'x',
      files: [{ path: '/p', mime: 'text/plain', name: 'a.txt' }],
    })
    expect(ChannelMeta.safeParse(n1.meta).success).toBe(true)
    for (const action of ['primary', 'kill', 'revise', 'expired'] as const) {
      const n = cardActionNotification({
        thread,
        card: { id: 'c_x', title: 'T "q"\nx', primary_label: 'Go' },
        action,
        ts: '2026-10-28T00:00:00.000Z',
        edited: false,
        payloadPath: '/p',
        payloadHash: 'sha256:x',
        note: 'n',
      })
      expect(ChannelMeta.safeParse(n.meta).success, action).toBe(true)
      expect(n.content.split('\n')[0]).toContain('"T \'q\' x"')
    }
    const b = backlogNotification({
      items: [
        { thread, messageId: 'm_1', at: '2026-10-28T10:00:00.000Z', text: 'one\ntwo' },
        { thread, messageId: 'm_2', at: '2026-10-28T10:05:00.000Z', text: 'three' },
      ],
      offlineMs: 3 * 3600_000 + 12 * 60_000,
      defaultThread: thread,
      ts: '2026-10-28T13:12:00.000Z',
    })
    expect(ChannelMeta.safeParse(b.meta).success).toBe(true)
    expect(b.content).toBe(
      'Mac was offline 3 h 12 min. 2 messages arrived meanwhile (oldest first):\n- 2026-10-28 10:00Z [General · thread_id=general] one\n    two\n- 2026-10-28 10:05Z [General · thread_id=general] three',
    )
  })
})

describe('protocol fixtures', () => {
  test('every relay->bridge fixture is accepted or answered with an error, never a crash, and the bridge keeps working', async () => {
    h = await startHarness()
    const fixtures = loadFrameFixturesForTests()
    const { parseFrame } = await import('@talos-app/protocol')
    let sent = 0
    for (const [name, f] of Object.entries(fixtures)) {
      const p = parseFrame(f, { direction: 'relay_to_bridge' })
      if (!p.ok) continue // frames of other directions
      if (['challenge', 'ready', 'hello.bridge'].includes(name) || f.type === 'challenge' || f.type === 'ready')
        continue
      h.relay.sendToBridge(f, { durable: false })
      sent++
    }
    expect(sent).toBeGreaterThan(5)
    await sleep(400)
    await eventually(() => expect(h.relay.bridgeConnected).toBe(true))
    await h.app.sendMessage('general', 'still alive')
    await waitFor(() => h.notes.some((n) => n.content === 'still alive'), 4000, 'the bridge still works')
  })

  test('an unknown frame type and garbage get error{bad_frame}, never a crash; ping gets pong', async () => {
    h = await startHarness()
    h.relay.sendToBridge({ type: 'totally.unknown' }, { durable: false })
    await h.relay.expectFrame('error', (f) => f.code === 'bad_frame', { direction: 'from_bridge' })
    h.relay.sendToBridge({ type: 'ping', nonce: 'abc' }, { durable: false })
    const pong = await h.relay.expectFrame('pong', (f) => f.nonce === 'abc', { direction: 'from_bridge' })
    expect(pong.nonce).toBe('abc')
    expect(h.relay.bridgeConnected).toBe(true)
  })
})

describe('ordering, media and handshake', () => {
  test('frames buffered at the relay while the bridge was down arrive in relay order, once each', async () => {
    h = await startHarness({ startBridge: false })
    for (const [i, t] of ['A', 'B', 'C'].entries()) {
      h.relay.sendToBridge({
        ...(await h.app.buildMessage('general', t)),
        relay: { seq: i + 1, received_at: new Date().toISOString() },
      })
    }
    h.bridge.start()
    await h.waitNotes(3)
    await sleep(100)
    await eventually(() => expect(h.notes.map((n) => n.content)).toEqual(['A', 'B', 'C']))
  })

  test('media.fetch re-uploads a file the Mac still has', async () => {
    h = await startHarness()
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const p = join(h.home, 'media', 'note.txt')
    writeFileSync(p, 'old media')
    await h.bridge.callTool('attach', { thread_id: 'general', path: p })
    const f = await h.relay.expectFrame('reply', (r) => r.message.kind === 'file', { direction: 'from_bridge' })
    const id = f.message.attachments[0]?.media_id as string
    h.relay.media.delete(id)
    h.relay.sendToBridge(await h.app.buildMediaFetch(id), { durable: false })
    await waitFor(() => h.relay.media.has(id), 3000, 're-upload')
    expect(new TextDecoder().decode(h.relay.media.get(id)?.bytes)).toBe('old media')
    // an id the Mac does not know is just logged
    h.relay.sendToBridge(await h.app.buildMediaFetch('md_01JBF3V7Q8K2M4N6P8R0S2T4V6'), { durable: false })
    await sleep(100)
    await eventually(() => expect(h.relay.bridgeConnected).toBe(true))
  })

  test('the handshake refuses a challenge that names another relay host (loopback excepted)', () => {
    expect(challengeHostOk('https://relay.example.com', { relay_host: 'relay.example.com' })).toBe(true)
    expect(challengeHostOk('https://relay.example.com:8443', { relay_host: 'relay.example.com:8443' })).toBe(true)
    expect(challengeHostOk('https://relay.example.com', { relay_host: 'evil.example.net' })).toBe(false)
    expect(challengeHostOk('http://127.0.0.1:3000', { relay_host: 'anything' })).toBe(true)
  })

  test('backoff never goes below 80% of the step', () => {
    expect(backoffMs(0, () => 0)).toBe(800)
  })
})
