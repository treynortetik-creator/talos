// "The prompt is over" (Wave 1, after hook-wins), the bridge's half. A hook card that stood in for a channel card (it replaced one, or
// claimed a channel request that came after it) is raised again as a channel card when the hook ends with no answer, because the prompt
// may still be open. When the hook says it KNOWS the prompt ended (`perm_over`, then the socket closing), nothing is raised again and the
// hook card closes with the reason `prompt_over`. Anything else (a plain close: a crash, SIGKILL, the hook's own wait) is as before.
// (`touch probe-N` is only a synthetic hook input here; which commands Claude Code offers a rule for is its own choice.)
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
const touch = { command: 'touch probe-1' }
const PREVIEW = '{"command": "touch probe-1"}'
const RELAY_IDS = new Set(['abcde', 'fghij'])
const relayParams = (input: string, request_id = 'abcde') => ({
  request_id,
  tool_name: 'Bash',
  description: 'Run it',
  input_preview: input,
})

let h: Harness | undefined
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await h?.stop()
  h = undefined
})

async function start() {
  h = await startHarness({ config: ((c: Record<string, unknown>) => ({ ...c, permission_relay: true })) as never })
  h.bridge.ctx.permission.setHookTimings({ graceMs: 150 })
  h.bridge.ctx.permission.setSessionPids([SESSION_PID])
  h.bridge.ctx.permission.setClientVersion(() => '2.1.312')
  writeFileSync(join(h.home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }), {
    mode: 0o600,
  })
  return h
}

type Answer = Record<string, unknown> & { t: string; id: string; decision: string }
/** A hook's connection: sends the perm line, can send more lines, and can be closed. */
function hook(home: string, line: Record<string, unknown>) {
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
  return {
    result,
    send: (l: Record<string, unknown>) => sock.write(`${JSON.stringify(l)}\n`),
    close: () => sock.destroy(),
  }
}
const permLine = (extra: Record<string, unknown> = {}, id = 'req-1', input: unknown = touch) => ({
  t: 'perm',
  id,
  tool_name: 'Bash',
  tool_input: input,
  ...extra,
})
const offerLine = (id = 'req-1', input: unknown = touch) => permLine({ ...main, suggest: SUGGEST }, id, input)
const over = (id = 'req-1') => ({ t: 'perm_over', id, why: 'term' })

const created = (x: Harness) =>
  x.relay.frames
    .filter(
      (f) => f.direction === 'from_bridge' && f.frame.type === 'card.create' && f.frame.card.kind === 'permission',
    )
    .map((f) => (f.frame as { card: CardT }).card)
const isRelay = (c: CardT) => RELAY_IDS.has((c.payload as { request_id?: string }).request_id ?? '')
const hookCards = (x: Harness) => created(x).filter((c) => !isRelay(c))
const relayCards = (x: Harness) => created(x).filter(isRelay)
const expired = (x: Harness, cardId: string) =>
  x.relay.frames.find(
    (f) =>
      f.direction === 'from_bridge' &&
      f.frame.type === 'card.update' &&
      f.frame.card_id === cardId &&
      f.frame.state === 'expired',
  )?.frame as { reason?: string } | undefined
const nextHookCard = async (x: Harness, n = 1) => {
  await eventually(() => expect(hookCards(x).length).toBeGreaterThanOrEqual(n))
  return hookCards(x)[n - 1] as CardT
}
const quiet = () => sleep(t(300)) // timing-ok: negative window: nothing is raised again

describe('perm_over: the hook card closes and nothing is raised again', () => {
  test('a twin was replaced, then perm_over and the socket closes: the hook card expires as prompt_over, no channel card comes back', async () => {
    const x = await start()
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const first = relayCards(x)[0] as CardT
    const call = hook(x.home, offerLine())
    const card = await nextHookCard(x)
    await eventually(() => expect(expired(x, first.id)?.reason).toBe('replaced_by_hook'))
    call.send(over())
    call.close()
    await eventually(() => expect(expired(x, card.id)?.reason).toBe('prompt_over'))
    await quiet()
    expect(relayCards(x)).toHaveLength(1)
    expect(x.bridge.ctx.ledger.list('pending').filter((r) => r.binding.kind === 'permission')).toHaveLength(0)
  })

  test('a channel request was claimed (the hook came first), then perm_over and close: the hook card expires, no channel card is ever made', async () => {
    const x = await start()
    const call = hook(x.home, offerLine())
    const card = await nextHookCard(x)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW)) // claimed: no card
    call.send(over())
    call.close()
    await eventually(() => expect(expired(x, card.id)?.reason).toBe('prompt_over'))
    await quiet()
    expect(relayCards(x)).toHaveLength(0)
  })

  test('a plain hook card (nothing paired): it expires as prompt_over rather than hook_gone', async () => {
    const x = await start()
    const call = hook(x.home, permLine()) // no pid: not provably the channel's session, so a card of its own
    const card = await nextHookCard(x)
    call.send(over())
    call.close()
    await eventually(() => expect(expired(x, card.id)?.reason).toBe('prompt_over'))
  })
})

describe('without perm_over everything is as it was', () => {
  test('a twin replaced, then a plain close (a crash): the channel card comes back', async () => {
    const x = await start()
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const call = hook(x.home, offerLine())
    await nextHookCard(x)
    await eventually(() => expect(expired(x, (relayCards(x)[0] as CardT).id)?.reason).toBe('replaced_by_hook'))
    call.close()
    await eventually(() => expect(relayCards(x)).toHaveLength(2))
  })

  test('a claimed request, then a plain close: the channel card is made after all', async () => {
    const x = await start()
    const call = hook(x.home, offerLine())
    const card = await nextHookCard(x)
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    call.close()
    await eventually(() => expect(relayCards(x)).toHaveLength(1))
    expect(expired(x, card.id)?.reason).toBe('hook_gone')
  })
})

describe('a perm_over that does not count is ignored', () => {
  async function pairedHook(x: Harness) {
    await x.bridge.ctx.permission.onRequest(relayParams(PREVIEW))
    const call = hook(x.home, offerLine())
    const card = await nextHookCard(x)
    await eventually(() => expect(expired(x, (relayCards(x)[0] as CardT).id)?.reason).toBe('replaced_by_hook'))
    return { call, card }
  }

  test('for another request id: the close is a crash (the channel card comes back)', async () => {
    const x = await start()
    const { call } = await pairedHook(x)
    call.send(over('somebody-else'))
    call.close()
    await eventually(() => expect(relayCards(x)).toHaveLength(2))
  })

  test('sent before any perm on its own connection: no effect, no crash, the hub still answers a later perm', async () => {
    const x = await start()
    const early = hook(x.home, over())
    await sleep(t(100))
    early.close()
    const call = hook(x.home, offerLine('req-2'))
    const card = await nextHookCard(x)
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    expect(await call.result).toMatchObject({ t: 'perm_result', id: 'req-2', decision: 'allow' })
  })

  test('sent twice: it closes the card once, and nothing else changes', async () => {
    const x = await start()
    const { call, card } = await pairedHook(x)
    call.send(over())
    call.send(over())
    call.close()
    await eventually(() => expect(expired(x, card.id)?.reason).toBe('prompt_over'))
    await quiet()
    expect(relayCards(x)).toHaveLength(1)
  })

  test('sent after the owner answered: the answer stands and the hook gets it', async () => {
    const x = await start()
    const { call, card } = await pairedHook(x)
    await x.app.resolveCard(card, 'primary', card.payload_hash, {
      session: true,
      session_hash: sessionRulesHash(RULES),
    })
    expect(await call.result).toMatchObject({ decision: 'allow', session: true })
    call.send(over())
    await quiet()
    expect(x.bridge.ctx.ledger.get(card.id)?.state).not.toBe('expired')
    expect(relayCards(x)).toHaveLength(1)
  })

  test('a perm_over cannot reach another hook’s card', async () => {
    const x = await start()
    const a = hook(x.home, offerLine('req-1'))
    await nextHookCard(x)
    const b = hook(x.home, offerLine('req-2', { command: 'touch probe-2' }))
    const cardB = await nextHookCard(x, 2)
    a.send(over('req-2')) // names B's request id on A's own connection
    await quiet()
    expect(expired(x, cardB.id)).toBeUndefined()
    b.close()
    a.close()
  })
})
