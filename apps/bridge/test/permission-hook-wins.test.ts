// (`touch probe-N` here is only a synthetic hook input. Which commands Claude Code offers a rule for is its own choice and differs by version:
// on 2.1.332 `touch` and `rm -rf` got no rule, and `python3 -c "open('probe-N','w').close()"` did.)
// Wave 1 follow-up to item 1.10: a Main-session prompt reaches the owner by the hook road when the hook carries a valid "Allow for this
// session" offer. Claude Code asks twice for one call in the Main session (a channel permission_request and the PermissionRequest hook).
// With no offer, the relay's card carries the prompt and the hook says `relay_carries_it` (permission-hook.test.ts covers that and must
// not change). With an offer, the hook's card is raised at once, the relay's twin is replaced (`replaced_by_hook`) or, if it arrives
// later, never made; the channel side is never sent a verdict. Real live bridge, the hub socket, FakeRelay and a FakeApp.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { type CardT, sessionRulesHash } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { eventually, type Harness, sleep, startHarness } from './helpers.ts'

setDefaultTimeout(t(30_000))

const SESSION_PID = 4_242_424
const main = { pid: SESSION_PID, cwd: '/srv/proj' }
const RULES = [{ tool: 'Bash', content: 'touch probe-*' }]
const SUGGEST = { rules: RULES }
const HASH = sessionRulesHash(RULES)
const touch = { command: 'touch probe-1' }
const PREVIEW = '{"command": "touch probe-1"}'
const relayParams = (input: string, request_id = 'abcde') => ({
  request_id,
  tool_name: 'Bash',
  description: 'Run it',
  input_preview: input,
})
const RELAY_IDS = new Set(['abcde', 'fghij', 'mnopq'])

let h: Harness | undefined
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await h?.stop()
  h = undefined
})

async function start() {
  h = await startHarness({
    config: ((c: Record<string, unknown>) => ({ ...c, permission_relay: true })) as never,
  })
  h.bridge.ctx.permission.setHookTimings({ graceMs: 150 })
  h.bridge.ctx.permission.setSessionPids([SESSION_PID])
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
  return { result, close: () => sock.destroy() }
}

const permLine = (extra: Record<string, unknown> = {}, input: unknown = touch, id = 'req-1') => ({
  t: 'perm',
  id,
  tool_name: 'Bash',
  tool_input: input,
  ...extra,
})
const offerLine = (id = 'req-1', input: unknown = touch) => permLine({ ...main, suggest: SUGGEST }, input, id)

const created = (x: Harness) =>
  x.relay.frames
    .filter(
      (f) => f.direction === 'from_bridge' && f.frame.type === 'card.create' && f.frame.card.kind === 'permission',
    )
    .map((f) => (f.frame as { card: CardT }).card)
const isRelay = (c: CardT) => RELAY_IDS.has((c.payload as { request_id?: string }).request_id ?? '')
const hookCards = (x: Harness) => created(x).filter((c) => !isRelay(c))
const relayCards = (x: Harness) => created(x).filter(isRelay)
const live = (x: Harness) => x.bridge.ctx.ledger.list('pending').filter((r) => r.binding.kind === 'permission')
const expiredUpdate = (x: Harness, cardId: string) =>
  x.relay.frames.find(
    (f) =>
      f.direction === 'from_bridge' &&
      f.frame.type === 'card.update' &&
      f.frame.card_id === cardId &&
      f.frame.state === 'expired',
  )?.frame as { reason?: string } | undefined
const nextHookCard = async (x: Harness, n = 1): Promise<CardT> => {
  await eventually(() => expect(hookCards(x).length).toBeGreaterThanOrEqual(n))
  return hookCards(x)[n - 1] as CardT
}
const spy = (x: Harness) => {
  const sent: unknown[] = []
  x.bridge.ctx.permission.setSender(async (v) => {
    sent.push(v)
  })
  return sent
}
const session = (x: Harness, card: CardT) =>
  x.app.resolveCard(card, 'primary', card.payload_hash, { session: true, session_hash: HASH })

/** Holds the channel relay's card.create for the given request id until released or failed; every other frame passes. */
function holdRelaySend(x: Harness, requestId = 'abcde') {
  const tr = x.bridge.ctx.transport as unknown as { sendDurable: (f: unknown) => Promise<unknown> }
  const real = tr.sendDurable
  let release: () => void = () => {}
  let fail: () => void = () => {}
  tr.sendDurable = function (this: unknown, f: unknown) {
    const fr = f as { type: string; card?: { kind: string; payload?: { request_id?: string } } }
    if (fr.type !== 'card.create' || fr.card?.kind !== 'permission' || fr.card.payload?.request_id !== requestId)
      return real.call(this, f)
    return new Promise((res, rej) => {
      release = () => real.call(this, f).then(res, rej)
      fail = () => rej(new Error('relay down'))
    })
  }
  return { release: () => release(), fail: () => fail() }
}

/** Holds the HOOK's card.create (a request id that is not a relay one) until failed or released; the relay's frames pass. */
function holdHookSend(x: Harness) {
  const tr = x.bridge.ctx.transport as unknown as { sendDurable: (f: unknown) => Promise<unknown> }
  const real = tr.sendDurable
  let release: () => void = () => {}
  let fail: () => void = () => {}
  let started = false
  tr.sendDurable = function (this: unknown, f: unknown) {
    const fr = f as { type: string; card?: { kind: string; payload?: { request_id?: string } } }
    if (fr.type !== 'card.create' || fr.card?.kind !== 'permission' || RELAY_IDS.has(fr.card.payload?.request_id ?? ''))
      return real.call(this, f)
    started = true
    return new Promise((res, rej) => {
      release = () => real.call(this, f).then(res, rej)
      fail = () => rej(new Error('relay down'))
    })
  }
  return { release: () => release(), fail: () => fail(), started: () => started }
}
const ids = (x: Harness) =>
  x.bridge.ctx.permission as unknown as { hookOffers: Map<string, { at: number }>; recentRelay: unknown[] }

describe('a Main-session hook with an offer: the hook card wins', () => {
  test('1. the relay card already exists: the hook card is raised and the relay card is replaced', async () => {
    const x = await start()
    const sent = spy(x)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const relay = relayCards(x)[0] as CardT
    const call = rawCall(x.home, offerLine())
    const card = await nextHookCard(x)
    expect(card.session_allow).toEqual(SUGGEST)
    await eventually(() => expect(expiredUpdate(x, relay.id)?.reason).toBe('replaced_by_hook'))
    expect(live(x).map((r) => r.id)).toEqual([card.id])
    await session(x, card)
    expect(await call.result).toEqual({
      t: 'perm_result',
      id: 'req-1',
      decision: 'allow',
      reason: 'owner',
      session: true,
      session_hash: HASH,
    })
    expect(sent).toEqual([]) // the channel side was never sent a verdict
  })

  test('2. the hook is first, the relay request follows: no relay card is ever made', async () => {
    const x = await start()
    const sent = spy(x)
    rawCall(x.home, offerLine())
    const card = await nextHookCard(x)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    expect(relayCards(x)).toHaveLength(0)
    expect(live(x).map((r) => r.id)).toEqual([card.id])
    expect(x.bridge.ctx.permission.openCount).toBe(1) // only the hook's id is open: the relay request got none
    expect(sent).toEqual([])
  })

  test('3. the relay send is slow, then goes: the hook card is up at once, the relay card is replaced once it is out', async () => {
    const x = await start()
    const sent = spy(x)
    const hold = holdRelaySend(x)
    const sending = x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const call = rawCall(x.home, offerLine())
    const card = await nextHookCard(x) // not waiting for the relay's slow send
    expect(relayCards(x)).toHaveLength(0)
    hold.release()
    await sending
    const relay = relayCards(x)[0] as CardT
    await eventually(() => expect(expiredUpdate(x, relay.id)?.reason).toBe('replaced_by_hook'))
    expect(x.bridge.ctx.ledger.get(relay.id)?.state).toBe('expired')
    // a tap on the replaced card is refused and sends nothing
    await x.app.resolveCard(relay, 'primary', relay.payload_hash)
    await sleep(t(150))
    expect(sent).toEqual([])
    await session(x, card)
    expect(await call.result).toMatchObject({ decision: 'allow', session: true })
  })

  test('4. the relay send is slow, then fails: one hook card, and the owner’s answer reaches the hook', async () => {
    const x = await start()
    const hold = holdRelaySend(x)
    const sending = x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const call = rawCall(x.home, offerLine())
    const card = await nextHookCard(x)
    hold.fail()
    await sending
    expect(relayCards(x)).toHaveLength(0)
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    expect(await call.result).toEqual({ t: 'perm_result', id: 'req-1', decision: 'allow', reason: 'owner' })
  })

  test('5. the hook card cannot be sent: the relay card is NOT replaced and still answers over the channel', async () => {
    const x = await start()
    const sent = spy(x)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const relay = relayCards(x)[0] as CardT
    const tr = x.bridge.ctx.transport as unknown as { sendDurable: (f: unknown) => Promise<unknown> }
    const real = tr.sendDurable
    tr.sendDurable = function (this: unknown, f: unknown) {
      const fr = f as { type: string; card?: { kind: string; payload?: { request_id?: string } } }
      if (
        fr.type === 'card.create' &&
        fr.card?.kind === 'permission' &&
        !RELAY_IDS.has(fr.card.payload?.request_id ?? '')
      )
        return Promise.reject(new Error('relay down'))
      return real.call(this, f)
    }
    const r = await rawCall(x.home, offerLine()).result
    expect(r).toMatchObject({ decision: 'none', reason: 'send_failed' })
    expect(x.bridge.ctx.ledger.get(relay.id)?.state).toBe('pending')
    expect(expiredUpdate(x, relay.id)).toBeUndefined()
    await x.app.resolveCard(relay, 'primary', relay.payload_hash)
    await eventually(() => expect(sent).toEqual([{ request_id: 'abcde', behavior: 'allow' }]))
  })

  test('6. the channel side is never sent a verdict, whichever way the hook card ends', async () => {
    const x = await start()
    const sent = spy(x)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const call = rawCall(x.home, offerLine())
    const card = await nextHookCard(x)
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    await call.result
    await sleep(t(200))
    expect(sent).toEqual([])
    expect(x.bridge.ctx.permission.openCount).toBe(0)
  })

  test('7. two identical calls: two hook cards, each relay request claimed once, a third gets its own card', async () => {
    const x = await start()
    rawCall(x.home, offerLine('req-1'))
    rawCall(x.home, offerLine('req-2'))
    await nextHookCard(x, 2)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW, 'abcde'))
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW, 'fghij'))
    expect(relayCards(x)).toHaveLength(0)
    expect(live(x)).toHaveLength(2)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW, 'mnopq'))
    expect(relayCards(x)).toHaveLength(1) // nothing left to pair with: as today
    expect(live(x)).toHaveLength(3)
  })

  test('8. the hook card closed (the hook is gone): a relay request after that gets a normal card', async () => {
    const x = await start()
    const call = rawCall(x.home, offerLine())
    const card = await nextHookCard(x)
    call.close()
    await eventually(() => expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('expired'))
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    expect(relayCards(x)).toHaveLength(1)
    expect(x.bridge.ctx.ledger.get((relayCards(x)[0] as CardT).id)?.state).toBe('pending')
  })

  test('9. Deny on the hook card: the hook answers deny, no relay card exists, the channel is never sent anything', async () => {
    const x = await start()
    const sent = spy(x)
    const call = rawCall(x.home, offerLine())
    const card = await nextHookCard(x)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await call.result).toMatchObject({ decision: 'deny' })
    expect(created(x)).toHaveLength(1)
    expect(sent).toEqual([])
  })

  test('10. the card says nothing about another card when it took the twin, and keeps the note when it did not', async () => {
    const x = await start()
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    rawCall(x.home, offerLine('req-1'))
    const withTwin = await nextHookCard(x)
    expect(withTwin.warning).toBeUndefined()
    rawCall(x.home, offerLine('req-2', { command: 'touch other' }))
    const noTwin = await nextHookCard(x, 2) // hook first: a channel request may still come, so the note stays
    expect(noTwin.warning).toBe('Another card for this call can also approve this.')
    rawCall(x.home, permLine(main, { command: 'touch third' }, 'req-3'))
    expect((await nextHookCard(x, 3)).warning).toBe('Another card for this call can also approve this.')
  })
})

describe('with no usable offer, the twin path is exactly what it was', () => {
  test.each([
    ['no suggest', {}],
    ['a wildcard-only suggest', { suggest: { rules: [{ tool: 'Bash', content: '*' }] } }],
    ['a suggest for another tool', { suggest: { rules: [{ tool: 'Write', content: 'x*' }] } }],
    ['a junk suggest', { suggest: 'allow' }],
  ])('%s: the relay card carries the prompt and the hook says relay_carries_it', async (_why, extra) => {
    const x = await start()
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const r = await rawCall(x.home, permLine({ ...main, ...extra })).result
    expect(r).toMatchObject({ decision: 'none', reason: 'relay_carries_it' })
    expect(created(x)).toHaveLength(1)
    const relay = relayCards(x)[0] as CardT
    expect(x.bridge.ctx.ledger.get(relay.id)?.state).toBe('pending')
    expect(expiredUpdate(x, relay.id)).toBeUndefined()
  })

  test('a hook that is not the Main session (no pid) never replaces or suppresses a relay card', async () => {
    const x = await start()
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const call = rawCall(x.home, permLine({ suggest: SUGGEST })) // no pid: not provably the channel's session
    const card = await nextHookCard(x)
    expect(created(x)).toHaveLength(2)
    expect(x.bridge.ctx.ledger.get((relayCards(x)[0] as CardT).id)?.state).toBe('pending')
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await call.result).toMatchObject({ decision: 'deny' })
  })

  test('a relay card that cannot stand in (part of the call hidden) is not replaced, even with an offer', async () => {
    const x = await start()
    const masked = relayParams('{"command": "touch probe-1", "token": "[REDACTED]"}')
    await x.bridge.ctx.permission.onRequest(masked)
    rawCall(x.home, offerLine('req-1', { command: 'touch probe-1', token: '[REDACTED]' }))
    await nextHookCard(x)
    expect(created(x)).toHaveLength(2)
    expect(x.bridge.ctx.ledger.get((relayCards(x)[0] as CardT).id)?.state).toBe('pending')
  })

  test('a relay request with part of the call hidden that comes AFTER an offered hook card is not suppressed', async () => {
    const x = await start()
    rawCall(x.home, offerLine('req-1', { command: 'touch probe-1', token: '[REDACTED]' }))
    await nextHookCard(x)
    await x.bridge.ctx.permission.onRequest(relayParams('{"command": "touch probe-1", "token": "[REDACTED]"}'))
    expect(relayCards(x)).toHaveLength(1)
  })
})

describe('the hook ends without an answer: the prompt is still open, so the channel card comes back', () => {
  const rebuilt = (x: Harness) =>
    relayCards(x).filter((c) => (c.payload as { request_id: string }).request_id === 'abcde')
  const relayIdsOf = (x: Harness) => relayCards(x).map((c) => (c.payload as { request_id: string }).request_id)

  test('S1-1. the hook is first, the relay request is claimed, then the hook card cannot be sent: a relay card is made and answers', async () => {
    const x = await start()
    const sent = spy(x)
    const hold = holdHookSend(x)
    const call = rawCall(x.home, offerLine())
    await eventually(() => expect(hold.started()).toBe(true))
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW)) // claimed: no card, no id
    expect(relayCards(x)).toHaveLength(0)
    hold.fail()
    expect(await call.result).toMatchObject({ decision: 'none', reason: 'send_failed' })
    await eventually(() => expect(rebuilt(x)).toHaveLength(1))
    const card = rebuilt(x)[0] as CardT
    expect(card.warning).toBeUndefined() // a fresh card, not a "repeated id" one: Allow works
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    await eventually(() => expect(sent).toEqual([{ request_id: 'abcde', behavior: 'allow' }]))
  })

  test('S1-2. a twin was replaced, then the hook is killed before it answered: the relay card is back and answers', async () => {
    const x = await start()
    const sent = spy(x)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const first = relayCards(x)[0] as CardT
    const call = rawCall(x.home, offerLine())
    await nextHookCard(x)
    await eventually(() => expect(expiredUpdate(x, first.id)?.reason).toBe('replaced_by_hook'))
    call.close() // the hook dies (or Claude Code ends it) with no answer
    await eventually(() => expect(rebuilt(x)).toHaveLength(2))
    const again = rebuilt(x)[1] as CardT
    expect(again.id).not.toBe(first.id)
    expect(again.warning).toBeUndefined()
    await x.app.resolveCard(again, 'primary', again.payload_hash)
    await eventually(() => expect(sent).toEqual([{ request_id: 'abcde', behavior: 'allow' }]))
  })

  test('S1-2b. the hook times out unanswered: the relay card is back too', async () => {
    const x = await start()
    x.bridge.ctx.permission.setHookTimings({ graceMs: 150, maxWaitMs: 400 })
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    rawCall(x.home, offerLine())
    await nextHookCard(x)
    await eventually(() => expect(rebuilt(x)).toHaveLength(2))
  })

  test('S1-3. the hook was answered: nothing is raised again', async () => {
    const x = await start()
    spy(x)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const call = rawCall(x.home, offerLine())
    const card = await nextHookCard(x)
    await session(x, card)
    await call.result
    await sleep(t(300))
    expect(rebuilt(x)).toHaveLength(1)
    // and the claimed kind: hook first, relay claimed, hook answered
    const y = rawCall(x.home, offerLine('req-2', { command: 'touch two' }))
    const card2 = await nextHookCard(x, 2)
    await x.bridge.ctx.permission.onRequest(relayParams('{"command": "touch two"}', 'fghij'))
    await x.app.resolveCard(card2, 'primary', card2.payload_hash)
    await y.result
    await sleep(t(300))
    expect(relayCards(x)).toHaveLength(1)
  })

  test('S1-4. a Deny on the hook card re-raises nothing either', async () => {
    const x = await start()
    spy(x)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const call = rawCall(x.home, offerLine())
    const card = await nextHookCard(x)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await call.result
    await sleep(t(300))
    expect(rebuilt(x)).toHaveLength(1)
  })

  test('F3. a stale unpaired hook card cannot claim a later prompt channel request', async () => {
    const x = await start()
    rawCall(x.home, offerLine())
    const card = await nextHookCard(x)
    const entry = ids(x).hookOffers.get(card.id)
    expect(entry).toBeDefined()
    ;(entry as { at: number }).at -= 20_000 // older than a channel card is kept as a twin (15 s)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    expect(relayCards(x)).toHaveLength(1) // made as usual: the stale offer claimed nothing
    expect(ids(x).hookOffers.size).toBe(0)
  })

  test('F6. a twin whose own send failed is not put back after the hook card fails', async () => {
    const x = await start()
    const relayHold = holdRelaySend(x)
    const hookHold = holdHookSend(x)
    const sending = x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const call = rawCall(x.home, offerLine())
    await eventually(() => expect(hookHold.started()).toBe(true))
    relayHold.fail() // the relay card never went
    await sending
    hookHold.fail()
    expect(await call.result).toMatchObject({ decision: 'none', reason: 'send_failed' })
    await sleep(t(100))
    expect(ids(x).recentRelay).toHaveLength(0)
  })

  test('F2. two identical calls, the second hook never connects: its prompt has a card, and a dead first hook gives its claimed request back', async () => {
    const x = await start()
    const sent = spy(x)
    const callA = rawCall(x.home, offerLine('req-1'))
    await nextHookCard(x)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW, 'abcde')) // claimed by hook A
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW, 'fghij')) // prompt B: its hook never comes: a card of its own
    expect(relayIdsOf(x)).toEqual(['fghij'])
    callA.close()
    await eventually(() => expect(relayIdsOf(x)).toEqual(['fghij', 'abcde']))
    const back = relayCards(x)[1] as CardT
    await x.app.resolveCard(back, 'primary', back.payload_hash)
    await eventually(() => expect(sent).toEqual([{ request_id: 'abcde', behavior: 'allow' }]))
  })
})
