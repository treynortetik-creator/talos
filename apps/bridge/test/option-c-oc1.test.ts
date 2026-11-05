// Option C, WP-OC1 (docs/OPTION-C.md): worker mode, the hub socket, read_inbound, routing with exactly-once claims and
// deadlines, the governor and thread.session.control. Real bridges (one live = the hub, one in worker mode) over the
// FakeRelay, a fake Bot API, and a workers.json written the way the desktop supervisor writes it. No real claude.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAIM_DEADLINE_MS, DedicatedConfig, newUlid, WakeFile, WORKER_BRIDGE_TOOLS } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { cardUpdateFrame } from '../src/frames-out.ts'
import { pgidOf } from '../src/hub/server.ts'
import { nullLogger } from '../src/log.ts'
import { advanceSteps, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

const NONCE = 'test-nonce-0123456789abcdef'
let h: Harness | undefined
let worker: Bridge | undefined
afterEach(async () => {
  await worker?.stop()
  worker = undefined
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

type Entry = { state: string; pane_pid?: number; error?: unknown }
function writeWorkers(home: string, now: number, threads: Record<string, Entry>, opts: { stale?: boolean } = {}) {
  const at = new Date(opts.stale ? now - 60_000 : now).toISOString()
  const t: Record<string, unknown> = {}
  for (const [id, e] of Object.entries(threads))
    t[id] = {
      state: e.state,
      session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
      tmux: `t-${id}`,
      pane_pid: e.pane_pid ?? 0,
      cwd: home,
      error: e.error ?? null,
    }
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({ v: 1, supervisor: { pid: 1, heartbeat_at: at, workers_supported: true }, threads: t }),
  )
}
function writeNonce(home: string, id: string) {
  mkdirSync(join(home, 'workers', id), { recursive: true })
  writeFileSync(join(home, 'workers', id, 'nonce'), NONCE)
}

const myPgid = () => pgidOf(process.pid) as number

/** waitFor that also nudges a fake clock, so timers on it (the inbound settle window) can fire. */
async function waitTicking(clock: ReturnType<typeof fakeClock>, cond: () => boolean, ms = 4000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    clock.advance(50)
    await sleep(20)
  }
}

async function hub(opts: { clock?: ReturnType<typeof fakeClock> } = {}) {
  h = await startHarness({
    ...(opts.clock ? { clock: opts.clock } : {}),
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [
        ...c.threads,
        thread('trip', 'Trip', { session: 'dedicated' }),
        thread('garden', 'Garden', { session: 'dedicated' }),
        thread('shared_one', 'Shared'),
      ],
      dedicated: { enabled: true },
    })) as never,
  })
  await waitFor(() => existsSync(join(h?.home as string, 'hub.sock')))
  return h
}

async function startWorker(home: string, relayUrl: string, connect = true) {
  worker = await Bridge.create({
    env: loadEnv({
      TALOS_APP_HOME: home,
      TALOS_APP_RELAY_URL: relayUrl,
      TALOS_APP_WORKER_THREAD: 'trip',
      TALOS_APP_WORKER_NONCE: NONCE,
    }),
    logger: nullLogger,
  })
  if (connect) {
    const ok = await worker.startWorker()
    expect(ok, `the worker was refused: ${JSON.stringify(worker.hubClient?.lastRefusal)}`).toBe(true)
  }
  return worker
}

describe('OC1: worker mode is fail-closed', () => {
  test('worker env plus TALOS_APP_BRIDGE=1: non-zero exit, no bridge.pid, no relay socket', async () => {
    const home = mkdtempSync(join(tmpdir(), 'oc1-fail-'))
    const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, '..', 'src', 'server.ts')], {
      env: {
        ...process.env,
        TALOS_APP_HOME: home,
        TALOS_APP_BRIDGE: '1',
        TALOS_APP_WORKER_THREAD: 'trip',
        TALOS_APP_RELAY_URL: 'http://127.0.0.1:9',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    expect(code).not.toBe(0)
    expect(await new Response(proc.stderr).text()).toContain('never the live bridge')
    expect(existsSync(join(home, 'bridge.pid'))).toBe(false)
    expect(existsSync(join(home, 'hub.sock'))).toBe(false)
  })

  test('a bad thread id refuses too', async () => {
    const home = mkdtempSync(join(tmpdir(), 'oc1-bad-'))
    const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, '..', 'src', 'server.ts')], {
      env: { ...process.env, TALOS_APP_HOME: home, TALOS_APP_WORKER_THREAD: 'Not A Thread' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).not.toBe(0)
  })

  test('tools: only the worker list; another thread is refused naming only its own', async () => {
    const hh = await hub()
    const w = await startWorker(hh.home, hh.relay.httpUrl, false)
    expect(w.tools.map((t) => t.name).sort()).toEqual([...WORKER_BRIDGE_TOOLS].sort())
    expect(w.tools.some((t) => t.name === 'create_thread')).toBe(false)
    const r = await w.callTool('reply', { thread_id: 'general', text: 'hi' })
    expect(r.isError).toBe(true)
    const msg = r.content[0]?.text ?? ''
    expect(msg).toContain('Valid thread ids: trip')
    expect(msg).not.toContain('general,')
    expect((await w.callTool('create_thread', { name: 'x' })).isError).toBe(true)
    expect((await w.callTool('set_status', { thread_id: 'garden', state: 'working' })).isError).toBe(true)
  })
})

describe('OC1: the hub socket', () => {
  test('hub up: a worker reply reaches the relay over the live socket', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const w = await startWorker(hh.home, hh.relay.httpUrl)
    expect(existsSync(join(hh.home, 'workers', 'trip', 'ready'))).toBe(true)
    const r = await w.callTool('reply', { thread_id: 'trip', text: 'Booked the train.' })
    expect(r.isError).toBeFalsy()
    expect(r.content[0]?.text).toMatch(/^sent/)
    await hh.relay.expectFrame('reply', (f) => f.message.text === 'Booked the train.', { direction: 'from_bridge' })
  })

  test('hub refuses hello from a pid outside the pane group, a wrong nonce, or a shared thread', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() + 999_999 } })
    writeNonce(hh.home, 'trip')
    const hubServer = hh.bridge.hub
    expect(hubServer).toBeDefined()
    expect(hubServer?.checkHello({ thread_id: 'trip', pid: process.pid, nonce: NONCE })?.code).toBe('not_owner')
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    expect(hubServer?.checkHello({ thread_id: 'trip', pid: process.pid, nonce: NONCE })).toBeNull()
    expect(hubServer?.checkHello({ thread_id: 'trip', pid: process.pid, nonce: 'x'.repeat(20) })?.code).toBe(
      'not_owner',
    )
    expect(hubServer?.checkHello({ thread_id: 'shared_one', pid: process.pid, nonce: NONCE })?.code).toBe('not_owner')
    // a dead pid (no process group) is refused
    expect(hubServer?.checkHello({ thread_id: 'trip', pid: 2 ** 22 + 17, nonce: NONCE })?.code).toBe('not_owner')
    // the real path: the client gets `refused`, not `welcome`
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() + 999_999 } })
    const w = await startWorker(hh.home, hh.relay.httpUrl, false)
    expect(await w.startWorker()).toBe(false)
    expect(w.hubClient?.lastRefusal?.code).toBe('not_owner')
  })

  test('a worker frame for another thread is refused by the hub', async () => {
    const hh = await hub()
    const res = await hh.bridge.hub?.onOut('trip', {
      v: 1,
      type: 'status',
      id: '01JBF3V7Q8K2M4N6P8R0S2T4A1',
      ts: new Date().toISOString(),
      thread_id: 'garden',
      state: 'working',
      since: new Date().toISOString(),
    })
    expect(res).toMatchObject({ ok: false, code: 'not_owner' })
    expect((await hh.bridge.hub?.onOut('trip', { type: 'config.sync', id: 'x' }))?.ok).toBe(false)
  })

  test('hub down: the reply goes over HTTP and reaches the relay', async () => {
    const hh = await hub()
    await hh.bridge.hub?.close() // the hub socket is gone
    const w = await startWorker(hh.home, hh.relay.httpUrl, false)
    const r = await w.callTool('reply', { thread_id: 'trip', text: 'Sent while the hub was down.' })
    expect(r.isError).toBeFalsy()
    await hh.relay.expectFrame('reply', (f) => f.message.text === 'Sent while the hub was down.', {
      direction: 'from_bridge',
    })
  })
})

describe('OC1: routing and read_inbound', () => {
  test('owner text in a dedicated thread: wake file, no notification to main; read_inbound returns it once', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const w = await startWorker(hh.home, hh.relay.httpUrl)
    const before = hh.notes.length
    const sent = await hh.app.sendMessage('trip', 'Find a hotel near the station')
    const wakePath = join(hh.home, 'workers', 'trip', 'wake')
    await waitFor(() => existsSync(wakePath))
    const wake = WakeFile.parse(JSON.parse(readFileSync(wakePath, 'utf8')))
    expect(wake.message_ids).toEqual([sent.client_msg_id as string])
    expect(JSON.stringify(wake)).not.toContain('hotel') // ids only, never content
    await sleep(100)
    expect(hh.notes.length).toBe(before)
    const r = JSON.parse((await w.callTool('read_inbound', {})).content[0]?.text ?? '{}')
    expect(r.messages).toHaveLength(1)
    const n = r.messages[0]
    expect(n.content).toBe('Find a hotel near the station')
    expect(n.meta).toMatchObject({ thread_id: 'trip', chat_id: 'trip', kind: 'text', trust: 'owner' })
    expect(n.meta.message_id).toBe(sent.client_msg_id)
    const again = JSON.parse((await w.callTool('read_inbound', {})).content[0]?.text ?? '{}')
    expect(again.messages).toHaveLength(0)
  })

  test('a shared thread and the default thread still go to main', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    await hh.app.sendMessage('shared_one', 'one')
    await hh.app.sendMessage('general', 'two')
    await hh.waitNotes(2)
    expect(hh.notes.map((n) => n.meta.thread_id)).toEqual(['shared_one', 'general'])
    expect(hh.notes.every((n) => n.meta.routed === undefined)).toBe(true)
  })

  test('stale heartbeat: immediate fallback to main, told once, with a system row', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } }, { stale: true })
    await hh.app.sendMessage('trip', 'anyone there?')
    await hh.waitNotes(1)
    const n = hh.notes[0]
    expect(n?.meta).toMatchObject({ thread_id: 'trip', routed: 'fallback', reason: 'worker_unavailable' })
    await hh.relay.expectFrame(
      'reply',
      (f) => f.message.author === 'system' && /didn't pick this up/.test(f.message.text ?? ''),
      { direction: 'from_bridge' },
    )
    expect(existsSync(join(hh.home, 'workers', 'trip', 'wake'))).toBe(false)
  })

  test('a torn workers.json falls back too', async () => {
    const hh = await hub()
    writeFileSync(join(hh.home, 'workers.json'), '{"v":1,"supervisor":{"pid":1,')
    await hh.app.sendMessage('trip', 'hello?')
    await hh.waitNotes(1)
    expect(hh.notes[0]?.meta.routed).toBe('fallback')
  })

  test('not claimed by the deadline: main is told once, and a late read_inbound gets "already handled by main"', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub({ clock })
    writeWorkers(hh.home, clock.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const sent = await hh.app.sendMessage('trip', 'Book it')
    await waitTicking(clock, () => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
    expect(hh.notes).toHaveLength(0)
    await advanceSteps(clock, CLAIM_DEADLINE_MS + 1_000, 10_000)
    await hh.waitNotes(1)
    expect(hh.notes[0]?.meta).toMatchObject({ routed: 'fallback', message_id: sent.client_msg_id })
    const w = await startWorker(hh.home, hh.relay.httpUrl, false)
    const r = JSON.parse((await w.callTool('read_inbound', {})).content[0]?.text ?? '{}')
    expect(r.messages).toHaveLength(0)
    expect(r.already_handled_by_main).toEqual([sent.client_msg_id])
    await advanceSteps(clock, CLAIM_DEADLINE_MS, 10_000)
    expect(hh.notes).toHaveLength(1) // never twice
  })

  test('claimed in time: main is never told', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub({ clock })
    writeWorkers(hh.home, clock.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    await hh.app.sendMessage('trip', 'Quick one')
    await waitTicking(clock, () => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
    const w = await startWorker(hh.home, hh.relay.httpUrl, false)
    const r = JSON.parse((await w.callTool('read_inbound', {})).content[0]?.text ?? '{}')
    expect(r.messages).toHaveLength(1)
    await advanceSteps(clock, CLAIM_DEADLINE_MS + 1_000, 10_000)
    await sleep(100)
    expect(hh.notes).toHaveLength(0)
  })

  test('governor at 81 %: a parked thread falls back (usage_governor), a live worker still gets a wake; 95 % parks all', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() }, garden: { state: 'parked' } })
    const at = new Date().toISOString()
    let pct = 81
    hh.bridge.ctx.mod.liveState = () => ({
      session_id: 's',
      source: 'mod',
      capabilities: [],
      rate_limits: [{ kind: 'five_hour', percent: pct }],
      surfaces: [],
      at,
    })
    await hh.app.sendMessage('garden', 'parked thread')
    await hh.waitNotes(1)
    expect(hh.notes[0]?.meta).toMatchObject({ thread_id: 'garden', routed: 'fallback', reason: 'usage_governor' })
    await hh.app.sendMessage('trip', 'live thread')
    await waitFor(() => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
    expect(hh.notes).toHaveLength(1)
    pct = 96
    hh.bridge.optionCTick()
    const wake = WakeFile.parse(JSON.parse(readFileSync(join(hh.home, 'workers', 'trip', 'wake'), 'utf8')))
    expect(wake).toMatchObject({ action: 'park', reason: 'governor' })
  })

  test('no governor reading never blocks', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { garden: { state: 'parked' } })
    await hh.app.sendMessage('garden', 'wake up')
    await waitFor(() => existsSync(join(hh.home, 'workers', 'garden', 'wake')))
    expect(hh.notes).toHaveLength(0)
  })

  test('voice calls and card actions on main-raised cards go to main; decide() is the table', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    const r = hh.bridge.router
    const meta = (kind: string, extra: Record<string, string> = {}) => ({
      content: 'x',
      meta: {
        thread_id: 'trip',
        chat_id: 'trip',
        message_id: 'm_01JBF3V7Q8K2M4N6P8R0S2T401',
        kind,
        trust: 'owner',
        ...extra,
      },
    })
    expect(r?.decide(meta('voice_delegation'))).toEqual({ to: 'main' })
    expect(r?.decide(meta('hook_event'))).toEqual({ to: 'main' })
    expect(r?.decide(meta('backlog'))).toEqual({ to: 'main' })
    expect(r?.decide(meta('text', { trust: 'external' }))).toEqual({ to: 'main' })
    expect(r?.decide(meta('text'))).toEqual({ to: 'worker', thread: 'trip', cold: false })
    expect(r?.decide(meta('card_action', { card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T401' }))).toEqual({ to: 'main' })
    r?.store.setCardRaiser('c_01JBF3V7Q8K2M4N6P8R0S2T401', 'trip', Date.now())
    expect(r?.decide(meta('card_action', { card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T401', thread_id: 'general' }))).toEqual({
      to: 'worker',
      thread: 'trip',
      cold: false,
    })
  })

  test('a card the worker raised: its card_action is routed back to the worker', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const w = await startWorker(hh.home, hh.relay.httpUrl)
    const res = await w.callTool('card', {
      thread_id: 'trip',
      kind: 'decision',
      title: 'Book the hotel',
      primary_label: 'Book',
      kill_label: 'Kill it',
      risk: 'low',
      origin: 'chat',
      destination: [],
    })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    const created = await hh.relay.expectFrame('card.create', (f) => f.card.thread_id === 'trip', {
      direction: 'from_bridge',
    })
    await hh.app.resolveCard(created.card, 'kill', created.card.payload_hash)
    await waitFor(() => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
    const r = JSON.parse((await w.callTool('read_inbound', {})).content[0]?.text ?? '{}')
    expect(r.messages[0]?.meta).toMatchObject({ kind: 'card_action', card_id: created.card.id })
    expect(hh.notes.filter((n) => n.meta.kind === 'card_action')).toHaveLength(0)
  })

  /**
   * A card a thread session raised, the owner's tap on it held for that session, and main's channel closed. Returns what main
   * was told once the channel is opened again, so a test can prove nothing is sent late.
   */
  async function heldTap(action: 'primary' | 'kill' | 'revise', clock: ReturnType<typeof fakeClock>) {
    const hh = await hub({ clock })
    writeWorkers(hh.home, clock.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const w = await startWorker(hh.home, hh.relay.httpUrl)
    const res = await w.callTool('card', {
      thread_id: 'trip',
      kind: 'decision',
      title: 'Book the hotel',
      primary_label: 'Book',
      kill_label: 'Kill it',
      risk: 'low',
      origin: 'chat',
      destination: [],
    })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    const created = await hh.relay.expectFrame('card.create', (f) => f.card.thread_id === 'trip', {
      direction: 'from_bridge',
    })
    const sentToMain: unknown[] = []
    const channel = { open: false }
    hh.bridge.setEmit(async (n) => {
      if (!channel.open) throw new Error('channel closed')
      sentToMain.push(n)
    })
    await hh.app.resolveCard(
      created.card,
      action,
      created.card.payload_hash,
      action === 'revise' ? { note: 'Make it cheaper' } : {},
    )
    await waitTicking(clock, () => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
    const id = created.card.id
    const notices = () =>
      hh.relay.frames
        .filter((r) => r.direction === 'from_bridge' && r.frame.type === 'reply')
        .map((r) => (r.frame as { message: { author: string; text?: string } }).message)
        .filter((m) => m.author === 'system')
        .map((m) => m.text ?? '')
    const failedUpdates = () =>
      hh.relay.frames.filter(
        (r) =>
          r.direction === 'from_bridge' &&
          r.frame.type === 'card.update' &&
          (r.frame as { card_id: string; state: string }).card_id === id &&
          (r.frame as { state: string }).state === 'failed',
      )
    return { hh, id, sentToMain, channel, notices, failedUpdates }
  }

  test('a worker never claims the approval and main cannot be told at the deadline: the card ends failed, the owner is told, nothing is sent later', async () => {
    const clock = fakeClock(new Date().toISOString())
    const t = await heldTap('primary', clock)
    await advanceSteps(clock, CLAIM_DEADLINE_MS + 1_000, 10_000)
    const upd = await t.hh.relay.expectFrame('card.update', (f) => f.card_id === t.id && f.state === 'failed', {
      direction: 'from_bridge',
    })
    expect(upd.result).toMatchObject({ ok: false, ran: false })
    await waitFor(() => t.notices().some((x) => x.includes('Book the hotel')), 5000, 'the owner notice')
    expect(t.hh.bridge.ctx.ledger.get(t.id)?.state).toBe('failed')
    t.channel.open = true // the channel mends: the decision must not be sent now
    await advanceSteps(clock, CLAIM_DEADLINE_MS, 10_000)
    expect(t.sentToMain).toHaveLength(0)
  })

  for (const [action, said] of [
    ['kill', "Your Kill didn't reach your agent. Nothing was running."],
    ['revise', "Your request for changes didn't reach your agent. Nothing was running."],
  ] as const)
    test(`a ${action} held for a worker that main cannot be told about at the deadline: the owner is told, and it is not sent later`, async () => {
      const clock = fakeClock(new Date().toISOString())
      const t = await heldTap(action, clock)
      await advanceSteps(clock, CLAIM_DEADLINE_MS + 1_000, 10_000)
      await waitFor(() => t.notices().includes(said), 5000, `the owner notice (${t.notices().join(' | ')})`)
      expect(t.hh.bridge.ctx.ledger.get(t.id)?.state).toBe('done') // nothing was running: not a failure
      expect(t.failedUpdates()).toHaveLength(0)
      t.channel.open = true
      await advanceSteps(clock, CLAIM_DEADLINE_MS, 10_000)
      expect(t.sentToMain).toHaveLength(0)
    })

  for (const action of ['primary', 'kill'] as const)
    test(`a ${action} still held when the thread's own session is switched off, and main cannot be told: the owner hears it`, async () => {
      const clock = fakeClock(new Date().toISOString())
      const t = await heldTap(action, clock)
      t.hh.bridge.ctx.config.update((c) => ({ ...c, dedicated: DedicatedConfig.parse({ enabled: false }) }))
      t.hh.bridge.optionCTick()
      if (action === 'primary') {
        const upd = await t.hh.relay.expectFrame('card.update', (f) => f.card_id === t.id && f.state === 'failed', {
          direction: 'from_bridge',
        })
        expect(upd.result).toMatchObject({ ok: false, ran: false })
      } else await waitFor(() => t.notices().some((x) => x.includes("Kill didn't reach")), 5000, 'the owner notice')
      expect(t.sentToMain).toHaveLength(0)
    })
})

describe('OC1: thread.session.control and workers.status', () => {
  test('park writes a park wake and records an ok result; a shared thread is refused', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    const f = await hh.app.sendThreadSessionControl('trip', 'park')
    const res = await hh.relay.expectFrame('session.control.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(res.ok).toBe(true)
    const wake = WakeFile.parse(JSON.parse(readFileSync(join(hh.home, 'workers', 'trip', 'wake'), 'utf8')))
    expect(wake).toMatchObject({ action: 'park', reason: 'control', message_ids: [] })
    const g = await hh.app.sendThreadSessionControl('shared_one', 'restart')
    const no = await hh.relay.expectFrame('session.control.result', (x) => x.control_id === g.control_id, {
      direction: 'from_bridge',
    })
    expect(no).toMatchObject({ ok: false, code: 'worker_unavailable' })
  })

  test('workers.status goes out with the dedicated threads and their state', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() }, garden: { state: 'parked' } })
    hh.bridge.optionCTick()
    const f = await hh.relay.expectFrame('workers.status', (x) => x.status.threads.length === 2, {
      direction: 'from_bridge',
    })
    expect(f.status).toMatchObject({ supported: true, supervisor_online: true, governor: { state: 'unknown' } })
    expect(f.status.threads.map((t) => [t.thread_id, t.state])).toEqual([
      ['trip', 'live'],
      ['garden', 'parked'],
    ])
  })
})

describe('OC1: after a thread session is switched off', () => {
  const off = (hh: Harness) =>
    hh.bridge.ctx.config.update((c) => ({ ...c, dedicated: DedicatedConfig.parse({ enabled: false }) }))

  test('the hub itself refuses an old worker frame, but a card it raised can still report its result', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    hh.bridge.router?.store.setCardRaiser('c_01JBF3V7Q8K2M4N6P8R0S2T401', 'trip', Date.now())
    off(hh)
    const at = new Date().toISOString()
    const status = { v: 1, type: 'status', id: newUlid(), ts: at, thread_id: 'trip', state: 'working', since: at }
    expect(await hh.bridge.hub?.onOut('trip', status)).toMatchObject({ ok: false, code: 'worker_unavailable' })
    const update = cardUpdateFrame(Date.now(), {
      card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T401',
      state: 'done',
      result: { ok: true, text: 'done', at },
    })
    expect(await hh.bridge.hub?.onOut('trip', update)).toMatchObject({ ok: true })
  })

  test('a message still waiting goes to main at the next tick, once, with a system row', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    await hh.app.sendMessage('trip', 'Find a hotel')
    await waitFor(() => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
    expect(hh.notes).toHaveLength(0)
    off(hh)
    hh.bridge.optionCTick()
    await hh.waitNotes(1)
    expect(hh.notes[0]?.meta).toMatchObject({ routed: 'fallback', reason: 'worker_unavailable' })
    hh.bridge.optionCTick()
    await sleep(50)
    expect(hh.notes).toHaveLength(1)
  })
})

describe('OC1: card ownership', () => {
  test('a card.create over the hub for a card the worker did not mint is refused, in its own thread too', async () => {
    const hh = await hub()
    const made = await hh.bridge.callTool('card', {
      thread_id: 'trip',
      kind: 'decision',
      title: 'Main raised this',
      primary_label: 'Go',
      kill_label: 'Kill it',
      risk: 'low',
      origin: 'chat',
      destination: [],
    })
    expect(made.isError, made.content[0]?.text).toBeFalsy()
    const created = await hh.relay.expectFrame('card.create', (f) => f.card.thread_id === 'trip', {
      direction: 'from_bridge',
    })
    expect(await hh.bridge.hub?.onOut('trip', created as never)).toMatchObject({ ok: false, code: 'not_owner' })
    expect(hh.bridge.router?.store.cardRaiser(created.card.id)).toBeUndefined()
    // first writer wins: a raiser row can't move
    expect(hh.bridge.router?.store.setCardRaiser(created.card.id, 'trip', Date.now())).toBe(true)
    expect(hh.bridge.router?.store.setCardRaiser(created.card.id, 'garden', Date.now())).toBe(false)
    expect(hh.bridge.router?.store.cardRaiser(created.card.id)).toBe('trip')
  })
})
