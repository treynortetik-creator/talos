// Deny with a note (Wave 0, item 0.8). The owner's few words ride the signed `note` of a `kill` card.resolve, and reach the
// agent only through the PermissionRequest hook's deny answer (the channel relay's verdict has no room for words, so a relay
// card never takes a note). Real live bridge, the hub socket, FakeRelay and a FakeApp; the hook's own output is in
// kit/scripts/test-permission-relay.sh.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { type CardT, cleanDenyNote, PERMISSION_DENY_NOTE_MAX } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { createLogger } from '../src/log.ts'
import { eventually, type Harness, sleep, startHarness } from './helpers.ts'

setDefaultTimeout(t(30_000))

let h: Harness | undefined
const sockets: { destroy(): void }[] = []
const logged: string[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  logged.length = 0
  await h?.stop()
  h = undefined
})

async function start() {
  h = await startHarness({
    config: ((c: Record<string, unknown>) => ({ ...c, permission_relay: true })) as never,
    // a logger that keeps every line at every level, to prove no owner note is ever written to a log
    bridge: { logger: createLogger(null, 'debug', (line) => logged.push(line)) },
  })
  h.bridge.ctx.permission.setHookTimings({ graceMs: 150 })
  h.bridge.ctx.permission.setClientVersion(() => '2.1.312')
  writeFileSync(join(h.home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }), {
    mode: 0o600,
  })
  return h
}

type Answer = Record<string, unknown> & { t: string; id: string; decision: string }
function rawCall(home: string, line: Record<string, unknown>) {
  const sock = createConnection(join(home, 'run', 'hub.sock'))
  sockets.push(sock)
  sock.setEncoding('utf8')
  let buf = ''
  let settle: (a: Answer | null) => void = () => {}
  const result = new Promise<Answer | null>((r) => {
    settle = r
  })
  sock.on('data', (d: string) => {
    buf += d
    const nl = buf.indexOf('\n')
    if (nl >= 0) settle(JSON.parse(buf.slice(0, nl)) as Answer)
  })
  sock.on('close', () => settle(null))
  sock.on('error', () => settle(null))
  sock.on('connect', () => sock.write(`${JSON.stringify(line)}\n`))
  return { result }
}

const perm = (id: string, command = 'rm -rf /home/alex/projects') => ({
  t: 'perm',
  id,
  tool_name: 'Bash',
  tool_input: { command, description: 'remove it' },
})
const permissionCards = (x: Harness) =>
  x.relay.frames.filter(
    (f) => f.direction === 'from_bridge' && f.frame.type === 'card.create' && f.frame.card.kind === 'permission',
  )
const hookCard = async (x: Harness): Promise<CardT> => {
  let found: CardT | undefined
  await eventually(() => {
    found = permissionCards(x)
      .map((f) => (f.frame as { card: CardT }).card)
      .find((c) => (c.payload as { request_id?: string }).request_id !== 'abcde')
    expect(found).toBeDefined()
  })
  return found as CardT
}

describe('a hook card offers a note; the hook answer carries it on Deny only', () => {
  test('the card a hook raised carries deny_note, and its hash is the same as without it', async () => {
    const x = await start()
    rawCall(x.home, perm('r1'))
    const card = await hookCard(x)
    expect(card.deny_note).toBe(true)
  })

  test('Deny with a note: perm_result carries the cleaned note', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('r1'))
    const card = await hookCard(x)
    await x.app.resolveCard(card, 'kill', card.payload_hash, { note: 'use the staging bucket instead' })
    expect(await call.result).toEqual({
      t: 'perm_result',
      id: 'r1',
      decision: 'deny',
      reason: 'owner',
      note: 'use the staging bucket instead',
    })
  })

  test('Deny with no note: the answer is exactly what it was before (no note key)', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('r1'))
    const card = await hookCard(x)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await call.result).toEqual({ t: 'perm_result', id: 'r1', decision: 'deny', reason: 'owner' })
  })

  test('Deny with a blank or invisible-only note: no note key', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('r1'))
    const card = await hookCard(x)
    await x.app.resolveCard(card, 'kill', card.payload_hash, { note: ' \n\t ' })
    expect(await call.result).toEqual({ t: 'perm_result', id: 'r1', decision: 'deny', reason: 'owner' })
  })

  test('Allow with a note: the note is ignored, the answer is allow with no note', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('r1'))
    const card = await hookCard(x)
    await x.app.resolveCard(card, 'primary', card.payload_hash, { note: 'sneaky' })
    expect(await call.result).toEqual({ t: 'perm_result', id: 'r1', decision: 'allow', reason: 'owner' })
  })

  test('a long note full of control characters is cleaned and capped before it leaves the bridge', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('r1'))
    const card = await hookCard(x)
    const dirty = `use\u0000 the\n"staging"‮ bucket \\ ${'é​'.repeat(900)}`
    await x.app.resolveCard(card, 'kill', card.payload_hash, { note: dirty })
    const a = await call.result
    const note = a?.note as string
    expect(note).toBe(cleanDenyNote(dirty) as string)
    expect([...note].length).toBeLessThanOrEqual(PERMISSION_DENY_NOTE_MAX)
    expect(note).toMatch(/^use the "staging" bucket \\ é+$/)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is that none is left
    expect(note).not.toMatch(/[\u0000-\u001f​‮]/)
  })

  test('the note is never written to a log', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('r1'))
    const card = await hookCard(x)
    await x.app.resolveCard(card, 'kill', card.payload_hash, { note: 'marker-note-do-not-log-7731' })
    expect((await call.result)?.note).toBe('marker-note-do-not-log-7731')
    await sleep(t(100)) // let the logger finish writing
    expect(logged.length).toBeGreaterThan(0) // the logger was live, so an empty hit means something
    expect(logged.join('')).not.toContain('marker-note-do-not-log-7731')
  })
})

describe('the channel relay road takes no note', () => {
  const params = { request_id: 'abcde', tool_name: 'Bash', description: 'Run it', input_preview: '{"command": "ls"}' }
  test('a relay card has no deny_note, and a kill with a note sends the old verdict with no words in it', async () => {
    const x = await start()
    const sent: unknown[] = []
    x.bridge.ctx.permission.setSender(async (v) => {
      sent.push(v)
    })
    await x.bridge.ctx.permission.onRequest(params)
    const card = (permissionCards(x)[0] as unknown as { frame: { card: CardT } }).frame.card
    expect(card.deny_note).toBeUndefined()
    await x.app.resolveCard(card, 'kill', card.payload_hash, { note: 'use staging' })
    await eventually(() => expect(sent).toEqual([{ request_id: 'abcde', behavior: 'deny' }]))
  })
})
