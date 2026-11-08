// A PermissionRequest hook turns a prompt the channel relay does not carry (Claude Code's own "Dangerous rm operation on
// critical path", and every prompt of a thread's own session) into the existing permission card, and returns the owner's
// signed answer. docs/CLAUDE-CODE.md C3.9. Real live bridge, the hub socket, FakeRelay and a FakeApp with a pinned device
// key; the end-to-end tests run the REAL kit/hooks/permission-relay.py as a child process, the way Claude Code runs it.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type CardT, permissionCardAllowsPrimary } from '@talos-app/protocol'
import { pgidOf } from '../src/hub/server.ts'
import { foldWhitespace } from '../src/permission/hook-render.ts'
import { eventually, type Harness, pushCardResolvePastRelay, sleep, startHarness } from './helpers.ts'

const HOOK = resolve(import.meta.dir, '..', '..', '..', 'kit', 'hooks', 'permission-relay.py')
const NONCE = 'test-nonce-0123456789abcdef'
const DANGEROUS_RM = { command: 'rm -rf /home/alex/projects', description: 'remove the projects folder' }
const myPgid = () => pgidOf(process.pid) as number
/** The pid of the Claude Code this test bridge plays the channel of (a hook from it can have a relay twin). */
const SESSION_PID = 4_242_424

let h: Harness | undefined
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await h?.stop()
  h = undefined
})

const thread = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})

async function start(opts: { relayOn?: boolean; workers?: boolean } = {}) {
  h = await startHarness({
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      permission_relay: opts.relayOn ?? true,
      threads: [...c.threads, thread('trip', 'Trip', { session: 'dedicated' }), thread('garden', 'Garden')],
      dedicated: { enabled: true },
    })) as never,
  })
  h.bridge.ctx.permission.setHookTimings({ graceMs: 150 })
  h.bridge.ctx.permission.setSessionPids([SESSION_PID])
  h.bridge.ctx.permission.setClientVersion(() => '2.1.312') // as server.ts does from the MCP handshake: a relayed card offers Allow
  // what server.ts's takeOver writes: the hook only talks to the process this file names (here, this test process is the bridge)
  writeFileSync(join(h.home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }), {
    mode: 0o600,
  })
  if (opts.workers !== false) {
    writeWorkers(h.home, { trip: myPgid() })
    mkdirSync(join(h.home, 'workers', 'trip'), { recursive: true })
    writeFileSync(join(h.home, 'workers', 'trip', 'nonce'), NONCE)
  }
  return h
}

function writeWorkers(home: string, panes: Record<string, number>) {
  const t: Record<string, unknown> = {}
  for (const [id, pane] of Object.entries(panes))
    t[id] = {
      state: 'live',
      session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
      tmux: `t-${id}`,
      pane_pid: pane,
      cwd: home,
      error: null,
    }
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
      threads: t,
    }),
  )
}

type Answer = { t: string; id: string; decision: string; reason?: string }
/** A raw hub client: sends one line, resolves with the first reply line (or null when the hub closed without one). */
function rawCall(home: string, line: Record<string, unknown> | string) {
  const sock = createConnection(join(home, 'hub.sock'))
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
  sock.on('connect', () => sock.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`))
  return { result, close: () => sock.destroy() }
}

const permLine = (extra: Record<string, unknown> = {}, input: unknown = DANGEROUS_RM) => ({
  t: 'perm',
  id: 'req-1',
  tool_name: 'Bash',
  tool_input: input,
  ...extra,
})
const workerProof = { thread_id: 'trip', nonce: NONCE, pid: process.pid }

const permissionCards = (x: Harness) =>
  x.relay.frames.filter(
    (f) => f.direction === 'from_bridge' && f.frame.type === 'card.create' && f.frame.card.kind === 'permission',
  )
const cardWith = async (x: Harness, text: string): Promise<CardT> =>
  (
    await x.relay.expectFrame(
      'card.create',
      (f) => f.card.kind === 'permission' && (f.card.body ?? '').replace(/\n/g, '').includes(text),
      {
        direction: 'from_bridge',
      },
    )
  ).card
/** The card a hook raised (a relay card in these tests always has the request id abcde). */
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
const approve = async (x: Harness, card: CardT) =>
  x.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: x.relay.mintStepup(`card:${card.id}`) })

describe('hook request becomes the existing permission card', () => {
  test('a dangerous-rm shaped call: a high-risk permission card with the exact command; Allow (with step-up) returns allow', async () => {
    const x = await start()
    const call = rawCall(x.home, permLine())
    const card = await cardWith(x, 'rm -rf /home/alex/projects')
    expect(card.kind).toBe('permission')
    expect(card.title).toBe('Allow Bash?')
    expect(card.risk).toBe('high')
    expect(card.thread_id).toBe(x.bridge.ctx.config.config.default_thread)
    expect(card.body).toBe('rm -rf /home/alex/projects') // a Bash command is shown as text, not as JSON
    expect(card.fields[0]?.value).toBe('remove the projects folder')
    expect(permissionCardAllowsPrimary(card)).toBe(true)
    await approve(x, card)
    expect(await call.result).toMatchObject({ t: 'perm_result', id: 'req-1', decision: 'allow' })
    const done = await x.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'done', {
      direction: 'from_bridge',
    })
    expect(done.result?.ok).toBe(true)
  })

  test('Deny returns deny', async () => {
    const x = await start()
    const call = rawCall(x.home, permLine())
    const card = await cardWith(x, 'rm -rf')
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await call.result).toMatchObject({ decision: 'deny' })
  })

  test('a risky card cannot be allowed without step-up: the relay refuses, the hook gets nothing, Deny still works', async () => {
    const x = await start()
    const call = rawCall(x.home, permLine())
    const card = await cardWith(x, 'rm -rf')
    await x.app.resolveCard(card, 'primary', card.payload_hash) // no step-up token
    await x.relay.expectFrame('error', (e) => e.code === 'stepup_required', { direction: 'to_app' })
    const early = await Promise.race([call.result, sleep(250).then(() => 'still waiting')])
    expect(early).toBe('still waiting')
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await call.result).toMatchObject({ decision: 'deny' })
  })

  test('one approval answers one request: a replayed approve makes no second answer, an approve of a card does not answer another hook', async () => {
    const x = await start()
    const a = rawCall(x.home, permLine({ id: 'a' }, { command: 'rm -rf /home/alex/a' }))
    const b = rawCall(x.home, permLine({ id: 'b' }, { command: 'rm -rf /home/alex/b' }))
    const cardA = await cardWith(x, '/home/alex/a')
    const cardB = await cardWith(x, '/home/alex/b')
    expect(cardA.id).not.toBe(cardB.id)
    await approve(x, cardA)
    expect(await a.result).toMatchObject({ id: 'a', decision: 'allow' })
    expect(await Promise.race([b.result, sleep(250).then(() => 'still waiting')])).toBe('still waiting')
    await approve(x, cardA) // replay
    await sleep(200)
    expect(await Promise.race([b.result, sleep(100).then(() => 'still waiting')])).toBe('still waiting')
    await x.app.resolveCard(cardB, 'kill', cardB.payload_hash)
    expect(await b.result).toMatchObject({ id: 'b', decision: 'deny' })
  })

  test('bidi text is shown with a marker and the call stays approvable; one the call cannot show whole is deny-only', async () => {
    const x = await start()
    const call = rawCall(x.home, permLine({}, { command: 'echo ok \u202e~ fr- mr' }))
    const card = await cardWith(x, 'echo ok')
    expect(card.body).toContain('[U+202E]')
    expect(permissionCardAllowsPrimary(card)).toBe(true)
    await approve(x, card)
    expect(await call.result).toMatchObject({ decision: 'allow' })
    // a part the owner could never see: a call Claude Code elided is deny-only, a forged Allow is refused, Deny works
    const cut = rawCall(
      x.home,
      permLine({ id: 'cut' }, { command: 'echo a \u22ef 20 code points elided \u22ef echo b' }),
    )
    const cutCard = await cardWith(x, 'elided')
    expect(permissionCardAllowsPrimary(cutCard)).toBe(false)
    const f = await pushCardResolvePastRelay(x, cutCard, cutCard.payload_hash)
    const err = await x.relay.expectFrame('error', (e) => e.ref === (f as { id: string }).id, {
      direction: 'from_bridge',
    })
    expect(err.code).toBe('permission_hidden')
    expect(await Promise.race([cut.result, sleep(250).then(() => 'still waiting')])).toBe('still waiting')
    await x.app.resolveCard(cutCard, 'kill', cutCard.payload_hash)
    expect(await cut.result).toMatchObject({ decision: 'deny' })
  })

  test('a line over the hub limit drops the connection and raises no card', async () => {
    const x = await start()
    rawCall(x.home, permLine({}, { command: `echo ${'y'.repeat(320 * 1024)}` }))
    // observed at the hub: on macOS Bun's client socket never reports `close` while it still has unsent bytes for a peer that left
    await eventually(() => expect(x.bridge.hub?.connections).toBe(0))
    expect(permissionCards(x)).toHaveLength(0)
  })

  test('unknown extra fields and a missing optional field are accepted; a bad shape is answered none, no card', async () => {
    const x = await start()
    const ok = rawCall(x.home, {
      t: 'perm',
      id: 'n1',
      tool_name: 'Write',
      tool_input: { file_path: '/home/alex/a.txt' },
      future: { a: 1 },
    })
    const card = await cardWith(x, '/home/alex/a.txt')
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await ok.result).toMatchObject({ decision: 'deny' })
    for (const bad of [
      { t: 'perm', id: 'n2' }, // no tool
      { t: 'perm', id: 'n3', tool_name: '' },
      { t: 'perm', tool_name: 'Bash' }, // no id
      '{"t":"perm"',
    ]) {
      const r = await rawCall(x.home, bad).result
      expect(r === null || r.decision === 'none' || (r as { t: string }).t === 'refused').toBe(true)
    }
    expect(permissionCards(x)).toHaveLength(1)
  })
})

describe('no decision unless the owner answered', () => {
  test('the setting off: no card, answered none at once', async () => {
    const x = await start({ relayOn: false })
    const r = await rawCall(x.home, permLine()).result
    expect(r).toMatchObject({ decision: 'none', reason: 'relay_off' })
    expect(permissionCards(x)).toHaveLength(0)
  })

  test('the owner never answers: the card closes at the ceiling and the hook gets none; a late Allow is refused', async () => {
    const x = await start()
    x.bridge.ctx.permission.setHookTimings({ maxWaitMs: 400 })
    const call = rawCall(x.home, permLine())
    const card = await cardWith(x, 'rm -rf')
    expect(await call.result).toMatchObject({ decision: 'none', reason: 'timeout' })
    const gone = await x.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'expired', {
      direction: 'from_bridge',
    })
    expect(gone.reason).toBe('timeout')
    await approve(x, card)
    // the relay itself knows the card is expired and turns the tap away; the bridge would refuse it too (permission_closed)
    const err = await x.relay.expectFrame('error', (e) => e.code === 'card_expired', { direction: 'to_app' })
    expect(err.code).toBe('card_expired')
    expect(x.bridge.ctx.permission.openCount).toBe(0)
  })

  test('the hook goes away (killed, or the owner answered at the Mac): the card closes and nothing can answer it', async () => {
    const x = await start()
    const call = rawCall(x.home, permLine())
    const card = await cardWith(x, 'rm -rf')
    call.close()
    const gone = await x.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'expired', {
      direction: 'from_bridge',
    })
    expect(gone.reason).toBe('hook_gone')
    expect(x.bridge.ctx.permission.openCount).toBe(0)
    await approve(x, card)
    await x.relay.expectFrame('error', (e) => e.code === 'card_expired', { direction: 'to_app' })
  })

  test('the setting is switched off while a hook waits: the hook gets none and the card closes', async () => {
    const x = await start()
    const call = rawCall(x.home, permLine())
    const card = await cardWith(x, 'rm -rf')
    const cfgPath = join(x.home, 'config.json')
    const cfg = JSON.parse(require('node:fs').readFileSync(cfgPath, 'utf8'))
    await sleep(30)
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, permission_relay: false }), { mode: 0o600 })
    await x.bridge.poll()
    expect(await call.result).toMatchObject({ decision: 'none', reason: 'relay_off' })
    await x.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'expired', {
      direction: 'from_bridge',
    })
  })

  test('the bridge stops while a hook waits: the hook sees the socket close, no answer', async () => {
    const x = await start()
    const call = rawCall(x.home, permLine())
    await cardWith(x, 'rm -rf')
    await x.bridge.hub?.close()
    expect(await call.result).toBeNull()
  })

  test('a card that cannot be sent: none, and the card is expired, never left answerable', async () => {
    const x = await start()
    const ctx = x.bridge.ctx
    const real = ctx.transport.sendDurable.bind(ctx.transport)
    ctx.transport.sendDurable = (async (f: { type: string; card?: { kind: string } }) => {
      if (f.type === 'card.create' && f.card?.kind === 'permission') throw new Error('relay down')
      return real(f as never)
    }) as never
    const r = await rawCall(x.home, permLine()).result
    expect(r).toMatchObject({ decision: 'none', reason: 'send_failed' })
    expect(x.bridge.ctx.permission.openCount).toBe(0)
    expect(ctx.ledger.list('pending').filter((row) => row.binding.kind === 'permission')).toHaveLength(0)
  })
})

describe('no double cards', () => {
  const relayParams = (input: string) => ({
    request_id: 'abcde',
    tool_name: 'Bash',
    description: 'Run it',
    input_preview: input,
  })

  const git = { command: 'git push origin main' }
  const main = { pid: SESSION_PID, cwd: '/srv/proj' }

  test('the channel relay already carries the prompt (its card exists): the hook creates no second card', async () => {
    const x = await start()
    await x.bridge.ctx.permission.onRequest(relayParams('{"command": "git push origin main"}'))
    const r = await rawCall(x.home, permLine(main, git)).result
    expect(r).toMatchObject({ decision: 'none', reason: 'relay_carries_it' })
    await sleep(100)
    expect(permissionCards(x)).toHaveLength(1)
  })

  test('the hook arrives first and the relay card lands inside the grace window: still one card', async () => {
    const x = await start()
    x.bridge.ctx.permission.setHookTimings({ graceMs: 2_000 })
    const call = rawCall(x.home, permLine(main, git))
    await sleep(100)
    await x.bridge.ctx.permission.onRequest(relayParams('{"command":"git push origin main"}'))
    expect(await call.result).toMatchObject({ decision: 'none', reason: 'relay_carries_it' })
    expect(permissionCards(x)).toHaveLength(1)
  })

  test('a relay request whose card was never made (send failed) is not a twin', async () => {
    const x = await start()
    const ctx = x.bridge.ctx
    const real = ctx.transport.sendDurable.bind(ctx.transport)
    ctx.transport.sendDurable = (async (f: { type: string }) => {
      if (f.type === 'card.create') throw new Error('relay down')
      return real(f as never)
    }) as never
    await ctx.permission.onRequest(relayParams('{"command": "git push origin main"}'))
    ctx.transport.sendDurable = real as never
    const call = rawCall(x.home, permLine(main, git))
    const card = await hookCard(x)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await call.result).toMatchObject({ decision: 'deny' })
  })

  test('a relay request for a DIFFERENT call is not a twin: the hook still gets its own card, and says another may be open', async () => {
    const x = await start()
    await x.bridge.ctx.permission.onRequest(relayParams('{"command": "ls"}'))
    const call = rawCall(x.home, permLine(main))
    const card = await cardWith(x, 'rm -rf')
    expect(permissionCards(x)).toHaveLength(2)
    expect(card.warning).toBe('Another card for this call can also approve this.')
    expect(permissionCardAllowsPrimary(card)).toBe(true) // the note never costs the owner the Allow button
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await call.result).toMatchObject({ decision: 'deny' })
  })

  test('a preview Claude Code cut or reshaped is NOT matched (a duplicate card beats a missing one)', async () => {
    const x = await start()
    const long = `echo ${'a'.repeat(300)} && rm -rf /home/alex/z`
    await x.bridge.ctx.permission.onRequest(
      relayParams(`{"command": "echo ${'a'.repeat(40)}⋯ 240 code points elided ⋯aaaa && rm -rf /home/alex/z"}`),
    )
    await x.bridge.ctx.permission.onRequest(relayParams(`{"command": "echo ${'a'.repeat(300)} && rm -rf /home/alex/z…`))
    const call = rawCall(x.home, permLine(main, { command: long }))
    const card = await hookCard(x)
    expect(permissionCards(x)).toHaveLength(3)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await call.result).toMatchObject({ decision: 'deny' })
  })

  test('a relay card with NO Allow (part of the call hidden) is not a twin: the hook raises its own card', async () => {
    const x = await start()
    // a relayed preview Claude Code redacted: its card is deny-only
    await x.bridge.ctx.permission.onRequest(relayParams('{"command": "git push origin main", "token": "[REDACTED]"}'))
    const call = rawCall(x.home, permLine(main, { command: 'git push origin main', token: '[REDACTED]' }))
    const card = await hookCard(x)
    expect(permissionCards(x)).toHaveLength(2)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await call.result).toMatchObject({ decision: 'deny' })
  })

  test('whitespace is not deleted when comparing: `rm -rf a b` is not `rm -rf ab`', async () => {
    const x = await start()
    await x.bridge.ctx.permission.onRequest(relayParams('{"command": "rm -rf ab"}'))
    const call = rawCall(x.home, permLine(main, { command: 'rm -rf a b' }))
    const card = await hookCard(x)
    expect(permissionCards(x)).toHaveLength(2)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await call.result).toMatchObject({ decision: 'deny' })
    // and the same text with only its spacing changed IS the same call
    const y = await relayTwin('rm -rf a b', '{"command":   "rm -rf a   b"}')
    expect(y).toMatchObject({ decision: 'none', reason: 'relay_carries_it' })
  })

  const relayTwin = async (hookCommand: string, relayPreview: string) => {
    const z = await start()
    await z.bridge.ctx.permission.onRequest(relayParams(relayPreview))
    return rawCall(z.home, permLine(main, { command: hookCommand })).result
  }

  test('a hook from another Claude Code session (not the one this bridge is the channel of) is never suppressed, and says who asked', async () => {
    const x = await start()
    await x.bridge.ctx.permission.onRequest(relayParams('{"command": "git push origin main"}'))
    const call = rawCall(x.home, permLine({ pid: SESSION_PID + 1, cwd: '/srv/other' }, git))
    const card = await hookCard(x)
    expect(permissionCards(x)).toHaveLength(2)
    expect(card.warning).toBeUndefined()
    expect(card.fields[0]?.value).toBe(`[asked by pid ${SESSION_PID + 1} in /srv/other]`)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await call.result).toMatchObject({ decision: 'deny' })
  })

  test('two identical requests at once get TWO cards, and one Allow releases exactly one hook', async () => {
    const x = await start()
    const a = rawCall(x.home, permLine({ id: 'a', session_id: 's1' }))
    const b = rawCall(x.home, permLine({ id: 'b', session_id: 's1' }))
    await eventually(() => expect(permissionCards(x)).toHaveLength(2))
    const [c1, c2] = permissionCards(x).map((f) => (f.frame as { card: CardT }).card)
    expect(c1?.id).not.toBe(c2?.id)
    await approve(x, c1 as CardT)
    const first = await Promise.race([a.result.then((r) => ['a', r] as const), b.result.then((r) => ['b', r] as const)])
    expect(first[1]).toMatchObject({ decision: 'allow' })
    const other = first[0] === 'a' ? b : a
    expect(await Promise.race([other.result, sleep(300).then(() => 'still waiting')])).toBe('still waiting')
    await x.app.resolveCard(c2 as CardT, 'kill', (c2 as CardT).payload_hash)
    expect(await other.result).toMatchObject({ decision: 'deny' })
  })
})

describe('what the card shows: the whole call, with blanks folded to visible markers (owner rule: seen in full means approvable)', () => {
  const padded = (pad: string) => `echo hello${pad}&& rm -rf ~`

  test('15,000 spaces between the harmless part and the rm: one marker with the count, the rm right behind it, Allow stays', async () => {
    const x = await start()
    const call = rawCall(x.home, permLine({}, { command: padded(' '.repeat(15_000)) }))
    const card = await cardWith(x, 'rm -rf ~')
    expect(card.body).toBe('echo hello⟨15000 spaces⟩&& rm -rf ~')
    expect(permissionCardAllowsPrimary(card)).toBe(true)
    expect(card.warning).toBeUndefined()
    await approve(x, card)
    expect(await call.result).toMatchObject({ decision: 'allow' })
  })

  // every blank that is not an ASCII space is its own marker: "spaces" is only ever said of ASCII spaces
  for (const [name, ch, marker] of [
    ['U+2003 em space', '\u2003', '[U+2003]'],
    ['U+00A0 no-break space', '\u00a0', '[U+00A0]'],
    ['U+3000 ideographic space', '\u3000', '[U+3000]'],
    ['U+202F narrow no-break space', '\u202f', '[U+202F]'],
    ['tab', '\t', '⇥'],
    ['vertical tab', '\u000b', '[U+000B]'],
    ['form feed', '\u000c', '[U+000C]'],
    ['U+FEFF', '\ufeff', '[U+FEFF]'],
  ] as const) {
    test(`${name} padding of 300: shown as ${marker} each (never labelled "spaces"), the rm in view, Allow stays`, async () => {
      const x = await start()
      rawCall(x.home, permLine({}, { command: padded(ch.repeat(300)) }))
      const card = await cardWith(x, 'rm -rf ~')
      expect(card.body).toBe(`echo hello${marker.repeat(300)}&& rm -rf ~`)
      expect(card.body).not.toContain('spaces')
      expect(permissionCardAllowsPrimary(card)).toBe(true)
    })
  }

  test('a short run of an exotic space is shown as markers, and Allow stays', async () => {
    const x = await start()
    rawCall(x.home, permLine({}, { command: padded('\u2003\u2003') }))
    const card = await cardWith(x, 'rm -rf ~')
    expect(card.body).toBe('echo hello[U+2003][U+2003]&& rm -rf ~')
    expect(permissionCardAllowsPrimary(card)).toBe(true)
  })

  // 500 runs of 8 spaces, each split by an invisible or odd code point: the call is long, but every character of it is shown
  for (const [name, ch] of [
    ['U+E0080', 0xe0080],
    ['U+16FE4', 0x16fe4],
    ['U+1D159', 0x1d159],
    ['U+FFFC', 0xfffc],
    ['U+3164', 0x3164],
    ['U+2800', 0x2800],
    ['U+115F U+1160', 0x115f],
    ['ANSI ESC', 0x1b],
  ] as const) {
    test(`500 runs of 8 spaces split by ${name}: every code point is shown (as a marker where invisible) and the end of the call is there`, async () => {
      const x = await start()
      const sep = ch === 0x115f ? String.fromCodePoint(0x115f, 0x1160) : String.fromCodePoint(ch)
      const command = `git status${`        ${sep}`.repeat(500)}; rm -rf ~`
      const call = rawCall(x.home, permLine({}, { command }))
      const card = await hookCard(x)
      expect(card.body?.endsWith('; rm -rf ~')).toBe(true)
      const raw = card.body ?? ''
      // no character of the call is missing from what is shown: invisible ones appear as [U+XXXX], the rest as themselves
      expect(
        raw.includes(String.fromCodePoint(ch)) || raw.includes(`[U+${ch.toString(16).toUpperCase().padStart(4, '0')}]`),
      ).toBe(true)
      expect(permissionCardAllowsPrimary(card)).toBe(true) // 500 x 26 characters is under MAX_SHOWN
      await x.app.resolveCard(card, 'kill', card.payload_hash)
      expect(await call.result).toMatchObject({ decision: 'deny' })
    })
  }

  test('foldWhitespace folds ASCII space runs and line breaks only; every other blank is left for its own marker', () => {
    expect(foldWhitespace('a b')).toBe('a b')
    expect(foldWhitespace('a\nb')).toBe('a⏎b')
    expect(foldWhitespace('a\r\nb')).toBe('a⏎b')
    expect(foldWhitespace('a\n    b')).toBe('a⏎    b')
    expect(foldWhitespace(`a${'\n'.repeat(20)}b`)).toBe('a⟨20 lines⟩b')
    expect(foldWhitespace(`a${' '.repeat(9)}b`)).toBe('a⟨9 spaces⟩b')
    for (const other of ['\u00a0', '\t', '\ufeff', '\u000b', '\u000c', '\u2003', '\u3000'])
      expect(foldWhitespace(`a${other.repeat(20)}b`), JSON.stringify(other)).toBe(`a${other.repeat(20)}b`)
    expect(foldWhitespace('ls ⟨3 spaces⟩ rm')).toBe('ls ⟨3 spaces⟩ rm') // a literal marker is just text; the owner reads it
  })

  test('a Bash call with an extra key (a sandbox override) is shown whole as JSON, never as just the command', async () => {
    const x = await start()
    rawCall(x.home, permLine({}, { command: 'ls', dangerouslyDisableSandbox: true }))
    const card = await cardWith(x, 'dangerouslyDisableSandbox')
    expect(card.body).toBe('{"command":"ls","dangerouslyDisableSandbox":true}')
  })
})

describe('long and odd calls keep Allow (only a call that cannot be shown at all has none)', () => {
  const cpn = (n: number) => String.fromCodePoint(n)
  const probes: [string, string][] = [
    ['U+1D159 x9000', `git status${cpn(0x1d159).repeat(9000)}; rm -rf ~`],
    [' . x5000', `git status${' .'.repeat(5000)}; rm -rf ~`],
    ['one line of a x15000', `${'a'.repeat(15000)}; rm -rf ~`],
    ['CJK and emoji', `${'\u6f22\u5b57'.repeat(200)}\u{1F600}`],
  ]
  for (const [name, command] of probes) {
    test(`hook path, ${name}: Allow stays, the owner's approval comes back as allow`, async () => {
      const x = await start()
      const call = rawCall(x.home, permLine({}, { command }))
      const card = await hookCard(x)
      expect(permissionCardAllowsPrimary(card)).toBe(true)
      await approve(x, card)
      expect(await call.result).toMatchObject({ decision: 'allow' })
    })
  }

  test('a call past MAX_SHOWN cannot be shown whole: deny-only, a forged Allow is refused, Deny works', async () => {
    const x = await start()
    const call = rawCall(x.home, permLine({}, { command: `echo ${'x'.repeat(25_000)}` }))
    const card = await hookCard(x)
    expect(permissionCardAllowsPrimary(card)).toBe(false)
    const f = await pushCardResolvePastRelay(x, card, card.payload_hash)
    const err = await x.relay.expectFrame('error', (e) => e.ref === (f as { id: string }).id, {
      direction: 'from_bridge',
    })
    expect(err.code).toBe('permission_hidden')
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await call.result).toMatchObject({ decision: 'deny' })
  })

  test('relay path (the same composer): a hidden-character preview is shown with markers and keeps Allow', async () => {
    const x = await start()
    await x.bridge.ctx.permission.onRequest({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run it',
      input_preview: '{"command": "echo ok \u202e~ fr- mr"}',
    })
    const frame = permissionCards(x)[0]?.frame as { card: CardT }
    expect(frame.card.body).toContain('[U+202E]')
    expect(permissionCardAllowsPrimary(frame.card)).toBe(true)
  })

  test('a normal 300-character command keeps Allow, and its card body ends with the command', async () => {
    const x = await start()
    const command = `echo ${'word '.repeat(58)}&& ls`
    const call = rawCall(x.home, permLine({}, { command }))
    const card = await hookCard(x)
    expect(permissionCardAllowsPrimary(card)).toBe(true)
    expect(card.body?.endsWith('&& ls')).toBe(true)
    await approve(x, card)
    expect(await call.result).toMatchObject({ decision: 'allow' })
  })
})

describe('the socket', () => {
  test('hub.sock is owner-only, so another user cannot reach the hook path at all', async () => {
    const x = await start()
    expect(statSync(join(x.home, 'hub.sock')).mode & 0o777).toBe(0o600)
    expect(statSync(x.home).mode & 0o077).toBe(0)
  })
})

describe('the real hook script, end to end', () => {
  const callJson = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: 'abc',
      cwd: '/home/alex',
      permission_mode: 'bypassPermissions',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: DANGEROUS_RM,
      permission_suggestions: [],
      ...extra,
    })
  function runHook(env: Record<string, string>, stdin: string) {
    const p = Bun.spawn(['python3', HOOK], {
      env: { PATH: process.env.PATH ?? '', HOME: env.HOME ?? '/nonexistent', ...env },
      stdin: new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      p,
      out: (async () => ({
        stdout: await new Response(p.stdout).text(),
        stderr: await new Response(p.stderr).text(),
        code: await p.exited,
      }))(),
    }
  }

  test('Allow on the phone becomes the PermissionRequest decision Claude Code reads', async () => {
    const x = await start()
    const run = runHook({ TALOS_APP_HOME: x.home }, callJson())
    const card = await cardWith(x, 'rm -rf /home/alex/projects')
    await approve(x, card)
    const r = await run.out
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
  })

  test('Deny on the phone becomes a deny decision with a reason', async () => {
    const x = await start()
    const run = runHook({ TALOS_APP_HOME: x.home }, callJson())
    const card = await cardWith(x, 'rm -rf')
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    const r = await run.out
    const d = JSON.parse(r.stdout).hookSpecificOutput.decision
    expect(d.behavior).toBe('deny')
    expect(typeof d.message).toBe('string')
    expect(r.code).toBe(0)
  })

  test('a thread session: the hook sends its own env proof and the card is in the thread', async () => {
    const x = await start()
    const run = runHook(
      {
        TALOS_APP_HOME: x.home,
        TALOS_APP_PERM_HOOK_SOURCE: 'worker',
        TALOS_APP_WORKER_THREAD: 'trip',
        TALOS_APP_WORKER_NONCE: NONCE,
        CLAUDE_PID: String(process.pid),
      },
      callJson(),
    )
    const card = await cardWith(x, 'rm -rf')
    expect(card.thread_id).toBe('trip')
    await approve(x, card)
    expect(JSON.parse((await run.out).stdout).hookSpecificOutput.decision.behavior).toBe('allow')
  })

  test('a thread session with the wrong nonce: no card, no output, exit 0', async () => {
    const x = await start()
    const run = runHook(
      {
        TALOS_APP_HOME: x.home,
        TALOS_APP_PERM_HOOK_SOURCE: 'worker',
        TALOS_APP_WORKER_THREAD: 'trip',
        TALOS_APP_WORKER_NONCE: 'nope-nope-nope-nope-nope',
        CLAUDE_PID: String(process.pid),
      },
      callJson(),
    )
    const r = await run.out
    expect(r).toMatchObject({ stdout: '', code: 0 })
    expect(permissionCards(x)).toHaveLength(0)
  })

  test('the hook is killed while the card is open (the owner answered at the Mac): the card closes', async () => {
    const x = await start()
    const run = runHook({ TALOS_APP_HOME: x.home }, callJson())
    const card = await cardWith(x, 'rm -rf')
    run.p.kill('SIGTERM')
    await run.out
    await x.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'expired', {
      direction: 'from_bridge',
    })
    await eventually(() => expect(x.bridge.ctx.permission.openCount).toBe(0))
  })

  test('the owner is slower than the hook: the hook gives up with no output, and the card closes', async () => {
    const x = await start()
    const run = runHook({ TALOS_APP_HOME: x.home, TALOS_PERMISSION_HOOK_WAIT_S: '0.6' }, callJson())
    const card = await cardWith(x, 'rm -rf')
    const r = await run.out
    expect(r).toMatchObject({ stdout: '', code: 0 })
    await x.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'expired', {
      direction: 'from_bridge',
    })
  })

  test('the setting off: no card, no output', async () => {
    const x = await start({ relayOn: false })
    const r = await runHook({ TALOS_APP_HOME: x.home }, callJson()).out
    expect(r).toMatchObject({ stdout: '', code: 0 })
    expect(permissionCards(x)).toHaveLength(0)
  })
  test('the agent folder copy of the hook in a thread session raises nothing: one hook, one card', async () => {
    const x = await start()
    const r = await runHook(
      {
        TALOS_APP_HOME: x.home,
        TALOS_APP_WORKER_THREAD: 'trip',
        TALOS_APP_WORKER_NONCE: NONCE,
        CLAUDE_PID: String(process.pid),
      },
      callJson(),
    ).out
    expect(r).toMatchObject({ stdout: '', code: 0 })
    expect(permissionCards(x)).toHaveLength(0)
  })

  test('an unattended claude -p run (CLAUDE_CODE_SESSION_ATTENDED=0): no card, no output', async () => {
    const x = await start()
    const r = await runHook({ TALOS_APP_HOME: x.home, CLAUDE_CODE_SESSION_ATTENDED: '0' }, callJson()).out
    expect(r).toMatchObject({ stdout: '', code: 0 })
    expect(permissionCards(x)).toHaveLength(0)
  })

  test('a stand-in listener on hub.sock (another process than the one in bridge.pid) never sees the call and gives no allow', async () => {
    const x = await start()
    const fakeHome = mkdtempSync(join(tmpdir(), 'phf-'))
    writeFileSync(join(fakeHome, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'x' }))
    const seen = join(fakeHome, 'seen')
    const fake = Bun.spawn(
      [
        'python3',
        '-c',
        `import os,socket,sys\nos.chdir(sys.argv[1])\ns=socket.socket(socket.AF_UNIX);s.bind('hub.sock');s.listen(1);open('up','w').write('1')\nc,_=s.accept();c.settimeout(2)\ntry:\n  d=c.recv(65536)\nexcept Exception:\n  d=b''\nopen('seen','wb').write(d)\nc.sendall(b'{"t":"perm_result","id":"x","decision":"allow"}\\n')`,
        fakeHome,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    sockets.push({ destroy: () => fake.kill() })
    await eventually(() => expect(existsSync(join(fakeHome, 'up'))).toBe(true))
    const r = await runHook({ TALOS_APP_HOME: fakeHome }, callJson()).out
    expect(r).toMatchObject({ stdout: '', code: 0 })
    await fake.exited
    expect(readFileSync(seen).length).toBe(0) // the tool input was never sent to it
    expect(permissionCards(x)).toHaveLength(0)
  })
})
