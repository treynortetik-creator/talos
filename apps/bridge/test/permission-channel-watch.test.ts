// Route H, second plan. A Main prompt that offers no rule is carried by the channel's card (the hook answers `relay_carries_it` and ends).
// That hook still told the bridge its call's exact tool_use id, so the bridge watches the CHANNEL card for that id's tool_result and closes
// it as `prompt_over` when a terminal Yes, No or Esc finished the call. Only when the take of the twin was unambiguous (exactly one note
// with that tool and input), only with an id, only for the Main session. Also the flash fix: a hook that ended with no word and had an id
// looks for the result in small steps for a short window before the channel card is raised again.
// (`touch probe-N` is only a synthetic hook input.)
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CardT } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { type Clock, realClock } from '../src/clock.ts'
import { eventually, type Harness, sleep, startHarness } from './helpers.ts'

setDefaultTimeout(t(30_000))

const SID = '9a7c1e52-0b3d-4f6a-8c21-5d4e3f2a1b00'
const ID = 'toolu_01AAAAAAAAAAAAAAAAAAAAAA'
const OTHER = 'toolu_01BBBBBBBBBBBBBBBBBBBBBB'
const tmps: string[] = []
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)))
  tmps.push(d)
  return d
}
const transcriptIn = (root: string) => {
  const dir = join(root, 'projects', '-srv-proj')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${SID}.jsonl`)
}
const result = (id: string) =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })}\n`
const use = (id: string) =>
  `${JSON.stringify({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'touch probe-1' } }] } })}\n`

const SESSION_PID = 4_242_424
const main = { pid: SESSION_PID, cwd: '/srv/proj' }
const RULES = [{ tool: 'Bash', content: 'touch probe-*' }]
const touch = { command: 'touch probe-1' }
const PREVIEW = '{"command": "touch probe-1"}'
const relayParams = (request_id = 'abcde') => ({
  request_id,
  tool_name: 'Bash',
  description: 'Run it',
  input_preview: PREVIEW,
})
const RELAY_IDS = new Set(['abcde', 'fghij'])

const sockets: { destroy(): void }[] = []
let h: Harness | undefined
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await h?.stop()
  h = undefined
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function start(timings: { watchMs?: number; reraiseLookMs?: number; graceMs?: number } = {}, clock?: Clock) {
  h = await startHarness({
    config: ((c: Record<string, unknown>) => ({ ...c, permission_relay: true })) as never,
    ...(clock ? { clock } : {}),
  })
  h.bridge.ctx.permission.setHookTimings({ graceMs: 150, watchMs: 40, ...timings })
  h.bridge.ctx.permission.setSessionPids([SESSION_PID])
  h.bridge.ctx.permission.setClientVersion(() => '2.1.312')
  writeFileSync(join(h.home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }), {
    mode: 0o600,
  })
  return h
}
type Answer = Record<string, unknown> & { t: string; id: string; decision: string }
function hook(home: string, line: Record<string, unknown>) {
  const sock = createConnection(join(home, 'run', 'hub.sock'))
  sockets.push(sock)
  sock.setEncoding('utf8')
  let buf = ''
  let settle: (a: Answer | null) => void = () => {}
  const answer = new Promise<Answer | null>((r) => {
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
  return { answer, close: () => sock.destroy() }
}
/** A Main hook line with NO session offer (a plain channel prompt). */
const plain = (transcript: string | undefined, over: Record<string, unknown> = {}) => ({
  t: 'perm',
  id: 'req-1',
  tool_name: 'Bash',
  tool_input: touch,
  session_id: SID,
  ...main,
  ...(transcript ? { tool_use_id: ID, transcript_path: transcript } : {}),
  ...over,
})
/** A Main hook line WITH a session offer (hook-wins: its card replaces the twin). */
const offer = (transcript: string) => plain(transcript, { suggest: { rules: RULES } })

const created = (x: Harness) =>
  x.relay.frames
    .filter(
      (f) => f.direction === 'from_bridge' && f.frame.type === 'card.create' && f.frame.card.kind === 'permission',
    )
    .map((f) => (f.frame as { card: CardT }).card)
const isRelay = (c: CardT) => RELAY_IDS.has((c.payload as { request_id?: string }).request_id ?? '')
const hookCards = (x: Harness) => created(x).filter((c) => !isRelay(c))
const relayCards = (x: Harness) => created(x).filter(isRelay)
const expiredReason = (x: Harness, cardId: string) =>
  (
    x.relay.frames.find(
      (f) =>
        f.direction === 'from_bridge' &&
        f.frame.type === 'card.update' &&
        f.frame.card_id === cardId &&
        f.frame.state === 'expired',
    )?.frame as { reason?: string } | undefined
  )?.reason
const watching = (x: Harness) => (x.bridge.ctx.permission as unknown as { watches: Map<string, unknown> }).watches.size
const quiet = () => sleep(t(400)) // timing-ok: negative window: the card must stay, nothing else is raised
const pendingPerm = (x: Harness) => x.bridge.ctx.ledger.list('pending').filter((r) => r.binding.kind === 'permission')

/** The channel card is out; then a plain Main hook arrives with the transcript: it is answered relay_carries_it. */
async function carried(x: Harness, line: (f: string) => Record<string, unknown>, content = use(ID)) {
  const f = transcriptIn(tmp('ch-'))
  writeFileSync(f, content)
  await x.bridge.ctx.permission.onRequest(relayParams())
  const card = relayCards(x)[0] as CardT
  const call = hook(x.home, line(f))
  expect(await call.answer).toMatchObject({ t: 'perm_result', decision: 'none', reason: 'relay_carries_it' })
  return { f, card, call }
}

describe('a plain channel card is closed by its own call’s result', () => {
  test('the hook is answered relay_carries_it; the result for the id then closes the CHANNEL card as prompt_over', async () => {
    const x = await start()
    const { f, card } = await carried(x, (p) => plain(p))
    await eventually(() => expect(watching(x)).toBe(1))
    await quiet()
    expect(expiredReason(x, card.id)).toBeUndefined()
    appendFileSync(f, result(ID))
    await eventually(() => expect(expiredReason(x, card.id)).toBe('prompt_over'))
    expect(watching(x)).toBe(0)
    expect(pendingPerm(x)).toHaveLength(0)
    expect(x.bridge.ctx.permission.openCount).toBe(0) // its request id is closed: a late tap is refused
    await quiet()
    expect(relayCards(x)).toHaveLength(1)
    expect(hookCards(x)).toHaveLength(0)
  })

  test('the result is already in the file when the hook arrives: the card closes at the first look', async () => {
    const x = await start()
    const { card } = await carried(x, (p) => plain(p), use(ID) + result(ID))
    await eventually(() => expect(expiredReason(x, card.id)).toBe('prompt_over'))
  })

  test('no id on the hook request: the channel card stays, nothing is watched', async () => {
    const x = await start()
    const { f, card } = await carried(x, () => plain(undefined))
    appendFileSync(f, result(ID))
    await quiet()
    expect(expiredReason(x, card.id)).toBeUndefined()
    expect(watching(x)).toBe(0)
    expect(pendingPerm(x)).toHaveLength(1)
  })

  test("another call's result does not close it", async () => {
    const x = await start()
    const { f, card } = await carried(x, (p) => plain(p))
    appendFileSync(f, result(OTHER))
    await quiet()
    expect(expiredReason(x, card.id)).toBeUndefined()
    expect(watching(x)).toBe(1)
  })

  test('two channel cards with the same tool and input when the hook takes one: nothing is watched', async () => {
    const x = await start()
    const f = transcriptIn(tmp('ch-'))
    writeFileSync(f, use(ID))
    await x.bridge.ctx.permission.onRequest(relayParams('abcde'))
    await x.bridge.ctx.permission.onRequest(relayParams('fghij'))
    expect(relayCards(x)).toHaveLength(2)
    const call = hook(x.home, plain(f))
    expect(await call.answer).toMatchObject({ decision: 'none', reason: 'relay_carries_it' })
    appendFileSync(f, result(ID))
    await quiet()
    expect(watching(x)).toBe(0)
    expect(pendingPerm(x)).toHaveLength(2)
  })

  test('a hook that is not the Main session’s (no pid) never watches a channel card', async () => {
    const x = await start()
    const f = transcriptIn(tmp('ch-'))
    writeFileSync(f, use(ID))
    await x.bridge.ctx.permission.onRequest(relayParams())
    const channel = relayCards(x)[0] as CardT
    hook(x.home, plain(f, { pid: undefined })) // not provably the channel's session: a card of its own
    await eventually(() => expect(hookCards(x)).toHaveLength(1))
    expect(watching(x)).toBe(1) // its own card only
    appendFileSync(f, result(ID))
    await eventually(() => expect(expiredReason(x, (hookCards(x)[0] as CardT).id)).toBe('prompt_over'))
    expect(expiredReason(x, channel.id)).toBeUndefined()
    expect(pendingPerm(x)).toHaveLength(1)
  })

  test('answered on the phone: the watch is gone and a later result does nothing', async () => {
    const x = await start()
    x.bridge.ctx.permission.setSender(async () => {})
    const { f, card } = await carried(x, (p) => plain(p))
    await eventually(() => expect(watching(x)).toBe(1))
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(watching(x)).toBe(0))
    appendFileSync(f, result(ID))
    await quiet()
    expect(expiredReason(x, card.id)).toBeUndefined()
  })

  test('no channel card at all: the hook makes its own card, armed as before', async () => {
    const x = await start()
    const f = transcriptIn(tmp('ch-'))
    writeFileSync(f, use(ID))
    hook(x.home, plain(f))
    await eventually(() => expect(hookCards(x)).toHaveLength(1))
    expect(watching(x)).toBe(1)
    appendFileSync(f, result(ID))
    await eventually(() => expect(expiredReason(x, (hookCards(x)[0] as CardT).id)).toBe('prompt_over'))
  })
})

describe('the flash fix: a short look before the channel card is raised again', () => {
  /** A twin replaced by an armed hook card (hook-wins); returns the hook. */
  async function replaced(x: Harness) {
    const f = transcriptIn(tmp('fl-'))
    writeFileSync(f, use(ID))
    await x.bridge.ctx.permission.onRequest(relayParams())
    const first = relayCards(x)[0] as CardT
    const call = hook(x.home, offer(f))
    await eventually(() => expect(hookCards(x)).toHaveLength(1))
    await eventually(() => expect(expiredReason(x, first.id)).toBe('replaced_by_hook'))
    return { f, call, card: hookCards(x)[0] as CardT }
  }

  test('the result is written a little AFTER the hook ended: no channel card is raised at all', async () => {
    const x = await start({ reraiseLookMs: t(600) })
    const { f, call, card } = await replaced(x)
    call.close()
    await eventually(() => expect(expiredReason(x, card.id)).toBe('hook_gone'))
    await sleep(t(200)) // timing-ok: the result comes after the stop, inside the window
    appendFileSync(f, result(ID))
    await sleep(t(900)) // timing-ok: past the window
    expect(relayCards(x)).toHaveLength(1)
    expect(pendingPerm(x)).toHaveLength(0)
    expect(watching(x)).toBe(0)
  })

  test('no result within the window: the card is raised after it, and watched', async () => {
    const x = await start({ reraiseLookMs: t(300) })
    const { call } = await replaced(x)
    call.close()
    await sleep(t(100)) // timing-ok: still inside the window
    expect(relayCards(x)).toHaveLength(1)
    await eventually(() => expect(relayCards(x)).toHaveLength(2))
    await eventually(() => expect(watching(x)).toBe(1))
  })

  test('the bridge stopping during the window raises nothing', async () => {
    const x = await start({ reraiseLookMs: t(500) })
    const { call } = await replaced(x)
    call.close()
    await sleep(t(100)) // timing-ok: inside the window
    x.bridge.ctx.permission.closeAll()
    await sleep(t(900)) // timing-ok: past the window
    expect(relayCards(x)).toHaveLength(1)
  })

  test('no id: raised at once, no delay', async () => {
    const x = await start({ reraiseLookMs: t(5000) })
    const f = transcriptIn(tmp('fl-'))
    writeFileSync(f, use(ID))
    await x.bridge.ctx.permission.onRequest(relayParams())
    const call = hook(x.home, plain(undefined, { suggest: { rules: RULES } }))
    await eventually(() => expect(hookCards(x)).toHaveLength(1))
    call.close()
    await sleep(t(500)) // timing-ok: well inside what a delay would be
    expect(relayCards(x)).toHaveLength(2)
  })
})

type Perm = {
  watches: Map<string, unknown>
  recentRelay: { cardId: string }[]
  startWatch(cardId: string, w: { poll(): boolean }): void
}
const internals = (x: Harness) => x.bridge.ctx.permission as unknown as Perm
/** Holds the FIRST card send until `release()`: a channel card whose send is slow (the hook's wait for it spans other requests). */
function slowFirstSend(x: Harness) {
  const tr = x.bridge.ctx.transport as unknown as { sendDurable: (f: unknown) => Promise<unknown> }
  const orig = tr.sendDurable.bind(tr)
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  let first = true
  tr.sendDurable = async (f) => {
    if (first) {
      first = false
      await gate
    }
    return orig(f)
  }
  return { release: () => release() }
}
const lineFor = (f: string, id: string, tool: string) => plain(f, { id, tool_use_id: tool })

describe('pairing follows identity: any other note with the same tool and input in the window blocks the watch', () => {
  test('crossed order: the first hook takes the first note before the second is noted, the second hook takes the second: neither card is watched', async () => {
    const x = await start()
    const f = transcriptIn(tmp('ch-'))
    writeFileSync(f, use(ID) + use(OTHER))
    await x.bridge.ctx.permission.onRequest(relayParams('abcde')) // c1
    const b = hook(x.home, lineFor(f, 'req-b', OTHER))
    expect(await b.answer).toMatchObject({ reason: 'relay_carries_it' })
    await x.bridge.ctx.permission.onRequest(relayParams('fghij')) // c2, noted after B took c1
    const a = hook(x.home, lineFor(f, 'req-a', ID))
    expect(await a.answer).toMatchObject({ reason: 'relay_carries_it' })
    appendFileSync(f, result(ID)) // A is answered at the terminal
    await quiet()
    expect(pendingPerm(x)).toHaveLength(2) // B's prompt is still open: its card must not be closed
    expect(watching(x)).toBe(0)
  })

  test('a second identical note arriving while the first card is still being sent blocks it', async () => {
    const x = await start()
    const f = transcriptIn(tmp('ch-'))
    writeFileSync(f, use(ID))
    const slow = slowFirstSend(x)
    const first = x.bridge.ctx.permission.onRequest(relayParams('abcde'))
    const call = hook(x.home, plain(f))
    await sleep(t(80)) // timing-ok: the hook has taken the note and waits for its send
    await x.bridge.ctx.permission.onRequest(relayParams('fghij'))
    slow.release()
    await first
    expect(await call.answer).toMatchObject({ reason: 'relay_carries_it' })
    appendFileSync(f, result(ID))
    await quiet()
    expect(pendingPerm(x)).toHaveLength(2)
    expect(watching(x)).toBe(0)
  })

  test('crossed order with the first send held for over 15 s: the first card’s own entry is still counted', async () => {
    // the test's own clock: real time and real timers, plus a skew it moves (never the shared realClock, which every later file reads)
    let skew = 0
    const clock: Clock = { ...realClock, now: () => realClock.now() + skew }
    const x = await start({}, clock)
    const f = transcriptIn(tmp('ch-'))
    writeFileSync(f, use(ID) + use(OTHER))
    const slow = slowFirstSend(x)
    const first = x.bridge.ctx.permission.onRequest(relayParams('abcde')) // c1, its send is held
    const b = hook(x.home, lineFor(f, 'req-b', OTHER)) // takes c1 and waits for its send
    await sleep(t(80)) // timing-ok: the hook has taken the note
    skew += 10_000
    await x.bridge.ctx.permission.onRequest(relayParams('fghij')) // c2, 10 s later
    skew += 10_000 // 20 s after c1: c1's request is older than the 15 s window seen from now
    slow.release()
    await first
    expect(await b.answer).toMatchObject({ reason: 'relay_carries_it' })
    appendFileSync(f, result(OTHER))
    await quiet()
    expect(pendingPerm(x)).toHaveLength(2)
    expect(watching(x)).toBe(0)
  })

  test('the hook comes before its note (it waits out the grace): one note pairs', async () => {
    const x = await start({ graceMs: t(1500) })
    const f = transcriptIn(tmp('ch-'))
    writeFileSync(f, use(ID))
    const call = hook(x.home, plain(f))
    await sleep(t(80)) // timing-ok: the hook is waiting
    await x.bridge.ctx.permission.onRequest(relayParams('abcde'))
    expect(await call.answer).toMatchObject({ reason: 'relay_carries_it' })
    await eventually(() => expect(watching(x)).toBe(1))
  })

  test('the hook comes before its notes and two arrive together: nothing is watched', async () => {
    const x = await start({ graceMs: t(1500) })
    const f = transcriptIn(tmp('ch-'))
    writeFileSync(f, use(ID))
    const call = hook(x.home, plain(f))
    await sleep(t(80)) // timing-ok: the hook is waiting
    void x.bridge.ctx.permission.onRequest(relayParams('abcde'))
    await x.bridge.ctx.permission.onRequest(relayParams('fghij'))
    expect(await call.answer).toMatchObject({ reason: 'relay_carries_it' })
    appendFileSync(f, result(ID))
    await quiet()
    expect(pendingPerm(x)).toHaveLength(2)
    expect(watching(x)).toBe(0)
  })

  test('an older untaken note of the same call (within 15 s) means the newer card is not watched either', async () => {
    const x = await start()
    const f = transcriptIn(tmp('ch-'))
    writeFileSync(f, use(ID))
    await x.bridge.ctx.permission.onRequest(relayParams('abcde')) // an earlier prompt's card nobody took
    await x.bridge.ctx.permission.onRequest(relayParams('fghij'))
    const call = hook(x.home, plain(f))
    expect(await call.answer).toMatchObject({ reason: 'relay_carries_it' })
    appendFileSync(f, result(ID))
    await quiet()
    expect(pendingPerm(x)).toHaveLength(2)
    expect(watching(x)).toBe(0)
  })

  test('a note a hook already took still counts: the next identical prompt’s card is not watched', async () => {
    const x = await start()
    const f = transcriptIn(tmp('ch-'))
    writeFileSync(f, use(ID) + use(OTHER))
    await x.bridge.ctx.permission.onRequest(relayParams('abcde'))
    expect(await hook(x.home, lineFor(f, 'req-1', ID)).answer).toMatchObject({ reason: 'relay_carries_it' })
    await x.bridge.ctx.permission.onRequest(relayParams('fghij'))
    expect(await hook(x.home, lineFor(f, 'req-2', OTHER)).answer).toMatchObject({ reason: 'relay_carries_it' })
    appendFileSync(f, result(OTHER))
    await quiet()
    expect(pendingPerm(x)).toHaveLength(2)
  })

  test('the channel card closes between the take and the attach: nothing is watched, nothing throws', async () => {
    const x = await start()
    const f = transcriptIn(tmp('ch-'))
    writeFileSync(f, use(ID))
    const slow = slowFirstSend(x)
    const first = x.bridge.ctx.permission.onRequest(relayParams('abcde'))
    const call = hook(x.home, plain(f))
    await sleep(t(80)) // timing-ok: the hook waits for the send
    const id = (x.bridge.ctx.ledger.list('pending')[0] as { id: string }).id
    x.bridge.ctx.permission.onCardGone(id)
    slow.release()
    await first
    // the card is gone, so it carries nothing: the hook makes a card of its own (watched on its own), the channel card is not
    await eventually(() => expect(hookCards(x)).toHaveLength(1))
    await quiet()
    expect(watching(x)).toBe(1)
    expect(expiredReason(x, id)).not.toBe('prompt_over')
    call.close()
  })
})

describe('smaller things', () => {
  test('a channel card raised again is not noted as a twin (no hook can rightly take it)', async () => {
    const x = await start({ reraiseLookMs: 0 })
    const f = transcriptIn(tmp('fl-'))
    writeFileSync(f, use(ID))
    await x.bridge.ctx.permission.onRequest(relayParams())
    const call = hook(x.home, offer(f))
    await eventually(() => expect(hookCards(x)).toHaveLength(1))
    call.close()
    await eventually(() => expect(relayCards(x)).toHaveLength(2))
    const again = (relayCards(x)[1] as CardT).id
    expect(internals(x).recentRelay.some((r) => r.cardId === again)).toBe(false)
  })

  test('one card never gets two watch loops: starting a second replaces the first', async () => {
    const x = await start()
    const { card } = await carried(x, () => plain(undefined))
    let first = 0
    let second = 0
    internals(x).startWatch(card.id, {
      poll: () => {
        first++
        return false
      },
    })
    internals(x).startWatch(card.id, {
      poll: () => {
        second++
        return false
      },
    })
    await sleep(t(150)) // timing-ok: several polls pass
    const at = first
    await sleep(t(200)) // timing-ok: the first loop must be dead
    expect(first).toBe(at)
    expect(second).toBeGreaterThan(2)
    expect(watching(x)).toBe(1)
  })

  test('the relay switched off during the look window: nothing is raised', async () => {
    const x = await start({ reraiseLookMs: t(500) })
    const f = transcriptIn(tmp('fl-'))
    writeFileSync(f, use(ID))
    await x.bridge.ctx.permission.onRequest(relayParams())
    const call = hook(x.home, offer(f))
    await eventually(() => expect(hookCards(x)).toHaveLength(1))
    call.close()
    await sleep(t(100)) // timing-ok: inside the window
    x.bridge.ctx.permission.markDeclared(false) // the relay is off from here on
    await sleep(t(900)) // timing-ok: past the window
    expect(relayCards(x)).toHaveLength(1)
  })
})
