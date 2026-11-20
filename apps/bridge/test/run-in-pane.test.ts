// A Run for the owner's own terminal pane (docs/TERMINAL-PANE.md "One path to the shell"). A tap that is signed with
// `run_where: 'pane'` goes through the same checks and the same once-only mark as any Run, and then is NOT handed to the agent:
// the bridge sends {thread_id, script, run_id, signed_by} to the Mac app's own socket, and whatever short of ok comes back is a
// line the owner reads in the thread. Real inbound, real signed frames, real workers; the Mac app is a stand-in that refuses what
// the real one refuses (its identity rule is the Swift side's own test, `ShellRunChannelTests`).
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { newId, RUN_MAX_AGE_MS, RUN_PANE_FEATURE, runText } from '@talos-app/protocol'
import { FakeApp } from '@talos-app/testkit'
import { bridgeFeatures } from '../src/handshake.ts'
import {
  PANE_APP_CLOSED,
  PANE_RUN_APP_BUDGET_MS,
  PANE_RUN_TIMEOUT_MS,
  PaneChannel,
  paneFailLine,
  paneTransport,
  sendPaneRun,
} from '../src/pane-run.ts'
import { screenRequest, screenSockPath } from '../src/screen.ts'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
let phone: FakeApp | undefined
const original = paneTransport.request
afterEach(async () => {
  paneTransport.request = original
  await phone?.close()
  phone = undefined
  await h?.stop()
  h = undefined
})
const hh = () => h as Harness

const SCRIPT = 'echo hello\nls -la\n'
/** The stand-in app vouches for every id (the witness rule itself is the Swift side's: ShellRunChannelTests). */
const ALL = { includes: () => true } as unknown as string[]
const blockRef = () => ({ message_id: newId('m'), index: 0 })
const paneFrame = (x: FakeApp, script = SCRIPT, extra: Record<string, unknown> = {}, thread = 'general') =>
  x.buildMessage(thread, runText(script, 'sh') as string, {
    intent: 'run',
    run_block: blockRef(),
    run_where: 'pane',
    ...extra,
  })

const notices = (x: Harness) =>
  x.relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.raw.type === 'reply')
    .map((f) => (f.raw as { message: { author: string; text: string } }).message)
    .filter((m) => m.author === 'system')
    .map((m) => m.text)

/** Everything sent before this has been handled when it returns: frames are taken in order. */
async function afterQueue(x: Harness) {
  const word = `sentinel ${newId('m')}`
  x.app.send(await x.app.buildMessage('general', word))
  await waitFor(() => x.notes.some((n) => n.content === word), 8000, 'the queue to reach the last message')
}

type Seen = Record<string, unknown>
/**
 * The Mac app, as far as the bridge can tell: it takes the request, and answers like the real one. Its rule is the same: a pane
 * Run runs only for a message id the owner's own click vouched for (`witnessed`); anything else is refused and says why.
 * `down` makes it answer like a socket nobody listens on.
 */
function macApp(witnessed: string[], opts: { down?: boolean; code?: string } = {}): Seen[] {
  const seen: Seen[] = []
  const used = new Set<string>()
  paneTransport.request = async (_ctx, req) => {
    // the channel probe is a request of its own (`pane_status`): the Mac app answers it while it is there
    if (req.op === 'pane_status')
      return opts.down ? { ok: false, code: 'not_running', text: '' } : { ok: true, body: { ok: true } }
    seen.push(req)
    if (opts.down) return { ok: false, code: 'not_running', text: '' }
    if (opts.code) return { ok: false, code: opts.code, text: '' }
    const id = String(req.client_msg_id)
    if (!witnessed.includes(id) || used.has(id))
      return { ok: false, code: 'no_witness', text: "your click in the Mac app didn't come with that Run" }
    used.add(id)
    return { ok: true, body: { ok: true } }
  }
  return seen
}

async function second(x: Harness): Promise<FakeApp> {
  const p = new FakeApp({ relayWs: x.relay.wsBase })
  await p.connect()
  const file = join(x.home, 'devices.json')
  const cur = JSON.parse(readFileSync(file, 'utf8')) as { version: 1; devices: Record<string, unknown>[] }
  cur.devices.push({
    id: p.device.deviceId,
    name: 'Mac app',
    pubkey_jwk: p.device.publicJwk,
    pinned_at: new Date().toISOString(),
  })
  writeFileSync(file, JSON.stringify(cur), { mode: 0o600 })
  return p
}

describe('a pane Run', () => {
  test('goes to the Mac app once, with the signed tap own message id, and never to the agent', async () => {
    h = await startHarness()
    const seen = macApp(ALL)
    const f = await paneFrame(hh().app)
    hh().app.send(f)
    await waitFor(() => seen.length === 1, 5000, 'the request to the Mac app')
    expect(seen[0]).toMatchObject({
      op: 'pane_run',
      thread_id: 'general',
      script: SCRIPT,
      client_msg_id: f.client_msg_id,
    })
    await afterQueue(hh())
    expect(hh().notes.filter((n) => n.meta.run === 'tap' || n.content.includes('echo hello'))).toHaveLength(0)
    expect(notices(hh())).toEqual([])
  })

  test('a replay, and the same tap under a new frame id, reaches the Mac app once', async () => {
    h = await startHarness()
    const seen = macApp(ALL)
    const f = await paneFrame(hh().app)
    hh().app.send(f)
    await waitFor(() => seen.length === 1, 5000, 'the first request')
    hh().relay.sendToBridge(f as never)
    hh().relay.sendToBridge((await paneFrame(hh().app, SCRIPT, { client_msg_id: f.client_msg_id })) as never)
    await afterQueue(hh())
    expect(seen).toHaveLength(1)
    expect(hh().notes.some((n) => n.content.includes('echo hello'))).toBe(false)
  })

  test('a fresh tap on the same block is a new Run', async () => {
    h = await startHarness()
    const seen = macApp(ALL)
    const block = blockRef()
    hh().app.send(await paneFrame(hh().app, SCRIPT, { run_block: block }))
    await waitFor(() => seen.length === 1, 5000, 'the first request')
    hh().app.send(await paneFrame(hh().app, SCRIPT, { run_block: block }))
    await waitFor(() => seen.length === 2, 5000, 'the second request')
    expect(seen[0]?.client_msg_id).not.toBe(seen[1]?.client_msg_id)
  })

  test('signed on a phone, with no click in the Mac app: the app refuses for want of a witness, the owner is told, the agent hears nothing', async () => {
    h = await startHarness()
    phone = await second(hh())
    const seen = macApp([]) // nothing was clicked in the Mac app
    const f = await paneFrame(phone)
    phone.send(f)
    await waitFor(() => seen.length === 1, 5000, 'the request')
    // the bridge passed the phone's message id unchanged; it cannot make the app believe it
    expect(seen[0]?.client_msg_id).toBe(f.client_msg_id)
    await waitFor(() => notices(hh()).length === 1, 5000, 'the line for the owner')
    expect(notices(hh())[0]).toBe(paneFailLine("your click in the Mac app didn't come with that Run"))
    await afterQueue(hh())
    expect(hh().notes.some((n) => n.content.includes('echo hello') || n.meta.run === 'tap')).toBe(false)
  })

  test('the Mac app is not open: not routed, a visible refusal in the thread, never the agent, the tap is spent', async () => {
    h = await startHarness()
    const seen = macApp(ALL, { down: true })
    const f = await paneFrame(hh().app)
    hh().app.send(f)
    await waitFor(() => notices(hh()).length === 1, 5000, 'the line for the owner')
    // the exact words the owner reads (and the web app's status line is built on)
    expect(notices(hh())[0]).toBe(
      "Run couldn't reach the terminal pane: the Talos Mac app isn't open on this Mac. Nothing was run.",
    )
    expect(notices(hh())[0]).toBe(paneFailLine(PANE_APP_CLOSED))
    hh().relay.sendToBridge(f as never)
    await afterQueue(hh())
    expect(seen).toHaveLength(0) // run-pane/1 is not listed: the Run is not even sent
    expect(notices(hh())).toHaveLength(1)
    expect(hh().notes.some((n) => n.content.includes('echo hello') || n.meta.run === 'tap')).toBe(false)
  })

  test('the channel dies between the look and the Run: the app is asked, answers nothing, and the owner is told the same words', async () => {
    h = await startHarness()
    const seen: Record<string, unknown>[] = []
    paneTransport.request = async (_ctx, req) => {
      if (req.op === 'pane_status') return { ok: true, body: { ok: true } }
      seen.push(req)
      return { ok: false, code: 'not_running', text: '' }
    }
    hh().app.send(await paneFrame(hh().app))
    await waitFor(() => notices(hh()).length === 1, 5000, 'the line for the owner')
    expect(seen).toHaveLength(1)
    expect(notices(hh())[0]).toBe(paneFailLine(PANE_APP_CLOSED))
    expect(hh().notes.some((n) => n.content.includes('echo hello'))).toBe(false)
  })

  test('every answer short of ok is a line, an unknown code included', async () => {
    h = await startHarness()
    macApp(ALL, { code: 'brand_new_code' })
    hh().app.send(await paneFrame(hh().app))
    await waitFor(() => notices(hh()).length === 1, 5000, 'the line for the owner')
    expect(notices(hh())[0]).toContain("Run couldn't reach the terminal pane: Talos.app refused (brand_new_code)")
  })

  test('a transport that throws is a line, not a lost tap', async () => {
    h = await startHarness()
    paneTransport.request = async (_ctx, req) => {
      if (req.op === 'pane_status') return { ok: true, body: { ok: true } }
      throw new Error('socket exploded')
    }
    hh().app.send(await paneFrame(hh().app))
    await waitFor(() => notices(hh()).length === 1, 5000, 'the line for the owner')
    expect(notices(hh())[0]).toContain('socket exploded')
  })

  test('no answer in time: the line does not say nothing was run, and says to look before running it again', async () => {
    h = await startHarness()
    const f = await paneFrame(hh().app)
    paneTransport.request = async (_ctx, req) =>
      req.op === 'pane_status' ? { ok: true, body: { ok: true } } : { ok: false, code: 'no_answer', text: '' }
    hh().app.send(f)
    await waitFor(() => notices(hh()).length === 1, 5000, 'the line for the owner')
    expect(notices(hh())[0]).toBe(
      "Run couldn't reach the terminal pane: Talos.app didn't answer in time; check the terminal pane before running it again.",
    )
    expect(notices(hh())[0]).not.toContain('Nothing was run')
    expect(paneFailLine('x', true)).not.toContain('Nothing was run')
    expect(paneFailLine('x')).toContain('Nothing was run')
  })

  test('an answer that cannot be read is not "nothing was run" either', async () => {
    h = await startHarness()
    paneTransport.request = async (_ctx, req) =>
      req.op === 'pane_status' ? { ok: true, body: { ok: true } } : { ok: false, code: 'bad_answer', text: '' }
    hh().app.send(await paneFrame(hh().app))
    await waitFor(() => notices(hh()).length === 1, 5000, 'the line for the owner')
    expect(notices(hh())[0]).toBe(
      "Run couldn't reach the terminal pane: Talos.app's answer couldn't be read; check the terminal pane before running it again.",
    )
  })

  test('the bridge waits longer than the app can take: its whole budget and at least two seconds more', () => {
    expect(PANE_RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(PANE_RUN_APP_BUDGET_MS + 2000)
    // witness wait 1.5 s + pane wait 5 s + clear wait 3 s fit in the app's budget, with room to paste
    expect(1_500 + 5_000 + 3_000).toBeLessThan(PANE_RUN_APP_BUDGET_MS)
  })

  test('the same checks as any Run: a tap signed too long ago is refused and never sent', async () => {
    h = await startHarness()
    const seen = macApp(ALL)
    hh().app.send(
      await paneFrame(hh().app, SCRIPT, { ts: new Date(Date.now() - RUN_MAX_AGE_MS - 3600_000).toISOString() }),
    )
    await waitFor(() => notices(hh()).length === 1, 5000, 'the refusal')
    expect(notices(hh())[0]).toContain('signed more than a day ago')
    expect(seen).toHaveLength(0)
  })

  test('a thread with its own session takes a pane Run (no agent is involved) but still refuses a plain one', async () => {
    h = await startHarness({
      config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
        ...c,
        threads: [
          ...c.threads,
          {
            id: 'trip',
            name: 'Trip',
            kind: 'fixed',
            order: 5,
            notify: 'all',
            archived: false,
            created_at: '2026-10-28T00:00:00.000Z',
            session: 'dedicated',
          },
        ],
        dedicated: { enabled: true },
      })) as never,
    })
    const seen = macApp(ALL)
    hh().app.send(await paneFrame(hh().app, SCRIPT, {}, 'trip'))
    await waitFor(() => seen.length === 1, 5000, 'the request')
    expect(seen[0]?.thread_id).toBe('trip')
    hh().app.send(
      await hh().app.buildMessage('trip', runText(SCRIPT, 'sh') as string, { intent: 'run', run_block: blockRef() }),
    )
    await waitFor(() => notices(hh()).length === 1, 5000, 'the refusal of the plain one')
    expect(notices(hh())[0]).toContain("has its own session, so Run isn't available here")
    expect(seen).toHaveLength(1)
  })
})

describe('a place the schema does not know', () => {
  test.each([['agent'], ['PANE'], ['pane '], ['tmux'], [''], [['pane']], [null], [1]])(
    'run_where %p is a bad frame: sent nowhere, never run by the agent',
    async (v) => {
      h = await startHarness()
      const seen = macApp(ALL)
      hh().app.send(await paneFrame(hh().app, SCRIPT, { run_where: v }))
      await sleep(300)
      await afterQueue(hh())
      expect(seen).toHaveLength(0)
      expect(hh().notes.some((n) => n.content.includes('echo hello') || n.meta.run === 'tap')).toBe(false)
    },
  )

  test('a refused place spends nothing: the same block, asked for properly, runs', async () => {
    h = await startHarness()
    const seen = macApp(ALL)
    const block = blockRef()
    hh().app.send(await paneFrame(hh().app, SCRIPT, { run_block: block, run_where: 'nowhere' }))
    await sleep(300)
    hh().app.send(await paneFrame(hh().app, SCRIPT, { run_block: block }))
    await waitFor(() => seen.length === 1, 5000, 'the request')
  })
})

describe('the normal Run is unchanged', () => {
  test('no run_where: the agent gets it once as run=tap, and the Mac app is never asked', async () => {
    h = await startHarness()
    const seen = macApp(ALL)
    const f = await hh().app.buildMessage('general', runText(SCRIPT, 'sh') as string, {
      intent: 'run',
      run_block: blockRef(),
    })
    hh().app.send(f)
    await hh().waitNotes(1)
    expect(hh().notes[0]?.meta).toMatchObject({ kind: 'text', trust: 'owner', run: 'tap', thread_id: 'general' })
    expect(hh().notes[0]?.content).toBe(runText(SCRIPT, 'sh') as string)
    expect(seen).toHaveLength(0)
    expect(notices(hh())).toEqual([])
  })

  test('a message with run_where but no intent run is refused in the thread, not routed and not read as text', async () => {
    h = await startHarness()
    const seen = macApp(ALL)
    hh().app.send(await hh().app.buildMessage('general', runText(SCRIPT, 'sh') as string, { run_where: 'pane' }))
    await waitFor(() => notices(hh()).length === 1, 5000, 'the refusal')
    expect(notices(hh())[0]).toBe(
      'That message was not run: it asked for the terminal pane but is not a Run. Nothing was run.',
    )
    await afterQueue(hh())
    expect(seen).toHaveLength(0)
    expect(hh().notes.some((n) => n.content.includes('echo hello'))).toBe(false)
  })
})

// The client itself, against a real Unix socket answered the way the app answers (TalosDesktopCore ScreenSocket).
// The real client asks only on a Mac (screenRequest refuses every other platform as not_mac), so the socket cases run on
// a Mac and the refusal is checked everywhere: on Linux CI against the real platform, and on every OS with the platform named.
const MAC = process.platform === 'darwin'
const MAC_ONLY_LINE = 'the terminal pane is only in the Talos Mac app'
describe('the request to the Mac app', () => {
  const homes: string[] = []
  const servers: Server[] = []
  const conns: Socket[] = []
  afterEach(async () => {
    for (const c of conns.splice(0)) c.destroy()
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
    for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  async function serve(answer: (req: Record<string, unknown>) => string | null) {
    const home = mkdtempSync('/tmp/tsb-')
    homes.push(home)
    mkdirSync(join(home, 'run'), { mode: 0o700 })
    const seen: Record<string, unknown>[] = []
    const server = createServer((sock) => {
      conns.push(sock)
      let buf = ''
      sock.on('data', (b) => {
        buf += b.toString('utf8')
        const nl = buf.indexOf('\n')
        if (nl < 0) return
        const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
        seen.push(req)
        const out = answer(req)
        if (out !== null) sock.write(`${out}\n`)
      })
      sock.on('error', () => {})
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(screenSockPath(home), () => r()))
    return { home, seen }
  }
  const ctxFor = (home: string) => ({ paths: { home } }) as never
  const req = { thread_id: 'general', script: SCRIPT, client_msg_id: 'm_x' }

  test.if(MAC)('sends one line with the op and the three fields; ok is the only success', async () => {
    const { home, seen } = await serve(() => '{"ok":true,"v":1}')
    expect(await sendPaneRun(ctxFor(home), req)).toEqual({ ok: true })
    expect(seen).toEqual([{ v: 1, op: 'pane_run', id: 'm_x', ...req }])
  })

  test('off a Mac the client never touches the socket: not_mac, said as the Mac-only line, never ok', async () => {
    const { home, seen } = await serve(() => '{"ok":true,"v":1}')
    expect(await screenRequest(home, { op: 'pane_run', ...req }, { platform: 'linux' })).toMatchObject({
      ok: false,
      code: 'not_mac',
    })
    expect(seen).toEqual([])
  })

  test.if(!MAC)('on this (non-Mac) machine a pane Run is refused with the Mac-only line', async () => {
    const { home, seen } = await serve(() => '{"ok":true,"v":1}')
    expect(await sendPaneRun(ctxFor(home), req)).toEqual({ ok: false, why: MAC_ONLY_LINE })
    expect(seen).toEqual([])
  })

  test.if(MAC)('an older app answers unknown_op: the owner is told to update, not "ok"', async () => {
    const { home } = await serve(() => '{"ok":false,"v":1,"error":{"code":"unknown_op","text":"No screen operation"}}')
    const r = await sendPaneRun(ctxFor(home), req)
    expect(r).toEqual({ ok: false, why: 'this Talos.app is older and cannot run a script in the pane. Update it' })
  })

  test.if(MAC)('no socket: not running. An answer that is not the app shape: a failure, never ok', async () => {
    const none = mkdtempSync('/tmp/tsb-')
    homes.push(none)
    expect(await sendPaneRun(ctxFor(none), req)).toEqual({ ok: false, why: PANE_APP_CLOSED })
    const { home } = await serve(() => '{"ok":"yes"}')
    const r = await sendPaneRun(ctxFor(home), req)
    expect(r.ok).toBe(false)
  })

  test.if(MAC)('the real client gives up on a silent app with a line saying the script may not have run', async () => {
    const { home } = await serve(() => null)
    const a = await screenRequest(home, { op: 'pane_run', ...req }, { timeoutMs: 200 })
    expect(a).toMatchObject({ ok: false, code: 'no_answer' })
  })
})

// run-pane/1 is listed only while the Mac app's run channel answers, and leaves when it goes
describe('the run-pane/1 feature', () => {
  const ctxWith = (home: string, extra: object = {}) =>
    ({ paths: { home }, clock: { setTimeout, clearTimeout }, ...extra }) as never
  test('not listed with no channel; listed with one; gone again when a pane Run finds it down', async () => {
    const home = mkdtempSync('/tmp/tsb-')
    let changes = 0
    const ch = new PaneChannel(ctxWith(home), () => changes++, 60_000)
    expect(bridgeFeatures({ paneRun: ch })).not.toContain(RUN_PANE_FEATURE)
    paneTransport.request = async () => ({ ok: true, body: { ok: true } })
    ch.start()
    await waitFor(() => bridgeFeatures({ paneRun: ch }).includes(RUN_PANE_FEATURE), 3000, 'the channel to answer')
    expect(changes).toBe(1)
    paneTransport.request = async () => ({ ok: false, code: 'not_running', text: '' })
    const ctx = ctxWith(home, { paneRun: ch })
    expect((await sendPaneRun(ctx, { thread_id: 'general', script: SCRIPT, client_msg_id: 'm_x' })).ok).toBe(false)
    expect(bridgeFeatures({ paneRun: ch })).not.toContain(RUN_PANE_FEATURE)
    expect(changes).toBe(2)
    ch.stop()
    rmSync(home, { recursive: true, force: true })
  })

  test('the probe sees the channel go away between Runs', async () => {
    const home = mkdtempSync('/tmp/tsb-')
    let up = true
    paneTransport.request = async () =>
      up ? { ok: true, body: { ok: true } } : { ok: false, code: 'not_running', text: '' }
    const ch = new PaneChannel(ctxWith(home), () => {}, 20)
    ch.start()
    await waitFor(() => ch.available, 3000, 'up')
    up = false
    await waitFor(() => !ch.available, 3000, 'down')
    ch.stop()
    rmSync(home, { recursive: true, force: true })
  })
})
