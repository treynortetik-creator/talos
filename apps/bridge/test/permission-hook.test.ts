// A PermissionRequest hook turns a prompt the channel relay does not carry (Claude Code's own "Dangerous rm operation on
// critical path", and every prompt of a thread's own session) into the existing permission card, and returns the owner's
// signed answer. docs/CLAUDE-CODE.md C3.9. Real live bridge, the hub socket, FakeRelay and a FakeApp with a pinned device
// key; the end-to-end tests run the REAL kit/hooks/permission-relay.py as a child process, the way Claude Code runs it.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type CardT,
  permissionCardAllowsPrimary,
  permissionHiddenReasons,
  permissionHiddenWarning,
} from '@talos-app/protocol'
import { pgidOf } from '../src/hub/server.ts'
import { foldWhitespace } from '../src/permission/hook-render.ts'
import { eventually, type Harness, sleep, startHarness } from './helpers.ts'

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

/** Every temp folder a test builds a home or a thread's folder in: its real path, as a start records one (a Mac's /var). */
const realTmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)))

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
    // what a start records for the bridge's folder check (worker/project-settings.ts): a folder with no project settings, by
    // its real path as a start records it (a Mac's temp folder is /var/..., really /private/var/...)
    writeFileSync(
      join(h.home, 'workers', 'trip', 'project-check.json'),
      JSON.stringify({ v: 1, folders: [{ folder: realpathSync(h.home), agent_folder: false }] }),
    )
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
  test('a dangerous-rm shaped call: a low-risk permission card with the exact command; Allow returns allow', async () => {
    const x = await start()
    const call = rawCall(x.home, permLine())
    const card = await cardWith(x, 'rm -rf /home/alex/projects')
    expect(card.kind).toBe('permission')
    expect(card.title).toBe('Allow Bash?')
    expect(card.risk).toBe('low')
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

  test('a tap approves: an Allow with no step-up token returns allow, and the relay asks for none', async () => {
    const x = await start()
    const call = rawCall(x.home, permLine())
    const card = await cardWith(x, 'rm -rf')
    await x.app.resolveCard(card, 'primary', card.payload_hash) // no step-up token
    expect(await call.result).toMatchObject({ decision: 'allow' })
    expect(
      x.relay.frames.some((f) => f.frame.type === 'error' && (f.frame as { code?: string }).code === 'stepup_required'),
    ).toBe(false)
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

  test('bidi text is shown with a marker and the call stays approvable; an elided call keeps Allow with the note', async () => {
    const x = await start()
    const call = rawCall(x.home, permLine({}, { command: 'echo ok \u202e~ fr- mr' }))
    const card = await cardWith(x, 'echo ok')
    expect(card.body).toContain('[U+202E]')
    expect(permissionCardAllowsPrimary(card)).toBe(true)
    await approve(x, card)
    expect(await call.result).toMatchObject({ decision: 'allow' })
    // a part the owner cannot see: a call Claude Code elided keeps Allow, with the note naming it, and Allow returns allow
    const cut = rawCall(
      x.home,
      permLine({ id: 'cut' }, { command: 'echo a \u22ef 20 code points elided \u22ef echo b' }),
    )
    const cutCard = await cardWith(x, 'elided')
    expect(cutCard.warning).toBe(permissionHiddenWarning(['elided']))
    expect(permissionCardAllowsPrimary(cutCard)).toBe(true)
    await approve(x, cutCard)
    expect(await cut.result).toMatchObject({ decision: 'allow' })
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

  test('a relay card whose only note is "another channel can also approve this" still carries the prompt: one card', async () => {
    const x = await start()
    x.bridge.ctx.permission.setOtherChannels(['Telegram'])
    await x.bridge.ctx.permission.onRequest(relayParams('{"command": "git push origin main"}'))
    const r = await rawCall(x.home, permLine(main, git)).result
    expect(r).toMatchObject({ decision: 'none', reason: 'relay_carries_it' })
    await sleep(100)
    expect(permissionCards(x)).toHaveLength(1)
  })

  test('a repeated id: nothing is sent either way; Allow says why, Deny clears the card from the phone', async () => {
    const x = await start()
    const perm = x.bridge.ctx.permission
    await perm.onRequest(relayParams('{"command": "ls"}'))
    await perm.onRequest(relayParams('{"command": "ls"}')) // the same id again
    const repeated = x.bridge.ctx.ledger
      .list('pending')
      .filter((row) => row.binding.kind === 'permission')
      .at(-1)
    expect(repeated).toBeDefined()
    const allow = perm.precheck(repeated?.id ?? '', 'primary')
    expect(allow).toMatchObject({ handled: true, ok: false, code: 'permission_hidden' })
    expect((allow as { reason?: string }).reason).toContain('The prompt is still open at the Mac.')
    expect(x.bridge.ctx.ledger.get(repeated?.id ?? '')?.state).toBe('pending') // Allow leaves it as it was
    // Deny clears it from the phone (he can dismiss it), and still sends nothing
    const deny = perm.precheck(repeated?.id ?? '', 'kill')
    expect(deny).toMatchObject({ handled: true, ok: false, code: 'permission_hidden' })
    expect((deny as { reason?: string }).reason).toBe(
      "Cleared from here. Nothing was sent: Claude Code's prompt is still open at the Mac.",
    )
    expect(x.bridge.ctx.ledger.get(repeated?.id ?? '')?.state).not.toBe('pending')
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

  test('a relay card with part of the call hidden (Allow kept, with a note) is not a twin: the hook raises its own whole card', async () => {
    const x = await start()
    // a relayed preview Claude Code redacted: its card keeps Allow with a note, but the hook's card shows the whole call
    const masked = relayParams('{"command": "git push origin main", "token": "[REDACTED]"}')
    await x.bridge.ctx.permission.onRequest(masked)
    const relayFrame = permissionCards(x)[0]?.frame as { card: CardT }
    const relayCard = relayFrame.card
    expect(relayCard.warning).toBe(permissionHiddenWarning(permissionHiddenReasons(masked)))
    expect(permissionCardAllowsPrimary(relayCard)).toBe(true)
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

  test('a call past MAX_SHOWN cannot be shown whole: its start is shown with the too-long note, and Allow returns allow', async () => {
    const x = await start()
    const call = rawCall(x.home, permLine({}, { command: `echo ${'x'.repeat(25_000)}` }))
    const card = await hookCard(x)
    expect(card.payload).toMatchObject({ oversize: true })
    expect(card.body?.replace(/\n/g, '').startsWith('echo xxx')).toBe(true)
    expect(card.warning).toBe(permissionHiddenWarning(['too_long']))
    expect(permissionCardAllowsPrimary(card)).toBe(true)
    await approve(x, card)
    expect(await call.result).toMatchObject({ decision: 'allow' })
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

describe('a relayed verdict that does not get through says why (never "answer it at the Mac")', () => {
  const params = { request_id: 'abcde', tool_name: 'Bash', description: 'Run it', input_preview: '{"command": "ls"}' }
  const relayCard = async (x: Harness) => {
    await x.bridge.ctx.permission.onRequest(params)
    const frame = permissionCards(x)[0]?.frame as { card: CardT }
    return frame.card
  }
  test('a send that throws is tried again (twice), and the third try gets through', async () => {
    const x = await start()
    const sent: unknown[] = []
    let calls = 0
    x.bridge.ctx.permission.setSender(async (v) => {
      calls++
      if (calls < 3) throw new Error('channel busy')
      sent.push(v)
    })
    const card = await relayCard(x)
    await approve(x, card)
    await eventually(() => expect(sent).toEqual([{ request_id: 'abcde', behavior: 'allow' }]))
    expect(calls).toBe(3)
    const done = await x.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'done', {
      direction: 'from_bridge',
    })
    expect(done.result?.ok).toBe(true)
  })
  test('a send that always throws fails after three tries, with the reason in the result', async () => {
    const x = await start()
    let calls = 0
    x.bridge.ctx.permission.setSender(async () => {
      calls++
      throw new Error('channel gone')
    })
    const card = await relayCard(x)
    await approve(x, card)
    const failed = await x.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'failed', {
      direction: 'from_bridge',
    })
    expect(calls).toBe(3)
    expect(failed.result?.text).toBe(
      'Not sent: Claude Code did not take the answer (it may have answered or closed the prompt).',
    )
    expect(failed.result?.text).not.toMatch(/at the Mac/)
  })
})

describe('the socket', () => {
  test('hub.sock is owner-only, so another user cannot reach the hook path at all', async () => {
    const x = await start()
    expect(statSync(join(x.home, 'run', 'hub.sock')).mode & 0o777).toBe(0o600)
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
      env: {
        PATH: process.env.PATH ?? '',
        HOME: env.HOME ?? '/nonexistent',
        TALOS_TEST_SANDBOX: process.env.TALOS_TEST_SANDBOX ?? '',
        ...env,
      },
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

  // run/hub.sock, and hub.sock where the socket was before (the hook falls back to it while run/hub.sock is not there)
  test.each(['run/hub.sock', 'hub.sock'])(
    'a stand-in listener on %s (another process than the one in bridge.pid) never sees the call and gives no allow',
    async (at) => {
      const x = await start()
      const fakeHome = realTmp('phf-')
      mkdirSync(join(fakeHome, 'run'), { mode: 0o700 })
      writeFileSync(join(fakeHome, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'x' }))
      const seen = join(fakeHome, 'seen')
      const fake = Bun.spawn(
        [
          'python3',
          '-c',
          `import os,socket,sys\nos.chdir(sys.argv[1])\ns=socket.socket(socket.AF_UNIX);s.bind(sys.argv[2]);s.listen(1);open('up','w').write('1')\nc,_=s.accept();c.settimeout(2)\ntry:\n  d=c.recv(65536)\nexcept Exception:\n  d=b''\nopen('seen','wb').write(d)\nc.sendall(b'{"t":"perm_result","id":"x","decision":"allow"}\\n')`,
          fakeHome,
          at,
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
    },
  )
})

describe('a thread session whose folder’s project settings changed mid-session (checked at every request)', () => {
  // what the start records (worker/project-settings.ts): the folder the session runs in, out of the session's reach
  // what a start records; a thread folder's session loads only the user's settings
  const record = (
    home: string,
    folder: string,
    agentFolder = false,
    sources: string | null = agentFolder ? null : 'user',
  ) =>
    writeFileSync(
      join(home, 'workers', 'trip', 'project-check.json'),
      JSON.stringify({ v: 1, folders: [{ folder, agent_folder: agentFolder }], sources }),
    )
  const folderWith = (settings: unknown) => {
    const folder = realTmp('talos-proj-')
    mkdirSync(join(folder, '.claude'))
    writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify(settings))
    return folder
  }
  const systemLines = (x: Harness) =>
    x.relay.frames.filter(
      (f) =>
        f.direction === 'from_bridge' &&
        f.frame.type === 'reply' &&
        (f.frame as { message: { author: string } }).message.author === 'system',
    )

  const agentFile = (folder: string, name: string, frontmatter: string) => {
    mkdirSync(join(folder, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(folder, '.claude', 'agents', name), `---\n${frontmatter}\n---\nbody\n`)
  }
  test('a thread folder (it loads none of its files): a subagent with hooks, a link, a bad setting still raise the card, no line', async () => {
    const x = await start()
    const folder = folderWith({ env: { LD_PRELOAD: '/x.so' }, hooks: { PermissionRequest: [] } })
    agentFile(folder, 'helper.md', 'name: helper\nhooks:\n  SessionStart: []')
    symlinkSync('/', join(folder, '.claude', 'skills'))
    record(x.home, folder)
    const call = rawCall(x.home, permLine({ ...workerProof, id: 'req-thread' }))
    await hookCard(x)
    call.close()
    expect(systemLines(x)).toHaveLength(0)
  })
  test('a session started before its sources were recorded (it may load its folder’s settings) is still held to them', async () => {
    const x = await start()
    const folder = folderWith({ env: { LD_PRELOAD: '/x.so' } })
    writeFileSync(
      join(x.home, 'workers', 'trip', 'project-check.json'),
      JSON.stringify({ v: 1, folders: [{ folder, agent_folder: false }] }),
    )
    const a = await rawCall(x.home, permLine({ ...workerProof, id: 'req-old-record' })).result
    expect(a).toMatchObject({ decision: 'none', reason: 'project_settings' })
  })
  test('the agent folder (its files load as Main’s do): a setting it may not carry gets no card, the owner told once', async () => {
    const x = await start()
    const folder = folderWith({ env: { LD_PRELOAD: '/x.so' } })
    record(x.home, folder, true)
    for (const id of ['req-1', 'req-2']) {
      const a = await rawCall(x.home, permLine({ ...workerProof, id })).result
      expect(a).toMatchObject({ t: 'perm_result', id, decision: 'none', reason: 'project_settings' })
    }
    expect(permissionCards(x)).toHaveLength(0)
    await eventually(() => expect(systemLines(x)).toHaveLength(1))
    const first = systemLines(x)[0]
    if (!first) throw new Error('control: one line')
    const text = (first.frame as { message: { text: string; thread_id: string } }).message
    expect(text.thread_id).toBe('trip')
    expect(text.text).toContain('sets LD_PRELOAD in env')
    expect(text.text).toContain("remove it or move this thread's folder")
  })
  test.skipIf(process.platform !== 'linux')(
    'Linux: a session with no record (started before the check existed) is refused the same way, and told to restart',
    async () => {
      const x = await start()
      rmSync(join(x.home, 'workers', 'trip', 'project-check.json'))
      const a = await rawCall(x.home, permLine({ ...workerProof, id: 'req-old' })).result
      expect(a).toMatchObject({ decision: 'none', reason: 'project_settings' })
      expect(permissionCards(x)).toHaveLength(0)
      await eventually(() => expect(systemLines(x)).toHaveLength(1))
      const line = systemLines(x)[0]
      if (!line) throw new Error('control: one line')
      expect((line.frame as { message: { text: string } }).message.text).toContain('restart the thread')
    },
  )
  test('a thread that writes a new key each request cannot flood the thread: at most 3 lines an hour', async () => {
    const x = await start()
    const folder = folderWith({})
    record(x.home, folder, true)
    for (let n = 0; n < 6; n++) {
      // a new key each request: a new reason each time
      writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify({ env: { [`K${n}`]: 'x' } }))
      expect((await rawCall(x.home, permLine({ ...workerProof, id: `req-f${n}` })).result)?.reason).toBe(
        'project_settings',
      )
    }
    await sleep(300)
    expect(systemLines(x)).toHaveLength(3)
  })
  test('the agent folder: a .git pointer written after the start (a root the start never saw) is refused at the next request', async () => {
    const x = await start()
    const folder = folderWith({})
    record(x.home, folder, true)
    // the thread fakes a worktree whose canonical root is a folder of its choosing
    const elsewhere = folderWith({})
    mkdirSync(join(elsewhere, '.git', 'worktrees', 'w'), { recursive: true })
    writeFileSync(join(elsewhere, '.git', 'worktrees', 'w', 'commondir'), '../..\n')
    writeFileSync(join(folder, '.git'), `gitdir: ${join(elsewhere, '.git', 'worktrees', 'w')}\n`)
    const a = await rawCall(x.home, permLine({ ...workerProof, id: 'req-root' })).result
    expect(a).toMatchObject({ decision: 'none', reason: 'project_settings' })
    await eventually(() => expect(systemLines(x)).toHaveLength(1))
    expect((systemLines(x)[0]?.frame as { message: { text: string } } | undefined)?.message.text).toContain(
      'which its start did not check',
    )
  })
  test('control: the same folder clean, or the agent folder with its kit hooks, still raises the card', async () => {
    const x = await start()
    record(x.home, folderWith({ env: { BASH_DEFAULT_TIMEOUT_MS: '600000' }, permissions: { deny: [] } }))
    const call = rawCall(x.home, permLine({ ...workerProof, id: 'req-ok' }))
    await hookCard(x)
    call.close()
    record(x.home, folderWith({ hooks: { PreToolUse: [] }, statusLine: { type: 'command', command: 'x' } }), true)
    const call2 = rawCall(x.home, permLine({ ...workerProof, id: 'req-agent' }))
    await eventually(() => expect(permissionCards(x).length).toBeGreaterThanOrEqual(2))
    call2.close()
    expect(systemLines(x)).toHaveLength(0)
  })
})

describe('an edit of an agent, skill or command file: the card says first when it touches a key that changes what the agent may do', () => {
  const AGENT = '---\nname: helper\ndescription: helps\nmodel: sonnet\n---\nDo the work.\n'
  const note = (c: CardT) => c.fields.find((f) => f.key === 'summary')?.value ?? ''

  test('a Write that adds hooks: the description starts with Careful and names the hook sentence', async () => {
    const x = await start()
    const dir = realTmp('agents-')
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    const file = join(dir, '.claude', 'agents', 'a.md')
    writeFileSync(file, AGENT)
    const content = AGENT.replace('model: sonnet\n', 'model: sonnet\nhooks:\n  PreToolUse:\n    - command: ./x.sh\n')
    rawCall(x.home, permLine({ ...workerProof, tool_name: 'Write' }, { file_path: file, content }))
    const card = await hookCard(x)
    expect(note(card).startsWith('Careful: ')).toBe(true)
    expect(note(card)).toContain('this lets the agent run its own hook, which can approve its own actions')
    expect(permissionCardAllowsPrimary(card)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('an Edit of the body only: no Careful', async () => {
    const x = await start()
    const dir = realTmp('agents-')
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    const file = join(dir, '.claude', 'agents', 'a.md')
    writeFileSync(file, AGENT)
    rawCall(
      x.home,
      permLine(
        { ...workerProof, tool_name: 'Edit' },
        { file_path: file, old_string: 'Do the work.', new_string: 'Do more.' },
      ),
    )
    const card = await hookCard(x)
    expect(note(card)).not.toContain('Careful')
    rmSync(dir, { recursive: true, force: true })
  })

  test('a change that needs the warning but is too long for a card: no card, a deny', async () => {
    const x = await start()
    const dir = realTmp('agents-')
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    const file = join(dir, '.claude', 'agents', 'big.md')
    const content = `---\nname: big\nhooks:\n  PreToolUse: []\n---\n${'pad '.repeat(6000)}`
    const call = rawCall(x.home, permLine({ ...workerProof, tool_name: 'Write' }, { file_path: file, content }))
    const r = await call.result
    expect(r).toMatchObject({ decision: 'deny' })
    expect(r?.reason).toContain('too long to show the owner on a card')
    expect(permissionCards(x)).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })

  test('the same 24 KB body with no risky change still gets the too-long card', async () => {
    const x = await start()
    const dir = realTmp('agents-')
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    const file = join(dir, '.claude', 'agents', 'big.md')
    // the file is there with the same name, so only the body changes
    writeFileSync(file, '---\nname: big\n---\nsmall\n')
    const content = `---\nname: big\n---\n${'pad '.repeat(6000)}`
    rawCall(x.home, permLine({ ...workerProof, tool_name: 'Write' }, { file_path: file, content }))
    const card = await hookCard(x)
    expect(card.payload).toMatchObject({ oversize: true })
    expect(card.warning).toContain('Not all of this call is shown')
    rmSync(dir, { recursive: true, force: true })
  })

  test('a project’s src/commands file gets a plain card', async () => {
    const x = await start()
    const dir = realTmp('proj-')
    mkdirSync(join(dir, 'src', 'commands'), { recursive: true })
    rawCall(
      x.home,
      permLine(
        { ...workerProof, tool_name: 'Write' },
        { file_path: join(dir, 'src', 'commands', 'foo.ts'), content: 'x' },
      ),
    )
    expect(note(await hookCard(x))).not.toContain('Careful')
    rmSync(dir, { recursive: true, force: true })
  })

  test('an upper-case Agents folder under .claude: adding hooks warns', async () => {
    const x = await start()
    const dir = realTmp('proj-')
    mkdirSync(join(dir, '.claude', 'Agents'), { recursive: true })
    rawCall(
      x.home,
      permLine(
        { ...workerProof, tool_name: 'Write' },
        { file_path: join(dir, '.claude', 'Agents', 'x.md'), content: '---\nname: a\nhooks: x\n---\n' },
      ),
    )
    expect(note(await hookCard(x))).toContain('Careful: this lets the agent run its own hook')
    rmSync(dir, { recursive: true, force: true })
  })

  test('MultiEdit, replace_all and a CRLF file with a BOM are read the way they would be written', async () => {
    const x = await start()
    const dir = realTmp('agents-')
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    const file = join(dir, '.claude', 'agents', 'crlf.md')
    writeFileSync(file, '\ufeff---\r\nname: a\r\nmodel: sonnet\r\n---\r\nsonnet sonnet\r\n')
    // replace_all of the body word only: the model line is untouched
    rawCall(
      x.home,
      permLine(
        { ...workerProof, id: 'r1', tool_name: 'Edit' },
        { file_path: file, old_string: 'sonnet sonnet', new_string: 'x', replace_all: true },
      ),
    )
    const plain = await hookCard(x)
    expect(note(plain)).not.toContain('Careful')
    // MultiEdit: a body edit, then the model line
    rawCall(
      x.home,
      permLine(
        { ...workerProof, id: 'r2', tool_name: 'MultiEdit' },
        {
          file_path: file,
          edits: [
            { old_string: 'sonnet sonnet', new_string: 'y' },
            { old_string: 'model: sonnet', new_string: 'model: opus' },
          ],
        },
      ),
    )
    await eventually(() => {
      const careful = permissionCards(x)
        .map((f) => (f.frame as { card: CardT }).card)
        .find((c) => note(c).includes('Careful'))
      expect(careful ? note(careful) : '').toContain('this changes which model the agent runs on')
    })
    rmSync(dir, { recursive: true, force: true })
  })

  test('a Bash command naming agent files warns', async () => {
    const x = await start()
    rawCall(
      x.home,
      permLine({ ...workerProof }, { command: 'cp /tmp/a.md ~/.claude/agents/a.md', description: 'copy' }),
    )
    const card = await hookCard(x)
    expect(note(card)).toContain('this command touches your Claude agent, skill or command files')
  })

  test('an Edit that changes the model line, with a relative path and the thread folder as cwd: Careful', async () => {
    const x = await start()
    const dir = realTmp('agents-')
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'agents', 'a.md'), AGENT)
    rawCall(
      x.home,
      permLine(
        { ...workerProof, tool_name: 'Edit', cwd: dir },
        { file_path: '.claude/agents/a.md', old_string: 'model: sonnet', new_string: 'model: opus' },
      ),
    )
    const card = await hookCard(x)
    expect(note(card)).toContain('Careful: this changes which model the agent runs on')
    rmSync(dir, { recursive: true, force: true })
  })

  test('an Edit whose old_string is not in the file: unclear, flagged', async () => {
    const x = await start()
    const dir = realTmp('agents-')
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
    const file = join(dir, '.claude', 'skills', 's.md')
    writeFileSync(file, AGENT)
    rawCall(
      x.home,
      permLine({ ...workerProof, tool_name: 'Edit' }, { file_path: file, old_string: 'nowhere', new_string: 'x' }),
    )
    const card = await hookCard(x)
    expect(note(card)).toContain("Careful: Claude can't read this file's settings block for certain")
    rmSync(dir, { recursive: true, force: true })
  })

  test('a Write to a path that is not an agent, skill or command: the card is as it was', async () => {
    const x = await start()
    const dir = realTmp('agents-')
    const file = join(dir, 'notes.md')
    rawCall(
      x.home,
      permLine({ ...workerProof, tool_name: 'Write' }, { file_path: file, content: '---\nhooks: x\n---\n' }),
    )
    const card = await hookCard(x)
    expect(note(card)).not.toContain('Careful')
    expect(note(card)).toBe('')
    rmSync(dir, { recursive: true, force: true })
  })
})

// The hook's card is sent without the hook waiting on the send: a send can take many seconds (an ack wait, then the HTTP
// fallback), and the owner's tap, a failed send or the hook leaving must be heard meanwhile.
describe('the hook hears the card at once, not after its send settles', () => {
  const LONG = 20_000
  const isPermissionCreate = (f: unknown) => {
    const fr = f as { type?: string; card?: { kind?: string } }
    return fr?.type === 'card.create' && fr.card?.kind === 'permission'
  }
  // Holds the FIRST permission card's create send open until release() (or fails it with fail()); other frames pass through.
  function holdSend(x: Harness) {
    const t = x.bridge.ctx.transport as unknown as { sendDurable: (f: unknown) => Promise<unknown> }
    const real = t.sendDurable
    let release: () => void = () => {}
    let fail: () => void = () => {}
    let held = false
    t.sendDurable = function (this: unknown, f: unknown) {
      if (!isPermissionCreate(f) || held) return real.call(this, f)
      held = true
      return new Promise((res, rej) => {
        release = () => real.call(this, f).then(res, rej)
        fail = () => rej(new Error('relay down'))
      })
    }
    return {
      release: () => release(),
      fail: () => fail(),
      restore: () => {
        t.sendDurable = real
      },
      sent: () => eventually(() => expect(held).toBe(true)),
    }
  }
  const promptly = <T>(p: Promise<T>) =>
    Promise.race([p, sleep(1500).then(() => 'HUNG' as const)]) as Promise<T | 'HUNG'>
  const heldRow = (x: Harness) => {
    const row = x.bridge.ctx.ledger.list('pending').find((r) => r.binding.kind === 'permission')
    if (!row) throw new Error('no pending permission card')
    return row
  }
  // What inbound-cards.ts does for a permission card once the owner's signature is checked: the relay's precheck, then the
  // ledger's resolve, then onResolved on the row the ledger hands back. (Only the signature and the card.update frames are skipped.)
  const answerAsInbound = async (x: Harness, action: 'primary' | 'kill') => {
    const row = heldRow(x)
    const pre = x.bridge.ctx.permission.precheck(row.id, action)
    if (pre.handled && !pre.ok) throw new Error(`precheck refused: ${pre.code}`)
    const out = x.bridge.ctx.ledger.resolve(
      { card_id: row.id, action, payload_hash: row.payload_hash, ts: new Date(x.bridge.ctx.clock.now()).toISOString() },
      x.bridge.ctx.clock.now(),
    )
    if (!out.ok) throw new Error(`ledger refused: ${out.code}`)
    return x.bridge.ctx.permission.onResolved(out.row, action)
  }
  const longWait = (x: Harness) => x.bridge.ctx.permission.setHookTimings({ maxWaitMs: LONG })

  // The create frame has not reached the fake relay, so the app cannot sign a tap. This is the call inbound-cards.ts makes
  // after it has checked the signature, on the row in the ledger.
  test('(a) Allow while the create is held: the hook hears allow at once', async () => {
    const x = await start()
    longWait(x)
    const hold = holdSend(x)
    try {
      const call = rawCall(x.home, permLine())
      await hold.sent()
      const explained: string[] = []
      x.bridge.ctx.permission.setExplainer({
        explain: async () => {
          explained.push('asked')
          return { ok: false, reason: 'spy' }
        },
      })
      await answerAsInbound(x, 'primary')
      expect(await promptly(call.result)).toMatchObject({ decision: 'allow' })
      hold.release()
      await sleep(300)
      expect(explained).toEqual([]) // answered before the send settled: no model call for a card nobody can answer
    } finally {
      hold.restore()
    }
  })

  test('(b) Deny while the create is held: the hook hears deny at once', async () => {
    const x = await start()
    longWait(x)
    const hold = holdSend(x)
    try {
      const call = rawCall(x.home, permLine())
      await hold.sent()
      await answerAsInbound(x, 'kill')
      expect(await promptly(call.result)).toMatchObject({ decision: 'deny' })
      hold.release()
    } finally {
      hold.restore()
    }
  })

  test('(c) a send that fails: none with send_failed, the card expired, no waiter and no open id left behind', async () => {
    const x = await start()
    longWait(x)
    const hold = holdSend(x)
    try {
      const call = rawCall(x.home, permLine())
      await hold.sent()
      const id = heldRow(x).id
      hold.fail()
      expect(await promptly(call.result)).toMatchObject({ decision: 'none', reason: 'send_failed' })
      await eventually(() => expect(x.bridge.ctx.ledger.get(id)?.state).toBe('expired'))
      expect(x.bridge.ctx.permission.openCount).toBe(0)
      // nothing is left to answer it
      const out = await x.bridge.ctx.permission.onResolved(x.bridge.ctx.ledger.get(id) as never, 'primary')
      expect(out.ok).toBe(false)
    } finally {
      hold.restore()
    }
  })

  test('(d) a send that succeeds: expiry.sync runs, then the explainer is asked, both only after the send settles', async () => {
    const x = await start()
    longWait(x)
    const order: string[] = []
    x.bridge.ctx.permission.setExplainer({
      explain: async () => {
        order.push('explain')
        return { ok: false, reason: 'spy' }
      },
    })
    const expiry = x.bridge.ctx.expiry
    const realSync = expiry?.sync.bind(expiry)
    if (expiry && realSync)
      expiry.sync = () => {
        order.push('sync')
        return realSync()
      }
    const hold = holdSend(x)
    try {
      const call = rawCall(x.home, permLine())
      await hold.sent()
      await sleep(150)
      expect(order).toEqual([]) // the send is still held: neither has run
      hold.release()
      await eventually(() => expect(order).toContain('explain'))
      expect(order).toEqual(expiry ? ['sync', 'explain'] : ['explain'])
      call.close()
    } finally {
      hold.restore()
      if (expiry && realSync) expiry.sync = realSync
    }
  })

  test('(e) the hook leaves while the create is held: the card closes as hook_gone', async () => {
    const x = await start()
    longWait(x)
    const hold = holdSend(x)
    try {
      const call = rawCall(x.home, permLine())
      await hold.sent()
      const id = heldRow(x).id
      call.close()
      await eventually(() => expect(x.bridge.ctx.ledger.get(id)?.state).toBe('expired'))
      expect(x.bridge.ctx.permission.openCount).toBe(0)
      hold.release()
      const gone = await x.relay.expectFrame('card.update', (f) => f.card_id === id && f.state === 'expired', {
        direction: 'from_bridge',
      })
      expect(gone.reason).toBe('hook_gone')
    } finally {
      hold.restore()
    }
  })
})

describe('a slow relay card send never makes the hook raise a second card', () => {
  const relayParams = (input: string) => ({
    request_id: 'abcde',
    tool_name: 'Bash',
    description: 'Run it',
    input_preview: input,
  })
  const git = { command: 'git push origin main' }
  const main = { pid: SESSION_PID, cwd: '/srv/proj' }
  const GIT_PREVIEW = '{"command": "git push origin main"}'
  const SLOW_MS = 400 // well past the 150 ms grace this file's bridge runs with

  /** Holds the channel relay's card.create (request id abcde) until the test releases or fails it; the hook's own cards pass. */
  function holdRelaySend(x: Harness) {
    const t = x.bridge.ctx.transport as unknown as { sendDurable: (f: unknown) => Promise<unknown> }
    const real = t.sendDurable
    let release: () => void = () => {}
    let fail: () => void = () => {}
    t.sendDurable = function (this: unknown, f: unknown) {
      const fr = f as { type: string; card?: { kind: string; payload?: { request_id?: string } } }
      if (fr.type !== 'card.create' || fr.card?.kind !== 'permission' || fr.card.payload?.request_id !== 'abcde')
        return real.call(this, f)
      return new Promise((res, rej) => {
        release = () => real.call(this, f).then(res, rej)
        fail = () => rej(new Error('relay down'))
      })
    }
    return { release: () => release(), fail: () => fail() }
  }
  /** A hook wait long enough that a lost answer shows as a hang, not as a timeout answer. */
  const longWait = (x: Harness) => x.bridge.ctx.permission.setHookTimings({ maxWaitMs: 60_000 })
  const raced = <T>(p: Promise<T>, ms = 3_000) =>
    Promise.race([p, sleep(ms).then(() => 'still waiting' as const)]) as Promise<T | 'still waiting'>

  test('(a) slow send, then success: the hook raises no card and returns relay_carries_it once the send goes', async () => {
    const x = await start()
    longWait(x)
    const hold = holdRelaySend(x)
    const sending = x.bridge.ctx.permission.onRequest(relayParams(GIT_PREVIEW))
    const call = rawCall(x.home, permLine(main, git))
    await sleep(SLOW_MS)
    expect(permissionCards(x)).toHaveLength(0) // the relay's card is held; the hook has not made one of its own
    expect(await raced(call.result, 100)).toBe('still waiting')
    hold.release()
    await sending
    expect(await raced(call.result)).toMatchObject({ decision: 'none', reason: 'relay_carries_it' })
    expect(permissionCards(x)).toHaveLength(1)
  })

  test('(b) slow send, then failure: the hook that took the twin raises its own card and the owner answer reaches it', async () => {
    const x = await start()
    longWait(x)
    const hold = holdRelaySend(x)
    const sending = x.bridge.ctx.permission.onRequest(relayParams(GIT_PREVIEW))
    const call = rawCall(x.home, permLine(main, git))
    await sleep(SLOW_MS)
    hold.fail()
    await sending
    const card = await hookCard(x)
    expect(permissionCards(x)).toHaveLength(1)
    await approve(x, card)
    expect(await raced(call.result)).toMatchObject({ decision: 'allow' })
  })

  test('(c) the send fails before any hook arrives: a later hook finds no twin and raises its own card', async () => {
    const x = await start()
    longWait(x)
    const hold = holdRelaySend(x)
    const sending = x.bridge.ctx.permission.onRequest(relayParams(GIT_PREVIEW))
    hold.fail()
    await sending
    const call = rawCall(x.home, permLine(main, git))
    const card = await hookCard(x)
    await approve(x, card)
    expect(await raced(call.result)).toMatchObject({ decision: 'allow' })
  })

  test('(d) a fast send: one card, and the hook says relay_carries_it', async () => {
    const x = await start()
    longWait(x)
    await x.bridge.ctx.permission.onRequest(relayParams(GIT_PREVIEW))
    expect(await raced(rawCall(x.home, permLine(main, git)).result)).toMatchObject({
      decision: 'none',
      reason: 'relay_carries_it',
    })
    await sleep(100)
    expect(permissionCards(x)).toHaveLength(1)
  })

  test('(e) a relay card that cannot stand in (part of the call hidden) is no twin even while its send is held', async () => {
    const x = await start()
    longWait(x)
    const hold = holdRelaySend(x)
    const masked = relayParams('{"command": "git push origin main", "token": "[REDACTED]"}')
    const sending = x.bridge.ctx.permission.onRequest(masked)
    const call = rawCall(x.home, permLine(main, { command: 'git push origin main', token: '[REDACTED]' }))
    const card = await hookCard(x)
    await approve(x, card)
    expect(await raced(call.result)).toMatchObject({ decision: 'allow' })
    hold.release()
    await sending
  })

  test('the relay card is dropped (onCardGone) while its send is out: it never stands in, the hook raises its own card', async () => {
    const x = await start()
    longWait(x)
    const hold = holdRelaySend(x)
    const sending = x.bridge.ctx.permission.onRequest(relayParams(GIT_PREVIEW))
    const call = rawCall(x.home, permLine(main, git))
    await sleep(SLOW_MS) // the hook took the twin and waits on the send
    const relayRow = x.bridge.ctx.ledger.list('pending').find((r) => r.binding.kind === 'permission')
    expect(relayRow).toBeDefined()
    x.bridge.ctx.permission.onCardGone(relayRow?.id ?? '')
    hold.release()
    await sending
    const card = await hookCard(x)
    await approve(x, card)
    expect(await raced(call.result)).toMatchObject({ decision: 'allow' })
  })

  test('a hook that leaves while waiting on the send returns hook_gone, and the relay card is still sent once', async () => {
    const x = await start()
    longWait(x)
    const hold = holdRelaySend(x)
    const sending = x.bridge.ctx.permission.onRequest(relayParams(GIT_PREVIEW))
    const ctl = new AbortController()
    const hook = x.bridge.ctx.permission.onHookRequest(
      { tool_name: 'Bash', tool_input: git, pid: SESSION_PID, cwd: '/srv/proj' } as never,
      ctl.signal,
    )
    await sleep(SLOW_MS) // past the grace: the hook holds the twin and waits on the send
    ctl.abort()
    expect(await raced(hook)).toMatchObject({ decision: 'none', reason: 'hook_gone' })
    hold.release()
    await sending
    expect(permissionCards(x)).toHaveLength(1)
  })
})
