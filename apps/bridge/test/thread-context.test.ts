// A thread with its own session: the app's context chip and Session panel must show THAT worker's context, so the
// bridge sends each dedicated worker's context as a scoped `session.state` (docs/OPTION-C.md 9.3). The numbers come from
// the worker's own transcript (Claude Code's `<config dir>/projects/<folder>/<session id>.jsonl`), read by the hub on its
// poll. Real bridge over the FakeRelay, workers.json written the way the desktop supervisor writes it, a fake transcript
// in a temp HOME. No real claude.
import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionState } from '@talos-app/protocol'
import { loadEnv } from '../src/config.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

const SESSION = '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41'
const CWD = '/Users/example/Trip folder'
let h: Harness | undefined
const PRELOAD_CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
afterEach(async () => {
  if (PRELOAD_CLAUDE_DIR) process.env.CLAUDE_CONFIG_DIR = PRELOAD_CLAUDE_DIR
  await h?.stop()
  h = undefined
})

const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})

async function hub(relayFeatures?: string[]) {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ctx-home-'))
  process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude') // a folder of its own per test; restored after
  h = await startHarness({
    env: { HOME: fakeHome },
    ...(relayFeatures ? { relay: { relayFeatures } } : {}),
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [...c.threads, thread('trip', { session: 'dedicated' }), thread('plain')],
      dedicated: { enabled: true },
    })) as never,
  })
  await waitFor(() => existsSync(join(h?.home as string, 'hub.sock')))
  return { hh: h, fakeHome }
}

function writeWorkers(home: string, state: string, over: Record<string, unknown> = {}) {
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
      threads: {
        trip: { state, session_id: SESSION, tmux: 't-trip', pane_pid: 0, cwd: CWD, error: null, ...over },
      },
    }),
  )
}

const transcriptFile = (fakeHome: string) =>
  join(fakeHome, '.claude', 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'), `${SESSION}.jsonl`)

const assistant = (
  usage: { input: number; create: number; read: number },
  over: Record<string, unknown> = {},
  at = '2026-11-08T10:00:00.000Z',
) =>
  `${JSON.stringify({
    type: 'assistant',
    timestamp: at,
    isSidechain: false,
    sessionId: SESSION,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-5',
      usage: {
        input_tokens: usage.input,
        cache_creation_input_tokens: usage.create,
        cache_read_input_tokens: usage.read,
        output_tokens: 300,
      },
    },
    ...over,
  })}\n`

function writeTranscript(fakeHome: string, text: string) {
  const f = transcriptFile(fakeHome)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, text)
}

const scopedFrames = (hh: Harness) =>
  hh.relay.frames.filter(
    (f) =>
      f.direction === 'from_bridge' &&
      f.frame.type === 'session.state' &&
      (f.frame as { state?: { scope?: unknown } }).state?.scope !== undefined,
  )
const scopedStates = (hh: Harness) =>
  scopedFrames(hh).map((f) => (f.frame as unknown as { state: Record<string, unknown> }).state)

describe('a dedicated worker reports its own context', () => {
  test('the numbers are the last call input: input + cache creation + cache read, against a 200k window', async () => {
    const { hh, fakeHome } = await hub()
    writeTranscript(
      fakeHome,
      assistant({ input: 5, create: 100, read: 1000 }) + assistant({ input: 6, create: 1200, read: 40000 }),
    )
    writeWorkers(hh.home, 'live')
    hh.bridge.optionCTick()
    const f = await hh.relay.expectFrame('session.state', (x) => x.state.scope !== undefined, {
      direction: 'from_bridge',
    })
    expect(f.state.scope).toEqual({ thread_id: 'trip' })
    expect(f.state.session_id).toBe(SESSION)
    expect(f.state.context).toEqual({ tokens: 41206, window: 200000, percent: 20.6 })
    expect(f.state.capabilities).toEqual([]) // no controls: the app greys them
    expect(f.state.rate_limits).toEqual([]) // weekly usage is main's, account-wide
    expect(f.state.at).toBe('2026-11-08T10:00:00.000Z') // as fresh as the worker's last reply
    // the strict parser an app has accepts it
    expect(SessionState.safeParse(f.state).success).toBe(true)
  })

  test('a [1m] worker model has a 1M window', async () => {
    const { hh, fakeHome } = await hub()
    writeTranscript(fakeHome, assistant({ input: 10, create: 0, read: 99990 }))
    writeWorkers(hh.home, 'live', { model: 'opus[1m]' })
    hh.bridge.optionCTick()
    const f = await hh.relay.expectFrame('session.state', (x) => x.state.scope !== undefined, {
      direction: 'from_bridge',
    })
    expect(f.state.context).toEqual({ tokens: 100000, window: 1000000, percent: 10 })
  })

  test('a parked worker still reports its last known context', async () => {
    const { hh, fakeHome } = await hub()
    writeTranscript(fakeHome, assistant({ input: 1, create: 0, read: 49999 }))
    writeWorkers(hh.home, 'parked')
    hh.bridge.optionCTick()
    const f = await hh.relay.expectFrame('session.state', (x) => x.state.scope !== undefined, {
      direction: 'from_bridge',
    })
    expect(f.state.context?.tokens).toBe(50000)
  })

  test('a session with no transcript yet reports a state with no context, so an old reading is replaced', async () => {
    const { hh } = await hub()
    writeWorkers(hh.home, 'live')
    hh.bridge.optionCTick()
    const f = await hh.relay.expectFrame('session.state', (x) => x.state.scope !== undefined, {
      direction: 'from_bridge',
    })
    expect(f.state.context).toBeUndefined()
  })

  test('a worker that was never started (no session id) reports nothing', async () => {
    const { hh } = await hub()
    writeWorkers(hh.home, 'off', { session_id: null })
    hh.bridge.optionCTick()
    await hh.relay.expectFrame('workers.status', (x) => x.status.threads.length === 1, { direction: 'from_bridge' })
    expect(scopedFrames(hh)).toHaveLength(0)
  })

  test('only the last reply counts, only the main chain counts, and only the end of a big file is read', async () => {
    const { hh, fakeHome } = await hub()
    const pad = assistant({ input: 1, create: 0, read: 1 }).repeat(4000) // ~1.5 MB of old replies
    writeTranscript(
      fakeHome,
      pad +
        assistant({ input: 2, create: 0, read: 30000 }) +
        assistant({ input: 9, create: 0, read: 190000 }, { isSidechain: true }) + // a subagent's reply is not this context
        '{"type":"user","message":{"content":"hi"}}\n' +
        'not json at all\n',
    )
    writeWorkers(hh.home, 'live')
    hh.bridge.optionCTick()
    const f = await hh.relay.expectFrame('session.state', (x) => x.state.scope !== undefined, {
      direction: 'from_bridge',
    })
    expect(f.state.context?.tokens).toBe(30002)
  })

  test('a transcript it cannot read gives no context and breaks nothing', async () => {
    const { hh, fakeHome } = await hub()
    writeTranscript(fakeHome, 'garbage\n{"type":"assistant","message":{"usage":{"input_tokens":"many"}}}\n')
    writeWorkers(hh.home, 'live')
    hh.bridge.optionCTick()
    const f = await hh.relay.expectFrame('session.state', (x) => x.state.scope !== undefined, {
      direction: 'from_bridge',
    })
    expect(f.state.context).toBeUndefined()
  })

  test('an unchanged reading is not sent again; a new reply is', async () => {
    const { hh, fakeHome } = await hub()
    writeTranscript(fakeHome, assistant({ input: 1, create: 0, read: 1000 }))
    writeWorkers(hh.home, 'live')
    hh.bridge.optionCTick()
    await waitFor(() => scopedStates(hh).length === 1, 4000, 'the first scoped state')
    hh.bridge.optionCTick()
    hh.bridge.optionCTick()
    await new Promise((r) => setTimeout(r, 150))
    expect(scopedStates(hh)).toHaveLength(1)
    appendFileSync(
      transcriptFile(fakeHome),
      assistant({ input: 1, create: 0, read: 2000 }, {}, '2026-11-08T10:05:00.000Z'),
    )
    hh.bridge.optionCTick()
    await waitFor(() => scopedStates(hh).length === 2, 4000, 'the second scoped state')
    expect((scopedStates(hh)[1]?.context as { tokens: number } | undefined)?.tokens).toBe(2001)
  })

  test('every scoped state names the dedicated thread, never a shared one', async () => {
    const { hh, fakeHome } = await hub()
    writeTranscript(fakeHome, assistant({ input: 1, create: 0, read: 1000 }))
    writeWorkers(hh.home, 'live')
    hh.bridge.optionCTick()
    await waitFor(() => scopedStates(hh).length === 1, 4000, 'the scoped state')
    expect(scopedStates(hh).every((s) => (s.scope as { thread_id: string }).thread_id === 'trip')).toBe(true)
  })
})

describe('review fixes', () => {
  const mainState = (window: number) =>
    ({
      session_id: 'main-1',
      source: 'mod',
      capabilities: [],
      context: { tokens: 1000, window, percent: 1 },
      rate_limits: [],
      surfaces: [],
      at: new Date().toISOString(),
    }) as never

  test('an inherit worker does not take main’s window: main on 1M, the worker on 200k at 180k reads 90%, not 18%', async () => {
    const { hh, fakeHome } = await hub()
    ;(hh.bridge.ctx.mod as { liveState: () => unknown }).liveState = () => mainState(1_000_000)
    writeTranscript(fakeHome, assistant({ input: 0, create: 0, read: 180_000 }))
    writeWorkers(hh.home, 'live') // model defaults to inherit
    hh.bridge.optionCTick()
    const f = await hh.relay.expectFrame('session.state', (x) => x.state.scope !== undefined, {
      direction: 'from_bridge',
    })
    expect(f.state.context).toEqual({ tokens: 180000, window: 200000, percent: 90 })
  })

  test('above 200k with no model of its own means a 1M window', async () => {
    const { hh, fakeHome } = await hub()
    writeTranscript(fakeHome, assistant({ input: 0, create: 0, read: 250_000 }))
    writeWorkers(hh.home, 'live')
    hh.bridge.optionCTick()
    const f = await hh.relay.expectFrame('session.state', (x) => x.state.scope !== undefined, {
      direction: 'from_bridge',
    })
    expect(f.state.context).toEqual({ tokens: 250000, window: 1000000, percent: 25 })
  })

  test('a long folder path whose project folder is named differently is found by the session id, then followed', async () => {
    const { hh, fakeHome } = await hub()
    const other = join(fakeHome, '.claude', 'projects', '-a-name-claude-shortened-differently')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, `${SESSION}.jsonl`), assistant({ input: 1, create: 0, read: 5000 }))
    writeWorkers(hh.home, 'live')
    hh.bridge.optionCTick()
    await waitFor(() => scopedStates(hh).length === 1, 4000, 'the first scoped state')
    expect((scopedStates(hh)[0]?.context as { tokens: number } | undefined)?.tokens).toBe(5001)
    appendFileSync(
      join(other, `${SESSION}.jsonl`),
      assistant({ input: 1, create: 0, read: 9000 }, {}, '2026-11-08T10:09:00.000Z'),
    )
    hh.bridge.optionCTick()
    await waitFor(() => scopedStates(hh).length === 2, 4000, 'the second scoped state')
    expect((scopedStates(hh)[1]?.context as { tokens: number } | undefined)?.tokens).toBe(9001)
  })

  test('a thread that left workers.json is forgotten: when it returns, its state is sent again', async () => {
    const { hh, fakeHome } = await hub()
    writeTranscript(fakeHome, assistant({ input: 1, create: 0, read: 1000 }))
    writeWorkers(hh.home, 'live')
    hh.bridge.optionCTick()
    await waitFor(() => scopedStates(hh).length === 1, 4000, 'the first scoped state')
    writeFileSync(
      join(hh.home, 'workers.json'),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
        threads: {},
      }),
    )
    hh.bridge.optionCTick()
    writeWorkers(hh.home, 'live')
    hh.bridge.optionCTick()
    await waitFor(() => scopedStates(hh).length === 2, 4000, 'the state again')
  })

  test('tests never read the real Claude folder: CLAUDE_CONFIG_DIR is a throw-away one, and the bridge env carries it', () => {
    const dir = PRELOAD_CLAUDE_DIR ?? ''
    expect(dir).not.toBe('')
    expect(dir.startsWith(tmpdir()) || dir.includes('/tmp') || dir.includes('/var/folders')).toBe(true)
    expect(loadEnv({ TALOS_APP_HOME: join(tmpdir(), 'x') }).claudeConfigDir).toBe(process.env.CLAUDE_CONFIG_DIR)
  })
})

describe('the window of an inherit worker is the model it was launched with', () => {
  // The launcher passes no --model for `inherit` (WorkerSpec.swift), so Claude Code takes `model` from its settings files.
  const setModel = (fakeHome: string, model: string) => {
    mkdirSync(join(fakeHome, '.claude'), { recursive: true })
    writeFileSync(join(fakeHome, '.claude', 'settings.json'), JSON.stringify({ model }))
  }
  const ctxOf = async (hh: Harness) =>
    (await hh.relay.expectFrame('session.state', (x) => x.state.scope !== undefined, { direction: 'from_bridge' }))
      .state.context

  test('inherit + main configured opus[1m]: 158k is ~16%, not 79%', async () => {
    const { hh, fakeHome } = await hub()
    setModel(fakeHome, 'opus[1m]')
    writeTranscript(fakeHome, assistant({ input: 0, create: 0, read: 158_000 }))
    writeWorkers(hh.home, 'live')
    hh.bridge.optionCTick()
    expect(await ctxOf(hh)).toEqual({ tokens: 158000, window: 1000000, percent: 15.8 })
  })

  test('inherit + main configured plain opus: 200k', async () => {
    const { hh, fakeHome } = await hub()
    setModel(fakeHome, 'opus')
    writeTranscript(fakeHome, assistant({ input: 0, create: 0, read: 158_000 }))
    writeWorkers(hh.home, 'live')
    hh.bridge.optionCTick()
    expect(await ctxOf(hh)).toEqual({ tokens: 158000, window: 200000, percent: 79 })
  })

  test('an explicit worker model uses its own, even while main is configured [1m]', async () => {
    const { hh, fakeHome } = await hub()
    setModel(fakeHome, 'opus[1m]')
    writeTranscript(fakeHome, assistant({ input: 0, create: 0, read: 158_000 }))
    writeWorkers(hh.home, 'live', { model: 'sonnet' })
    hh.bridge.optionCTick()
    expect(await ctxOf(hh)).toEqual({ tokens: 158000, window: 200000, percent: 79 })
  })

  test('a later /model switch in main does not change an inherit worker’s window', async () => {
    const { hh, fakeHome } = await hub()
    setModel(fakeHome, 'opus')
    ;(hh.bridge.ctx.mod as { liveState: () => unknown }).liveState = () =>
      ({
        session_id: 'main-1',
        source: 'mod',
        capabilities: [],
        model: { id: 'claude-opus-5-5[1m]' },
        context: { tokens: 1000, window: 1_000_000, percent: 1 },
        rate_limits: [],
        surfaces: [],
        at: new Date().toISOString(),
      }) as never
    writeTranscript(fakeHome, assistant({ input: 0, create: 0, read: 158_000 }))
    writeWorkers(hh.home, 'live', { model: 'default' })
    hh.bridge.optionCTick()
    expect(await ctxOf(hh)).toEqual({ tokens: 158000, window: 200000, percent: 79 })
  })
})

describe('an old relay or app is never sent what it cannot read', () => {
  test('without thread-sessions/1 on the relay no scoped state goes out', async () => {
    const { hh, fakeHome } = await hub(['schedules/1'])
    writeTranscript(fakeHome, assistant({ input: 1, create: 0, read: 1000 }))
    writeWorkers(hh.home, 'live')
    hh.bridge.optionCTick()
    hh.bridge.optionCTick()
    await new Promise((r) => setTimeout(r, 200))
    expect(scopedFrames(hh)).toHaveLength(0)
  })
})
