// The thread-session manager (P3d2) on a fake host and a fake clock: start, ready, live, park, stop, crash, wakes, the
// session-not-saved rule. Temp Talos home for the shared files; nothing is launched.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAP_HOLD_MS,
  CLAIM_DEADLINE_MS,
  DIALOG_CARD_WAIT_MS,
  type PtyExit,
  type PtyLaunch,
  type PtySendResult,
  parseWorkersFile,
  WORKER_POINTER,
  WORKER_POINTER_TEXT,
  WORKER_TIMING,
  type WorkerEntryT,
} from '@talos-app/protocol'
import type { Proc } from '../../src/supervisor/bg-work.ts'
import { RESUME_TURN_MAX_AGE_MS } from '../../src/supervisor/cut-turn.ts'
import { LoginEnvCache } from '../../src/supervisor/login-env.ts'
import { restored } from '../../src/supervisor/owed-pointer.ts'
import { stripEscapes } from '../../src/supervisor/screen.ts'
import { parseCapture } from '../../src/supervisor/tmux-commands.ts'
import {
  UPDATE_KEYS_QUIET_S,
  UPDATE_RELEASE_POLL_S,
  UPDATE_RESTART_GIVE_UP_S,
  UPDATE_STATE_FILE,
} from '../../src/supervisor/update-restart.ts'
import { PYTHON_RULES } from '../../src/supervisor/worker-hook.ts'
import { wantedFolder } from '../../src/supervisor/worker-launch.ts'
import type { PostOutcome } from '../../src/supervisor/worker-notices.ts'
import { foldsCase } from '../../src/supervisor/worker-policy.ts'
import { adoptedGone, stoppedWhy, turnLook, withTurnLost } from '../../src/supervisor/worker-status.ts'
import {
  type WorkerDeps,
  type WorkerHost,
  WorkerManager,
  type WorkerPlan,
  type WorkerThread,
} from '../../src/supervisor/workers.ts'
import { dedicatedThreads, workerPlanner } from '../../src/supervisor/workers-wiring.ts'
import { workerDir, workersJsonPath, writeControl, writeReady, writeWake } from '../../src/worker/files.ts'
import { cleanupReleases, sealedRelease } from './kit-release-fixture.ts'

// The stand-in python3 files these tests build in temp folders are this user's own: the two trust rules (the system's folder
// first, nothing the session's user could change) are off here and back after each test; worker-hook.test.ts tests them.
const savedPythonRules = { ...PYTHON_RULES }
beforeEach(() => Object.assign(PYTHON_RULES, { preferredDir: null, trustedOwner: process.getuid?.() ?? 0 }))
afterEach(() => Object.assign(PYTHON_RULES, savedPythonRules))

// the sealed kit releases this file made: writable again and removed (kit-release-fixture.ts)
afterAll(cleanupReleases)

/** No managed settings: the ceiling never reads the machine's own (managedDir is required in production code). */
const NO_MANAGED = join(tmpdir(), 'talos-test-no-managed-settings')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

class FakeHost implements WorkerHost {
  launches: PtyLaunch[] = []
  signals: string[] = []
  pid = 0
  running = false
  private exitCb: ((e: PtyExit) => void) | null = null
  constructor(private readonly nextPid: () => number) {}
  async start(l: PtyLaunch) {
    this.launches.push(l)
    this.pid = this.nextPid()
    this.running = true
    return this.pid
  }
  async probe(): ReturnType<WorkerHost['probe']> {
    return this.running ? { kind: 'running' as const, pid: this.pid } : { kind: 'gone' as const }
  }
  async attachIfRunning() {
    return this.running ? this.pid : null
  }
  signal(sig: NodeJS.Signals) {
    if (!this.running) return false
    this.signals.push(sig)
    return true
  }
  async close() {}
  detach() {}
  childPid() {
    return this.running ? this.pid : null
  }
  // the pane the pointer is typed into: an input box, empty (its dim placeholder) or holding what was typed
  box = ''
  submitted: string[] = []
  clients: number[] | null = []
  async clientActivities() {
    return this.clients
  }
  mode: boolean | null = false
  async inCopyMode() {
    return this.mode
  }
  /** A whole screen in place of the input box (a dialog, a prompt): plain rows, and the coloured ones when given. */
  screen: string[] | null = null
  screenEscaped: string[] | null = null
  async visibleRowsEscaped() {
    if (this.screen) return this.screenEscaped ?? this.screen
    const rule = '\u2500'.repeat(40)
    const rows = [
      this.history,
      rule,
      this.box ? `\u276F\u00A0${this.box}` : '\u276F\u00A0\u001b[2mTry "x"\u001b[0m',
      rule,
    ]
    return this.status ? [...rows, this.status] : rows
  }
  /** What the conversation shows above the box, and the status line under it. */
  history = 'history'
  status = ''
  /** When the pane last drew anything (wall ms; null: tmux did not say). Long ago by default: quiet. */
  output: number | null = 0
  async lastOutputAt() {
    return this.output
  }
  async visibleRows() {
    if (this.screen) return this.screen
    return (await this.visibleRowsEscaped()).map(stripEscapes)
  }
  async sendText(t: string): Promise<PtySendResult> {
    this.box += t
    return 'sent'
  }
  lastKeyRefusal?: () => { why: string; row?: string } | null
  async sendEnterKey() {
    this.submitted.push(this.box)
    this.box = ''
    return 'sent' as const
  }
  dialogKeys: string[] = []
  async sendDialogKey(k: string) {
    this.dialogKeys.push(k)
    return 'sent' as const
  }
  async sendBackspaces() {
    this.box = ''
    return 'sent' as const
  }
  onExit(cb: (e: PtyExit) => void) {
    this.exitCb = cb
  }
  /** The agent exits (by itself, or after a signal). */
  exit(code: number | null = 0, signal: number | null = null) {
    this.running = false
    this.exitCb?.({ pid: this.pid, code, signal, hostLost: false, lastRows: [] })
  }
}

const TRIP: WorkerThread = { id: 'trip', cwd: '/home/alex/trip', model: 'inherit', effort: null, parentCwd: null }

function setup(
  o: {
    threads?: WorkerThread[]
    env?: boolean
    saved?: (id: string) => boolean
    plan?: (p: Parameters<WorkerDeps['plan']>[0]) => WorkerPlan
    /** Another supervisor on the same home and the same panes. */
    home?: string
    hosts?: Map<string, FakeHost>
    /** config.json's dedicated.max_live (null: unreadable). */
    maxLive?: () => number | null
    /** How a thread folder resolves (none: as given; the folders here are not on disk). */
    realFolder?: (cwd: string) => string | null
    /** The agent folder (several sessions may work there). */
    agentDir?: string
    /** Main runs in a mode no thread session can be held to (its name), or not. */
    mainNarrowed?: () => string | null
    /** A parent folder no session may use. */
    parentFolderProblem?: WorkerDeps['parentFolderProblem']
    /** A start refused before it takes a slot. */
    preflight?: WorkerDeps['preflight']
    /** Main is running and signed in. */
    mainSignedIn?: () => boolean
    /** A post's outcome (none: sent). */
    postOutcome?: () => PostOutcome
    /** Restart-on-update (update-restart.ts): the switch, the governor a live status.json says, the default thread. */
    updates?: {
      on?: () => boolean | null
      governor?: () => string | null
      defaultThread?: string
      release?: () => string | null
    }
    /** The process table the background-work look reads (none: an empty one, so nothing runs under any pane). */
    procTable?: () => Proc[] | null
    /** The reap of what a cut session left running throws. */
    reapFails?: boolean
  } = {},
) {
  const home = o.home ?? mkdtempSync(join(tmpdir(), 'talos-workers-'))
  dirs.push(home)
  let t = 100
  let wall = Date.parse('2026-11-10T12:00:00.000Z')
  let boot = 50_000_000 // ms since boot: a clock of its own, a step of the wall clock never moves it
  let pid = 5000
  let ids = 0
  const audit: Array<[string, Record<string, string> | undefined]> = []
  const posts: Array<[string, string]> = []
  const hosts = o.hosts ?? new Map<string, FakeHost>()
  const plans: Array<{
    sessionId: string
    resume: boolean
    nonce: string
    resumeTurn: boolean | undefined
    reapsSoFar: number
  }> = []
  const reaps: string[] = []
  const reapFroms: Array<number | undefined> = []
  let planNow = o.plan
  let envOff = false
  let procs = o.procTable ?? (() => [])
  const env = new LoginEnvCache(
    async () => (o.env === false ? null : { PATH: '/usr/bin', HOME: '/home/alex' }),
    () => t,
  )
  const m = new WorkerManager({
    home,
    hostFor: (id) => {
      const h = hosts.get(id) ?? new FakeHost(() => ++pid)
      hosts.set(id, h)
      return h
    },
    threads: () => o.threads ?? [TRIP],
    ...(o.maxLive ? { maxLive: o.maxLive } : {}),
    plan: (p) => {
      plans.push({
        sessionId: p.sessionId,
        resume: p.resume,
        nonce: p.nonce,
        resumeTurn: p.resumeTurn,
        reapsSoFar: reaps.length,
      })
      return (
        planNow?.(p) ?? {
          launch: {
            session: `t-${p.thread.id}`,
            argv: ['claude'],
            cwd: p.thread.cwd,
            env: { TALOS_APP_WORKER_NONCE: p.nonce },
          },
          settingsJSON: '{}',
          cwd: p.thread.cwd,
        }
      )
    },
    // a test may take the login environment away (setEnv(false)): a start then waits, as with none read yet
    loginEnv: { refreshIfDue: () => env.refreshIfDue(), current: () => (envOff ? null : env.current()) },
    sessionSaved: (_cwd, id) => o.saved?.(id) ?? false,
    realFolder: o.realFolder ?? ((c) => c),
    ...(o.agentDir ? { agentDir: () => o.agentDir as string } : {}),
    newSessionId: () => `11111111-2222-3333-4444-${String(++ids).padStart(12, '0')}`,
    now: () => t,
    wallMs: () => wall,
    bootMs: () => boot,
    audit: (e, f) => audit.push([e, f]),
    mainPanePid: () => 42,
    supervisorPid: 7,
    post: async (thread, text) => {
      const out = o.postOutcome?.() ?? 'sent'
      if (out === 'sent') posts.push([thread, text])
      return out
    },
    ...(o.preflight ? { preflight: o.preflight } : {}),
    ...(o.mainSignedIn ? { mainSignedIn: o.mainSignedIn } : {}),
    ...(o.parentFolderProblem ? { parentFolderProblem: o.parentFolderProblem } : {}),
    ...(o.mainNarrowed ? { mainNarrowed: o.mainNarrowed } : {}),
    ...(o.updates
      ? {
          restartOnUpdate: o.updates.on ?? (() => true),
          updateGovernor: o.updates.governor ?? (() => 'ok'),
          defaultThread: () => o.updates?.defaultThread ?? 'general',
          releaseId: o.updates.release ?? (() => 'r1'),
        }
      : {}),
    where: (id) => ({
      attach: `talos-app supervise attach ${id}`,
      restart: `talos-app supervise restart-thread ${id}`,
      machine: 'devbox',
    }),
    procTable: () => procs(),
    procArgv: () => null,
    reap: async (nonce, notBeforeMs) => {
      if (o.reapFails) throw new Error('reap failed')
      reaps.push(nonce)
      reapFroms.push(notBeforeMs)
      return undefined
    },
  })
  const tick = async (s = 1) => {
    t += s
    wall += s * 1000
    boot += s * 1000
    await m.tick()
    await new Promise((r) => setTimeout(r, 0)) // the login env read answers
    await m.noticesSettled()
  }
  return {
    m,
    setPlan: (f: typeof planNow) => {
      planNow = f
    },
    setEnv: (on: boolean) => {
      envOff = !on
    },
    setProcs: (f: () => Proc[] | null) => {
      procs = f
    },
    posts,
    home,
    hosts,
    plans,
    reaps,
    reapFroms,
    audit,
    events: () => audit.map(([e]) => e),
    tick,
    /** The wall clock jumps (set, corrected, a resume); the monotonic clock does not. */
    jumpWall: (ms: number) => {
      wall += ms
    },
    wall: () => wall,
    boot: () => boot,
    host: (id = 'trip') => hosts.get(id) as FakeHost,
    file: () => parseWorkersFile(readFileSync(workersJsonPath(home), 'utf8')),
    ready: (id = 'trip') =>
      writeReady(home, { v: 1, thread_id: id, pid: hosts.get(id)?.pid ?? 1, at: new Date(wall).toISOString() }),
  }
}

/** Up to live: the login env read, a start, the hub's ready. */
async function live(x: ReturnType<typeof setup>, id = 'trip') {
  await x.tick()
  await x.m.start(id)
  x.ready(id)
  await x.tick()
}

describe('a thread session’s start', () => {
  it('writes a fresh nonce, starts the pane, publishes its pane pid at once, and is live when the hub’s ready appears', async () => {
    const x = setup()
    await x.tick()
    await x.m.start('trip')
    expect(x.m.state('trip')).toBe('starting')
    const nonce = readFileSync(join(workerDir(x.home, 'trip'), 'nonce'), 'utf8')
    expect(x.host().launches[0]?.env.TALOS_APP_WORKER_NONCE).toBe(nonce)
    expect(x.file()?.threads.trip).toMatchObject({ state: 'starting', pane_pid: x.host().pid })
    expect(x.file()?.supervisor).toMatchObject({ pid: 7, main_pane_pid: 42, workers_supported: true })
    await x.tick()
    expect(x.m.state('trip')).toBe('starting')
    x.ready()
    await x.tick()
    expect(x.m.state('trip')).toBe('live')
    expect(x.events()).toContain('worker_live')
  })
  it('with no login environment read yet it holds: nothing is launched on a bare PATH', async () => {
    const x = setup({ env: false })
    await x.tick()
    await x.m.start('trip')
    expect(x.m.state('trip')).toBe('off')
    expect(x.hosts.size).toBe(0)
    expect(x.events()).toContain('worker_start_held')
  })
  it('no verified hello within ready_s: the session is ended and the worker fails start_failed, its nonce gone', async () => {
    const x = setup()
    await x.tick()
    await x.m.start('trip')
    await x.tick(WORKER_TIMING.ready_s)
    expect(x.m.state('trip')).toBe('failed')
    expect(x.m.entry('trip')?.error?.code).toBe('start_failed')
    expect(x.host().signals).toContain('SIGKILL')
    expect(existsSync(join(workerDir(x.home, 'trip'), 'nonce'))).toBe(false)
  })
  it('a plan the fence refuses fails the worker with its code and launches nothing', async () => {
    const x = setup({ plan: () => ({ refused: { code: 'mode_escalation_denied', detail: 'wider than Main' } }) })
    await x.tick()
    await x.m.start('trip')
    expect(x.m.entry('trip')?.error?.code).toBe('mode_escalation_denied')
    expect(x.hosts.size).toBe(0)
    expect(existsSync(join(workerDir(x.home, 'trip'), 'nonce'))).toBe(false)
  })
  it('a refusal on the mcp axis is recorded with its axis', async () => {
    const x = setup({
      plan: () => ({ refused: { code: 'mode_escalation_denied', detail: 'mcp: not approved', axis: 'mcp' } }),
    })
    await x.tick()
    await x.m.start('trip')
    expect(x.m.entry('trip')?.error).toMatchObject({ code: 'mode_escalation_denied', axis: 'mcp' })
    await x.tick()
    expect(x.file()?.threads.trip?.error?.axis).toBe('mcp')
    expect(x.hosts.size).toBe(0)
  })
  it.skipIf(foldsCase(realpathSync(tmpdir())))(
    'a list with credentials: no audit line, notice, error or workers.json ever holds a value from a definition',
    async () => {
      const SECRET = 'ghp_FICTIONAL_SECRET_0123456789'
      const PROJECT_SECRET = 'db_FICTIONAL_PROJECT_SECRET_42'
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'talos-workers-mcp-')))
      dirs.push(root)
      const userHome = join(root, 'home')
      const agentDir = join(userHome, 'agent')
      const trip = join(userHome, 'trip')
      const home = join(root, 'talos')
      for (const d of [agentDir, trip, home, join(userHome, '.claude')]) mkdirSync(d, { recursive: true })
      writeFileSync(join(agentDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': { command: 'bun' } } }))
      const owner = (approve: string[]) =>
        writeFileSync(
          join(userHome, '.claude.json'),
          JSON.stringify({
            mcpServers: { github: { command: 'npx', env: { GITHUB_TOKEN: SECRET } } },
            projects: { [trip]: { enabledMcpjsonServers: approve } },
          }),
        )
      owner([])
      writeFileSync(
        join(trip, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'local-db': { command: 'db', env: { DB_PASSWORD: PROJECT_SECRET } } } }),
      )
      const planner = workerPlanner({
        threadFolders: () => [],
        kitVendor: sealedRelease(),
        talosHome: home,
        userHome,
        agentDir,
        claudeDir: join(userHome, '.claude'),
        resolveClaude: () => '/usr/bin/claude',
        mainArgs: () => ['--permission-mode=default'],
        managedDir: NO_MANAGED,
      })
      const x = setup({
        home,
        threads: [{ ...TRIP, cwd: trip, mcpAllow: ['github', 'local-db', 'claude.ai Gmail', 'nope'] }],
        plan: (p) => planner(p),
      })
      await x.tick()
      await x.m.start('trip')
      expect(x.m.entry('trip')?.error).toMatchObject({ code: 'mode_escalation_denied', axis: 'mcp' })
      // approved: it launches, and the secrets are only in the generated file
      owner(['local-db'])
      await x.m.start('trip', { fresh: true })
      expect(x.m.state('trip')).toBe('starting')
      const mcp = readFileSync(join(home, 'workers', 'trip', 'mcp', 'mcp.json'), 'utf8')
      expect(mcp).toContain(SECRET)
      expect(mcp).toContain(PROJECT_SECRET)
      const said = JSON.stringify({
        audit: x.audit,
        posts: x.posts,
        file: readFileSync(workersJsonPath(home), 'utf8'),
        launches: x.host().launches,
        settings: readFileSync(join(home, 'workers', 'trip', 'settings.json'), 'utf8'),
      })
      for (const v of [SECRET, PROJECT_SECRET, 'npx', '"db"']) expect(said).not.toContain(v)
    },
  )
  it('two threads in one folder: the second fails folder_claimed', async () => {
    const other = { ...TRIP, id: 'other' }
    const x = setup({ threads: [TRIP, other] })
    await live(x)
    await x.m.start('other')
    expect(x.m.entry('other')?.error?.code).toBe('folder_claimed')
  })
  it('a thread that is not dedicated is never started', async () => {
    const x = setup()
    await x.tick()
    await x.m.start('nope')
    expect(x.hosts.size).toBe(0)
  })
})

describe('the end of a session', () => {
  it('a park signals TERM, and the exit parks it: session id kept, nonce and ready gone, pane pid 0', async () => {
    const x = setup()
    await live(x)
    const sid = x.m.entry('trip')?.session_id
    await x.m.park('trip')
    expect(x.m.state('trip')).toBe('parking')
    expect(x.host().signals).toEqual(['SIGTERM'])
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    expect(x.m.entry('trip')).toMatchObject({ session_id: sid, pane_pid: 0 })
    expect(existsSync(join(workerDir(x.home, 'trip'), 'nonce'))).toBe(false)
    expect(existsSync(join(workerDir(x.home, 'trip'), 'ready'))).toBe(false)
  })
  it('a session that ignores TERM gets KILL after park_grace_s', async () => {
    const x = setup()
    await live(x)
    await x.m.park('trip')
    await x.tick(WORKER_TIMING.park_grace_s)
    expect(x.host().signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
  it('a stop ends off; a thread no longer dedicated is stopped', async () => {
    const x = setup()
    await live(x)
    await x.m.stop('trip')
    expect(x.m.state('trip')).toBe('stopping')
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('off')
    let threads = [TRIP]
    const y = setup({ threads })
    await live(y)
    threads = []
    ;(y.m as unknown as { d: { threads: () => WorkerThread[] } }).d.threads = () => threads
    await y.tick()
    expect(y.m.state('trip')).toBe('stopping')
  })
  it('a crash parks it and counts; five in fifteen minutes fail it crash_loop', async () => {
    const x = setup()
    await live(x)
    x.host().exit(1)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    for (let i = 0; i < 4; i++) {
      await x.m.start('trip')
      x.ready()
      await x.tick(30)
      x.host().exit(1)
      await x.tick()
    }
    expect(x.m.state('trip')).toBe('failed')
    expect(x.m.entry('trip')?.error?.code).toBe('crash_loop')
  })
  it('an exit during the start is start_failed', async () => {
    const x = setup()
    await x.tick()
    await x.m.start('trip')
    x.host().exit(1)
    await x.tick()
    expect(x.m.entry('trip')?.error?.code).toBe('start_failed')
  })
})

describe('wakes and the session id', () => {
  const wake = (x: ReturnType<typeof setup>, action: 'park' | 'restart' | 'fresh' | 'resume') =>
    writeControl(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: [],
      at: '2026-11-10T12:00:00.000Z',
      reason: 'control',
      action,
    })
  it('a restart wake goes through park, then starts again resuming the same session', async () => {
    const x = setup({ saved: () => true })
    await live(x)
    const sid = x.m.entry('trip')?.session_id
    wake(x, 'restart')
    await x.tick()
    expect(x.m.state('trip')).toBe('parking')
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('starting')
    expect(x.plans.at(-1)).toMatchObject({ sessionId: sid, resume: true })
    expect(x.plans[0]?.nonce).not.toBe(x.plans.at(-1)?.nonce)
  })
  it('a fresh wake retires the session id into previous_ids and starts a new one', async () => {
    const x = setup()
    await live(x)
    const sid = x.m.entry('trip')?.session_id as string
    wake(x, 'fresh')
    await x.tick()
    x.host().exit(0)
    await x.tick()
    expect(x.m.entry('trip')?.previous_ids).toEqual([sid])
    expect(x.m.entry('trip')?.session_id).not.toBe(sid)
    expect(x.plans.at(-1)?.resume).toBe(false)
  })
  it('a session that never had a turn is started again with the same id, not resumed (session_not_saved)', async () => {
    const x = setup({ saved: () => false })
    await live(x)
    const sid = x.m.entry('trip')?.session_id
    await x.m.park('trip')
    x.host().exit(0)
    await x.tick()
    wake(x, 'resume')
    await x.tick()
    expect(x.plans.at(-1)).toMatchObject({ sessionId: sid, resume: false })
    expect(x.events()).toContain('session_not_saved')
  })
  it('a transcript seen while live is remembered: the next start resumes even if the check would fail then', async () => {
    let saved = true
    const x = setup({ saved: () => saved })
    await live(x)
    await x.tick()
    expect(x.m.entry('trip')?.turn_session).toBe(x.m.entry('trip')?.session_id ?? 'none')
    saved = false
    await x.m.park('trip')
    x.host().exit(0)
    await x.tick()
    await x.m.start('trip')
    expect(x.plans.at(-1)?.resume).toBe(true)
  })
  it('through the tick, the reader’s notice of record says what was carried out, and nothing when nothing was (Fable R1-1, R1-5)', async () => {
    const x = setup({ saved: () => true })
    await live(x)
    wake(x, 'restart')
    await x.tick()
    await new Promise((r) => setTimeout(r, 0))
    expect(x.m.state('trip')).toBe('parking')
    expect(x.posts.filter(([, t]) => t.startsWith('Talos restarted'))).toEqual([
      ['trip', "Talos restarted this thread's session (a session control)."],
    ])
    x.host().exit(0)
    await x.tick()
    await x.m.park('trip')
    x.host().exit(0)
    await x.tick()
    const before = x.posts.length
    wake(x, 'park') // already parked: nothing to carry out
    await x.tick()
    await new Promise((r) => setTimeout(r, 0))
    expect(x.posts.length).toBe(before)
    expect(x.events()).toContain('wake_no_effect')
  })
  it('a park wake parks a live session; a wake for a thread that is not dedicated is never acted on', async () => {
    const x = setup()
    await live(x)
    wake(x, 'park')
    await x.tick()
    expect(x.m.state('trip')).toBe('parking')
    writeControl(x.home, {
      v: 1,
      thread_id: 'ghost',
      message_ids: [],
      at: '2026-11-10T12:00:00.000Z',
      reason: 'control',
      action: 'resume',
    })
    await x.tick()
    expect(x.hosts.has('ghost')).toBe(false)
  })
})

describe('adoption after a supervisor restart', () => {
  const prior = (x: ReturnType<typeof setup>, threads: Record<string, unknown>) =>
    writeFileSync(
      workersJsonPath(x.home),
      JSON.stringify({ v: 1, supervisor: { pid: 1, heartbeat_at: '2026-11-10T11:59:00.000Z' }, threads }),
    )
  const was = (over: Record<string, unknown>) => ({
    state: 'live',
    session_id: '11111111-2222-3333-4444-999999999999',
    tmux: 't-trip',
    pane_pid: 5001,
    cwd: '/home/alex/trip',
    ...over,
  })
  it('the same pid still running in its pane is adopted, and its exit is followed', async () => {
    const x = setup()
    prior(x, { trip: was({}) })
    const h = new FakeHost(() => 5001)
    h.pid = 5001
    h.running = true
    x.hosts.set('trip', h)
    await x.tick()
    expect(x.m.state('trip')).toBe('live')
    expect(x.events()).toContain('worker_adopted')
    expect(x.m.ownedPgids()).toEqual([5001])
    h.exit(1)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
  })
  it('a pane that is gone is parked with its session id kept; a resting entry is kept as it was', async () => {
    const x = setup({ threads: [TRIP, { ...TRIP, id: 'old', cwd: '/home/alex/old' }] })
    prior(x, { trip: was({}), old: was({ state: 'parked', tmux: 't-old', pane_pid: 0 }) })
    await x.tick()
    expect(x.m.entry('trip')).toMatchObject({
      state: 'parked',
      pane_pid: 0,
      session_id: '11111111-2222-3333-4444-999999999999',
    })
    expect(x.m.entry('old')?.state).toBe('parked')
    expect(x.events()).toContain('worker_adopt_parked')
  })
  it('a probe that cannot tell is asked again next tick, never acted on', async () => {
    const x = setup()
    prior(x, { trip: was({}) })
    const h = new FakeHost(() => 5001)
    let unknown = true
    h.probe = async () => (unknown ? { kind: 'unknown' as const } : { kind: 'gone' as const })
    x.hosts.set('trip', h)
    await x.tick()
    await x.tick()
    expect(x.m.state('trip')).toBe('live') // still what the last supervisor said: nothing was done on a guess
    unknown = false
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
  })
  it('a pane running another pid than the recorded one is not ours: closed and parked', async () => {
    const x = setup()
    prior(x, { trip: was({ state: 'starting' }) })
    const h = new FakeHost(() => 7777)
    h.pid = 7777
    h.running = true
    x.hosts.set('trip', h)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    expect(x.events()).not.toContain('worker_bug')
  })
})

describe('the review’s cases (P3d2)', () => {
  const prior = (x: ReturnType<typeof setup>, threads: Record<string, unknown>) =>
    writeFileSync(
      workersJsonPath(x.home),
      JSON.stringify({ v: 1, supervisor: { pid: 1, heartbeat_at: '2026-11-10T11:59:00.000Z' }, threads }),
    )
  const was = {
    state: 'live',
    session_id: '11111111-2222-3333-4444-999999999999',
    tmux: 't-trip',
    pane_pid: 5001,
    cwd: '/home/alex/trip',
  }
  it('a session still being looked for is not stopped, woken or counted ours; once adopted a stop signals it', async () => {
    let threads: WorkerThread[] = []
    const x = setup()
    ;(x.m as unknown as { d: { threads: () => WorkerThread[] } }).d.threads = () => threads
    prior(x, { trip: was })
    const h = new FakeHost(() => 5001)
    h.pid = 5001
    h.running = true
    let unknown = true
    const real = h.probe.bind(h)
    h.probe = async () => (unknown ? { kind: 'unknown' as const } : real())
    x.hosts.set('trip', h)
    await x.tick()
    expect(x.m.ownedPgids()).toEqual([]) // a pid read from the file is never whitelisted
    await x.tick()
    expect(x.m.state('trip')).toBe('live') // not dedicated any more, but not stopped on a guess
    expect(h.signals).toEqual([])
    unknown = false
    await x.tick() // adopted, then stopped: not dedicated
    expect(x.m.state('trip')).toBe('stopping')
    expect(h.signals).toEqual(['SIGTERM'])
    expect(x.m.ownedPgids()).toEqual([5001])
    threads = [TRIP]
  })
  it('no readable config on the first tick stops nothing it adopted', async () => {
    const x = setup()
    ;(x.m as unknown as { d: { threads: () => WorkerThread[] | null } }).d.threads = () => null
    prior(x, { trip: was })
    const h = new FakeHost(() => 5001)
    h.pid = 5001
    h.running = true
    x.hosts.set('trip', h)
    await x.tick()
    await x.tick()
    expect(x.m.state('trip')).toBe('live')
    expect(h.signals).toEqual([])
  })
  it('a workers.json that is there but unreadable freezes the manager: nothing starts and nothing is written over it', async () => {
    const x = setup()
    writeFileSync(workersJsonPath(x.home), '{"v": 2, "torn')
    await x.tick()
    await x.m.start('trip')
    expect(x.hosts.size).toBe(0)
    expect(readFileSync(workersJsonPath(x.home), 'utf8')).toBe('{"v": 2, "torn')
    expect(x.events()).toContain('workers_file_unreadable')
  })
  it('one folder by any spelling: a trailing slash does not let a second session in', async () => {
    const other = { ...TRIP, id: 'other', cwd: `${TRIP.cwd}/` }
    const x = setup({ threads: [TRIP, other] })
    await live(x)
    await x.m.start('other')
    expect(x.m.entry('other')?.error?.code).toBe('folder_claimed')
  })
  it('failed starts are not crashes: they never add up to crash_loop', async () => {
    const x = setup()
    await x.tick()
    for (let i = 0; i < 6; i++) {
      await x.m.start('trip')
      x.host().exit(1)
      await x.tick()
    }
    expect(x.m.entry('trip')?.error?.code).toBe('start_failed')
    expect(x.m.entry('trip')?.restarts).toEqual([])
  })
  it('a crash kills what the session left in its group before the pane is closed', async () => {
    const x = setup()
    await live(x)
    const h = x.host()
    h.running = true // its group is still there when the exit is seen
    const sig = h.signal.bind(h)
    const seen: string[] = []
    h.signal = (s) => {
      seen.push(s)
      return sig(s)
    }
    h.exit(1)
    h.running = true
    await x.tick()
    expect(seen).toContain('SIGKILL')
  })
  it('a restart asked for while the session is parking starts it again once parked', async () => {
    const x = setup({ saved: () => true })
    await live(x)
    await x.m.park('trip')
    await x.m.restart('trip')
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('starting')
  })
})

describe('the owed pointer on a thread session (P3d3)', () => {
  const pointerWake = (x: ReturnType<typeof setup>, atMs?: number) =>
    writeWake(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: ['m_01HZZZZZZZZZZZZZZZZZZZZZZZ'],
      at: new Date(atMs ?? Date.parse('2026-11-10T12:00:00.000Z')).toISOString(),
      reason: 'message',
      action: 'pointer',
    })
  it('a pointer wake on a resting worker starts it; once live the line is typed, seen and submitted, and the turn recorded', async () => {
    const x = setup()
    await x.tick()
    pointerWake(x)
    await x.tick(1)
    expect(x.m.state('trip')).toBe('starting')
    const raw = JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8'))
    expect(raw.threads.trip.pointer_owed_until).toBeDefined() // written before the start: a crash here does not lose it
    expect(x.file()?.threads.trip).not.toHaveProperty('pointer_owed_until') // the hub's parse never sees it
    x.ready()
    await x.tick()
    await x.tick()
    expect(x.host().submitted).toEqual([WORKER_POINTER_TEXT])
    expect(x.m.entry('trip')?.turn_session).toBe(x.m.entry('trip')?.session_id ?? 'none')
    // the turn begins when the line goes in; last_turn_at is when it ENDS (status that tells the truth, the Mac's 2d18db28)
    const started = x.m.entry('trip')?.turn_started_at
    expect(started).toBe(new Date(x.wall()).toISOString())
    expect(x.m.entry('trip')?.last_turn_at).toBeNull()
    expect(x.file()?.threads.trip?.turn_started_at).toBe(started)
    await x.tick(5)
    expect(JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8')).threads.trip.pointer_owed_until).toBeUndefined()
    // never seen busy yet (the line went in, nothing drawn): quiet is not the turn's end
    for (let i = 0; i <= WORKER_TIMING.busy_window_s; i++) await x.tick(1)
    expect(x.m.entry('trip')?.turn_started_at).toBe(started)
    // the line's own echo, drawn in the Enter's own second, is busy but not the turn: quiet after it is still no end (Fable R2-5:
    // tmux gives output times in whole seconds)
    x.host().output = Math.floor(Date.parse(started ?? '') / 1000) * 1000
    await x.tick(1)
    for (let i = 0; i <= WORKER_TIMING.busy_window_s + 1; i++) await x.tick(1)
    expect(x.m.entry('trip')?.turn_started_at).toBe(started)
    // the turn draws (busy), then the pane goes quiet for the busy window: the turn is over
    x.host().output = x.wall()
    await x.tick(1)
    for (let i = 0; i <= WORKER_TIMING.busy_window_s + 1; i++) await x.tick(1)
    expect(x.m.entry('trip')?.turn_started_at).toBeUndefined()
    expect(x.m.entry('trip')?.last_turn_at).not.toBeNull()
    expect(Date.parse(x.m.entry('trip')?.last_turn_at ?? '')).toBeGreaterThan(Date.parse(started ?? ''))
  })
  it('a failed worker or a wake older than the longest claim owes nothing', async () => {
    const x = setup({ plan: () => ({ refused: { code: 'start_failed', detail: 'x' } }) })
    await x.tick()
    await x.m.start('trip')
    pointerWake(x)
    await x.tick()
    expect(x.hosts.size).toBe(0)
    const y = setup()
    await y.tick()
    pointerWake(y, Date.parse('2026-11-10T11:00:00.000Z'))
    await y.tick()
    expect(y.m.state('trip')).toBe('off')
    expect(y.events()).toContain('worker_wake_stale')
  })
  it('a pointer owed when the supervisor went is typed by the next one: the parked worker is started for it once', async () => {
    const x = setup()
    await live(x)
    await x.m.park('trip')
    x.host().exit(0)
    await x.tick()
    pointerWake(x, Date.parse('2026-11-10T12:00:03.000Z'))
    // the wake starts it; the supervisor goes before it is live
    await x.tick()
    expect(x.m.state('trip')).toBe('starting')
    const fileBefore = JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8'))
    expect(fileBefore.threads.trip.pointer_owed_until).toBeDefined()
    // a new supervisor on the same home: the pane it adopts is gone, so the worker is parked, and the pointer starts it again
    const y = setup()
    rmSync(y.home, { recursive: true, force: true })
    ;(y.m as unknown as { d: { home: string } }).d.home = x.home
    const h = new FakeHost(() => 9001)
    y.hosts.set('trip', h)
    await y.tick()
    expect(y.events()).toContain('worker_adopt_parked')
    await y.tick()
    expect(y.m.state('trip')).toBe('starting')
    writeReady(x.home, { v: 1, thread_id: 'trip', pid: h.pid, at: '2026-11-10T12:00:10.000Z' })
    await y.tick()
    await y.tick()
    expect(h.submitted).toEqual([WORKER_POINTER_TEXT])
  })
  it('a pointer wake that came while the session was parking starts it once it is parked', async () => {
    const x = setup()
    await live(x)
    await x.m.park('trip')
    pointerWake(x, Date.parse('2026-11-10T12:00:03.000Z'))
    await x.tick()
    expect(x.m.state('trip')).toBe('parking')
    x.host().exit(0)
    await x.tick()
    await x.tick()
    expect(x.m.state('trip')).toBe('starting')
  })
})

describe('what a worker’s pane tells the owner (P3d3, part 4b-i)', () => {
  const FIX = join(import.meta.dir, '../../../desktop/Tests/Fixtures')
  const cap = (dir: string, name: string) => parseCapture(readFileSync(join(FIX, dir, `${name}.txt`), 'utf8'))
  const TRUST = cap('real-2.1.319/needs-you-capture', '01-trust-first')
  const BASH = cap('real-2.1.318', 'bash-permission')
  const NAMED = [{ ...TRIP, name: 'Trip' }]
  const wake = (x: ReturnType<typeof setup>) =>
    writeWake(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: ['m_01HZZZZZZZZZZZZZZZZZZZZZZZ'],
      at: new Date(Date.parse('2026-11-10T12:00:00.000Z')).toISOString(),
      reason: 'message',
      action: 'pointer',
    })
  const ticks = async (x: ReturnType<typeof setup>, n: number) => {
    for (let i = 0; i < n; i++) await x.tick()
  }

  it('a dialog at start: its line, the ready timer waits on it, and after start_dialog_s the start fails needs_mac with its line', async () => {
    const x = setup({ threads: NAMED })
    await x.tick()
    await x.m.start('trip')
    x.host().screen = TRUST
    await ticks(x, WORKER_TIMING.dialog_settle_s + 2)
    expect(x.posts).toEqual([
      [
        'trip',
        "This thread's session is waiting on a 'trust this folder' prompt; attach on devbox to answer: talos-app supervise attach trip",
      ],
    ])
    await x.tick(WORKER_TIMING.ready_s + 10)
    expect(x.m.state('trip')).toBe('starting') // the ready timer waits while the dialog is on screen
    await x.tick(WORKER_TIMING.start_dialog_s)
    expect(x.m.state('trip')).toBe('failed')
    expect(x.m.entry('trip')?.error).toMatchObject({ code: 'needs_mac', detail: 'trust this folder' })
    expect(x.host().signals).toContain('SIGKILL')
    expect(x.posts.at(-1)?.[1]).toBe(
      "This thread's session stopped at a question only devbox can answer ('trust this folder'): nobody answered it in 15 minutes. To answer it, run `talos-app supervise restart-thread trip` on devbox, then `talos-app supervise attach trip`.",
    )
    await ticks(x, 3)
    expect(x.posts).toHaveLength(2)
  })
  const freshWake = (x: ReturnType<typeof setup>, id: string) =>
    writeWake(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: [id],
      at: new Date(x.wall()).toISOString(), // a message sent now
      reason: 'message',
      action: 'pointer',
    })
  const failAt = async (x: ReturnType<typeof setup>, screen: string[]) => {
    await x.tick()
    await x.m.start('trip')
    x.host().screen = screen
    await ticks(x, WORKER_TIMING.dialog_settle_s + 2)
    await x.tick(WORKER_TIMING.start_dialog_s + 5)
    x.host().screen = null
  }
  it('a start that met the sign-in screen (failed needs_mac): once Main is signed in, the next message starts it (Titan)', async () => {
    let signedIn = false
    const x = setup({ threads: NAMED, mainSignedIn: () => signedIn })
    await failAt(x, cap('real-2.1.318', 'login-not-logged-in'))
    expect(x.m.state('trip')).toBe('failed')
    expect(x.m.entry('trip')?.error).toMatchObject({ code: 'needs_mac', detail: 'sign in' })
    // Main still not signed in: a message is not taken (Main answers), as before
    freshWake(x, 'm_01HZZZZZZZZZZZZZZZZZZZZZZY')
    await ticks(x, 2)
    expect(x.m.state('trip')).toBe('failed')
    // the owner signs Main in: the next message starts the thread, and the old failure is gone
    signedIn = true
    freshWake(x, 'm_01HZZZZZZZZZZZZZZZZZZZZZZX')
    await ticks(x, 2)
    expect(x.m.state('trip')).toBe('starting')
    expect(x.m.entry('trip')?.error ?? null).toBeNull()
  })
  it('signed in or not, nothing else that failed starts on a message: a trust question stays failed', async () => {
    const x = setup({ threads: NAMED, mainSignedIn: () => true })
    await failAt(x, TRUST)
    expect(x.m.entry('trip')?.error).toMatchObject({ code: 'needs_mac', detail: 'trust this folder' })
    freshWake(x, 'm_01HZZZZZZZZZZZZZZZZZZZZZZW')
    await ticks(x, 2)
    expect(x.m.state('trip')).toBe('failed')
  })
  it('a known dialog read exactly is offered in workers.json; the line is the fallback after DIALOG_CARD_WAIT_MS, never with a card', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    x.host().screen = TRUST
    x.host().screenEscaped = cap('real-2.1.319/needs-you-capture', '01-trust-first.ansi')
    await ticks(x, WORKER_TIMING.dialog_settle_s + 1)
    const offered = x.file()?.threads.trip?.dialog
    expect(offered).toMatchObject({ kind: 'trust', options: ['No, exit', 'Yes, I trust this folder'], cursor: 0 })
    expect(x.posts).toHaveLength(0)
    await ticks(x, DIALOG_CARD_WAIT_MS / 1000)
    expect(x.posts).toHaveLength(1)
    // the bridge made a card for the next dialog: its line never goes from here
    x.host().screen = null
    await ticks(x, WORKER_TIMING.dialog_settle_s + 2)
    expect(x.file()?.threads.trip?.dialog).toBeUndefined()
    await x.tick(WORKER_TIMING.notice_debounce_s)
    x.host().screen = TRUST
    await ticks(x, WORKER_TIMING.dialog_settle_s + 1)
    const next = x.file()?.threads.trip?.dialog
    expect(next?.id).not.toBe(offered?.id)
    writeFileSync(
      join(workerDir(x.home, 'trip'), 'dialog-card.json'),
      JSON.stringify({
        v: 1,
        dialog_id: next?.id,
        card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T403',
        at: '2026-11-10T12:00:00Z',
      }),
    )
    await ticks(x, DIALOG_CARD_WAIT_MS / 1000 + 5)
    expect(x.posts).toHaveLength(1)
  })
  it('after the owner’s "No, exit" on the trust question the session ends as that answer: failed with its own words, no crash, no restart', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    x.host().screen = TRUST
    await ticks(x, WORKER_TIMING.dialog_settle_s + 1)
    // what the tap's answer sets (worker-dialogs.ts, tested there): the Enter on "No, exit" was sent
    const w = (x.m as unknown as { workers: Map<string, { offer: { declinedTrust: boolean } }> }).workers.get('trip')
    if (!w) throw new Error('no worker')
    w.offer.declinedTrust = true
    x.host().exit(1)
    await ticks(x, 3)
    expect(x.m.state('trip')).toBe('failed')
    expect(x.m.entry('trip')?.error?.code).toBe('start_failed')
    expect(x.m.entry('trip')?.error?.detail).toContain('chose not to trust')
    expect(x.m.entry('trip')?.restarts ?? []).toEqual([])
    await ticks(x, 30)
    expect(x.m.state('trip')).toBe('failed') // never restarted by itself
  })
  it('the bypass disclaimer and the development-channels question on a thread: offered as cards; with no card the line names no terminal and no command', async () => {
    const BYPASS = cap('real-2.1.318', 'bypass-disclaimer')
    const DEVCH = cap('real-dev-channels', 'dev-channels-capture')
    for (const [screen, kind, name] of [
      [BYPASS, 'bypass', 'bypass permissions'],
      [DEVCH, 'dev_channels', 'development channels'],
    ] as const) {
      const x = setup({ threads: NAMED })
      await live(x)
      x.host().screen = screen
      // as Claude Code draws it: the cursor row coloured (the real 2.1.318 capture is plain text only)
      x.host().screenEscaped = screen.map((r) =>
        r.includes('❯ ') ? r.replace(/❯ (.*)$/, '\u001b[38;5;153m❯ $1\u001b[39m') : r,
      )
      await ticks(x, WORKER_TIMING.dialog_settle_s + 1)
      expect(x.file()?.threads.trip?.dialog, kind).toMatchObject({ kind })
      expect(x.posts, kind).toHaveLength(0) // the card gets its time first
      await ticks(x, DIALOG_CARD_WAIT_MS / 1000)
      expect(x.posts).toHaveLength(1)
      const line = x.posts[0]?.[1] ?? ''
      expect(line).toContain(`'${name}' prompt`)
      expect(line).not.toMatch(/attach|ssh|tmux|Terminal|talos-app supervise/i)
    }
  })
  it('a partial disclaimer on a thread (a row missing) gets no card, only the line, and it still names no terminal', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    x.host().screen = cap('real-2.1.318', 'bypass-disclaimer').filter((r) => !r.includes('Yes, I accept'))
    await ticks(x, WORKER_TIMING.dialog_settle_s + 2)
    expect(x.file()?.threads.trip?.dialog).toBeUndefined()
    expect(x.posts).toHaveLength(1)
    expect(x.posts[0]?.[1]).not.toMatch(/attach|ssh|tmux|Terminal|talos-app supervise/i)
  })
  it('after the owner’s "No, exit" on the bypass disclaimer the session ends as that answer, in its own words, never a crash', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    x.host().screen = cap('real-2.1.318', 'bypass-disclaimer')
    await ticks(x, WORKER_TIMING.dialog_settle_s + 1)
    const w = (x.m as unknown as { workers: Map<string, { offer: { declinedExit: string | null } }> }).workers.get(
      'trip',
    )
    if (!w) throw new Error('no worker')
    w.offer.declinedExit = 'bypass'
    x.host().exit(1)
    await ticks(x, 3)
    expect(x.m.state('trip')).toBe('failed')
    expect(x.m.entry('trip')?.error?.detail).toContain('permission checks off')
    expect(x.m.entry('trip')?.restarts ?? []).toEqual([])
  })
  it('a "No" that was pressed but did not end the session is forgotten once the session runs: a later crash is a crash', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    const w = (x.m as unknown as { workers: Map<string, { offer: { declinedTrust: boolean } }> }).workers.get('trip')
    if (!w) throw new Error('no worker')
    w.offer.declinedTrust = true
    x.host().exit(1) // the session runs again after its next start
    await ticks(x, 3)
    expect(x.m.entry('trip')?.error?.detail).toContain('chose not to trust')
    w.offer.declinedTrust = true
    freshWake(x, 'm_01HZZZZZZZZZZZZZZZZZZZZZZW')
    await live(x)
    expect(w.offer.declinedTrust).toBe(false)
    x.host().exit(1)
    await ticks(x, 3)
    expect(x.m.entry('trip')?.error?.detail ?? '').not.toContain('chose not to trust')
  })
  it('a start with no dialog still times out at ready_s (the hold is only for what is on screen)', async () => {
    const x = setup()
    await x.tick()
    await x.m.start('trip')
    await x.tick(WORKER_TIMING.ready_s)
    expect(x.m.entry('trip')?.error?.code).toBe('start_failed')
    expect(x.posts).toHaveLength(0)
  })
  it('a prompt nobody named on a live worker: one line, however long it stays', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    x.host().screen = BASH
    await ticks(x, 20)
    expect(x.posts).toHaveLength(1)
    expect(x.posts[0]?.[1]).toContain(`waiting on a 'Bash command' prompt;`)
    expect(x.posts[0]?.[1]).not.toContain('Do you want to proceed?') // screen text never speaks in Talos's voice
  })
  it('a pointer held by the owner’s draft until its claim deadline: no line of its own (the hub says why), never typed onto the draft', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    x.host().box = 'half a thought'
    wake(x)
    await x.tick()
    await x.tick(WORKER_TIMING.draft_notice_after_s + 5)
    await ticks(x, 5)
    expect(x.posts).toHaveLength(0)
    await x.tick(CLAIM_DEADLINE_MS / 1000)
    await ticks(x, 5)
    expect(x.posts).toHaveLength(0)
    expect(x.host().box).toBe('half a thought')
    expect(x.host().submitted).toEqual([])
  })
  it('a restored pointer whose line may be mixed with the owner’s text: the left-over line after draft_notice_after_s', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    // a supervisor before this one typed our line and went; the owner has since added to it, at the pane (a client attached)
    const raw = JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8'))
    raw.threads.trip.pointer_owed_until = '2026-11-10T11:59:00.000Z'
    raw.threads.trip.enter_owed = true
    await x.m.detach()
    writeFileSync(workersJsonPath(x.home), JSON.stringify(raw))
    const host = x.host()
    host.box = `${WORKER_POINTER_TEXT} and more`
    host.clients = [Date.parse('2026-11-10T11:00:00.000Z')]
    const again = setup({ threads: NAMED, home: x.home, hosts: x.hosts })
    await again.tick()
    await again.tick()
    await again.tick(WORKER_TIMING.draft_notice_after_s)
    await again.tick()
    expect(again.posts.map((p) => p[1])).toEqual([
      "This thread's session has text in its input box that may include an old line from Talos, so Talos left it alone. Attach on devbox to clear it: talos-app supervise attach trip",
    ])
    expect(host.submitted).toEqual([])
  })
  it('a pointer the key guard refused: the audit row says why, with the row it would not type over (Fable R4-3)', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    const h = x.host()
    h.sendText = async () => 'refused' as const
    h.lastKeyRefusal = () => ({ why: 'row_under_box', row: '⏺ Buy $50 of credits' })
    wake(x)
    await x.tick()
    await x.tick()
    const held = x.audit.filter(([e]) => e === 'worker_pointer_held')
    expect(held).toHaveLength(1)
    expect(held[0]?.[1]).toMatchObject({ why: 'refused', guard: 'row_under_box', row: '⏺ Buy $50 of credits' })
  })
  it('an Enter that did not submit the line (a prompt may have taken it): audited with the classes, never the text; held', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    const h = x.host()
    h.sendEnterKey = async () => 'sent' as const // the line stays in the box: something else took the key
    wake(x)
    await x.tick()
    await x.tick()
    const row = x.audit.find(([e]) => e === 'enter_may_have_answered')
    expect(row?.[1]).toEqual({
      thread: 'trip',
      pre: 'box_ours',
      after: 'box_ours',
      later: 'box_ours',
      latest: 'box_ours',
      why: 'line_still_in_box',
    })
    expect(x.audit.filter(([e, f]) => e === 'worker_pointer_held' && f?.why === 'enter_uncertain')).toHaveLength(1)
  })
  /** workers.json's record of the thread, read back the way a next supervisor would. */
  const diskRecord = (x: ReturnType<typeof setup>) =>
    JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8')).threads.trip as Record<string, unknown>
  it('an app gone right after the Enter does not type the line again: the file says done before the check reads the pane', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    const h = x.host()
    // the crash: the file as it is when the Enter's check reads the pane, before the tick's end
    let crashed: Record<string, unknown> | null = null
    const read = h.visibleRowsEscaped.bind(h)
    h.visibleRowsEscaped = async () => {
      if (h.submitted.length > 0 && crashed === null) crashed = diskRecord(x)
      return read()
    }
    wake(x)
    await x.tick()
    await x.tick()
    expect(h.submitted).toEqual([WORKER_POINTER_TEXT])
    expect(crashed).not.toBeNull()
    expect(crashed).not.toHaveProperty('pointer_owed_until')
    expect(crashed).not.toHaveProperty('enter_owed')
    // the relaunch reads nothing owed, so nothing is typed onto the empty box
    expect(restored(crashed ?? {}).pending).toBe(false)
  })
  it('an app gone right after the Enter keeps the running turn: the file has its start and conversation, and the relaunch reads it busy', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    const h = x.host()
    let crashed: Record<string, unknown> | null = null
    const read = h.visibleRowsEscaped.bind(h)
    h.visibleRowsEscaped = async () => {
      if (h.submitted.length > 0 && crashed === null) crashed = diskRecord(x)
      return read()
    }
    wake(x)
    await x.tick()
    await x.tick()
    const rec = crashed as Record<string, unknown> | null
    expect(rec?.turn_started_at).toBe(x.m.entry('trip')?.turn_started_at) // the relaunch's turnSeenBusy reads it
    expect(rec?.turn_started_at).toBeTruthy()
    expect(rec?.turn_session).toBe(x.m.entry('trip')?.session_id)
  })
  it('a flagged Enter is on disk at once, before anything else of that tick runs', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    const h = x.host()
    h.sendEnterKey = async () => 'sent' as const // the line stays in the box: something else took the key
    let atAudit: Record<string, unknown> | null = null
    const push = x.audit.push.bind(x.audit)
    x.audit.push = (...e) => {
      if (e[0][0] === 'enter_may_have_answered' && atAudit === null) atAudit = diskRecord(x)
      return push(...e)
    }
    wake(x)
    await x.tick()
    await x.tick()
    expect(atAudit).toMatchObject({ enter_uncertain: true })
  })
  it('a pointer held by a pane with no input box until its claim deadline: one line then', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    x.host().screen = ['', 'Loading…', '']
    wake(x)
    await x.tick()
    await x.tick(CLAIM_DEADLINE_MS / 1000)
    await x.tick()
    expect(x.posts.map((p) => p[1])).toEqual([
      "This thread's session isn't showing its input box yet. Attach on devbox to see what it's waiting on: talos-app supervise attach trip",
    ])
  })
  describe('pointer_hold in workers.json (why the session cannot take the message now)', () => {
    const hold = (x: ReturnType<typeof setup>) =>
      diskRecord(x).pointer_hold as { reason: string; since: string } | undefined
    it('a draft in the box: written as soon as the hold starts, with a wall-clock `since` that stays fixed', async () => {
      const x = setup({ threads: NAMED })
      await live(x)
      expect(hold(x)).toBeUndefined()
      x.host().box = 'half a thought'
      wake(x)
      await x.tick()
      await x.tick()
      const first = hold(x)
      expect(first?.reason).toBe('draft')
      expect(Number.isFinite(Date.parse(first?.since ?? ''))).toBe(true)
      await x.tick(30)
      await x.tick(30)
      expect(hold(x)).toEqual(first) // the same hold: the same time
    })
    it('scrolled back (copy mode) is `scrolled`; a draft on top of it wins; a refusal alone is `refused`, from the first one', async () => {
      const a = setup({ threads: NAMED })
      await live(a)
      a.host().mode = true
      wake(a)
      await a.tick()
      await a.tick()
      expect(hold(a)?.reason).toBe('scrolled')
      a.host().box = 'half a thought' // the box is still on the pane under the scroll
      await a.tick()
      await a.tick()
      expect(hold(a)?.reason).toBe('draft')
      const b = setup({ threads: NAMED })
      await live(b)
      b.host().sendText = async () => 'refused' as const
      wake(b)
      await b.tick()
      await b.tick()
      expect(hold(b)?.reason).toBe('refused')
    })
    it('typed and never seen in the box is `typed_unseen`', async () => {
      const x = setup({ threads: NAMED })
      await live(x)
      x.host().sendText = async () => 'sent' as const // swallowed: the box never shows it
      wake(x)
      await x.tick()
      await x.tick(WORKER_POINTER.screen_lag_s + 2)
      await x.tick()
      expect(hold(x)?.reason).toBe('typed_unseen')
    })
    it('a different reason is a new hold with its own `since`', async () => {
      const x = setup({ threads: NAMED })
      await live(x)
      x.host().box = 'half a thought'
      wake(x)
      await x.tick()
      await x.tick()
      const draft = hold(x)
      x.host().box = ''
      x.host().mode = true
      await x.tick(20)
      await x.tick()
      expect(hold(x)?.reason).toBe('scrolled')
      expect(hold(x)?.since).not.toBe(draft?.since)
    })
    it('cleared as soon as the pointer is no longer owed (the owner cleared the draft and it was typed)', async () => {
      const x = setup({ threads: NAMED })
      await live(x)
      x.host().box = 'half a thought'
      wake(x)
      await x.tick()
      await x.tick()
      expect(hold(x)?.reason).toBe('draft')
      x.host().box = ''
      await ticks(x, 4)
      expect(x.host().submitted).toEqual([WORKER_POINTER_TEXT])
      expect(hold(x)).toBeUndefined()
    })
    it('cleared as soon as the session has no pane (it crashed while held)', async () => {
      const x = setup({ threads: NAMED })
      await live(x)
      x.host().box = 'half a thought'
      wake(x)
      await x.tick()
      await x.tick()
      expect(hold(x)?.reason).toBe('draft')
      x.host().exit(1)
      await x.tick()
      expect(diskRecord(x).state).not.toBe('live')
      expect(hold(x)).toBeUndefined()
    })
  })
})

describe('the idle park (P3d3, part 5)', () => {
  const QUICK: WorkerThread = { ...TRIP, idleParkMin: 5 }
  const LIMIT = 5 * 60
  const ticks = async (x: ReturnType<typeof setup>, n: number, s = 1, each?: (i: number) => void) => {
    for (let i = 0; i < n; i++) {
      each?.(i)
      await x.tick(s)
    }
  }
  const parkedIdle = (x: ReturnType<typeof setup>) =>
    x.audit.some(([e, f]) => e === 'worker_parked' && f?.why === 'idle')

  it('a quiet live worker is parked once idle_park_min has passed since its last activity, and not before', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    await ticks(x, 1)
    await x.tick(LIMIT - 10)
    expect(x.m.state('trip')).toBe('live')
    await ticks(x, 12)
    expect(x.m.state('trip')).toBe('parking')
    expect(parkedIdle(x)).toBe(true)
  })
  it('a dialog drawn just before the limit, not settled yet, holds the park (the Mac’s 62df2342)', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    await ticks(x, 1)
    await x.tick(LIMIT - 10)
    // drawn with no output time of its own (the output clock is what makes a session busy): only the screen can hold the park
    const dialog = parseCapture(
      readFileSync(join(import.meta.dir, '../../../desktop/Tests/Fixtures/real-2.1.318/bash-permission.txt'), 'utf8'),
    )
    const was = x.host().screen
    x.host().screen = dialog
    const internal = (x.m as unknown as { workers: Map<string, { idle: { body: string | null } }> }).workers.get('trip')
    // the idle clock reads the screen too: seed it with this screen, so the drawing is no activity it would count
    if (internal) internal.idle = { ...internal.idle, body: null }
    await x.tick(12) // past the limit, and inside dialog_settle_s: the dialog is not flagged yet
    expect([was === dialog, x.m.state('trip'), parkedIdle(x)]).toEqual([false, 'live', false])
  })
  it('a wall clock that jumps forward never makes a quiet session look idle for longer: no early park (the Mac’s finding)', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    await ticks(x, 1)
    await x.tick(10)
    x.jumpWall(3 * 3600_000) // the clock is set three hours ahead
    await x.tick()
    await x.tick()
    expect(x.m.state('trip')).toBe('live')
    expect(parkedIdle(x)).toBe(false)
    expect(x.audit.some(([e]) => e === 'wall_clock_jump')).toBe(true)
    // the real idle time still parks it
    await x.tick(LIMIT)
    await ticks(x, 12)
    expect(x.m.state('trip')).toBe('parking')
  })
  it('a key in an attached client before a forward jump never lets the session park early (it is on the monotonic clock)', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    await ticks(x, 1)
    await x.tick(120)
    x.host().clients = [x.wall()] // a key that changed nothing on the screen
    await x.tick(60)
    x.jumpWall(3 * 3600_000)
    await x.tick()
    // past the idle limit since the last screen change, but not since the key, in real time
    await x.tick(LIMIT - 100)
    expect(x.m.state('trip')).toBe('live')
    expect(parkedIdle(x)).toBe(false)
  })
  it('a jump during the tick itself (a resume during a tmux call) never makes a client key read as old: no early park', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    await ticks(x, 1)
    await x.tick(LIMIT - 61)
    x.host().clients = [x.wall()] // a key that changes nothing on the screen; no park is due yet, so it is not folded in
    await x.tick(59)
    const h = x.host()
    const before = h.lastOutputAt.bind(h)
    let jumped = false
    h.lastOutputAt = async () => {
      if (!jumped) {
        jumped = true
        x.jumpWall(3 * 3600_000) // inside this tick (the busy read), after its clock check
      }
      return before()
    }
    await x.tick(2) // the park falls due in the jump's own tick: screen quiet past the limit, the key only a minute old
    expect(x.m.state('trip')).toBe('live')
  })
  it('the thread’s own idle_park_min, from its session options (the default when it has none)', async () => {
    const x = setup()
    await live(x)
    await x.tick(LIMIT + 60)
    await x.tick()
    expect(x.m.state('trip')).toBe('live')
    await x.tick(30 * 60 - LIMIT)
    await x.tick()
    expect(x.m.state('trip')).toBe('parking')
  })
  it('a status line repainting is not activity: the worker still parks', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    await ticks(x, 32, 10, (i) => {
      x.host().status = `ctx ${i}%`
    })
    expect(parkedIdle(x)).toBe(true)
  })
  it('a change above the input box is activity: the clock starts again from it', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    await x.tick()
    await x.tick(LIMIT - 60)
    x.host().history = 'a turn drew something'
    await x.tick()
    await x.tick(LIMIT - 30)
    await x.tick()
    expect(x.m.state('trip')).toBe('live')
    await x.tick(40)
    await x.tick()
    expect(x.m.state('trip')).toBe('parking')
  })
  it('output within busy_window_s is busy: never parked, however long since the last activity', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    x.host().output = x.wall()
    await x.tick(LIMIT + 60)
    x.host().output = x.wall()
    await x.tick()
    expect(x.m.state('trip')).toBe('busy')
    expect(x.file()?.threads.trip?.state).toBe('busy')
    await x.tick(WORKER_TIMING.busy_window_s)
    await x.tick()
    expect(x.m.state('trip')).toBe('parking')
  })
  it('an unknown output time is busy', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    x.host().output = null
    await x.tick(LIMIT + 60)
    await x.tick()
    expect(x.m.state('trip')).toBe('busy')
  })
  it('an attached client’s key extends the idle clock; an unreadable client list never parks', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    await x.tick()
    await x.tick(LIMIT - 60)
    x.host().clients = [x.wall()]
    await x.tick(70)
    await x.tick()
    expect(x.m.state('trip')).toBe('live')
    x.host().clients = null
    await x.tick(LIMIT)
    await x.tick()
    expect(x.m.state('trip')).toBe('live')
    x.host().clients = []
    await x.tick()
    expect(x.m.state('trip')).toBe('parking')
  })
  it('a prompt asking the owner holds the park', async () => {
    const BASH = parseCapture(
      readFileSync(join(import.meta.dir, '../../../desktop/Tests/Fixtures/real-2.1.318/bash-permission.txt'), 'utf8'),
    )
    const x = setup({ threads: [QUICK] })
    await live(x)
    x.host().screen = BASH
    await ticks(x, WORKER_TIMING.dialog_settle_s + 2)
    await x.tick(LIMIT + 60)
    await x.tick()
    expect(x.m.state('trip')).toBe('live')
    x.host().screen = null
    await ticks(x, 3)
    await x.tick(LIMIT + 60)
    await x.tick()
    expect(x.m.state('trip')).toBe('parking')
  })
  it('an owed pointer holds the park while it waits', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    await x.tick(LIMIT - 30)
    x.host().box = 'the owner’s half-typed draft'
    writeWake(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: ['m_01HZZZZZZZZZZZZZZZZZZZZZZZ'],
      at: new Date(x.wall()).toISOString(),
      reason: 'message',
      action: 'pointer',
    })
    await x.tick()
    await x.tick(60)
    await x.tick()
    expect(x.m.state('trip')).toBe('live')
    expect(parkedIdle(x)).toBe(false)
  })
  it('the last activity is in workers.json while the pane is up, and gone once it is parked', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    await x.tick()
    x.host().history = 'something new'
    await x.tick()
    const at = new Date(x.wall()).toISOString()
    await x.tick(6) // a publish
    expect(x.file()?.threads.trip?.last_active_at).toBe(at)
    await x.tick(LIMIT)
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    expect(x.file()?.threads.trip?.last_active_at).toBeUndefined()
  })
  it('the last lines above the box are in workers.json only after four quiet minutes, redacted and capped, and gone the moment the pane changes', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    const rule = '─'.repeat(40)
    const shown = (...above: string[]) => [...above, rule, '❯ half a draft', rule, 'model: sonnet  12% ctx']
    x.host().screen = shown(
      'one',
      'two',
      `export TOKEN=ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`,
      'mail jane@example.com',
    )
    await x.tick()
    await x.tick(6)
    expect(x.file()?.threads.trip?.quiet_lines).toBeUndefined() // not quiet yet
    await x.tick(215) // just under four minutes since the screen last changed
    await x.tick(6)
    expect(x.file()?.threads.trip?.quiet_lines).toBeUndefined()
    await x.tick(20)
    await x.tick(6)
    const lines = x.file()?.threads.trip?.quiet_lines
    expect(lines).toHaveLength(3)
    expect(lines?.[0]).toContain('two')
    expect(JSON.stringify(lines)).not.toContain('ghp_a1B2')
    expect(JSON.stringify(lines)).not.toContain('jane@example.com')
    expect(JSON.stringify(lines)).not.toContain('half a draft') // the box is never read
    x.host().screen = shown('something new happened')
    await x.tick()
    await x.tick(6)
    expect(x.file()?.threads.trip?.quiet_lines).toBeUndefined()
  })
  it('quiet_lines of an earlier supervisor are never carried: a restart that adopts the worker publishes none (stale text is not republished for ever)', async () => {
    const x = setup({ threads: [QUICK] })
    writeFileSync(
      workersJsonPath(x.home),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: '2026-11-10T11:59:00.000Z' },
        threads: {
          trip: {
            state: 'live',
            session_id: '11111111-2222-3333-4444-999999999999',
            tmux: 't-trip',
            pane_pid: 5001,
            cwd: '/home/alex/trip',
            started_at: '2026-11-10T10:00:00.000Z',
            last_turn_at: '2026-11-10T10:00:00.000Z',
            last_active_at: '2026-11-10T10:00:00.000Z',
            quiet_lines: ['an old line from before the restart'],
          },
        },
      }),
    )
    await x.tick()
    await x.tick(6)
    await x.tick(6)
    expect(JSON.stringify(x.file())).not.toContain('an old line from before the restart')
    expect(x.file()?.threads.trip?.quiet_lines).toBeUndefined()
  })
  it('an adopted worker carries the idle clock on from workers.json: a restart buys it no extra idle time', async () => {
    const prior = (x: ReturnType<typeof setup>, last: string) =>
      writeFileSync(
        workersJsonPath(x.home),
        JSON.stringify({
          v: 1,
          supervisor: { pid: 1, heartbeat_at: '2026-11-10T11:59:00.000Z' },
          threads: {
            trip: {
              state: 'live',
              session_id: '11111111-2222-3333-4444-999999999999',
              tmux: 't-trip',
              pane_pid: 5001,
              cwd: '/home/alex/trip',
              started_at: '2026-11-10T10:00:00.000Z',
              last_turn_at: '2026-11-10T10:00:00.000Z',
              last_active_at: last,
            },
          },
        }),
      )
    const adopted = (x: ReturnType<typeof setup>) => {
      const h = new FakeHost(() => 5001)
      h.pid = 5001
      h.running = true
      x.hosts.set('trip', h)
    }
    const old = setup({ threads: [QUICK] })
    prior(old, '2026-11-10T10:00:00.000Z')
    adopted(old)
    await ticks(old, 3)
    expect(old.m.state('trip')).toBe('parking')
    const recent = setup({ threads: [QUICK] })
    prior(recent, '2026-11-10T11:58:00.000Z') // two minutes before the clock's start
    adopted(recent)
    await ticks(recent, 3)
    expect(recent.m.state('trip')).toBe('live')
    await recent.tick(LIMIT - 120)
    await recent.tick()
    expect(recent.m.state('trip')).toBe('parking')
  })
})

describe('background work holds the idle park and steers the cap (the Mac’s WorkerBackground.swift)', () => {
  const T = (id: string, idleParkMin?: number): WorkerThread => ({
    ...TRIP,
    id,
    cwd: `/home/alex/${id}`,
    ...(idleParkMin ? { idleParkMin } : {}),
  })
  const LIMIT = 5 * 60
  // each pane as a real one is (Claude Code 2.1.325, native install: the kernel names it for its version file), its MCP server,
  // and for the threads in `busy`, a Bash tool command left running in the background
  const table = (x: ReturnType<typeof setup>, busy: () => string[]) => (): Proc[] => {
    const out: Proc[] = []
    for (const [id, h] of x.hosts) {
      if (!h.running) continue
      out.push({ pid: h.pid, ppid: 1, name: '2.1.325', argv: ['/home/alex/.local/bin/claude', '--settings', '{}'] })
      out.push({ pid: h.pid + 1000, ppid: h.pid, name: 'bun', argv: ['bun', 'run', 'src/server.ts'] })
      if (busy().includes(id)) {
        const cmd = `source /home/alex/.claude/shell-snapshots/s.sh 2>/dev/null || true && eval 'until [ -f /tmp/${id}.done ]; do sleep 15; done' < /dev/null`
        out.push({ pid: h.pid + 2000, ppid: h.pid, name: 'zsh', argv: ['/bin/zsh', '-c', cmd] })
        out.push({ pid: h.pid + 3000, ppid: h.pid + 2000, name: 'sleep', argv: null })
      }
    }
    return out
  }
  const lines = (x: ReturnType<typeof setup>, e: string, id: string) =>
    x.audit.filter(([ev, f]) => ev === e && f?.thread === id).map(([, f]) => f)
  const ticks = async (x: ReturnType<typeof setup>, n: number, s = 1) => {
    for (let i = 0; i < n; i++) await x.tick(s)
  }

  it('a session with a background task is not parked at idle_park_min; once the task ends, it is', async () => {
    const x = setup({ threads: [T('trip', 5)] })
    let busy = ['trip']
    x.setProcs(table(x, () => busy))
    await live(x)
    await ticks(x, 1)
    await x.tick(LIMIT + 60)
    await ticks(x, 5)
    expect(x.m.state('trip')).toBe('live')
    expect(lines(x, 'worker_idle_held', 'trip')).toEqual([{ thread: 'trip', bg: '1' }]) // once per hold
    expect(lines(x, 'worker_parked', 'trip')).toEqual([])
    busy = []
    await ticks(x, 2)
    expect(x.m.state('trip')).toBe('parking')
    const [line] = lines(x, 'worker_parked', 'trip')
    expect(line?.why).toBe('idle')
    expect(line?.bg).toBe('0')
    expect(Number(line?.idle_s)).toBeGreaterThanOrEqual(LIMIT)
  })
  it('control: only its MCP servers under it, it is parked at the limit (the native install is known as claude)', async () => {
    const x = setup({ threads: [T('trip', 5)] })
    x.setProcs(table(x, () => []))
    await live(x)
    await ticks(x, 1)
    await x.tick(LIMIT + 2)
    await ticks(x, 2)
    expect(x.m.state('trip')).toBe('parking')
    expect(lines(x, 'worker_parked', 'trip').map((f) => [f?.why, f?.bg])).toEqual([['idle', '0']])
  })
  it('a process table that cannot be read holds the park: unknown is not "none"', async () => {
    const x = setup({ threads: [T('trip', 5)] })
    x.setProcs(() => null)
    await live(x)
    await ticks(x, 1)
    await x.tick(LIMIT + 60)
    await ticks(x, 3)
    expect(x.m.state('trip')).toBe('live')
    expect(lines(x, 'worker_idle_held', 'trip')).toEqual([{ thread: 'trip', bg: 'unknown' }])
  })
  it('the cap takes the quiet session with no background work, even when the one with some has been idle longer', async () => {
    const x = setup({ threads: [T('a'), T('b'), T('c')], maxLive: () => 2 })
    x.setProcs(table(x, () => ['a']))
    await live(x, 'a')
    await x.tick(60)
    await live(x, 'b')
    await x.tick(60)
    await x.m.start('c')
    await x.tick()
    expect(lines(x, 'worker_parked', 'b').map((f) => [f?.why, f?.bg])).toEqual([['cap', '0']])
    expect(lines(x, 'worker_parked', 'a')).toEqual([])
    expect(x.host('a').signals).toEqual([])
  })
  const BUSY_LINE =
    'Your computer is busy: other threads still have work running in the background, so this one started anyway and nothing was stopped.'
  const busyPosts = (x: ReturnType<typeof setup>) => x.posts.filter(([, t]) => t === BUSY_LINE).map(([id]) => id)
  const capParks = (x: ReturnType<typeof setup>) =>
    x.audit.filter(([e, f]) => e === 'worker_parked' && f?.why === 'cap').map(([, f]) => f?.thread)
  const wokeUp = (x: ReturnType<typeof setup>, id: string) =>
    writeWake(x.home, {
      v: 1,
      thread_id: id,
      message_ids: ['m_01HZZZZZZZZZZZZZZZZZZZZZZZ'],
      at: new Date(x.wall()).toISOString(),
      reason: 'message',
      action: 'pointer',
    })
  /** The hub's ready, then past the busy window: the new session is quiet, so the cap's own tick has it in its list. */
  const settle = async (x: ReturnType<typeof setup>, id: string) => {
    x.ready(id)
    await ticks(x, 3, WORKER_TIMING.busy_window_s + 1)
  }
  /** Two sessions up, a 60 s apart (the first idle longer), then a third asked for. */
  const twoThenStart = async (x: ReturnType<typeof setup>, third = 'c') => {
    await live(x, 'a')
    await x.tick(60)
    await live(x, 'b')
    await x.tick(60)
    await x.m.start(third)
  }
  it('T7: when every quiet session has background work, none is stopped: the new one starts over the limit with one plain line', async () => {
    const x = setup({ threads: [T('a'), T('b'), T('c')], maxLive: () => 2 })
    x.setProcs(table(x, () => ['a', 'b']))
    await twoThenStart(x)
    await settle(x, 'c')
    // R1-1: quiet now, over the limit, and not the cap's choice: the work that forced the overflow is not charged to it
    expect(x.audit.filter(([e]) => e === 'worker_parked')).toEqual([])
    expect(['a', 'b', 'c'].map((id) => x.m.state(id))).toEqual(['live', 'live', 'live'])
    expect(x.host('a').signals).toEqual([])
    expect(x.host('b').signals).toEqual([])
    expect(lines(x, 'worker_start_over_limit', 'c')).toHaveLength(1)
    expect(busyPosts(x)).toEqual(['c']) // once, to the thread that started, not per tick
    expect(x.posts.filter(([, t]) => t.startsWith('Parked while'))).toEqual([])
  })
  it('T7: the line waits for the start to really happen: a start the plan refuses says nothing', async () => {
    const x = setup({ threads: [T('a'), T('b'), T('c')], maxLive: () => 2 })
    x.setProcs(table(x, () => ['a', 'b']))
    await live(x, 'a')
    await x.tick(60)
    await live(x, 'b')
    await x.tick(60)
    x.setPlan(() => ({ refused: { code: 'start_failed', detail: 'x' } })) // refused after the cap said yes
    await x.m.start('c')
    await ticks(x, 2)
    expect(x.m.state('c')).toBe('failed')
    expect(busyPosts(x)).toEqual([])
    expect(lines(x, 'worker_start_over_limit', 'c')).toEqual([])
  })
  it('T7: a session whose background state cannot be read counts as having work, so it is not stopped either', async () => {
    const x = setup({ threads: [T('a'), T('b'), T('c')], maxLive: () => 2 })
    x.setProcs(() => null)
    await twoThenStart(x)
    await settle(x, 'c')
    expect(x.audit.filter(([e]) => e === 'worker_parked')).toEqual([])
    expect(x.m.state('c')).toBe('live')
    expect(busyPosts(x)).toEqual(['c'])
  })
  it('T7: the count comes down once the background work ends (the longest idle is parked then), and not before', async () => {
    const x = setup({ threads: [T('a'), T('b'), T('c')], maxLive: () => 2 })
    let busy = ['a', 'b']
    x.setProcs(table(x, () => busy))
    await twoThenStart(x)
    await settle(x, 'c')
    expect(capParks(x)).toEqual([]) // R1-1: not the new, quiet c either, however long the work runs
    expect(['a', 'b', 'c'].filter((id) => x.m.state(id) === 'live')).toHaveLength(3)
    busy = []
    await ticks(x, 3)
    expect(capParks(x)).toEqual(['a'])
    expect(['a', 'b', 'c'].filter((id) => ['live', 'busy'].includes(x.m.state(id)))).toHaveLength(2)
  })
  it('T7: a lowered limit (3 to 1) parks the clean ones that no longer fit, never the one with work, then it too when that work ends', async () => {
    let max = 3
    const x = setup({ threads: [T('a'), T('b'), T('c')], maxLive: () => max })
    let busy = ['a']
    x.setProcs(table(x, () => busy))
    await live(x, 'a')
    await x.tick(60)
    await live(x, 'b')
    await x.tick(60)
    await live(x, 'c')
    await x.tick(60)
    max = 1
    await ticks(x, 4)
    expect(capParks(x)).toEqual(['b']) // a has work; c is the one clean session the limit of 1 leaves room for
    expect(x.m.state('a')).toBe('live')
    expect(x.m.state('c')).toBe('live')
    busy = []
    await ticks(x, 4)
    expect(capParks(x)).toEqual(['b', 'a'])
  })
  it('T7: several starts over the limit grow by one per thread started (each says it once), never per tick, and none stops work', async () => {
    const x = setup({ threads: [T('a'), T('b'), T('c'), T('d')], maxLive: () => 2 })
    x.setProcs(table(x, () => ['a', 'b', 'c']))
    await twoThenStart(x)
    await settle(x, 'c')
    await x.m.start('d')
    await settle(x, 'd')
    await ticks(x, 6)
    expect(x.audit.filter(([e]) => e === 'worker_parked')).toEqual([])
    expect(busyPosts(x).sort()).toEqual(['c', 'd'])
  })
  it('T7: a start held for a slot while every session is in a turn starts over the limit when they go quiet with work, and is not dropped', async () => {
    const x = setup({ threads: [T('a'), T('b'), T('c')], maxLive: () => 2 })
    x.setProcs(table(x, () => ['a', 'b']))
    await live(x, 'a')
    await live(x, 'b')
    for (const id of ['a', 'b']) x.host(id).output = x.wall() + 3600_000 // both in a turn
    wokeUp(x, 'c')
    await ticks(x, 2)
    expect(x.m.state('c')).not.toBe('live') // held: nothing to park, no room
    expect(x.audit.filter(([e]) => e === 'worker_parked')).toEqual([])
    for (const id of ['a', 'b']) x.host(id).output = 0 // turns end; their background work runs on
    await ticks(x, 3, WORKER_TIMING.busy_window_s + 1)
    await settle(x, 'c')
    expect(x.m.state('c')).toBe('live')
    expect(x.audit.filter(([e]) => e === 'worker_cap_dropped')).toEqual([])
    expect(x.audit.filter(([e]) => e === 'worker_parked')).toEqual([])
    expect(busyPosts(x)).toEqual(['c'])
  })
  it('a crash is logged once, with its background work unknown, and the thread is told no number', async () => {
    const x = setup({ threads: [T('trip')] })
    x.setProcs(table(x, () => ['trip']))
    await live(x)
    x.host().exit(null, 9)
    await ticks(x, 2)
    expect(x.m.state('trip')).toBe('parked')
    expect(lines(x, 'worker_parked', 'trip').map((f) => [f?.why, f?.bg])).toEqual([['crash', 'unknown']])
    expect(x.posts.filter(([, t]) => t.startsWith('Parked while'))).toEqual([])
  })
})

describe('the live cap and the governor (P3d3, part 6)', () => {
  const T = (id: string): WorkerThread => ({ ...TRIP, id, cwd: `/home/alex/${id}` })
  const ABC = [T('a'), T('b'), T('c')]
  const parks = (x: ReturnType<typeof setup>, why: string) =>
    x.audit.filter(([e, f]) => e === 'worker_parked' && f?.why === why).map(([, f]) => f?.thread)
  const parkWake = (x: ReturnType<typeof setup>, reason: 'governor' | 'control' | 'message', id = 'trip') =>
    writeControl(x.home, {
      v: 1,
      thread_id: id,
      message_ids: [],
      at: new Date(x.wall()).toISOString(),
      reason,
      action: 'park',
    })
  const pointerWake = (x: ReturnType<typeof setup>, id: string) =>
    writeWake(x.home, {
      v: 1,
      thread_id: id,
      message_ids: ['m_01HZZZZZZZZZZZZZZZZZZZZZZZ'],
      at: new Date(x.wall()).toISOString(),
      reason: 'message',
      action: 'pointer',
    })
  /** Every host prints on (its output time keeps up with the clock), so every worker is busy. */
  const printing = (x: ReturnType<typeof setup>) => {
    for (const h of x.hosts.values()) h.output = x.wall() + 3600_000
  }

  it('one held start parks one worker: while its victim is on its way out, nothing more is planned', async () => {
    const T4 = [T('a'), T('b'), T('c'), T('d')]
    const x = setup({ threads: T4, maxLive: () => 3 })
    await live(x, 'a')
    await live(x, 'b')
    await live(x, 'c')
    pointerWake(x, 'd')
    for (let i = 0; i < 4; i++) await x.tick()
    expect(parks(x, 'cap')).toHaveLength(1)
    expect(['a', 'b', 'c'].filter((id) => x.m.state(id) === 'live')).toHaveLength(2)
  })
  it('a restart on a worker in its turn waits for the turn; on one stuck at a prompt it is at once', async () => {
    const x = setup({ saved: () => true })
    await live(x)
    x.host().output = x.wall()
    writeControl(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: [],
      at: new Date(x.wall()).toISOString(),
      reason: 'control',
      action: 'restart',
    })
    await x.tick()
    expect(x.m.state('trip')).toBe('stopping') // its turn first
    expect(x.host().signals).toEqual([])
    await x.tick(WORKER_TIMING.busy_window_s)
    expect(x.m.state('trip')).toBe('parking')
    const y = setup({ saved: () => true })
    await live(y)
    y.host().output = y.wall()
    ;(y.m as unknown as { workers: Map<string, { notes: { needsYou: string | null } }> }).workers.get(
      'trip',
    )!.notes.needsYou = 'Bash command'
    writeControl(y.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: [],
      at: new Date(y.wall()).toISOString(),
      reason: 'control',
      action: 'restart',
    })
    await y.tick()
    expect(y.m.state('trip')).toBe('parking') // stuck: its turn never ends, so at once
  })
  it('an owner’s stop adopted by the next supervisor is still a stop: TERM at once, no turn wait', async () => {
    const x = setup()
    await live(x)
    await x.m.stop('trip')
    expect(x.m.state('trip')).toBe('stopping')
    await x.tick()
    const raw = JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8'))
    expect(raw.threads.trip.turn_wait_until).toBeUndefined()
    const y = setup()
    ;(y.m as unknown as { d: { home: string } }).d.home = x.home
    const h = new FakeHost(() => x.host().pid)
    h.pid = x.host().pid
    h.running = true
    y.hosts.set('trip', h)
    await y.tick()
    expect(h.signals).toEqual(['SIGTERM'])
  })
  it('a restart waiting on its turn survives a supervisor restart: once parked it starts again', async () => {
    const x = setup({ saved: () => true })
    await live(x)
    x.host().output = x.wall()
    writeControl(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: [],
      at: new Date(x.wall()).toISOString(),
      reason: 'control',
      action: 'restart',
    })
    await x.tick()
    expect(x.m.state('trip')).toBe('stopping')
    x.host().output = x.wall() + 1000
    await x.tick(5)
    expect(JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8')).threads.trip.turn_wait_after).toBe('restart')
    const y = setup({ saved: () => true })
    ;(y.m as unknown as { d: { home: string; wallMs: () => number } }).d.home = x.home
    ;(y.m as unknown as { d: { wallMs: () => number } }).d.wallMs = () => x.wall()
    const h = new FakeHost(() => 9100)
    h.pid = x.host().pid
    h.running = true
    h.output = x.wall()
    y.hosts.set('trip', h)
    await y.tick()
    expect(y.m.state('trip')).toBe('stopping')
    h.exit(0) // the turn ended and it went
    await y.tick()
    await y.tick()
    expect(y.m.state('trip')).toBe('starting')
  })
  it('a restart waiting on a park (no turn to wait for) survives a supervisor restart, pane still there or gone', async () => {
    for (const paneLeft of [true, false]) {
      const x = setup({ saved: () => true })
      await live(x)
      const sid = x.m.entry('trip')?.session_id
      await x.m.restart('trip') // quiet: it parks at once
      expect(x.m.state('trip')).toBe('parking')
      await x.tick()
      expect(JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8')).threads.trip.turn_wait_after).toBe('restart')
      const y = setup({ saved: () => true })
      ;(y.m as unknown as { d: { home: string } }).d.home = x.home
      ;(y.m as unknown as { d: { wallMs: () => number } }).d.wallMs = () => x.wall()
      const h = new FakeHost(() => 9100)
      h.pid = x.host().pid
      h.running = paneLeft
      y.hosts.set('trip', h)
      await y.tick()
      if (paneLeft) {
        expect(y.m.state('trip')).toBe('parking')
        h.exit(0)
        await y.tick()
      } else await y.tick() // the login environment is read: the start the last supervisor owed runs
      expect(y.m.state('trip')).toBe('starting')
      expect(y.plans.at(-1)).toMatchObject({ sessionId: sid, resume: true })
    }
  })
  it('an owner’s stop during a parking restart is kept across a supervisor restart: the session ends off, never restarted', async () => {
    for (const paneLeft of [true, false]) {
      const x = setup({ saved: () => true })
      await live(x)
      await x.m.restart('trip')
      expect(x.m.state('trip')).toBe('parking')
      await x.m.stop('trip') // the owner's stop overtakes the restart
      await x.tick()
      expect(JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8')).threads.trip.turn_wait_after).toBeUndefined()
      const y = setup({ saved: () => true })
      ;(y.m as unknown as { d: { home: string } }).d.home = x.home
      ;(y.m as unknown as { d: { wallMs: () => number } }).d.wallMs = () => x.wall()
      const h = new FakeHost(() => 9100)
      h.pid = x.host().pid
      h.running = paneLeft
      y.hosts.set('trip', h)
      await y.tick()
      if (paneLeft) h.exit(0)
      await y.tick()
      await y.tick()
      expect(y.m.state('trip')).not.toBe('starting')
      expect(y.plans).toEqual([])
    }
  })
  it('an owner’s stop the next supervisor adopts ends off, never parked (a parked session would wake on the next message)', async () => {
    const cases: Array<{ during: 'parking' | 'stopping'; paneLeft: boolean }> = [
      { during: 'parking', paneLeft: true },
      { during: 'parking', paneLeft: false },
      { during: 'stopping', paneLeft: false },
    ]
    for (const c of cases) {
      const x = setup({ saved: () => true })
      await live(x)
      if (c.during === 'parking') {
        await x.m.park('trip')
        expect(x.m.state('trip')).toBe('parking')
      }
      await x.m.stop('trip')
      expect(x.m.state('trip')).toBe(c.during)
      await x.tick()
      const y = setup({ saved: () => true })
      ;(y.m as unknown as { d: { home: string } }).d.home = x.home
      ;(y.m as unknown as { d: { wallMs: () => number } }).d.wallMs = () => x.wall()
      const h = new FakeHost(() => 9100)
      h.pid = x.host().pid
      h.running = c.paneLeft
      y.hosts.set('trip', h)
      await y.tick()
      if (c.paneLeft) h.exit(0)
      await y.tick()
      expect([c, y.m.state('trip')]).toEqual([c, 'off'])
    }
  })
  it('a wait for the turn survives a supervisor restart: the next one waits to the same deadline, then cuts it', async () => {
    const x = setup()
    await live(x)
    x.host().output = x.wall()
    parkWake(x, 'governor')
    await x.tick()
    x.host().output = x.wall() + 1000 // it prints on
    await x.tick(WORKER_TIMING.turn_wait_cap_s - 120) // the turn goes on
    const raw = JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8'))
    expect(raw.threads.trip.state).toBe('stopping')
    expect(raw.threads.trip.turn_wait_until).toBeDefined()
    // a new supervisor on the same home adopts it: no TERM, the wait goes on to the deadline the file names
    const y = setup()
    ;(y.m as unknown as { d: { home: string; wallMs: () => number } }).d.home = x.home
    ;(y.m as unknown as { d: { wallMs: () => number } }).d.wallMs = () => x.wall()
    const h = new FakeHost(() => x.host().pid)
    h.pid = x.host().pid
    h.running = true
    h.output = x.wall() // printing as the new supervisor looks
    y.hosts.set('trip', h)
    await y.tick()
    expect(y.m.state('trip')).toBe('stopping')
    expect(h.signals).toEqual([])
  })
  it('after the wall clock is set back, the session the owner is using is not the cap’s choice (ranked on the monotonic clock)', async () => {
    const T = (id: string): WorkerThread => ({ ...TRIP, id, cwd: `/home/alex/${id}` })
    const x = setup({ threads: [T('a'), T('b'), T('c')], maxLive: () => 2 })
    await live(x, 'a')
    await x.tick(60)
    await live(x, 'b')
    await x.tick(60)
    x.jumpWall(-3 * 3600_000)
    await x.tick()
    // the owner works in a: its screen changes
    x.host('a').screen = ['history', 'new output from the owner’s turn']
    await x.tick()
    await x.tick(5)
    await x.m.start('c')
    await x.tick()
    expect(x.audit.filter(([e, f]) => e === 'worker_parked' && f?.why === 'cap').map(([, f]) => f?.thread)).toEqual([
      'b',
    ])
  })
  it('full: the longest-idle worker that is not busy is parked, and the start waits for it to go', async () => {
    const x = setup({ threads: ABC, maxLive: () => 2 })
    await live(x, 'a')
    await live(x, 'b')
    await x.m.start('c')
    expect(parks(x, 'cap')).toEqual(['a'])
    expect(x.m.state('a')).toBe('parking')
    expect(x.m.state('c')).toBe('off')
    await x.tick()
    expect(x.m.state('c')).toBe('off') // a still holds its slot until it has gone
    x.host('a').exit(0)
    await x.tick()
    expect(x.m.state('a')).toBe('parked')
    expect(x.m.state('c')).toBe('starting')
    expect(x.m.state('b')).toBe('live')
  })
  it('a fresh start held for a slot is said as queued, and its line of record goes when it runs (Fable R2-1 on the reader)', async () => {
    const x = setup({ threads: ABC, maxLive: () => 2 })
    await live(x, 'a')
    await live(x, 'b')
    writeControl(x.home, {
      v: 1,
      thread_id: 'c',
      message_ids: [],
      at: new Date(x.wall()).toISOString(),
      reason: 'control',
      action: 'fresh',
    })
    await x.tick()
    await new Promise((r) => setTimeout(r, 0))
    expect(parks(x, 'cap')).toEqual(['a']) // the hold parks a quiet session to make room
    expect(x.m.state('c')).toBe('off')
    const lines = () => x.posts.filter(([t]) => t === 'c').map(([, l]) => l)
    expect(lines()).toEqual([
      'Talos will start a fresh conversation for this thread once a session slot is free (a session control).',
    ])
    x.host('a').exit(0)
    await x.tick()
    await x.tick()
    await new Promise((r) => setTimeout(r, 0))
    expect(x.m.state('c')).toBe('starting')
    expect(lines().at(-1)).toBe(
      'Talos started a fresh conversation for this thread (a session control). The old conversation is no longer loaded; its transcript is kept on this computer.',
    )
    expect(lines()).toHaveLength(2)
  })
  /** Every slot busy (a and b print on), then b's turn ends: the cap parks b and the held start for c runs. */
  const freeASlot = async (x: ReturnType<typeof setup>) => {
    x.host('b').output = x.wall() - WORKER_TIMING.busy_window_s * 1000
    x.host('a').output = x.wall() + 3600_000
    await x.tick()
    await x.tick(WORKER_TIMING.busy_window_s)
    x.host('b').exit(0)
    x.host('a').output = x.wall()
    await x.tick()
    await x.tick()
    await new Promise((r) => setTimeout(r, 0))
  }
  const control = (x: ReturnType<typeof setup>, action: 'fresh' | 'resume') =>
    writeControl(x.home, {
      v: 1,
      thread_id: 'c',
      message_ids: [],
      at: new Date(x.wall()).toISOString(),
      reason: 'control',
      action,
    })
  const lineFor = (x: ReturnType<typeof setup>) => x.posts.filter(([t]) => t === 'c').map(([, l]) => l)
  it('a fresh start that joins a held pointer start is said as queued, and the start that runs is fresh (Fable R3-1 a)', async () => {
    const x = setup({ threads: ABC, maxLive: () => 2 })
    await live(x, 'a')
    await live(x, 'b')
    printing(x)
    writeWake(x.home, {
      v: 1,
      thread_id: 'c',
      message_ids: ['m_01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      at: new Date(x.wall()).toISOString(),
      reason: 'message',
      action: 'pointer',
    })
    await x.tick()
    expect(x.events()).toContain('worker_start_held')
    expect(lineFor(x)).toEqual([])
    printing(x)
    control(x, 'fresh')
    await x.tick()
    await new Promise((r) => setTimeout(r, 0))
    expect(lineFor(x)).toEqual([
      'Talos will start a fresh conversation for this thread once a session slot is free (a session control).',
    ])
    await freeASlot(x)
    expect(x.m.state('c')).toBe('starting')
    expect(x.plans.at(-1)?.resume).toBe(false)
    expect(lineFor(x).at(-1)).toContain('Talos started a fresh conversation for this thread (a session control).')
  })
  it('a fresh start that joins a held resume replaces its line: never "resumed" for a replaced conversation (Fable R3-1 b)', async () => {
    const x = setup({ threads: ABC, maxLive: () => 2, saved: () => true })
    await live(x, 'c')
    await x.m.park('c')
    x.host('c').exit(0)
    await x.tick()
    await live(x, 'a')
    await live(x, 'b')
    printing(x)
    control(x, 'resume')
    await x.tick()
    printing(x)
    control(x, 'fresh')
    await x.tick()
    await new Promise((r) => setTimeout(r, 0))
    expect(lineFor(x)).toEqual([
      "Talos will resume this thread's session once a session slot is free (a session control).",
      'Talos will start a fresh conversation for this thread once a session slot is free (a session control).',
    ])
    await freeASlot(x)
    expect(x.m.state('c')).toBe('starting')
    expect(lineFor(x).at(-1)).toContain('Talos started a fresh conversation for this thread')
    expect(lineFor(x).some((l) => l.startsWith('Talos resumed'))).toBe(false)
  })
  it('a fresh start asked for while the hold’s victim is still parking is kept: the start that runs is fresh (Fable R5-1)', async () => {
    const x = setup({ threads: ABC, maxLive: () => 2, saved: () => true })
    await live(x, 'c')
    await x.m.park('c')
    x.host('c').exit(0)
    await x.tick()
    await live(x, 'a')
    await live(x, 'b')
    control(x, 'resume')
    await x.tick()
    expect(x.m.state('a')).toBe('parking') // the quiet one is parked to make room for c
    control(x, 'fresh') // arrives while a is still on its way out
    await x.tick()
    await new Promise((r) => setTimeout(r, 0))
    expect(lineFor(x).at(-1)).toBe(
      'Talos will start a fresh conversation for this thread once a session slot is free (a session control).',
    )
    x.host('a').exit(0)
    await x.tick()
    await x.tick()
    await new Promise((r) => setTimeout(r, 0))
    expect(x.m.state('c')).toBe('starting')
    expect(x.plans.at(-1)?.resume).toBe(false)
    expect(lineFor(x).at(-1)).toContain('Talos started a fresh conversation for this thread')
  })
  it('a control that joins a pointer-only hold while its victim parks makes it the control’s: it no longer drops with the pointer (T2-1)', async () => {
    const x = setup({ threads: ABC, maxLive: () => 2 })
    await live(x, 'a')
    await live(x, 'b')
    writeWake(x.home, {
      v: 1,
      thread_id: 'c',
      message_ids: ['m_01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      at: new Date(x.wall()).toISOString(),
      reason: 'message',
      action: 'pointer',
    })
    await x.tick()
    expect(x.m.state('a')).toBe('parking') // a quiet one is parked to make room for the pointer's start
    const held = () => (x.m as unknown as { workers: Map<string, { held: unknown }> }).workers.get('c')?.held
    expect(held()).toMatchObject({ forPointer: true, fresh: false })
    control(x, 'fresh') // while a is still on its way out
    await x.tick()
    expect(held()).toMatchObject({ forPointer: false, fresh: true })
  })
  it('a busy worker is never the cap’s choice: the quiet one is, whatever their idle times', async () => {
    const x = setup({ threads: ABC, maxLive: () => 2 })
    await live(x, 'a')
    await live(x, 'b')
    x.host('a').output = x.wall()
    await x.m.start('c')
    expect(parks(x, 'cap')).toEqual(['b'])
  })
  it('a worker waiting on the owner is not the cap’s choice (a prompt on its pane, or keys typed a moment ago)', async () => {
    const BASH = parseCapture(
      readFileSync(join(import.meta.dir, '../../../desktop/Tests/Fixtures/real-2.1.318/bash-permission.txt'), 'utf8'),
    )
    const x = setup({ threads: [...ABC, T('d')], maxLive: () => 3 })
    await live(x, 'a')
    await live(x, 'b')
    await live(x, 'c')
    x.host('a').screen = BASH
    x.host('b').clients = [x.wall()]
    await x.m.start('d')
    expect(parks(x, 'cap')).toEqual(['c'])
  })
  it('every slot busy: the start is held, retried each tick, and taken when a slot frees', async () => {
    const x = setup({ threads: ABC, maxLive: () => 2 })
    await live(x, 'a')
    await live(x, 'b')
    printing(x)
    await x.m.start('c')
    expect(x.m.state('c')).toBe('off')
    expect(x.events()).toContain('worker_start_held')
    printing(x)
    await x.tick(30)
    expect(x.m.state('c')).toBe('off')
    x.host('b').output = x.wall() - WORKER_TIMING.busy_window_s * 1000 // b's turn ended
    x.host('a').output = x.wall() + 3600_000 // a prints on
    await x.tick()
    await x.tick(WORKER_TIMING.busy_window_s)
    expect(parks(x, 'cap')).toEqual(['b'])
    x.host('b').exit(0)
    x.host('a').output = x.wall()
    await x.tick()
    expect(x.m.state('c')).toBe('starting')
  })
  it('a start held past CAP_HOLD_MS is dropped, and its owed pointer with it (Main has the message)', async () => {
    const x = setup({ threads: ABC, maxLive: () => 2 })
    await live(x, 'a')
    await live(x, 'b')
    printing(x)
    pointerWake(x, 'c')
    await x.tick()
    expect(x.m.state('c')).toBe('off')
    for (let s = 0; s < CAP_HOLD_MS / 1000; s += 30) {
      printing(x)
      await x.tick(30)
    }
    printing(x)
    await x.tick(5)
    // dropped: by the hold's own limit, or (the same moment, for a cold wake) by the pointer's deadline, which takes the hold with it
    expect(
      x.events().some((e) => e === 'worker_cap_dropped') || x.m.entry('c') === undefined || x.m.state('c') === 'off',
    ).toBe(true)
    // the slots free up: nothing is started for a message Main already has
    for (const h of x.hosts.values()) h.output = 0
    await x.tick(WORKER_TIMING.busy_window_s + 1)
    await x.tick()
    expect(x.m.state('c')).toBe('off')
    expect(JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8')).threads.c?.pointer_owed_until).toBeUndefined()
  })
  it('a lowered max_live parks the most idle extras; busy ones wait until their turn ends', async () => {
    let max = 3
    const x = setup({ threads: ABC, maxLive: () => max })
    await live(x, 'a')
    await live(x, 'b')
    await live(x, 'c')
    x.host('a').output = x.wall() + 3600_000 // a prints on
    x.host('b').output = x.wall()
    max = 1
    await x.tick()
    expect(parks(x, 'cap')).toEqual(['c'])
    expect(x.m.state('a')).toBe('busy')
    expect(x.m.state('b')).toBe('busy')
    await x.tick() // c on its way out has made its room: nobody else goes for it
    expect(parks(x, 'cap')).toEqual(['c'])
    x.host('c').exit(0)
    await x.tick(WORKER_TIMING.busy_window_s) // b's turn has ended
    expect(parks(x, 'cap')).toEqual(['c', 'b'])
    expect(x.m.state('a')).toBe('busy')
  })
  it('an unreadable max_live keeps the last good one', async () => {
    let max: number | null = 1
    const x = setup({ threads: ABC, maxLive: () => max })
    await live(x, 'a')
    max = null
    await x.tick()
    await x.m.start('b')
    expect(parks(x, 'cap')).toEqual(['a'])
  })
  it('the governor’s park waits for the turn to end, but never past turn_wait_cap_s: then the turn is cut and the thread told', async () => {
    const x = setup()
    await live(x)
    x.host().output = x.wall()
    parkWake(x, 'governor')
    await x.tick()
    expect(x.m.state('trip')).toBe('stopping')
    expect(x.host().signals).toEqual([])
    x.host().output = x.wall()
    await x.tick(WORKER_TIMING.turn_wait_cap_s - 30)
    expect(x.host().signals).toEqual([]) // still in its turn: waited for
    x.host().output = x.wall()
    await x.tick(31)
    expect(x.host().signals).toEqual(['SIGTERM'])
    expect(parks(x, 'stop_limit')).toEqual(['trip'])
    await x.tick()
    expect(x.posts.some(([, t]) => t.includes('so Talos cut it'))).toBe(true)
  })
  it('a turn that ends within the wait is not cut: parked after it, nobody told', async () => {
    const x = setup()
    await live(x)
    x.host().output = x.wall()
    parkWake(x, 'governor')
    await x.tick()
    await x.tick(WORKER_TIMING.busy_window_s) // the turn has ended
    expect(x.m.state('trip')).toBe('parking')
    expect(parks(x, 'governor')).toEqual(['trip'])
    expect(x.posts.some(([, t]) => t.includes('cut it'))).toBe(false)
  })
  it('a tap never gives a waiting turn more time than it already had', async () => {
    const x = setup()
    await live(x)
    x.host().output = x.wall()
    parkWake(x, 'governor')
    await x.tick()
    x.host().output = x.wall()
    await x.tick(WORKER_TIMING.turn_wait_cap_s - 60)
    parkWake(x, 'control')
    x.host().output = x.wall()
    await x.tick(61)
    expect(x.host().signals).toEqual(['SIGTERM'])
  })
  it('a tap’s park on a busy worker waits for the turn, at most owner_stop_s; on a quiet one it parks at once', async () => {
    const x = setup()
    await live(x)
    x.host().output = x.wall()
    parkWake(x, 'control')
    await x.tick()
    expect(x.m.state('trip')).toBe('stopping')
    x.host().output = x.wall()
    await x.tick(WORKER_TIMING.owner_stop_s)
    expect(x.host().signals).toEqual(['SIGTERM'])
    const y = setup()
    await live(y)
    parkWake(y, 'control')
    await y.tick()
    expect(y.m.state('trip')).toBe('parking')
  })
  it('a park wake for a message waits for the turn too, at most turn_wait_cap_s', async () => {
    const x = setup()
    await live(x)
    x.host().output = x.wall()
    parkWake(x, 'message')
    await x.tick()
    x.host().output = x.wall()
    await x.tick(WORKER_TIMING.turn_wait_cap_s - 30)
    expect(x.host().signals).toEqual([])
    x.host().output = x.wall()
    await x.tick(31)
    expect(x.host().signals).toEqual(['SIGTERM'])
  })
  it('an owner’s restart or stop during the governor’s wait is taken', async () => {
    const x = setup({ saved: () => true })
    await live(x)
    x.host().output = x.wall()
    parkWake(x, 'governor')
    await x.tick()
    await x.m.restart('trip')
    x.host().output = 0
    await x.tick()
    await x.tick(WORKER_TIMING.busy_window_s)
    expect(x.m.state('trip')).toBe('parking')
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('starting')
    const y = setup()
    await live(y)
    y.host().output = y.wall()
    parkWake(y, 'governor')
    await y.tick()
    await y.m.stop('trip')
    expect(y.host().signals).toEqual(['SIGTERM'])
    y.host().exit(0)
    await y.tick()
    expect(y.m.state('trip')).toBe('off')
  })
})

describe('the servers a launch left out (P3d3, part 7)', () => {
  it('a start without servers the owner listed says so, once: the missing ones and the refused ones, by name', async () => {
    const x = setup({
      plan: () => ({
        launch: { session: 't-trip', argv: ['claude'], cwd: TRIP.cwd, env: {} },
        settingsJSON: '{}',
        cwd: TRIP.cwd,
        mcpLeftOut: { missing: ['notion'], refused: ['claude.ai Gmail', 'computer-use'] },
      }),
    })
    await x.tick()
    await x.m.start('trip')
    await x.tick()
    await x.tick()
    const said = x.posts.map(([, t]) => t)
    expect(said.filter((t) => t.includes('were not found'))).toEqual([
      'These MCP servers on this thread\'s list were not found, so the session started without them: "notion".',
    ])
    expect(said.filter((t) => t.includes("can't be on a thread session's list"))).toHaveLength(1)
    expect(said.find((t) => t.includes("can't be on a thread session's list"))).toContain(
      '"claude.ai Gmail", "computer-use"',
    )
  })
})

describe('a change to what a running session was started with (P3d4, part 2)', () => {
  const SETTLE = WORKER_TIMING.launch_change_settle_s
  type Internals = { workers: Map<string, { notes: { needsYou: string | null }; entry: { launched?: unknown } }> }
  const internal = (x: ReturnType<typeof setup>) => (x.m as unknown as Internals).workers.get('trip')
  const requested = (x: ReturnType<typeof setup>) =>
    x.audit.filter(([e, f]) => e === 'worker_park_requested' && f?.why === 'config').length
  /** A thread list the test edits in place: the manager reads it each tick. */
  const editable = (t: WorkerThread = TRIP) => {
    const threads: WorkerThread[] = [{ ...t }]
    const edit = (o: Partial<WorkerThread>) => {
      threads[0] = { ...(threads[0] as WorkerThread), ...o }
    }
    return { threads, edit }
  }

  it('each start records what it was started with in workers.json', async () => {
    const { threads } = editable({ ...TRIP, model: 'opus', effort: 'high', mcpAllow: ['notion'] })
    const x = setup({ threads })
    await live(x)
    expect(x.file()?.threads.trip?.launched).toEqual({
      cwd: TRIP.cwd,
      model: 'opus',
      effort: 'high',
      mcp_allow: ['notion'],
    })
  })
  it('a new model restarts it after the change has stood for launch_change_settle_s, resuming the same session', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    const sid = x.m.entry('trip')?.session_id
    edit({ model: 'opus' })
    await x.tick()
    await x.tick(SETTLE - 2)
    expect(x.m.state('trip')).toBe('live')
    await x.tick(2)
    expect(x.m.state('trip')).toBe('stopping') // after its turn (it is quiet: parked on the next look)
    await x.tick()
    expect(x.m.state('trip')).toBe('parking')
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('starting')
    expect(x.plans.at(-1)).toMatchObject({ sessionId: sid, resume: true })
    expect(x.m.entry('trip')?.launched?.model).toBe('opus')
    x.ready()
    for (let i = 0; i < SETTLE + 5; i++) await x.tick()
    expect(x.m.state('trip')).toBe('live') // the new launch is the settings: nothing more
    expect(requested(x)).toBe(1)
  })
  it('a new MCP list restarts it too: no list and an empty list differ', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    edit({ mcpAllow: [] })
    await x.tick()
    await x.tick(SETTLE)
    expect(x.m.state('trip')).toBe('stopping')
  })
  it('a change back before the settle passes restarts nothing', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    edit({ model: 'opus' })
    await x.tick()
    await x.tick(SETTLE - 5)
    edit({ model: 'inherit' })
    await x.tick()
    await x.tick(SETTLE)
    expect(x.m.state('trip')).toBe('live')
    expect(requested(x)).toBe(0)
  })
  it('a new folder starts a fresh conversation there, and the thread is told once it has started', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    const sid = x.m.entry('trip')?.session_id as string
    edit({ cwd: '/home/alex/trip2' })
    await x.tick()
    await x.tick(SETTLE)
    await x.tick()
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('starting')
    expect(x.m.entry('trip')?.previous_ids).toEqual([sid])
    expect(x.plans.at(-1)?.resume).toBe(false)
    expect(x.m.entry('trip')?.launched?.cwd).toBe('/home/alex/trip2')
    await x.tick()
    expect(x.posts.map(([, t]) => t).filter((t) => t.startsWith('Started a new conversation'))).toEqual([
      "Started a new conversation in this thread's new folder.",
    ])
  })
  it('an owner’s restart while a folder change waits keeps it fresh: the new folder never resumes the old conversation', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    const sid = x.m.entry('trip')?.session_id as string
    x.host().output = x.wall() + 1000 // in its turn: the change waits
    edit({ cwd: '/home/alex/trip2' })
    await x.tick()
    await x.tick(SETTLE)
    await x.m.restart('trip') // the owner's restart lands on the waiting fresh one
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('starting')
    expect(x.plans.at(-1)?.resume).toBe(false)
    expect(x.m.entry('trip')?.previous_ids).toEqual([sid])
  })
  it('a session in its turn is not cut: it restarts once the turn ends, and a second change does not stack', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    x.host().output = x.wall() + 3600_000 // it prints on
    edit({ model: 'opus' })
    await x.tick()
    await x.tick(SETTLE)
    expect(x.m.state('trip')).toBe('stopping')
    await x.tick(60)
    expect(x.m.state('trip')).toBe('stopping')
    expect(x.host().signals).toEqual([])
    edit({ model: 'sonnet' }) // a second change while the restart is pending
    await x.tick()
    await x.tick(SETTLE)
    expect(requested(x)).toBe(1)
    x.host().output = 0 // the turn ends: busy for busy_window_s from the last output seen
    await x.tick()
    await x.tick(WORKER_TIMING.busy_window_s)
    expect(x.m.state('trip')).toBe('parking')
    x.host().exit(0)
    await x.tick()
    expect(x.m.entry('trip')?.launched?.model).toBe('sonnet') // the start takes the settings as they are then
  })
  it('a session stuck at a prompt restarts at once (its turn never ends)', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    x.host().output = x.wall() + 3600_000
    x.host().screen = parseCapture(
      readFileSync(join(import.meta.dir, '../../../desktop/Tests/Fixtures/real-2.1.318/bash-permission.txt'), 'utf8'),
    )
    for (let i = 0; i < WORKER_TIMING.dialog_settle_s + 2; i++) await x.tick()
    expect(internal(x)?.notes.needsYou).not.toBeNull()
    edit({ model: 'opus' })
    await x.tick()
    await x.tick(SETTLE)
    expect(x.m.state('trip')).toBe('parking')
    expect(x.host().signals).toContain('SIGTERM')
  })
  it('a session that is not running just takes the new settings at its next start', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    await x.m.park('trip')
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    edit({ model: 'opus' })
    await x.tick()
    await x.tick(SETTLE + 1)
    expect(x.m.state('trip')).toBe('parked') // nothing is started for it
    await x.m.start('trip')
    expect(x.m.entry('trip')?.launched?.model).toBe('opus')
  })
  const startedNew = (x: ReturnType<typeof setup>) =>
    x.posts.map(([, t]) => t).filter((t) => t.startsWith('Started a new conversation'))
  it('a folder changed while the session was parked: the next start is fresh there, never a resume of the old one', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    const sid = x.m.entry('trip')?.session_id as string
    await x.m.park('trip')
    x.host().exit(0)
    await x.tick()
    edit({ cwd: '/home/alex/trip2' })
    await x.m.start('trip')
    expect(x.plans.at(-1)?.resume).toBe(false)
    expect(x.plans.at(-1)?.sessionId).not.toBe(sid)
    expect(x.m.entry('trip')?.previous_ids).toEqual([sid])
    await x.tick()
    expect(startedNew(x)).toEqual(["Started a new conversation in this thread's new folder."])
  })
  it('a folder changed and changed back before the park ends resumes the same conversation, and says nothing', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    const sid = x.m.entry('trip')?.session_id as string
    x.host().output = x.wall() + 3600_000 // in its turn: the restart waits
    edit({ cwd: '/home/alex/trip2' })
    await x.tick()
    await x.tick(SETTLE)
    expect(x.m.state('trip')).toBe('stopping')
    edit({ cwd: TRIP.cwd }) // back
    x.host().output = 0
    await x.tick()
    await x.tick(WORKER_TIMING.busy_window_s)
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('starting')
    expect(x.plans.at(-1)).toMatchObject({ sessionId: sid, resume: true })
    await x.tick()
    expect(startedNew(x)).toEqual([])
  })
  it('a folder that cannot be resolved for a moment restarts nothing', async () => {
    const { threads } = editable()
    let up = true
    const x = setup({ threads, saved: () => true, realFolder: (c) => (up ? c : null) })
    await live(x)
    up = false
    await x.tick()
    await x.tick(SETTLE + 1)
    expect(x.m.state('trip')).toBe('live')
    expect(requested(x)).toBe(0)
  })
  it('a fresh start the plan refuses keeps the conversation for the next try', async () => {
    const { threads } = editable()
    let refuse = false
    const x = setup({
      threads,
      saved: () => true,
      plan: () =>
        (refuse ? { refused: { code: 'start_failed', detail: 'no folder' } } : undefined) as unknown as WorkerPlan,
    })
    await live(x)
    const sid = x.m.entry('trip')?.session_id as string
    await x.m.park('trip')
    x.host().exit(0)
    await x.tick()
    refuse = true
    await x.m.restart('trip', { fresh: true })
    expect(x.m.state('trip')).toBe('failed')
    expect(x.m.entry('trip')?.session_id).toBe(sid)
    expect(x.m.entry('trip')?.previous_ids).toEqual([])
    refuse = false
    await x.m.start('trip')
    expect(x.plans.at(-1)).toMatchObject({ sessionId: sid, resume: true })
  })
  it('session options that cannot be read restart nothing for their folder or model, but a narrowed MCP list does', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    edit({ cwd: '/home/alex/agent', model: 'inherit', effort: null, optsUnread: ['session_opts'] })
    await x.tick()
    await x.tick(SETTLE + 1)
    expect(x.m.state('trip')).toBe('live')
    edit({ mcpAllow: [] })
    await x.tick()
    await x.tick(SETTLE)
    expect(x.m.state('trip')).toBe('stopping')
  })
  it('session options that cannot be read never resume in, or start fresh in, the default folder: the start fails', async () => {
    const { threads, edit } = editable({ ...TRIP, mcpAllow: ['notion'] })
    const x = setup({ threads, saved: () => true })
    await live(x)
    const sid = x.m.entry('trip')?.session_id as string
    const n = x.plans.length
    edit({ cwd: '/home/alex/agent', optsUnread: ['session_opts'], mcpAllow: [] }) // the narrowing still restarts it
    await x.tick()
    await x.tick(SETTLE)
    expect(x.m.state('trip')).toBe('stopping')
    await x.tick(WORKER_TIMING.busy_window_s)
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('failed')
    expect(x.plans.length).toBe(n) // nothing launched in the agent folder
    expect(x.m.entry('trip')?.session_id).toBe(sid)
    expect(x.m.entry('trip')?.previous_ids).toEqual([])
  })
  it('a folder typo in a hand edit restarts nothing; the next start fails naming the field and keeps the conversation', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    const sid = x.m.entry('trip')?.session_id as string
    edit({ cwd: '/home/alex/agent', optsUnread: ['cwd'] }) // cwd: "~/trip" reads as the agent folder
    await x.tick()
    await x.tick(SETTLE + 1)
    expect(x.m.state('trip')).toBe('live')
    await x.m.park('trip')
    x.host().exit(0)
    await x.tick()
    const n = x.plans.length
    await x.m.start('trip')
    expect(x.m.state('trip')).toBe('failed')
    expect(x.plans.length).toBe(n)
    expect(x.m.entry('trip')?.error?.detail).toContain('session_opts.cwd')
    expect(x.m.entry('trip')?.session_id).toBe(sid)
    edit({ cwd: TRIP.cwd, optsUnread: undefined }) // fixed: it resumes
    await x.m.start('trip')
    expect(x.plans.at(-1)).toMatchObject({ sessionId: sid, resume: true })
  })
  it('a thread with no conversation yet and a folder that cannot be read never starts in the agent folder', async () => {
    const x = setup({ threads: [{ ...TRIP, cwd: '/home/alex/agent', optsUnread: ['cwd'] }] })
    await x.tick() // the thread list and the login environment are read
    await x.tick()
    await x.m.start('trip')
    expect(x.m.state('trip')).toBe('failed')
    expect(x.plans).toEqual([])
    expect(x.m.entry('trip')?.error?.detail).toContain('session_opts.cwd')
  })
  it('a model typo is the default model, and restarts nothing', async () => {
    const { threads, edit } = editable({ ...TRIP, model: 'opus' })
    const x = setup({ threads, saved: () => true })
    await live(x)
    edit({ model: 'inherit', optsUnread: ['model'] })
    await x.tick()
    await x.tick(SETTLE + 1)
    expect(x.m.state('trip')).toBe('live')
    expect(requested(x)).toBe(0)
  })
  it('an entry with no record of its launch (an older build) still resumes only in the folder it last launched in', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    const sid = x.m.entry('trip')?.session_id as string
    const w = internal(x)
    if (w) w.entry = { ...w.entry, launched: undefined }
    await x.m.park('trip')
    x.host().exit(0)
    await x.tick()
    edit({ cwd: '/home/alex/trip2' })
    await x.m.start('trip')
    expect(x.plans.at(-1)?.resume).toBe(false)
    expect(x.m.entry('trip')?.previous_ids).toEqual([sid])
    await x.tick()
    expect(startedNew(x)).toEqual(["Started a new conversation in this thread's new folder."])
  })
  const T = (id: string, cwd = `/home/alex/${id}`): WorkerThread => ({ ...TRIP, id, cwd })
  it('a start held by the cap after a folder change, the folder changed back while held: it resumes the conversation', async () => {
    const threads = [T('a'), T('c')]
    const x = setup({ threads, saved: () => true, maxLive: () => 1 })
    await live(x, 'c')
    const sid = x.m.entry('c')?.session_id as string
    await x.m.park('c')
    x.host('c').exit(0)
    await x.tick()
    await live(x, 'a')
    x.host('a').output = x.wall() + 3600_000 // every slot busy: c's start is held
    threads[1] = T('c', '/home/alex/c2')
    await x.m.start('c')
    expect(x.m.state('c')).toBe('parked')
    threads[1] = T('c') // back
    await x.tick()
    await x.m.park('a')
    x.host('a').exit(0)
    await x.tick()
    await x.tick()
    expect(x.m.state('c')).toBe('starting')
    expect(x.plans.at(-1)).toMatchObject({ sessionId: sid, resume: true })
    expect(x.m.entry('c')?.previous_ids).toEqual([])
  })
  it('an owner’s fresh restart held by the cap stays fresh when a pointer asks for the same start', async () => {
    const x = setup({ threads: [T('a'), T('c')], saved: () => true, maxLive: () => 1 })
    await live(x, 'c')
    const sid = x.m.entry('c')?.session_id as string
    await x.m.park('c')
    x.host('c').exit(0)
    await x.tick()
    await live(x, 'a')
    x.host('a').output = x.wall() + 3600_000
    await x.m.restart('c', { fresh: true })
    writeWake(x.home, {
      v: 1,
      thread_id: 'c',
      message_ids: ['m_01HZZZZZZZZZZZZZZZZZZZZZZZ'],
      at: new Date(x.wall()).toISOString(),
      reason: 'message',
      action: 'pointer',
    })
    await x.tick()
    await x.m.park('a')
    x.host('a').exit(0)
    await x.tick()
    await x.tick()
    expect(x.m.state('c')).toBe('starting')
    expect(x.plans.at(-1)?.resume).toBe(false)
    expect(x.m.entry('c')?.previous_ids).toEqual([sid])
  })
  it('an entry with no record of its launch (an older build) is left alone until its next start', async () => {
    const { threads, edit } = editable()
    const x = setup({ threads, saved: () => true })
    await live(x)
    const w = internal(x)
    if (w) w.entry = { ...w.entry, launched: undefined }
    edit({ model: 'opus' })
    await x.tick()
    await x.tick(SETTLE + 1)
    expect(x.m.state('trip')).toBe('live')
  })
})

describe('the P3d3 review’s lows (P3d4, part 3)', () => {
  const T = (id: string): WorkerThread => ({ ...TRIP, id, cwd: `/home/alex/${id}` })
  type Internals = {
    workers: Map<string, { held: unknown; owed: { pending: boolean }; notes: { promptWatch: { current: unknown } } }>
  }
  const internal = (x: ReturnType<typeof setup>, id: string) => (x.m as unknown as Internals).workers.get(id)
  it('an owed pointer dropped at its deadline leaves a start held for the owner’s own start; it runs once a slot frees', async () => {
    const x = setup({ threads: [T('a'), T('c')], maxLive: () => 1 })
    await live(x, 'a')
    x.host('a').output = x.wall() + 3600_000 // a is in its turn: every slot busy
    // a wake from two minutes ago: its cold deadline (3 min) comes well before the hold's own limit
    writeWake(x.home, {
      v: 1,
      thread_id: 'c',
      message_ids: ['m_01HZZZZZZZZZZZZZZZZZZZZZZZ'],
      at: new Date(x.wall() - 120_000).toISOString(),
      reason: 'message',
      action: 'pointer',
    })
    await x.tick()
    expect(internal(x, 'c')?.held).not.toBeNull()
    await x.m.start('c') // the owner's own start, held too
    for (let i = 0; i < 7; i++) {
      x.host('a').output = x.wall() + 3600_000
      await x.tick(10)
    }
    expect(internal(x, 'c')?.owed.pending).toBe(false) // the pointer is gone (Main has the message)
    expect(internal(x, 'c')?.held).not.toBeNull() // the owner's start is still waiting
    x.host('a').output = 0
    await x.tick()
    await x.tick(WORKER_TIMING.busy_window_s + 1)
    expect(x.m.state('a')).toBe('parking') // the quiet one makes room for it
    x.host('a').exit(0)
    await x.tick()
    expect(['starting', 'live']).toContain(x.m.state('c'))
  })
  it('a start held only for the pointer is dropped with it', async () => {
    const x = setup({ threads: [T('a'), T('c')], maxLive: () => 1 })
    await live(x, 'a')
    x.host('a').output = x.wall() + 3600_000
    writeWake(x.home, {
      v: 1,
      thread_id: 'c',
      message_ids: ['m_01HZZZZZZZZZZZZZZZZZZZZZZZ'],
      at: new Date(x.wall() - 120_000).toISOString(),
      reason: 'message',
      action: 'pointer',
    })
    await x.tick()
    expect(internal(x, 'c')?.held).not.toBeNull()
    for (let i = 0; i < 7; i++) {
      x.host('a').output = x.wall() + 3600_000
      await x.tick(10)
    }
    expect(internal(x, 'c')?.held).toBeNull()
  })
  it('a restart on a worker with a prompt PromptWatch is watching is at once, as for a named dialog', async () => {
    const x = setup({ saved: () => true })
    await live(x)
    x.host().output = x.wall() + 3600_000
    const w = internal(x, 'trip')
    if (w) w.notes.promptWatch.current = { signature: 'Allow this?', title: 'Allow this?' }
    writeControl(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: [],
      at: new Date(x.wall()).toISOString(),
      reason: 'control',
      action: 'restart',
    })
    await x.tick()
    expect(x.m.state('trip')).toBe('parking')
  })
})

describe('a sub-thread’s start (P3d5, part B)', () => {
  const WORK: WorkerThread = { ...TRIP, id: 'work', cwd: '/home/alex/work' }
  const sub = (o: Partial<WorkerThread> = {}, refusal: string | null = null): WorkerThread => ({
    ...TRIP,
    id: 'bug',
    cwd: '/home/alex/work/bug',
    parentCwd: '/home/alex/work',
    sub: { parentId: 'work', ownCwd: true, refusal, unreadable: {} },
    ...o,
  })
  it('one the rules refuse fails start_failed with their reason, before any folder is looked at', async () => {
    const x = setup({ threads: [WORK, sub({ cwd: WORK.cwd }, 'the parent thread is not there any more')] })
    await live(x, 'work')
    await x.m.start('bug')
    expect(x.m.state('bug')).toBe('failed')
    expect(x.m.entry('bug')?.error).toMatchObject({
      code: 'start_failed',
      detail: 'the parent thread is not there any more',
    })
  })
  it('one at its parent’s own folder is refused as such, never folder_claimed (never a wait for the parent)', async () => {
    const x = setup({ threads: [WORK, sub({ cwd: `${WORK.cwd}/` })] })
    await live(x, 'work')
    await x.m.start('bug')
    expect(x.m.entry('bug')?.error?.code).toBe('start_failed')
    expect(x.m.entry('bug')?.error?.detail).toStartWith('sub-thread folder:')
  })
  /** A real parent folder: the sub-thread check resolves what exists. */
  const realParent = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-sub-')))
    dirs.push(d)
    return { work: { ...WORK, cwd: d }, bug: sub({ cwd: join(d, 'bug'), parentCwd: d }) }
  }
  it('one inside its parent’s folder starts beside the parent’s session', async () => {
    const r = realParent()
    const x = setup({ threads: [r.work, r.bug] })
    await live(x, 'work')
    await x.m.start('bug')
    expect(x.m.state('bug')).toBe('starting')
  })
  it('a model or effort it set that is not valid is said once per start', async () => {
    const r = realParent()
    const bug = { ...r.bug, sub: { parentId: 'work', ownCwd: true, refusal: null, unreadable: { model: '7' } } }
    const x = setup({ threads: [bug] })
    await live(x, 'bug')
    expect(x.audit.filter(([e]) => e === 'thread_session_sub')).toEqual([
      ['thread_session_sub', { thread: 'bug', setting: 'model', unreadable: '7', taken: 'not set' }],
    ])
  })
})

describe('a sub-thread that shares its parent’s folder (subthreads_shared_folder)', () => {
  const WORK: WorkerThread = { ...TRIP, id: 'work', cwd: '/home/alex/work' }
  const kid = (id: string, o: Partial<WorkerThread> = {}, parentId = 'work'): WorkerThread => ({
    ...TRIP,
    id,
    cwd: WORK.cwd,
    parentCwd: null,
    sub: { parentId, ownCwd: false, shares: true, refusal: null, unreadable: {} },
    ...o,
  })
  it('starts beside its parent in the same folder, and so do its siblings: one family, no folder_claimed', async () => {
    const x = setup({ threads: [WORK, kid('bug'), kid('fix')] })
    await live(x, 'work')
    await x.m.start('bug')
    expect(x.m.state('bug')).toBe('starting')
    await x.m.start('fix')
    expect(x.m.state('fix')).toBe('starting')
  })
  it('and the parent may start after its child', async () => {
    const x = setup({ threads: [WORK, kid('bug')] })
    await live(x, 'bug')
    await x.m.start('work')
    expect(x.m.state('work')).toBe('starting')
  })
  it('still claimed against everyone else: an unrelated thread, a child of another parent, a sibling with the same subfolder', async () => {
    const other: WorkerThread = { ...TRIP, id: 'other', cwd: WORK.cwd }
    const x = setup({ threads: [WORK, kid('bug'), other] })
    await live(x, 'work')
    await x.m.start('other')
    expect(x.m.entry('other')?.error?.code).toBe('folder_claimed')
    // a child of ANOTHER parent that names this folder is no sibling
    const stray = kid('stray', {}, 'elsewhere')
    const y = setup({ threads: [WORK, stray] })
    await live(y, 'work')
    await y.m.start('stray')
    expect(y.m.entry('stray')?.error?.code).toBe('folder_claimed')
    // two children with the same SUBfolder (their own, not shared) are claimed against each other
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-fam-')))
    dirs.push(d)
    const own = (id: string): WorkerThread => ({
      ...TRIP,
      id,
      cwd: join(d, 'same'),
      parentCwd: d,
      sub: { parentId: 'work', ownCwd: true, refusal: null, unreadable: {} },
    })
    const z = setup({ threads: [{ ...WORK, cwd: d }, own('a'), own('b')] })
    await live(z, 'a')
    await z.m.start('b')
    expect(z.m.entry('b')?.error?.code).toBe('folder_claimed')
  })
  it('a running one is never parked as outside: no parent folder is judged against it', async () => {
    const x = setup({ threads: [WORK, kid('bug')] })
    await live(x, 'work')
    await live(x, 'bug')
    for (let i = 0; i < WORKER_TIMING.launch_change_settle_s + 5; i++) await x.tick()
    expect(x.m.state('bug')).toBe('live')
    expect(x.m.state('work')).toBe('live')
  })
})

describe('a sub-thread moved to a subfolder not made yet (P3d5, part B review)', () => {
  const world = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-subm-')))
    dirs.push(d)
    mkdirSync(join(d, 'a'))
    const threads: WorkerThread[] = [
      {
        ...TRIP,
        id: 'bug',
        cwd: join(d, 'a'),
        parentCwd: d,
        sub: { parentId: 'work', ownCwd: true, refusal: null, unreadable: {} },
      },
    ]
    const move = () => {
      threads[0] = { ...(threads[0] as WorkerThread), cwd: join(d, 'b') }
    }
    return { d, threads, move }
  }
  it('parked: the next start is a fresh conversation there, never a resume of the old one', async () => {
    const w = world()
    const x = setup({ threads: w.threads, saved: () => true, realFolder: wantedFolder })
    await live(x, 'bug')
    const sid = x.m.entry('bug')?.session_id as string
    await x.m.park('bug')
    x.host('bug').exit(0)
    await x.tick()
    w.move()
    await x.m.start('bug')
    expect(x.plans.at(-1)?.resume).toBe(false)
    expect(x.m.entry('bug')?.previous_ids).toEqual([sid])
  })
  it('running: the change restarts it, as for any new folder', async () => {
    const w = world()
    const x = setup({ threads: w.threads, saved: () => true, realFolder: wantedFolder })
    await live(x, 'bug')
    w.move()
    await x.tick()
    await x.tick(WORKER_TIMING.launch_change_settle_s)
    expect(x.m.state('bug')).toBe('stopping')
  })
})

describe('the agent folder is shared (P3d5, part B; the Mac’s rule)', () => {
  it('two thread sessions in the agent folder both start; any other folder is still one session', async () => {
    const A = (id: string): WorkerThread => ({ ...TRIP, id, cwd: '/home/alex/agent' })
    const x = setup({ threads: [A('a'), A('b')], agentDir: '/home/alex/agent' })
    await live(x, 'a')
    await x.m.start('b')
    expect(x.m.state('b')).toBe('starting')
    const y = setup({ threads: [A('a'), A('b')] }) // no agent folder known: no exemption
    await live(y, 'a')
    await y.m.start('b')
    expect(y.m.entry('b')?.error?.code).toBe('folder_claimed')
  })
})

describe('a sub-thread’s launch follows its parent (P3d5, part C)', () => {
  const SETTLE = WORKER_TIMING.launch_change_settle_s
  it('the parent narrowing its MCP list restarts the running sub-thread with the cut list', async () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-subc-')))
    dirs.push(d)
    const cfg = {
      default_thread: 'general',
      dedicated: { enabled: true },
      threads: [
        { id: 'general', kind: 'fixed' },
        { id: 'work', kind: 'user', session: 'dedicated', session_opts: { cwd: d, mcp_allow: ['a', 'b'] } },
        { id: 'bug', kind: 'user', session: 'dedicated', parent_id: 'work', session_opts: { cwd: join(d, 'bug') } },
      ],
    }
    const x = setup({ threads: undefined, saved: () => true })
    ;(x.m as unknown as { d: { threads: () => WorkerThread[] | null } }).d.threads = () =>
      (dedicatedThreads(cfg, '/home/alex/agent') ?? []).filter((t) => t.id === 'bug')
    await live(x, 'bug')
    expect(x.m.entry('bug')?.launched?.mcp_allow).toEqual(['a', 'b'])
    ;(cfg.threads[1] as { session_opts: unknown }).session_opts = { cwd: d, mcp_allow: ['a'] }
    await x.tick()
    await x.tick(SETTLE)
    expect(x.m.state('bug')).toBe('stopping')
    await x.tick(WORKER_TIMING.busy_window_s)
    x.host('bug').exit(0)
    await x.tick()
    expect(x.m.state('bug')).toBe('starting')
    expect(x.m.entry('bug')?.launched?.mcp_allow).toEqual(['a'])
  })
})

describe('a running sub-thread whose start would now be refused (its parent archived): parked, not left running', () => {
  const SETTLE = WORKER_TIMING.launch_change_settle_s
  // a real parent folder for each test: a sub-thread's start checks its folder inside the parent's on disk
  let parent = ''
  const freshParent = () => {
    parent = realpathSync(mkdtempSync(join(tmpdir(), 'talos-orphan-')))
    dirs.push(parent)
  }
  const subThread = (refusal: string | null): WorkerThread => ({
    ...TRIP,
    cwd: join(parent, 'trip'),
    sub: { parentId: 'work', ownCwd: true, refusal, unreadable: {} },
    parentCwd: parent,
  })
  it('once it has stood for the settle time: parked after its turn, and its next start is refused with the reason', async () => {
    freshParent()
    const threads = [subThread(null)]
    const x = setup({ threads, saved: () => true })
    await live(x)
    threads[0] = subThread(
      'the parent thread is not there any more, so the sub-thread’s folder has nothing to be inside',
    )
    await x.tick()
    await x.tick(SETTLE - 2)
    expect(x.m.state('trip')).toBe('live')
    await x.tick(3)
    expect(x.m.state('trip')).toMatch(/^(stopping|parking)$/)
    expect(x.audit.some(([e, f]) => e === 'worker_sub_refused' && f?.thread === 'trip')).toBe(true)
    await x.tick()
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked') // never started again by the park itself
    await x.m.start('trip')
    expect(x.m.entry('trip')?.error?.detail).toContain('the parent thread is not there any more')
  })
  it('one that is put right before the settle time passes changes nothing', async () => {
    freshParent()
    const threads = [subThread(null)]
    const x = setup({ threads, saved: () => true })
    await live(x)
    threads[0] = subThread('the parent thread is not there any more')
    await x.tick()
    await x.tick(SETTLE - 5)
    threads[0] = subThread(null)
    await x.tick()
    await x.tick(SETTLE)
    expect(x.m.state('trip')).toBe('live')
    expect(x.audit.some(([e]) => e === 'worker_sub_refused')).toBe(false)
  })
})

describe('a running sub-thread that shares its parent’s folder, whose parent’s folder setting becomes unreadable', () => {
  const SETTLE = WORKER_TIMING.launch_change_settle_s
  const shared: WorkerThread = {
    ...TRIP,
    cwd: '/home/alex/work',
    parentCwd: null,
    sub: { parentId: 'work', ownCwd: false, shares: true, refusal: null, unreadable: {} },
  }
  // what the planner now reads: refused, and its folder would fall to the agent folder
  const refused: WorkerThread = {
    ...shared,
    cwd: '/home/alex/agent',
    sub: {
      parentId: 'work',
      ownCwd: false,
      refusal: "the parent thread's folder setting can't be read (42)",
      unreadable: {},
    },
  }
  it('is parked once the refusal has stood, never restarted as a folder move into the agent folder', async () => {
    const threads = [shared]
    const x = setup({ threads, saved: () => true })
    await live(x)
    threads[0] = refused
    await x.tick()
    await x.tick(SETTLE + 3)
    expect(x.m.state('trip')).toMatch(/^(stopping|parking)$/)
    await x.tick()
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked') // not 'starting': nothing launched in Main's folder
    expect(x.plans).toHaveLength(1) // only the first start was ever planned: nothing launched in Main's folder
    await x.m.start('trip')
    expect(x.m.entry('trip')?.error?.detail).toContain("folder setting can't be read")
  })
})

describe('a start refused while Main’s own --settings cannot be read', () => {
  const said = (x: ReturnType<typeof setup>) => x.posts.map(([, t]) => t).filter((t) => t.includes("Main's --settings"))
  it('tells the thread once per episode, naming the file and the fix; a start that runs ends the episode', async () => {
    let unreadable = true
    const x = setup({
      plan: () =>
        (unreadable
          ? {
              refused: {
                code: 'start_failed',
                detail: 'no',
                mainSettingsUnreadable: '/home/alex/own.json',
              },
            }
          : undefined) as unknown as WorkerPlan,
    })
    await x.tick()
    await x.tick()
    await x.m.start('trip')
    await x.m.start('trip')
    await x.tick()
    expect(x.m.state('trip')).toBe('failed')
    expect(said(x)).toEqual([
      "Main's --settings file /home/alex/own.json can't be read, so this thread's session can't start with limits that match Main's; fix or remove it, then run `talos-app supervise restart-thread trip`.",
    ])
    unreadable = false
    await x.m.start('trip')
    expect(x.m.state('trip')).toBe('starting')
  })
})

describe('a start that is going to be refused takes no slot (Main’s own --settings cannot be read)', () => {
  const T = (id: string): WorkerThread => ({ ...TRIP, id, cwd: `/home/alex/${id}` })
  const blocked = { code: 'start_failed' as const, detail: 'no', mainSettingsUnreadable: '/home/alex/own.json' }
  it('with every slot taken, the quiet session is not parked for it; the thread is told once', async () => {
    let refuse = false
    const x = setup({ threads: [T('a'), T('c')], maxLive: () => 1, preflight: () => (refuse ? blocked : null) })
    await live(x, 'a')
    refuse = true
    await x.m.start('c')
    await x.m.start('c')
    await x.tick()
    expect(x.m.state('a')).toBe('live') // never parked to make room for a start that cannot run
    expect(x.m.state('c')).toBe('failed')
    expect(x.posts.filter(([, t]) => t.includes("Main's --settings"))).toHaveLength(1)
  })
  it('a line whose post failed is tried again on a later tick, and still posted once', async () => {
    let outcome: PostOutcome = 'failed'
    const x = setup({ preflight: () => blocked, postOutcome: () => outcome })
    await x.tick()
    await x.tick()
    await x.m.start('trip')
    await x.tick()
    expect(x.posts).toEqual([])
    outcome = 'sent'
    for (let i = 0; i < WORKER_TIMING.notice_retry_s + 2; i++) await x.tick()
    expect(x.posts.filter(([, t]) => t.includes("Main's --settings"))).toHaveLength(1)
  })
})

describe('a start whose permission hook cannot run takes no slot, and the thread is told', () => {
  const T = (id: string): WorkerThread => ({ ...TRIP, id, cwd: `/home/alex/${id}` })
  const why = 'the permission hook /opt/talos/kit/hooks/permission-relay.py is missing or cannot be read'
  it('with every slot taken, the quiet session is not parked for it; one line, with the reason; preflight sees the login env', async () => {
    let refuse = false
    const envs: Record<string, string>[] = []
    const x = setup({
      threads: [T('a'), T('c')],
      maxLive: () => 1,
      preflight: (_id, env) => {
        envs.push(env)
        return refuse ? { code: 'start_failed' as const, detail: why, hookMissing: why } : null
      },
    })
    await live(x, 'a')
    refuse = true
    await x.m.start('c')
    await x.m.start('c')
    await x.tick()
    expect(x.m.state('a')).toBe('live')
    expect(x.m.state('c')).toBe('failed')
    const told = x.posts.filter(([, t]) => t.includes('never reach your phone'))
    expect(told).toHaveLength(1)
    expect(told[0]?.[1]).toContain(why)
    expect(envs.every((e) => typeof e.PATH === 'string')).toBe(true)
  })
})

describe('a running sub-thread whose folder is no longer inside its parent’s (the parent moved): parked, then refused', () => {
  const SETTLE = WORKER_TIMING.launch_change_settle_s
  const world = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'talos-fence-')))
    dirs.push(root)
    for (const d of ['p', 'p/bug', 'q', 'q/p']) mkdirSync(join(root, d))
    const sub = (parentCwd: string): WorkerThread => ({
      ...TRIP,
      cwd: join(root, 'p', 'bug'),
      parentCwd,
      sub: { parentId: 'work', ownCwd: true, refusal: null, unreadable: {} },
    })
    return { root, sub }
  }
  it('the parent moved and p/bug is now outside it: an existing folder named as itself is kept as its own (c24c01f8)', async () => {
    const w = world()
    const threads = [w.sub(join(w.root, 'p'))]
    const x = setup({ threads, saved: () => true })
    await live(x)
    threads[0] = w.sub(join(w.root, 'q')) // the parent moved: p/bug is not inside q, but it exists and is named as itself
    await x.tick()
    await x.tick(SETTLE + 1)
    expect(x.m.state('trip')).toBe('live')
    expect(x.audit.some(([e]) => e === 'worker_sub_refused')).toBe(false)
  })
  it('the folder fence parks it after the settle time, and its next start is refused by the fence', async () => {
    const w = world()
    const threads = [w.sub(join(w.root, 'p'))]
    const x = setup({ threads, saved: () => true })
    await live(x)
    // the parent moved, and the folder is written through `..` (never an own folder): p/bug is not inside q
    threads[0] = { ...w.sub(join(w.root, 'q')), cwd: `${w.root}/q/../p/bug` }
    await x.tick()
    await x.tick(SETTLE - 2)
    expect(x.m.state('trip')).toBe('live')
    await x.tick(3)
    expect(x.m.state('trip')).toMatch(/^(stopping|parking)$/)
    await x.tick()
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    await x.m.start('trip')
    expect(x.m.entry('trip')?.error?.detail).toStartWith('sub-thread folder:')
  })
  it('a parent folder that cannot be read for a while is no verdict: the running session is not stopped', async () => {
    const w = world()
    const threads = [w.sub(join(w.root, 'p'))]
    const x = setup({ threads, saved: () => true })
    await live(x)
    renameSync(join(w.root, 'p'), join(w.root, 'p-away')) // a rename, a mount gone for a moment
    await x.tick()
    await x.tick(SETTLE + 1)
    expect(x.m.state('trip')).toBe('live')
    renameSync(join(w.root, 'p-away'), join(w.root, 'p'))
  })
  it('with no record of its launch, the folder it really runs in is fenced too', async () => {
    const w = world()
    const threads = [w.sub(join(w.root, 'p'))]
    const x = setup({ threads, saved: () => true })
    await live(x)
    const r = (x.m as unknown as { workers: Map<string, { entry: { launched?: unknown } }> }).workers.get('trip')
    if (r) r.entry = { ...r.entry, launched: undefined } // an older build's entry: no launch change is ever seen
    // the parent moved to p/bug itself and the config names a folder inside it, but the session still runs in p/bug: the
    // parent's own folder, which no sub-thread may have (and so never an own folder)
    mkdirSync(join(w.root, 'p', 'bug', 'sub'))
    threads[0] = { ...w.sub(join(w.root, 'p', 'bug')), cwd: join(w.root, 'p', 'bug', 'sub') }
    await x.tick()
    await x.tick(SETTLE + 1)
    expect(x.m.state('trip')).toMatch(/^(stopping|parking)$/)
  })
  it('a parent moved to a folder no session may use parks it, as a start would refuse', async () => {
    const w = world()
    const threads = [w.sub(join(w.root, 'p'))]
    const x = setup({
      threads,
      saved: () => true,
      parentFolderProblem: (p) => (p === w.root ? 'it is the home folder itself' : null),
    })
    await live(x)
    threads[0] = w.sub(w.root) // still holds p/bug, but no session may use it
    await x.tick()
    await x.tick(SETTLE + 1)
    expect(x.m.state('trip')).toMatch(/^(stopping|parking)$/)
  })
  it('a parent that moves but still holds the folder changes nothing', async () => {
    const w = world()
    const threads = [w.sub(join(w.root, 'p'))]
    const x = setup({ threads, saved: () => true })
    await live(x)
    threads[0] = w.sub(w.root) // the parent is now the folder above: p/bug is still inside it
    await x.tick()
    await x.tick(SETTLE + 1)
    expect(x.m.state('trip')).toBe('live')
    expect(x.audit.some(([e]) => e === 'worker_sub_refused')).toBe(false)
  })
})

describe('a start refused under a restricted Main', () => {
  it('the thread is told once, with the way out', async () => {
    const x = setup({
      preflight: () => ({
        code: 'start_failed',
        detail: 'restricted',
        mainRestricted: 'restricted mode (--restricted or CLAUDE_CODE_RESTRICTED)',
      }),
    })
    await x.tick()
    await x.tick()
    await x.m.start('trip')
    await x.m.start('trip')
    await x.tick()
    expect(x.m.state('trip')).toBe('failed')
    const said = x.posts.map(([, t]) => t).filter((t) => t.includes('restricted mode'))
    expect(said).toEqual([
      "Main runs in restricted mode (--restricted or CLAUDE_CODE_RESTRICTED), which this thread's session can't be held to, so it doesn't start; fix that and restart Main, then run `talos-app supervise restart-thread trip`.",
    ])
  })
})

describe('Main becomes narrowed while a thread session runs (the Mac’s R1-2)', () => {
  it('the running session is parked after its turn, and not restarted; nothing happens while Main is not narrowed', async () => {
    let narrowed: string | null = null
    const x = setup({ saved: () => true, mainNarrowed: () => narrowed })
    await live(x)
    await x.tick(5)
    expect(x.m.state('trip')).toBe('live')
    narrowed = 'safe mode (--safe-mode or CLAUDE_CODE_SAFE_MODE)'
    await x.tick()
    expect(x.m.state('trip')).toMatch(/^(stopping|parking)$/)
    expect(x.audit.some(([e, f]) => e === 'worker_park_requested' && f?.why === 'main_narrowed')).toBe(true)
    await x.tick()
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
  })
})

describe('status that tells the truth: stopped_why, needs_you and the turn fields in workers.json (the Mac’s 2d18db28)', () => {
  const TRUST = parseCapture(
    readFileSync(
      join(import.meta.dir, '../../../desktop/Tests/Fixtures/real-2.1.319/needs-you-capture/01-trust-first.txt'),
      'utf8',
    ),
  )
  const NAMED = [{ ...TRIP, name: 'Trip' }]
  const ticks = async (x: ReturnType<typeof setup>, n: number) => {
    for (let i = 0; i < n; i++) await x.tick()
  }
  const fileEntry = (x: ReturnType<typeof setup>) =>
    JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8')).threads.trip as Record<string, unknown>
  it('every end records why: the owner’s park and stop, the idle limit, a restart, a crash; a start clears it', async () => {
    const x = setup()
    await live(x)
    await x.m.park('trip', 'idle')
    expect(x.m.entry('trip')?.stopped_why).toBe('idle')
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    expect(fileEntry(x).stopped_why).toBe('idle')
    // a start: none of the three describes the new session
    await x.m.start('trip')
    expect(x.m.entry('trip')?.stopped_why).toBeUndefined()
    x.ready()
    await x.tick()
    await x.m.stop('trip')
    expect(x.m.entry('trip')?.stopped_why).toBe('owner')
    x.host().exit(0)
    await x.tick()
    await x.m.start('trip')
    x.ready()
    await x.tick()
    await x.m.restart('trip')
    expect(x.m.entry('trip')?.stopped_why).toBe('restart')
    x.host().exit(0)
    await x.tick()
    x.ready()
    await x.tick()
    expect(x.m.state('trip')).toBe('live')
    expect(x.m.entry('trip')?.stopped_why).toBeUndefined()
    // an exit nobody asked for: a crash
    x.host().exit(1)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    expect(x.m.entry('trip')?.stopped_why).toBe('crash')
  })
  it('a park that waits for the turn keeps the reason it was asked for when the turn ends (the governor’s, not the owner’s)', async () => {
    const x = setup()
    await live(x)
    writeControl(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: [],
      at: new Date(x.wall()).toISOString(),
      reason: 'governor',
      action: 'park',
    })
    x.host().output = x.wall() // a turn is running
    // the turn runs on past the wait's cap: it is cut (stop_limit), and the reason is still the governor's, not the owner's
    for (let i = 0; i <= WORKER_TIMING.turn_wait_cap_s + 2 && x.m.state('trip') !== 'parking'; i++) {
      x.host().output = x.wall()
      await x.tick(1)
    }
    expect(x.m.state('trip')).toBe('parking')
    expect(x.events()).toContain('worker_parked')
    expect(x.m.entry('trip')?.stopped_why).toBe('governor')
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    expect(x.m.entry('trip')?.stopped_why).toBe('governor')
  })
  const governorPark = (x: ReturnType<typeof setup>) =>
    writeControl(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: [],
      at: new Date(x.wall()).toISOString(),
      reason: 'governor',
      action: 'park',
    })
  it('a turn that finishes while a park waits for it moves last_turn_at (Fable R1-1)', async () => {
    const x = setup()
    await live(x)
    const began = new Date(x.wall()).toISOString()
    Object.assign(x.m.entry('trip') as object, { turn_started_at: began }) // a turn running, as a typed pointer leaves it
    x.host().output = x.wall()
    governorPark(x)
    await x.tick()
    expect(x.m.state('trip')).toBe('stopping')
    expect(x.m.entry('trip')?.turn_started_at).toBe(began)
    // the turn ends (the pane goes quiet): the park goes on, and the turn's end is recorded
    for (let i = 0; i <= WORKER_TIMING.busy_window_s + 1 && x.m.state('trip') === 'stopping'; i++) await x.tick(1)
    expect(x.m.state('trip')).toBe('parking')
    expect(x.m.entry('trip')?.turn_started_at).toBeUndefined()
    expect(Date.parse(x.m.entry('trip')?.last_turn_at ?? '')).toBeGreaterThan(Date.parse(began))
    x.host().exit(0)
    await x.tick()
    expect(x.m.entry('trip')?.last_turn_at).not.toBeNull() // the exit does not drop a finished turn
  })
  it('the owner’s stop always wins: on a parked session, during a park, a governor’s wait, a queued restart (Fable R1-2)', async () => {
    // (a) parked for idle, then stopped
    const a = setup()
    await live(a)
    await a.m.park('trip', 'idle')
    a.host().exit(0)
    await a.tick()
    await a.m.stop('trip')
    expect(a.m.entry('trip')).toMatchObject({ state: 'off', stopped_why: 'owner' })
    // (b) parking for the cap, then stopped
    const b = setup()
    await live(b)
    await b.m.park('trip', 'cap')
    await b.m.stop('trip')
    expect(b.m.entry('trip')?.stopped_why).toBe('owner')
    // (c) a governor's park waiting for the turn, then stopped
    const c = setup()
    await live(c)
    c.host().output = c.wall()
    governorPark(c)
    await c.tick()
    expect(c.m.entry('trip')?.stopped_why).toBe('governor')
    await c.m.stop('trip')
    expect(c.m.entry('trip')?.stopped_why).toBe('owner')
    // (d) a restart queued on a session going down, then stopped: it ends off, the owner's
    const d = setup()
    await live(d)
    d.host().output = d.wall()
    governorPark(d)
    await d.tick()
    await d.m.restart('trip')
    expect(d.m.entry('trip')?.stopped_why).toBe('restart')
    await d.m.stop('trip')
    expect(d.m.entry('trip')?.stopped_why).toBe('owner')
    d.host().exit(0)
    await d.tick()
    expect(d.m.entry('trip')).toMatchObject({ state: 'off', stopped_why: 'owner' })
  })
  it('the reasons by name: cap, a launch change, fresh, a tap’s park, a queued restart (Fable R1-3)', async () => {
    expect(stoppedWhy('cap', false)).toBe('cap')
    expect(stoppedWhy('config', false)).toBe('restart')
    expect(stoppedWhy('fresh', false)).toBe('restart')
    expect(stoppedWhy('control', false)).toBe('owner')
    expect(stoppedWhy('stop_limit', false)).toBe('owner')
    expect(stoppedWhy('idle', true)).toBe('restart')
    // a tap's park (control) waits for the turn and records the owner
    const x = setup()
    await live(x)
    x.host().output = x.wall()
    writeControl(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: [],
      at: new Date(x.wall()).toISOString(),
      reason: 'control',
      action: 'park',
    })
    await x.tick()
    expect(x.m.entry('trip')).toMatchObject({ state: 'stopping', stopped_why: 'owner' })
  })
  it('the usage-limit screen at a start: its own line (never "answer"), needs_you with the reset, and no needs_mac at the limit', async () => {
    const LIMIT = parseCapture(
      readFileSync(join(import.meta.dir, '../../../desktop/Tests/Fixtures/synthetic/usage-limit.txt'), 'utf8'),
    )
    const x = setup({ threads: NAMED })
    await x.tick()
    await x.m.start('trip')
    x.host().screen = LIMIT
    await ticks(x, WORKER_TIMING.dialog_settle_s + 2)
    expect(x.posts).toHaveLength(1)
    const line = x.posts[0]?.[1] ?? ''
    expect(line).toContain(
      'hit the usage limit for Fable. It resets 4pm (Europe/Paris). Talos pressed nothing on that screen',
    )
    expect(line).toContain('talos-app supervise attach trip')
    for (const w of ['answer', 'approve', 'accept', 'confirm']) expect(line.toLowerCase()).not.toContain(w)
    const needs = fileEntry(x).needs_you as { kind: string; since: string; resets_at?: string }
    expect(needs.kind).toBe('usage limit')
    expect(Date.parse(needs.resets_at ?? '')).toBeGreaterThan(x.wall())
    // never answered, so never a start that failed for want of an answer: still starting past the dialog limit
    await x.tick(WORKER_TIMING.start_dialog_s + 5)
    await x.tick()
    expect(x.m.state('trip')).toBe('starting')
    expect(x.m.entry('trip')?.error ?? null).toBeNull()
    // the owner pressed Esc: once the screen has settled without it, needs_you goes from the file (Fable R1-3)
    x.host().screen = null
    await ticks(x, WORKER_TIMING.dialog_settle_s + 2)
    expect(fileEntry(x).needs_you).toBeUndefined()
    // it comes back within the hour: needs_you again, but no second line in the thread
    x.host().screen = LIMIT
    await ticks(x, WORKER_TIMING.dialog_settle_s + 2)
    expect((fileEntry(x).needs_you as { kind: string }).kind).toBe('usage limit')
    expect(x.posts).toHaveLength(1)
  })
  it('a gone session the last supervisor was stopping: interrupted; a turn with no pane is no finished turn', () => {
    const base = { state: 'stopping', tmux: 't-trip', cwd: '/home/alex/trip' } as unknown as WorkerEntryT
    expect(adoptedGone({ ...base, state: 'parked' }, base).stopped_why).toBe('interrupted')
    const lost = withTurnLost({
      ...base,
      last_turn_at: '2026-11-10T11:00:00.000Z',
      turn_started_at: '2026-11-10T11:58:00.000Z',
    })
    expect(lost.turn_started_at).toBeUndefined()
    expect(lost.last_turn_at).toBe('2026-11-10T11:00:00.000Z')
    // an idle live session found gone: no reason of its own (noted for the Mac and Linux alike, docs/OPTION-C.md)
    expect(adoptedGone({ ...base, state: 'parked' }, { ...base, state: 'live' }).stopped_why).toBeUndefined()
  })
  it('needs_you: raised with the dialog (its kind, since when), in the file at once, and gone with it', async () => {
    const x = setup({ threads: NAMED })
    await x.tick()
    await x.m.start('trip')
    x.host().screen = TRUST
    await ticks(x, WORKER_TIMING.dialog_settle_s + 2)
    const needs = fileEntry(x).needs_you as { kind: string; since: string }
    expect(needs.kind).toBe('trust this folder')
    expect(Date.parse(needs.since)).toBeLessThanOrEqual(x.wall())
    x.host().screen = null
    await ticks(x, WORKER_TIMING.dialog_settle_s + 2)
    expect(fileEntry(x).needs_you).toBeUndefined()
  })
  it('a session found gone after a supervisor restart mid-turn: interrupted, and its unfinished turn is not a finished one', async () => {
    const x = setup()
    writeFileSync(
      workersJsonPath(x.home),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: '2026-11-10T11:59:00.000Z' },
        threads: {
          trip: {
            state: 'busy',
            session_id: '11111111-2222-3333-4444-999999999999',
            tmux: 't-trip',
            pane_pid: 5001,
            cwd: '/home/alex/trip',
            last_turn_at: '2026-11-10T11:00:00.000Z',
            turn_started_at: '2026-11-10T11:58:00.000Z',
          },
        },
      }),
    )
    await x.tick()
    expect(x.m.entry('trip')).toMatchObject({ state: 'parked', stopped_why: 'interrupted' })
    expect(x.m.entry('trip')?.turn_started_at).toBeUndefined()
    expect(x.m.entry('trip')?.last_turn_at).toBe('2026-11-10T11:00:00.000Z')
  })
})

describe('turnLook: a turn is seen busy only by output in a later second than its Enter (Fable R2-5, R3-7)', () => {
  const base = { state: 'live', tmux: 't-trip', cwd: '/home/alex/trip' } as unknown as WorkerEntryT
  const enterAt = Date.parse('2026-11-13T12:00:00.600Z')
  const w = (seen: number | null) => ({
    entry: { ...base, turn_started_at: '2026-11-13T12:00:00.600Z' } as WorkerEntryT,
    turnTypedAtMs: enterAt,
    turnSeenBusy: undefined as boolean | undefined,
    busyWatch: { seen },
  })
  it('tmux gives whole seconds: output reported in the Enter own second is its echo; the next second is the turn', () => {
    const echo = w(Date.parse('2026-11-13T12:00:00.000Z'))
    turnLook(echo, true, '2026-11-13T12:00:05.000Z')
    expect(echo.turnSeenBusy ?? false).toBe(false)
    const next = w(Date.parse('2026-11-13T12:00:01.000Z'))
    turnLook(next, true, '2026-11-13T12:00:05.000Z')
    expect(next.turnSeenBusy).toBe(true)
    // and then quiet: the turn is over
    expect(turnLook(next, false, '2026-11-13T12:00:09.000Z')).toBe(true)
    expect(next.entry.last_turn_at).toBe('2026-11-13T12:00:09.000Z')
  })
})

describe('restart on update (update-restart.ts)', () => {
  const T = (id: string, name?: string): WorkerThread => ({
    ...TRIP,
    id,
    cwd: `/home/alex/${id}`,
    idleParkMin: 24 * 60, // the test jumps the clock: no park for idleness meanwhile
    ...(name ? { name } : {}),
  })
  /** A planner whose spec hash the test sets (`spec.v`); a refused dry plan when `spec.refuseDry`. */
  const specPlan =
    (spec: { v: string; refuseDry?: boolean }) =>
    (p: Parameters<WorkerDeps['plan']>[0]): WorkerPlan =>
      p.dry && spec.refuseDry
        ? { refused: { code: 'start_failed', detail: 'no' } }
        : {
            launch: {
              session: `t-${p.thread.id}`,
              argv: ['claude'],
              cwd: p.thread.cwd,
              env: { TALOS_APP_WORKER_NONCE: p.nonce },
            },
            settingsJSON: '{}',
            cwd: p.thread.cwd,
            specHash: spec.v,
          }
  const H = (c: string) => `sha256:${c.repeat(64)}`
  const lines = (x: ReturnType<typeof setup>) => x.posts.filter(([t]) => t === 'general').map(([, l]) => l)
  const settle = async () => new Promise((r) => setTimeout(r, 0))
  /** A world with a release the test can change, and a spec it can change. */
  function world(o: { threads?: WorkerThread[]; governor?: () => string | null; on?: () => boolean | null } = {}) {
    const spec: { v: string; refuseDry?: boolean } = { v: H('a') }
    const rel = { v: 'r1', reads: 0 }
    const x = setup({
      plan: specPlan(spec),
      saved: () => true,
      threads: o.threads ?? [T('trip', 'Trip')],
      maxLive: () => 3,
      updates: {
        release: () => {
          rel.reads++
          return rel.v
        },
        ...(o.governor ? { governor: o.governor } : {}),
        ...(o.on ? { on: o.on } : {}),
      },
    })
    /** An update: a new release, seen at the next poll. */
    const update = async () => {
      rel.v = `${rel.v}+`
      await x.tick(UPDATE_RELEASE_POLL_S)
      await settle()
    }
    return { x, spec, rel, update }
  }
  /** The restart under way: the old session exits, the new one starts and is ready. */
  const comeBack = async (x: ReturnType<typeof setup>, id = 'trip') => {
    x.host(id).exit(0)
    await x.tick()
    x.ready(id)
    await x.tick()
    await settle()
  }
  /** A turn that ends: its last output now, then a whole busy window with none. */
  const turnEnds = async (x: ReturnType<typeof setup>, id = 'trip') => {
    x.host(id).output = x.wall()
    await x.tick()
    await x.tick(WORKER_TIMING.busy_window_s + 1)
    await x.tick()
    await settle()
  }

  it('right after a start and at each release: a quiet session with a new spec is restarted once, resumed, the spec written first', async () => {
    const w = world()
    await live(w.x)
    expect(w.x.m.entry('trip')?.launched?.spec_hash).toBe(H('a'))
    w.spec.v = H('b')
    // no new release: no check, whatever drifted
    await w.x.tick(UPDATE_RELEASE_POLL_S * 3)
    expect(w.x.m.state('trip')).toBe('live')
    const sid = w.x.m.entry('trip')?.session_id
    await w.update()
    expect(w.x.m.entry('trip')?.launched?.update_tried_hash).toBe(H('b')) // written before the try
    expect(w.x.m.state('trip')).toBe('parking')
    await comeBack(w.x)
    expect(w.x.m.state('trip')).toBe('live')
    expect(w.x.plans.at(-1)).toMatchObject({ sessionId: sid, resume: true })
    expect(lines(w.x)).toEqual(['Updated or instructions changed: restarted Trip.'])
    await w.update()
    expect(w.x.m.state('trip')).toBe('live')
    expect(w.x.events().filter((e) => e === 'update_restart')).toHaveLength(1)
  })
  it('never into the owner: not while a draft is in the box, or a client typed lately', async () => {
    const w = world()
    await live(w.x)
    w.spec.v = H('b')
    w.x.host().box = 'half a thought' // the owner's draft
    await w.update()
    await w.x.tick(5)
    expect(w.x.m.state('trip')).toBe('live')
    w.x.host().box = ''
    w.x.host().clients = [w.x.wall()] // a key in an attached client just now
    await w.x.tick(5)
    expect(w.x.m.state('trip')).toBe('live')
    w.x.host().clients = [w.x.wall() - UPDATE_KEYS_QUIET_S * 1000 - 1000]
    await w.x.tick(5)
    expect(w.x.m.state('trip')).toBe('parking')
    expect(lines(w.x)).toEqual(['Updated or instructions changed: Trip restarts when its turn ends.'])
  })
  it('background work under it (or a process table that cannot be read) keeps an update restart queued until the work ends', async () => {
    const w = world()
    await live(w.x)
    w.spec.v = H('b')
    let state: 'work' | 'none' | 'unreadable' = 'work'
    w.x.setProcs((): Proc[] | null => {
      if (state === 'unreadable') return null
      const pid = w.x.host('trip').pid
      const out: Proc[] = [
        { pid, ppid: 1, name: '2.1.325', argv: ['/home/alex/.local/bin/claude', '--settings', '{}'] },
      ]
      if (state === 'work') {
        const cmd =
          "source /home/alex/.claude/shell-snapshots/s.sh 2>/dev/null || true && eval 'until [ -f /tmp/t.done ]; do sleep 15; done' < /dev/null"
        out.push({ pid: pid + 2000, ppid: pid, name: 'zsh', argv: ['/bin/zsh', '-c', cmd] })
        out.push({ pid: pid + 3000, ppid: pid + 2000, name: 'sleep', argv: null })
      }
      return out
    })
    await w.update()
    await w.x.tick(5)
    expect(w.x.m.state('trip')).toBe('live')
    expect(w.x.events()).not.toContain('update_restart')
    state = 'unreadable'
    await w.x.tick(5)
    expect(w.x.m.state('trip')).toBe('live')
    expect(w.x.events()).not.toContain('update_restart')
    state = 'none'
    await w.x.tick(5)
    expect(w.x.m.state('trip')).toBe('parking')
    expect(w.x.events()).toContain('update_restart')
  })
  it('the notice of Claude Code’s own wait at a usage limit holds an update restart (it would end the wait); once it is gone, it restarts', async () => {
    const w = world()
    await live(w.x)
    w.spec.v = H('b')
    const RULE = '─'.repeat(110)
    const screen = (notice: boolean) => [
      '',
      '❯ Run the gate and tell me what failed.',
      '',
      RULE,
      '❯ ',
      RULE,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ...(notice ? ['  Continuing automatically when it resets · Esc to cancel'] : []),
    ]
    w.x.host().screen = screen(true)
    await w.x.tick(2)
    await w.update()
    await w.x.tick(5)
    expect(w.x.m.state('trip')).toBe('live')
    expect(w.x.events()).not.toContain('update_restart')
    w.x.host().screen = screen(false)
    await w.x.tick(5) // the first look without it
    await w.x.tick(5) // a settled miss: the skip is over
    await w.x.tick(5)
    expect(w.x.m.state('trip')).toBe('parking')
    expect(w.x.events()).toContain('update_restart')
  })
  it('a session in a turn waits and is named; its restart afterwards is said in a line of its own (Fable R1-1)', async () => {
    const w = world()
    await live(w.x)
    w.spec.v = H('b')
    w.x.host('trip').output = w.x.wall() + 3600_000 // printing: in a turn
    await w.update()
    await w.x.tick()
    expect(w.x.events()).not.toContain('update_restart')
    expect(lines(w.x)).toEqual(['Updated or instructions changed: Trip restarts when its turn ends.'])
    await turnEnds(w.x)
    expect(w.x.events()).toContain('update_restart')
    await comeBack(w.x)
    expect(lines(w.x)).toEqual([
      'Updated or instructions changed: Trip restarts when its turn ends.',
      'Updated or instructions changed: restarted Trip.',
    ])
  })
  it('held unless the governor is ok, off or unknown; nothing while the setting is off; no burst for a spec tried', async () => {
    let governor: string | null = 'paused'
    let on: boolean | null = true
    const w = world({ governor: () => governor, on: () => on })
    await live(w.x)
    w.spec.v = H('b')
    await w.update()
    expect(w.x.m.state('trip')).toBe('live')
    expect(w.x.events()).toContain('update_restart_held')
    governor = null
    await w.x.tick(5)
    expect(w.x.m.state('trip')).toBe('live')
    on = false
    await w.x.tick(5)
    await w.x.tick(5)
    expect(w.x.events().filter((e) => e === 'update_restart_off')).toHaveLength(1)
    on = true
    governor = 'ok'
    await w.update()
    expect(w.x.m.state('trip')).toBe('parking')
    await comeBack(w.x)
    const n = w.x.events().filter((e) => e === 'update_restart').length
    await w.update()
    expect(w.x.events().filter((e) => e === 'update_restart')).toHaveLength(n)
  })
  it('an unknown usage reading restarts a quiet session like a start does (L13); a real over-limit reading or no live status still holds', async () => {
    let governor: string | null = 'park_all'
    const w = world({ governor: () => governor })
    await live(w.x)
    w.spec.v = H('b')
    await w.update()
    expect(w.x.m.state('trip')).toBe('live')
    governor = null
    await w.x.tick(5)
    expect(w.x.m.state('trip')).toBe('live')
    governor = 'unknown'
    await w.update()
    expect(w.x.m.state('trip')).toBe('parking')
    expect(w.x.events().filter((e) => e === 'update_restart_held')).toHaveLength(2)
  })
  it('a spec tried is never tried again, even when the start it gave records another spec', async () => {
    const w = world()
    await live(w.x)
    w.x.setPlan((p) => specPlan({ v: p.dry ? H('d') : H('e') })(p))
    await w.update()
    expect(w.x.m.state('trip')).toBe('parking')
    await comeBack(w.x)
    expect(w.x.m.entry('trip')?.launched?.spec_hash).toBe(H('e'))
    for (let k = 0; k < 3; k++) await w.update()
    expect(w.x.m.state('trip')).toBe('live')
    expect(w.x.events().filter((e) => e === 'update_restart')).toHaveLength(1)
  })
  it('a dry plan refused: left alone; a start that fails: said, never retried; one that never comes back: given up, said as not restarted', async () => {
    const w = world()
    await live(w.x)
    w.spec.v = H('b')
    w.spec.refuseDry = true
    await w.update()
    expect(w.x.m.state('trip')).toBe('live')
    w.spec.refuseDry = false
    await w.update()
    expect(w.x.m.state('trip')).toBe('parking')
    const real = specPlan({ v: H('c') })
    w.x.setPlan((p) => (p.dry ? real(p) : { refused: { code: 'start_failed', detail: 'refused now' } }))
    w.x.host('trip').exit(0)
    await w.x.tick()
    await w.x.tick()
    await settle()
    expect(w.x.m.state('trip')).toBe('failed')
    expect(lines(w.x)).toEqual(['Updated or instructions changed: Trip failed.'])
    // a second thread whose restart parks and never starts again (no login environment for its start)
    const v = world({ threads: [T('a', 'A')] })
    await live(v.x, 'a')
    v.spec.v = H('b')
    await v.update()
    expect(v.x.m.state('a')).toBe('parking')
    v.x.setEnv(false)
    v.x.host('a').exit(0)
    await v.x.tick()
    expect(v.x.m.state('a')).toBe('parked')
    await v.x.tick(UPDATE_RESTART_GIVE_UP_S + 1)
    await settle()
    expect(lines(v.x)).toEqual(['Updated or instructions changed: A was not restarted (it did not start again).'])
    expect(v.x.events()).toContain('update_restart_given_up')
    expect(v.x.events()).not.toContain('update_restart_failed')
  })
  it('a release seen while a check cannot run (no login environment) is checked at the next poll, not the next release (R1-5)', async () => {
    const w = world()
    await live(w.x)
    w.spec.v = H('b')
    w.x.setEnv(false)
    await w.update() // a new release, but no environment to plan with: nothing checked, and the release is not recorded
    expect(w.x.events()).not.toContain('update_restart_queued')
    w.x.setEnv(true)
    await w.x.tick(UPDATE_RELEASE_POLL_S) // no newer release: the next poll still checks
    await settle()
    expect(w.x.events()).toContain('update_restart_queued')
  })
  it('the release is read only at a poll: never at every tick, with no thread or before the first check can run', async () => {
    const none = world({ threads: [] })
    for (let k = 0; k < 20; k++) await none.x.tick()
    for (let k = 0; k < 3; k++) await none.x.tick(UPDATE_RELEASE_POLL_S)
    expect(none.rel.reads).toBe(0)
    const w = world()
    await live(w.x)
    const after = w.rel.reads
    expect(after).toBe(1) // the first check, once it ran
    for (let k = 0; k < 10; k++) await w.x.tick(1)
    expect(w.rel.reads).toBe(after)
    await w.x.tick(UPDATE_RELEASE_POLL_S)
    expect(w.rel.reads).toBe(after + 1)
  })
  it('an unwritable state file: said once, and the release kept in memory, so no check repeats at every poll', async () => {
    const w = world()
    mkdirSync(join(w.x.home, UPDATE_STATE_FILE)) // a folder where the file goes: every write fails
    await live(w.x)
    w.spec.v = H('b')
    await w.update()
    expect(w.x.m.state('trip')).toBe('parking')
    await comeBack(w.x)
    let dry = 0
    const plan = specPlan(w.spec)
    w.x.setPlan((p) => {
      if (p.dry) dry++
      return plan(p)
    })
    for (let k = 0; k < 4; k++) await w.x.tick(UPDATE_RELEASE_POLL_S)
    await settle()
    expect(dry).toBe(0) // no check: the release has not changed
    expect(w.x.events().filter((e) => e === 'update_restart_state_not_written')).toHaveLength(1)
    expect(w.x.events().filter((e) => e === 'update_restart_queued')).toHaveLength(1)
  })
  it('turned off: the waiting list goes too, so a session that waited is never named again later', async () => {
    let on: boolean | null = true
    const w = world({ on: () => on })
    await live(w.x)
    w.spec.v = H('b')
    w.x.host('trip').output = w.x.wall() + 3600_000 // printing: in a turn
    await w.update()
    expect(lines(w.x)).toEqual(['Updated or instructions changed: Trip restarts when its turn ends.'])
    on = false
    await w.x.tick(5)
    on = true
    await w.x.tick(5)
    await w.x.m.park('trip')
    w.x.host('trip').exit(0)
    await w.x.tick()
    expect(w.x.m.state('trip')).toBe('parked')
    await w.update() // a new round: nothing running is stale, so nothing to say
    await w.x.tick()
    expect(lines(w.x)).toEqual(['Updated or instructions changed: Trip restarts when its turn ends.'])
  })
  it('one at a time: the second is restarted only once the first is live again', async () => {
    const w = world({ threads: [T('a', 'A'), T('b', 'B')] })
    await live(w.x, 'a')
    await live(w.x, 'b')
    w.spec.v = H('b')
    await w.update()
    const first = w.x.m.state('a') === 'parking' ? 'a' : 'b'
    const second = first === 'a' ? 'b' : 'a'
    expect(w.x.m.state(second)).toBe('live')
    await w.x.tick()
    expect(w.x.m.state(second)).toBe('live')
    await comeBack(w.x, first)
    await w.x.tick()
    expect(w.x.m.state(second)).toBe('parking')
    await comeBack(w.x, second)
    const [f, s2] = first === 'a' ? ['A', 'B'] : ['B', 'A']
    expect(lines(w.x)).toEqual([`Updated or instructions changed: restarted ${f}, ${s2}.`])
  })
})

describe('a turn that was cut off is run again by the next start, once and only soon (0.26)', () => {
  const SAVED = { saved: () => true }
  const lastPlan = (x: ReturnType<typeof setup>) => x.plans[x.plans.length - 1]
  /** In a turn: the pane drew just now. */
  const inTurn = async (x: ReturnType<typeof setup>) => {
    x.host().output = x.wall()
    await x.tick()
  }
  const startAgain = async (x: ReturnType<typeof setup>) => {
    await x.m.start('trip')
    x.ready()
    await x.tick()
  }
  const crashMidTurn = async (x: ReturnType<typeof setup>) => {
    await live(x)
    await inTurn(x)
    expect(x.m.state('trip')).toBe('busy')
    x.host().exit(1)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
  }
  const prior = (x: ReturnType<typeof setup>, over: Record<string, unknown>) =>
    writeFileSync(
      workersJsonPath(x.home),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: '2026-11-10T11:59:00.000Z' },
        threads: {
          trip: {
            state: 'busy',
            session_id: '11111111-2222-3333-4444-999999999999',
            tmux: 't-trip',
            pane_pid: 5001,
            cwd: '/home/alex/trip',
            ...over,
          },
        },
      }),
    )
  it('a crash in the middle of a turn: the next resume asks for the turn again', async () => {
    const x = setup(SAVED)
    await crashMidTurn(x)
    await startAgain(x)
    expect(lastPlan(x)).toMatchObject({ resume: true, resumeTurn: true })
  })
  it('an ordinary start, a start after a quiet park and a start after a crash between turns do not', async () => {
    const x = setup(SAVED)
    await live(x)
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
    await x.m.park('trip', 'idle')
    x.host().exit(0)
    await x.tick()
    await startAgain(x)
    expect(lastPlan(x)).toMatchObject({ resume: true })
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
    x.host().exit(1) // quiet: no turn was running
    await x.tick()
    await startAgain(x)
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
  })
  it('a turn that ended (Esc, or it finished) and then a crash: not run again', async () => {
    const x = setup(SAVED)
    await live(x)
    await inTurn(x)
    await x.tick(WORKER_TIMING.busy_window_s + 2) // the pane went quiet: the turn is over
    await x.tick()
    expect(x.m.state('trip')).toBe('live')
    x.host().exit(1)
    await x.tick()
    await startAgain(x)
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
  })
  it('the owner stops it in the middle of a turn: never run again', async () => {
    const x = setup(SAVED)
    await live(x)
    await inTurn(x)
    await x.m.stop('trip')
    x.host().exit(0)
    await x.tick()
    expect(x.m.state('trip')).toBe('off')
    await startAgain(x)
    expect(lastPlan(x)).toMatchObject({ resume: true })
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
  })
  it('a stop by the owner after a crash cleans the record: the later start does not run the turn', async () => {
    const x = setup(SAVED)
    await crashMidTurn(x)
    await x.m.stop('trip')
    await startAgain(x)
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
  })
  it('the turn is asked for once: the start after that one does not', async () => {
    const x = setup(SAVED)
    await crashMidTurn(x)
    await startAgain(x)
    expect(lastPlan(x)?.resumeTurn).toBe(true)
    x.host().exit(1) // quiet
    await x.tick()
    await startAgain(x)
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
  })
  it('a fresh start does not ask for it, and clears it', async () => {
    const x = setup(SAVED)
    await crashMidTurn(x)
    await x.m.start('trip', { fresh: true })
    x.ready()
    await x.tick()
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
    x.host().exit(1)
    await x.tick()
    await startAgain(x)
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
  })
  it('a direct restart, of a quiet session or of a busy one (its turn is stopped at once), does not ask for the turn again', async () => {
    const x = setup(SAVED)
    await live(x)
    await x.m.restart('trip') // quiet
    x.host().exit(0)
    await x.tick()
    x.ready()
    await x.tick()
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
    await inTurn(x)
    await x.m.restart('trip') // busy: the turn is stopped at once
    x.host().exit(0)
    await x.tick()
    expect(lastPlan(x)).toMatchObject({ resume: true })
    expect(lastPlan(x)?.resumeTurn).toBeFalsy() // a restart to get going again is not a cut turn
  })
  it('a restart wake on a stuck session (a dialog on its screen) is at once, and not a cut turn either', async () => {
    const x = setup(SAVED)
    await live(x)
    await inTurn(x)
    x.host().screen = parseCapture(
      readFileSync(
        join(import.meta.dir, '../../../desktop/Tests/Fixtures/real-2.1.319/needs-you-capture/01-trust-first.txt'),
        'utf8',
      ),
    )
    for (let i = 0; i < WORKER_TIMING.dialog_settle_s + 2; i++) await inTurn(x)
    writeControl(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: [],
      at: new Date(x.wall()).toISOString(),
      reason: 'control',
      action: 'restart',
    })
    await x.tick()
    expect(x.host().signals).toEqual(['SIGTERM']) // at once: the stuck branch
    x.host().screen = null
    x.host().exit(0)
    await x.tick()
    expect(lastPlan(x)).toMatchObject({ resume: true })
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
  })
  it('a restart wake that waits for the turn and then cuts it at the limit asks for it again', async () => {
    const x = setup(SAVED)
    await live(x)
    x.host().output = x.wall()
    writeControl(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: [],
      at: new Date(x.wall()).toISOString(),
      reason: 'control',
      action: 'restart',
    })
    await x.tick()
    expect(x.m.state('trip')).toBe('stopping')
    for (let i = 0; i < WORKER_TIMING.owner_stop_s + 2 && x.host().signals.length === 0; i++) {
      x.host().output = x.wall()
      await x.tick()
    }
    expect(x.host().signals).toEqual(['SIGTERM']) // the turn was cut
    x.host().exit(0)
    await x.tick()
    expect(lastPlan(x)).toMatchObject({ resume: true, resumeTurn: true })
  })
  it('a session the last supervisor left mid-turn, found gone, asks for the turn again (turn_started_at too)', async () => {
    for (const over of [{ state: 'busy' }, { state: 'live', turn_started_at: '2026-11-10T11:58:00.000Z' }]) {
      const x = setup(SAVED)
      prior(x, { ...over, last_active_at: '2026-11-10T11:58:30.000Z' })
      await x.tick()
      expect(x.m.state('trip')).toBe('parked')
      await startAgain(x)
      expect(lastPlan(x)).toMatchObject({ resume: true, resumeTurn: true })
    }
  })
  it('a session found gone while quiet does not', async () => {
    const x = setup(SAVED)
    prior(x, { state: 'live' })
    await x.tick()
    await startAgain(x)
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
  })
  it('the record survives a supervisor restart between the cut and the start', async () => {
    const x = setup(SAVED)
    await crashMidTurn(x)
    await x.tick(6) // published
    const y = setup({ ...SAVED, home: x.home })
    await y.tick()
    await y.m.start('trip')
    y.ready()
    await y.tick()
    expect(lastPlan(y)).toMatchObject({ resume: true, resumeTurn: true })
  })
  describe('plan mode', () => {
    it('cut in plan mode (the footer said so during the turn): not run again', async () => {
      const x = setup(SAVED)
      await live(x)
      x.host().status = '⏸ plan mode on (shift+tab to cycle)'
      await inTurn(x)
      x.host().exit(1)
      await x.tick()
      await startAgain(x)
      expect(lastPlan(x)).toMatchObject({ resume: true })
      expect(lastPlan(x)?.resumeTurn).toBeFalsy()
    })
    it('a session launched in plan mode is plan mode even when the footer cannot be read', async () => {
      const x = setup({
        ...SAVED,
        plan: (p) => ({
          launch: {
            session: 't-trip',
            argv: ['claude', '--permission-mode=plan'],
            cwd: p.thread.cwd,
            env: { TALOS_APP_WORKER_NONCE: p.nonce },
          },
          settingsJSON: '{}',
          cwd: p.thread.cwd,
        }),
      })
      await crashMidTurn(x)
      await startAgain(x)
      expect(lastPlan(x)?.resumeTurn).toBeFalsy()
    })
    it('a footer that shows another mode is not plan mode', async () => {
      const x = setup(SAVED)
      await live(x)
      x.host().status = '⏵⏵ accept edits on (shift+tab to cycle)'
      await inTurn(x)
      x.host().exit(1)
      await x.tick()
      await startAgain(x)
      expect(lastPlan(x)?.resumeTurn).toBe(true)
    })
    it('left plan mode during the turn: the last footer counts', async () => {
      const x = setup(SAVED)
      await live(x)
      x.host().status = '⏸ plan mode on (shift+tab to cycle)'
      await inTurn(x)
      x.host().status = '? for shortcuts'
      await inTurn(x)
      x.host().exit(1)
      await x.tick()
      await startAgain(x)
      expect(lastPlan(x)?.resumeTurn).toBe(true)
    })
    it('a prompt on the screen in place of the footer keeps what was seen', async () => {
      const x = setup(SAVED)
      await live(x)
      x.host().status = '⏸ plan mode on (shift+tab to cycle)'
      await inTurn(x)
      x.host().screen = ['Do you want to proceed?', '1. Yes', '2. No']
      await inTurn(x)
      x.host().exit(1)
      await x.tick()
      await startAgain(x)
      expect(lastPlan(x)?.resumeTurn).toBeFalsy()
    })
  })
  describe('the age gate (RESUME_TURN_MAX_AGE_MS)', () => {
    it('is thirty minutes', () => expect(RESUME_TURN_MAX_AGE_MS).toBe(30 * 60 * 1000))
    it('a start exactly at the limit still asks for the turn', async () => {
      const x = setup(SAVED)
      await crashMidTurn(x)
      x.jumpWall(RESUME_TURN_MAX_AGE_MS)
      await startAgain(x)
      expect(lastPlan(x)?.resumeTurn).toBe(true)
    })
    it('a start one millisecond past it does not', async () => {
      const x = setup(SAVED)
      await crashMidTurn(x)
      x.jumpWall(RESUME_TURN_MAX_AGE_MS + 1)
      await startAgain(x)
      expect(lastPlan(x)).toMatchObject({ resume: true })
      expect(lastPlan(x)?.resumeTurn).toBeFalsy()
    })
    it('a session found gone is as old as its last activity, not as the moment this supervisor noticed', async () => {
      const x = setup(SAVED)
      prior(x, { state: 'busy', last_active_at: '2026-11-10T11:00:00.000Z' }) // an hour before the test clock
      await x.tick()
      await startAgain(x)
      expect(lastPlan(x)).toMatchObject({ resume: true })
      expect(lastPlan(x)?.resumeTurn).toBeFalsy()
    })
  })
})

describe('what a cut session left running is ended before its turn runs again (0.26)', () => {
  const SAVED = { saved: () => true }
  const NONCE = /^[0-9a-f]{32,}$/
  const inTurn = async (x: ReturnType<typeof setup>) => {
    x.host().output = x.wall()
    await x.tick()
  }
  const startAgain = async (x: ReturnType<typeof setup>) => {
    await x.m.start('trip')
    x.ready()
    await x.tick()
  }
  it('a crash in the middle of a turn: the dead launch’s nonce is reaped once, before the next start', async () => {
    const x = setup(SAVED)
    await live(x)
    const nonce = x.plans[0]?.nonce as string
    expect(nonce).toMatch(NONCE)
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    expect(x.reaps).toEqual([nonce])
    await startAgain(x)
    expect(x.plans[1]).toMatchObject({ resumeTurn: true, reapsSoFar: 1 }) // reaped first
    expect(x.reaps).toEqual([nonce])
  })
  it('a crash between turns, an idle exit and a park reap nothing', async () => {
    const x = setup(SAVED)
    await live(x)
    x.host().exit(1)
    await x.tick()
    await startAgain(x)
    await x.m.park('trip', 'idle')
    x.host().exit(0)
    await x.tick()
    expect(x.reaps).toEqual([])
  })
  it('the owner’s stop in the middle of a turn reaps nothing: it is not resumed, and background work is the owner’s call', async () => {
    const x = setup(SAVED)
    await live(x)
    await inTurn(x)
    await x.m.stop('trip')
    x.host().exit(0)
    await x.tick()
    expect(x.reaps).toEqual([])
  })
  it('cut in plan mode: nothing runs again, so nothing is reaped', async () => {
    const x = setup(SAVED)
    await live(x)
    x.host().status = '⏸ plan mode on (shift+tab to cycle)'
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    expect(x.reaps).toEqual([])
  })
  it('a restart that stopped a running turn: reaped when the pane has gone, before the restart’s own start', async () => {
    const x = setup(SAVED)
    await live(x)
    const nonce = x.plans[0]?.nonce as string
    await inTurn(x)
    writeControl(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: [],
      at: new Date(x.wall()).toISOString(),
      reason: 'control',
      action: 'restart',
    })
    await x.tick()
    for (let i = 0; i < WORKER_TIMING.owner_stop_s + 2 && x.host().signals.length === 0; i++) await inTurn(x) // waits, then cuts
    expect(x.host().signals).toEqual(['SIGTERM'])
    expect(x.reaps).toEqual([]) // the pane is still going down
    x.host().exit(0)
    await x.tick()
    expect(x.reaps).toEqual([nonce])
    expect(x.plans[1]).toMatchObject({ resumeTurn: true, reapsSoFar: 1 })
  })
  it('a session found gone after a supervisor restart mid-turn: the nonce its file still holds is reaped', async () => {
    const x = setup(SAVED)
    const nonce = 'cd'.repeat(16)
    writeFileSync(
      workersJsonPath(x.home),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: '2026-11-10T11:59:00.000Z' },
        threads: {
          trip: {
            state: 'busy',
            session_id: '11111111-2222-3333-4444-999999999999',
            turn_started_at: '2026-11-10T11:58:00.000Z',
            tmux: 't-trip',
            pane_pid: 5001,
            cwd: '/home/alex/trip',
          },
        },
      }),
    )
    mkdirSync(workerDir(x.home, 'trip'), { recursive: true })
    writeFileSync(join(workerDir(x.home, 'trip'), 'nonce'), nonce)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    expect(x.reaps).toEqual([nonce])
    expect(existsSync(join(workerDir(x.home, 'trip'), 'nonce'))).toBe(false) // the file is still released
  })
  it('a session found gone while quiet reaps nothing', async () => {
    const x = setup(SAVED)
    writeFileSync(
      workersJsonPath(x.home),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: '2026-11-10T11:59:00.000Z' },
        threads: {
          trip: {
            state: 'live',
            session_id: '11111111-2222-3333-4444-999999999999',
            tmux: 't-trip',
            pane_pid: 5001,
            cwd: '/home/alex/trip',
          },
        },
      }),
    )
    mkdirSync(workerDir(x.home, 'trip'), { recursive: true })
    writeFileSync(join(workerDir(x.home, 'trip'), 'nonce'), 'cd'.repeat(16))
    await x.tick()
    expect(x.reaps).toEqual([])
  })
  it('a reap that fails changes nothing else: parked, said, and the next start still runs the turn', async () => {
    const x = setup({ ...SAVED, reapFails: true })
    await live(x)
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    expect(x.events()).toContain('worker_reap_failed')
    await startAgain(x)
    expect(x.plans[1]).toMatchObject({ resumeTurn: true })
  })
  it('the nonce travels with the record: a supervisor restart between the crash and the start loses nothing', async () => {
    const x = setup(SAVED)
    await live(x)
    const nonce = x.plans[0]?.nonce as string
    await inTurn(x)
    x.host().exit(1)
    await x.tick(6)
    const rec = JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8')).threads.trip
    expect(rec.cut_turn_nonce).toBe(nonce)
  })
})

describe('a turn that crashes its own session again is not run a second time in a row (review fix 1)', () => {
  const SAVED = { saved: () => true }
  const lastPlan = (x: ReturnType<typeof setup>) => x.plans[x.plans.length - 1]
  const inTurn = async (x: ReturnType<typeof setup>) => {
    x.host().output = x.wall()
    await x.tick()
  }
  const startAgain = async (x: ReturnType<typeof setup>) => {
    await x.m.start('trip')
    x.ready()
    await x.tick()
  }
  const quiet = async (x: ReturnType<typeof setup>) => {
    await x.tick(WORKER_TIMING.busy_window_s + 2)
    await x.tick()
  }
  it('the re-run crashes the session before it ends: the next start does not run it again', async () => {
    const x = setup(SAVED)
    await live(x)
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    await startAgain(x)
    expect(lastPlan(x)?.resumeTurn).toBe(true) // the one automatic re-run
    await inTurn(x) // the re-run is working...
    x.host().exit(1) // ...and kills the session again
    await x.tick()
    await startAgain(x)
    expect(lastPlan(x)).toMatchObject({ resume: true })
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
  })
  it('the re-run finishes, a new turn starts and crashes: that one is cut and runs again', async () => {
    const x = setup(SAVED)
    await live(x)
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    await startAgain(x)
    await inTurn(x)
    await quiet(x) // the re-run is over
    await inTurn(x) // a new turn
    x.host().exit(1)
    await x.tick()
    await startAgain(x)
    expect(lastPlan(x)?.resumeTurn).toBe(true)
  })
  it('a session that crashed in a re-run and was found gone by the next supervisor is not cut either', async () => {
    const x = setup(SAVED)
    await live(x)
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    await startAgain(x)
    await inTurn(x)
    await x.tick(6) // published: the flag is in workers.json
    const y = setup({ ...SAVED, home: x.home })
    // y finds the pane gone (its own fake host has nothing running)
    await y.tick()
    await y.tick()
    await y.m.start('trip')
    y.ready()
    await y.tick()
    expect(lastPlan(y)?.resumeTurn).toBeFalsy()
  })
  it('a restart’s cut does not count as a new turn either: it is a re-run in a row', async () => {
    const x = setup(SAVED)
    await live(x)
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    await startAgain(x)
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    expect(x.events().filter((e) => e === 'worker_turn_cut')).toHaveLength(1) // the second crash recorded nothing
  })
})

describe('a cut time in the future, and an Esc the owner pressed (review fixes 5 and 6)', () => {
  const SAVED = { saved: () => true }
  const lastPlan = (x: ReturnType<typeof setup>) => x.plans[x.plans.length - 1]
  const inTurn = async (x: ReturnType<typeof setup>) => {
    x.host().output = x.wall()
    await x.tick()
  }
  const startAgain = async (x: ReturnType<typeof setup>) => {
    await x.m.start('trip')
    x.ready()
    await x.tick()
  }
  const quiet = async (x: ReturnType<typeof setup>) => {
    await x.tick(WORKER_TIMING.busy_window_s + 2)
    await x.tick()
  }
  // the line Claude Code draws after Esc, as a real capture has it (real-2.1.318/after-esc.txt)
  const ESC_LINE = readFileSync(
    join(import.meta.dir, '../../../desktop/Tests/Fixtures/real-2.1.318/after-esc.txt'),
    'utf8',
  )
    .split('\n')
    .find((l) => l.includes('Interrupted · What should Claude do instead?')) as string
  it('the captured line is the one this test thinks it is', () => {
    // the capture has a no-break space after the corner: whitespace is compared as one space
    expect(ESC_LINE.replace(/\s+/g, ' ').trim()).toBe('⎿ Interrupted · What should Claude do instead?')
  })
  describe('the clock stepped back (a cut time in the future)', () => {
    const crash = async (x: ReturnType<typeof setup>) => {
      await live(x)
      await inTurn(x)
      x.host().exit(1)
      await x.tick()
    }
    it('a start a minute before the cut still asks for the turn', async () => {
      const x = setup(SAVED)
      await crash(x)
      x.jumpWall(-60_000)
      await startAgain(x)
      expect(lastPlan(x)?.resumeTurn).toBe(true)
    })
    it('a start more than a minute before it does not: the cut time cannot be trusted', async () => {
      const x = setup(SAVED)
      await crash(x)
      x.jumpWall(-60_001)
      await startAgain(x)
      expect(lastPlan(x)).toMatchObject({ resume: true })
      expect(lastPlan(x)?.resumeTurn).toBeFalsy()
    })
  })
  describe('Esc, then a crash within busy_window_s', () => {
    it('the interrupt line shows after the turn began: the owner ended it, so no cut', async () => {
      const x = setup(SAVED)
      await live(x)
      await inTurn(x)
      x.host().history = ESC_LINE // Esc: the line is drawn, and the pane stays busy for the window
      await inTurn(x)
      x.host().exit(1)
      await x.tick()
      await startAgain(x)
      expect(lastPlan(x)).toMatchObject({ resume: true })
      expect(lastPlan(x)?.resumeTurn).toBeFalsy()
    })
    it('an interrupt line that was on the screen before the turn is an old Esc: a crash in this turn is a cut', async () => {
      const x = setup(SAVED)
      await live(x)
      x.host().history = ESC_LINE // already there when the turn begins
      await x.tick()
      await inTurn(x)
      x.host().exit(1)
      await x.tick()
      await startAgain(x)
      expect(lastPlan(x)?.resumeTurn).toBe(true)
    })
    it('Esc, then a new turn after the pane went quiet, then a crash: that new turn is cut', async () => {
      const x = setup(SAVED)
      await live(x)
      await inTurn(x)
      x.host().history = ESC_LINE
      await inTurn(x)
      await quiet(x)
      await inTurn(x) // a new turn
      x.host().exit(1)
      await x.tick()
      await startAgain(x)
      expect(lastPlan(x)?.resumeTurn).toBe(true)
    })
  })
})

describe('the reap only ends what the cut turn started (review fixes 3 and 4)', () => {
  const SAVED = { saved: () => true }
  const inTurn = async (x: ReturnType<typeof setup>) => {
    x.host().output = x.wall()
    await x.tick()
  }
  const NONCE = 'cd'.repeat(16)
  const gone = (x: ReturnType<typeof setup>, over: Record<string, unknown>) =>
    writeFileSync(
      workersJsonPath(x.home),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: '2026-11-10T11:59:00.000Z' },
        threads: {
          trip: {
            state: 'busy',
            session_id: '11111111-2222-3333-4444-999999999999',
            tmux: 't-trip',
            pane_pid: 5001,
            cwd: '/home/alex/trip',
            ...over,
          },
        },
      }),
    )
  it('a crash: the reap is bounded by the last quiet look before the turn began (nothing of an earlier turn is in it)', async () => {
    const x = setup(SAVED)
    await live(x)
    await x.tick(5)
    const quietAt = x.boot() // the last look before the turn: the pane was quiet (boot time, ms)
    await inTurn(x)
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    expect(x.reaps).toHaveLength(1)
    expect(x.reapFroms).toEqual([quietAt])
  })
  it('the bound is kept in the record, so a supervisor restart loses nothing', async () => {
    const x = setup(SAVED)
    await live(x)
    await x.tick(5)
    const quietAt = x.boot()
    await inTurn(x)
    x.host().exit(1)
    await x.tick(6)
    const rec = JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8')).threads.trip
    expect(rec.cut_turn_from_boot).toBe(quietAt)
  })
  it('a turn the supervisor typed in: its own start time bounds the reap', async () => {
    const x = setup(SAVED)
    const started = '2026-11-10T11:58:00.000Z'
    const nonce = NONCE
    gone(x, { state: 'live', turn_started_at: started })
    mkdirSync(workerDir(x.home, 'trip'), { recursive: true })
    writeFileSync(join(workerDir(x.home, 'trip'), 'nonce'), nonce)
    await x.tick()
    expect(x.reaps).toEqual([nonce])
    expect(x.reapFroms).toEqual([x.boot() - (x.wall() - Date.parse(started))]) // the wall start, put on the boot clock as of now
  })
  it('a turn whose start is not known at all reaps nothing: it cannot be told from an earlier turn’s', async () => {
    const x = setup(SAVED)
    gone(x, { state: 'busy' }) // owner-typed, and the last supervisor kept no start for it
    mkdirSync(workerDir(x.home, 'trip'), { recursive: true })
    writeFileSync(join(workerDir(x.home, 'trip'), 'nonce'), NONCE)
    await x.tick()
    expect(x.reaps).toEqual([])
    expect(x.events()).toContain('worker_reap_skipped')
  })
  it('found gone after a restart that was waiting for the turn (parking, owner-typed turn): the cut it kept is reaped', async () => {
    const x = setup(SAVED)
    const from = 49_000_000 // boot ms
    gone(x, {
      state: 'parking',
      cut_turn_session: '11111111-2222-3333-4444-999999999999',
      cut_turn_at: '2026-11-10T11:58:30.000Z',
      cut_turn_nonce: NONCE,
      cut_turn_from_boot: from,
    })
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    expect(x.reaps).toEqual([NONCE])
    expect(x.reapFroms).toEqual([from])
    await x.m.start('trip')
    x.ready()
    await x.tick()
    expect(x.plans[x.plans.length - 1]).toMatchObject({ resumeTurn: true, reapsSoFar: 1 })
  })
  it('the owner’s stop of it (ending off) is not reaped, whatever record there was', async () => {
    const x = setup(SAVED)
    gone(x, {
      state: 'stopping',
      cut_turn_session: '11111111-2222-3333-4444-999999999999',
      cut_turn_at: '2026-11-10T11:58:30.000Z',
      cut_turn_nonce: NONCE,
      cut_turn_from_boot: 49_000_000,
      turn_wait_end: 'off',
    })
    await x.tick()
    expect(x.reaps).toEqual([])
  })
})

describe('the poison guard survives the pointer that starts the session, and does not stick (round 2, fixes 1 and 2)', () => {
  const SAVED = { saved: () => true }
  const lastPlan = (x: ReturnType<typeof setup>) => x.plans[x.plans.length - 1]
  const inTurn = async (x: ReturnType<typeof setup>) => {
    x.host().output = x.wall()
    await x.tick()
  }
  const pointerWake = (x: ReturnType<typeof setup>) =>
    writeWake(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: ['m_01HZZZZZZZZZZZZZZZZZZZZZZZ'],
      at: new Date(x.wall()).toISOString(),
      reason: 'message',
      action: 'pointer',
    })
  const startAgain = async (x: ReturnType<typeof setup>) => {
    await x.m.start('trip')
    x.ready()
    await x.tick()
  }
  /** A cut turn, then a start for a pointer: the re-run is under way and the pointer is typed on the first live tick. */
  const crashThenPointerStart = async (x: ReturnType<typeof setup>) => {
    await live(x)
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    pointerWake(x)
    await x.tick(1)
    expect(x.m.state('trip')).toBe('starting')
    expect(lastPlan(x)).toMatchObject({ resume: true, resumeTurn: true })
    x.ready()
  }
  it('crash mid-turn, a pointer wake starts with the re-run, the pointer is typed while the re-run works, crash again: no second re-run', async () => {
    const x = setup(SAVED)
    await crashThenPointerStart(x)
    await inTurn(x) // live, and the re-run is drawing
    await inTurn(x) // the pointer is typed in
    expect(x.host().submitted).toEqual([WORKER_POINTER_TEXT])
    expect(x.m.entry('trip')?.turn_started_at).toBeDefined() // the pointer began a turn
    await inTurn(x)
    x.host().exit(1) // the re-run (and the pointer) crash it again
    await x.tick()
    await startAgain(x)
    expect(lastPlan(x)).toMatchObject({ resume: true })
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
  })
  it('the re-run and the pointer’s turn end, then a real turn crashes: that one is cut', async () => {
    const x = setup(SAVED)
    await crashThenPointerStart(x)
    await inTurn(x)
    await inTurn(x)
    await x.tick(WORKER_TIMING.busy_window_s + 2) // quiet: both are over
    await x.tick()
    await inTurn(x) // a new turn
    x.host().exit(1)
    await x.tick()
    await startAgain(x)
    expect(lastPlan(x)?.resumeTurn).toBe(true)
  })
  it('the resume re-ran nothing (the pane is never busy): after a quiet window the guard is gone, and a real turn that crashes is cut', async () => {
    const x = setup(SAVED)
    await live(x)
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    await startAgain(x) // resumeTurn, but nothing re-runs
    expect(lastPlan(x)?.resumeTurn).toBe(true)
    await x.tick() // the first quiet look
    await x.tick(WORKER_TIMING.busy_window_s + 2) // and one a window later
    await x.tick()
    await inTurn(x) // the owner's own turn
    x.host().exit(1)
    await x.tick()
    await startAgain(x)
    expect(lastPlan(x)?.resumeTurn).toBe(true)
  })
  it('a quiet look or two before the re-run draws does not drop the guard', async () => {
    const x = setup(SAVED)
    await live(x)
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    await startAgain(x)
    await x.tick() // a quiet look: the re-run has not drawn yet
    await inTurn(x) // now it does
    x.host().exit(1)
    await x.tick()
    await startAgain(x)
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
  })
})

describe('the reap’s bound is on the boot clock, and holds through a prompt (round 2, fixes 3 and 4)', () => {
  const SAVED = { saved: () => true }
  const inTurn = async (x: ReturnType<typeof setup>) => {
    x.host().output = x.wall()
    await x.tick()
  }
  const TRUST = parseCapture(
    readFileSync(
      join(import.meta.dir, '../../../desktop/Tests/Fixtures/real-2.1.319/needs-you-capture/01-trust-first.txt'),
      'utf8',
    ),
  )
  const ESC_LINE = readFileSync(
    join(import.meta.dir, '../../../desktop/Tests/Fixtures/real-2.1.318/after-esc.txt'),
    'utf8',
  )
    .split('\n')
    .find((l) => l.includes('Interrupted · What should Claude do instead?')) as string
  it('a step of the wall clock (a host resume) during the turn does not move the bound', async () => {
    const x = setup(SAVED)
    await live(x)
    await x.tick(5)
    const quietAt = x.boot()
    await inTurn(x)
    x.jumpWall(3_600_000) // WSL's wall clock steps an hour
    await inTurn(x)
    x.jumpWall(-7_200_000) // and back past where it was
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    expect(x.reapFroms).toEqual([quietAt])
  })
  it('a turn that waits at a prompt keeps its start: tools started before the prompt are still in the bound', async () => {
    const x = setup(SAVED)
    await live(x)
    await x.tick(5)
    const quietAt = x.boot()
    await inTurn(x)
    await inTurn(x) // a tool is started here
    x.host().screen = TRUST // a prompt: the pane goes quiet for as long as it takes to answer
    for (let i = 0; i < WORKER_TIMING.busy_window_s + WORKER_TIMING.dialog_settle_s + 4; i++) await x.tick() // many quiet looks, the prompt flagged by the middle of them
    x.host().screen = null // answered
    await inTurn(x)
    x.host().exit(1)
    await x.tick()
    expect(x.reapFroms).toEqual([quietAt])
  })
  it('a turn that really ended (quiet, nothing waiting on the owner) starts a new bound with the next one', async () => {
    const x = setup(SAVED)
    await live(x)
    await inTurn(x)
    for (let i = 0; i < WORKER_TIMING.busy_window_s + WORKER_TIMING.dialog_settle_s + 4; i++) await x.tick() // quiet and nothing on the screen: it ended
    await x.tick(5)
    const quietAt = x.boot()
    await inTurn(x) // the next turn
    x.host().exit(1)
    await x.tick()
    expect(x.reapFroms).toEqual([quietAt])
  })
  it('Esc ends the turn: the next one has a bound of its own', async () => {
    const x = setup(SAVED)
    await live(x)
    await inTurn(x)
    x.host().history = ESC_LINE
    await inTurn(x)
    await x.tick(WORKER_TIMING.busy_window_s + 2) // quiet after the Esc
    const quietAt = x.boot()
    await inTurn(x) // a new turn
    x.host().exit(1)
    await x.tick()
    expect(x.reapFroms).toEqual([quietAt])
  })
  it('a turn the supervisor typed in, found gone: its own start is put on the boot clock, and the stored boot bound wins when there is one', async () => {
    const x = setup(SAVED)
    writeFileSync(
      workersJsonPath(x.home),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: '2026-11-10T11:59:00.000Z' },
        threads: {
          trip: {
            state: 'busy',
            session_id: '11111111-2222-3333-4444-999999999999',
            tmux: 't-trip',
            pane_pid: 5001,
            cwd: '/home/alex/trip',
            turn_from_boot: 49_500_000,
          },
        },
      }),
    )
    mkdirSync(workerDir(x.home, 'trip'), { recursive: true })
    writeFileSync(join(workerDir(x.home, 'trip'), 'nonce'), 'cd'.repeat(16))
    await x.tick()
    expect(x.reapFroms).toEqual([49_500_000])
  })
})

describe('the Esc line is read at Claude’s own indent, and a new prompt clears it (round 2, fix 5)', () => {
  const SAVED = { saved: () => true }
  const lastPlan = (x: ReturnType<typeof setup>) => x.plans[x.plans.length - 1]
  const inTurn = async (x: ReturnType<typeof setup>) => {
    x.host().output = x.wall()
    await x.tick()
  }
  const startAgain = async (x: ReturnType<typeof setup>) => {
    await x.m.start('trip')
    x.ready()
    await x.tick()
  }
  const ESC_LINE = readFileSync(
    join(import.meta.dir, '../../../desktop/Tests/Fixtures/real-2.1.318/after-esc.txt'),
    'utf8',
  )
    .split('\n')
    .find((l) => l.includes('Interrupted · What should Claude do instead?')) as string
  const HINT = '⏸ manual mode on · esc to interrupt'
  const crashed = async (x: ReturnType<typeof setup>) => {
    x.host().exit(1)
    await x.tick()
    await startAgain(x)
  }
  it('the real line, at the indent Claude draws it, is the one that counts (a sanity check on the capture)', () => {
    expect(ESC_LINE.startsWith('  ⎿')).toBe(true)
  })
  it('tool output that prints the line (deeper indent, a prefix, or more text after it) is not an Esc: the crash is a cut', async () => {
    for (const printed of [
      `   ${ESC_LINE}`, // nested deeper: a tool's output block
      `  ⎿  echo "${ESC_LINE.trim()}"`, // a command that echoes it
      `  ⏺ ${ESC_LINE.trim()}`, // Claude quoting it
      `${ESC_LINE} (that is what it printed)`, // more text after
    ]) {
      const x = setup(SAVED)
      await live(x)
      await inTurn(x)
      x.host().history = printed
      await inTurn(x)
      await crashed(x)
      expect(lastPlan(x)?.resumeTurn).toBe(true)
    }
  })
  it('Esc, then a new prompt inside the busy window (a fresh "esc to interrupt"), then a crash: the new turn is cut', async () => {
    const x = setup(SAVED)
    await live(x)
    x.host().status = HINT
    await inTurn(x) // a turn is running
    x.host().history = ESC_LINE // Esc
    x.host().status = '⏸ manual mode on'
    await inTurn(x) // the pane is still busy for the window
    x.host().status = HINT // a new prompt is submitted: the spinner is back
    await inTurn(x)
    await crashed(x)
    expect(lastPlan(x)?.resumeTurn).toBe(true)
  })
  it('Esc with no new spinner after it still means the owner ended the turn: no cut', async () => {
    const x = setup(SAVED)
    await live(x)
    x.host().status = HINT
    await inTurn(x)
    x.host().history = ESC_LINE
    x.host().status = '⏸ manual mode on'
    await inTurn(x)
    await inTurn(x)
    await crashed(x)
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
  })
  it('the spinner and the Esc line in the same look: the Esc counts (it came after the turn began)', async () => {
    const x = setup(SAVED)
    await live(x)
    await inTurn(x)
    x.host().history = ESC_LINE
    x.host().status = HINT // the footer has not caught up yet
    await inTurn(x)
    await crashed(x)
    expect(lastPlan(x)?.resumeTurn).toBeFalsy()
  })
})

describe('a usage limit never starts a session, and an owner’s stop at a limit sticks (continue-at-limit; Claude Code’s timer lives in its own process)', () => {
  const SRC = join(import.meta.dir, '../../src')
  const LIMIT_SCREEN = parseCapture(
    readFileSync(join(import.meta.dir, '../../../desktop/Tests/Fixtures/synthetic/usage-limit.txt'), 'utf8'),
  )
  const NAMED = [{ ...TRIP, name: 'Trip' }]
  const ticks = async (x: ReturnType<typeof setup>, n: number, s = 1) => {
    for (let i = 0; i < n; i++) await x.tick(s)
  }
  const HOUR = 3600
  const entry = (x: ReturnType<typeof setup>) =>
    JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8')).threads.trip as Record<string, unknown>
  /** A day and a bit of fake clock, an hour at a time: past any reset the usage-limit screen could name. */
  const pastEveryReset = (x: ReturnType<typeof setup>) => ticks(x, 26, HOUR)

  it('the only readers of a usage-limit reset moment are display, status and refusal code: none of them starts a session', () => {
    const readers = (dir: string): string[] => {
      const out: string[] = []
      for (const f of readdirSync(join(SRC, dir)))
        if (
          f.endsWith('.ts') &&
          /needsYouResetsAt|usageNeedsYou|resetsAt\(|\.resets_at/.test(readFileSync(join(SRC, dir, f), 'utf8'))
        )
          out.push(`${dir}/${f}`)
      return out
    }
    const found = [...readers('supervisor'), ...readers('router')].sort()
    // a new reader here must be read for "does it start a session?" before it is added to this list
    expect(found).toEqual([
      'router/governor.ts',
      'router/router.ts',
      'router/status-line.ts',
      'supervisor/limit-wait.ts', // the park skip: the reset the wait notice names, kept to bound the skip; it ends nothing and starts nothing
      'supervisor/main-request.ts',
      'supervisor/main.ts', // Main's own needs_you; a usage menu there only HOLDS Main's hang restart (main.ts)
      'supervisor/usage-limit.ts',
      'supervisor/worker-notices.ts',
      'supervisor/worker-status.ts',
    ])
    // and the files that start, wake or restart a session do not read it at all
    for (const f of [
      'workers.ts',
      'worker-slots.ts',
      'worker-launch.ts',
      'workers-wiring.ts',
      'owed-pointer.ts',
      'wake-reader.ts',
    ])
      expect(readFileSync(join(SRC, 'supervisor', f), 'utf8'), f).not.toMatch(
        /needsYouResetsAt|usageNeedsYou|resetsAt\b|resets_at|readUsageLimit/,
      )
  })

  it('a parked (idle), an owner-stopped and a switched-off thread session is never started by time passing, a limit screen or not', async () => {
    // idle-parked
    const a = setup()
    await live(a)
    await a.m.park('trip', 'idle')
    a.host().exit(0)
    await a.tick()
    expect(a.m.state('trip')).toBe('parked')
    await pastEveryReset(a)
    expect([a.m.state('trip'), a.host().launches.length]).toEqual(['parked', 1])
    // owner-stopped
    const b = setup()
    await live(b)
    await b.m.stop('trip')
    b.host().exit(0)
    await b.tick()
    expect(b.m.entry('trip')).toMatchObject({ state: 'off', stopped_why: 'owner' })
    await pastEveryReset(b)
    expect([b.m.state('trip'), b.host().launches.length]).toEqual(['off', 1])
    // the thread left the dedicated list (archived, or switched back to shared): its session is parked, never started again
    const list: WorkerThread[] = [TRIP]
    const c = setup({ threads: list })
    await live(c)
    list.length = 0
    await c.tick()
    c.host().exit(0)
    await c.tick()
    await pastEveryReset(c)
    expect(c.host().launches.length).toBe(1)
    expect(['parked', 'off']).toContain(c.m.state('trip'))
  })

  it('an archived thread is not a dedicated thread at all, so it has no session to continue', () => {
    const raw = (archived: boolean) => ({
      default_thread: 'general',
      dedicated: { enabled: true },
      threads: [
        { id: 'general', kind: 'fixed' },
        {
          id: 'trip',
          kind: 'user',
          session: 'dedicated',
          session_opts: { cwd: '/home/alex/trip' },
          ...(archived ? { archived: true } : {}),
        },
      ],
    })
    expect(dedicatedThreads(raw(false), '/agent')?.map((t) => t.id)).toEqual(['trip'])
    expect(dedicatedThreads(raw(true), '/agent')?.map((t) => t.id)).toEqual([])
  })

  it('the owner stops a session that sits on the usage-limit screen: it is killed (Claude Code’s timer goes with it) and nothing restarts it at the reset', async () => {
    const x = setup({ threads: NAMED })
    await live(x)
    x.host().screen = LIMIT_SCREEN
    await ticks(x, WORKER_TIMING.dialog_settle_s + 2)
    const needs = entry(x).needs_you as { kind: string; resets_at?: string }
    expect(needs.kind).toBe('usage limit')
    const resetAt = Date.parse(needs.resets_at ?? '')
    expect(resetAt).toBeGreaterThan(x.wall())
    await x.m.stop('trip')
    await ticks(x, WORKER_TIMING.owner_stop_s + 2)
    expect(x.host().signals).toContain('SIGTERM') // the process (and the timer in it) is told to end
    x.host().exit(0, 15)
    await x.tick()
    expect(x.m.entry('trip')).toMatchObject({ state: 'off', stopped_why: 'owner' })
    // the reset passes, and a day after it: still off, one launch ever
    while (x.wall() < resetAt + 25 * HOUR * 1000) await x.tick(HOUR)
    expect([x.m.state('trip'), x.host().launches.length]).toEqual(['off', 1])
    expect(x.posts.every(([, text]) => !/resumed|continu(ed|ing) the session/i.test(text))).toBe(true)
  })

  it('what the idle park does today at a limit: on the screen it waits on the owner and is never parked; with no screen (Claude Code waiting by itself) it is parked at idle_park_min, which ends Claude Code’s wait', async () => {
    const quick: WorkerThread = { ...TRIP, idleParkMin: 5 }
    // (a) the usage-limit screen is up: needs_you holds the park, however long it sits
    const a = setup({ threads: [{ ...quick, name: 'Trip' }] })
    await live(a)
    a.host().screen = LIMIT_SCREEN
    await ticks(a, WORKER_TIMING.dialog_settle_s + 2)
    await ticks(a, 12, 60)
    expect(a.m.state('trip')).toBe('live')
    // (b) Claude Code armed its own wait: no menu, a quiet idle pane. Talos cannot tell it from any quiet session
    const b = setup({ threads: [quick] })
    await live(b)
    await ticks(b, 12, 60)
    expect(['parking', 'parked']).toContain(b.m.state('trip'))
    expect(b.audit.some(([e, f]) => e === 'worker_parked' && f?.why === 'idle')).toBe(true)
  })

  it('a session killed while it waited at a limit is not a cut turn: its next start carries no resume-the-turn variables (so no second run beside Claude Code’s own continue)', async () => {
    const x = setup({ threads: NAMED, saved: () => true })
    await live(x)
    x.host().screen = LIMIT_SCREEN
    await ticks(x, WORKER_TIMING.dialog_settle_s + 2)
    x.host().screen = null
    x.host().exit(1) // killed or crashed while quiet at the limit
    await x.tick()
    expect(x.m.state('trip')).toBe('parked')
    await x.m.start('trip')
    expect(x.plans[x.plans.length - 1]?.resumeTurn).toBeFalsy()
  })
})

describe('the park skip: while Claude Code’s own wait at a usage limit shows, nothing automatic ends the session', () => {
  const QUICK: WorkerThread = { ...TRIP, idleParkMin: 5 }
  const H = 3600
  const RULE = '─'.repeat(110)
  /** Claude's box and status row, then (optionally) the wait notice under them; `above` is conversation. */
  const screenWith = (notice: string | null, above: string[] = []) => [
    '',
    '❯ Run the gate and tell me what failed.',
    '',
    ...above,
    "  You've hit your Fable limit · resets 4pm",
    '',
    RULE,
    '❯ ',
    RULE,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ...(notice === null ? [] : [`  ${notice}`]),
  ]
  /** The wait's clock text for a moment, as Claude Code draws it (en-US, lower case am/pm, no space), in this zone. */
  const clockIn = (ms: number) => {
    const d = new Date(ms)
    const h = d.getHours()
    const min = d.getMinutes()
    return `${h % 12 === 0 ? 12 : h % 12}${min === 0 ? '' : `:${String(min).padStart(2, '0')}`}${h >= 12 ? 'pm' : 'am'}`
  }
  const at = (ms: number) => `Continuing automatically at ${clockIn(ms)} · Esc to cancel`
  const UNKNOWN_RESET = 'Continuing automatically when it resets · Esc to cancel'
  const steps = async (x: ReturnType<typeof setup>, n: number, s: number) => {
    for (let i = 0; i < n; i++) await x.tick(s)
  }
  const entryOf = (x: ReturnType<typeof setup>) =>
    JSON.parse(readFileSync(workersJsonPath(x.home), 'utf8')).threads.trip as Record<string, unknown>
  const parkedIdle = (x: ReturnType<typeof setup>) =>
    x.audit.some(([e, f]) => e === 'worker_parked' && f?.why === 'idle')
  const governorPark = (x: ReturnType<typeof setup>) =>
    writeControl(x.home, {
      v: 1,
      thread_id: 'trip',
      message_ids: [],
      at: new Date(x.wall()).toISOString(),
      reason: 'governor',
      action: 'park',
    })

  it('the notice blocks the idle park, however long it sits (inside the skip); the same quiet pane without it parks', async () => {
    const a = setup({ threads: [QUICK] })
    await live(a)
    a.host().screen = screenWith(UNKNOWN_RESET)
    await steps(a, 8, 600) // 80 minutes, far past idle_park_min
    expect(a.m.state('trip')).toBe('live')
    expect(parkedIdle(a)).toBe(false)
    expect(entryOf(a).limit_wait).toMatchObject({ since: expect.any(String) })
    const b = setup({ threads: [QUICK] })
    await live(b)
    b.host().screen = screenWith(null)
    await steps(b, 8, 600)
    expect(['parking', 'parked']).toContain(b.m.state('trip'))
    expect(parkedIdle(b)).toBe(true)
  })

  it('the notice blocks the governor’s park; without it the governor parks', async () => {
    const a = setup({ threads: [QUICK] })
    await live(a)
    a.host().screen = screenWith(UNKNOWN_RESET)
    await a.tick(2)
    governorPark(a)
    await steps(a, 3, 5)
    expect(a.m.state('trip')).toBe('live')
    expect(a.audit.some(([e, f]) => e === 'worker_park_skipped' && f?.why === 'limit_wait')).toBe(true)
    const b = setup({ threads: [QUICK] })
    await live(b)
    b.host().screen = screenWith(null)
    await b.tick(2)
    governorPark(b)
    await steps(b, 3, 5)
    expect(['stopping', 'parking', 'parked']).toContain(b.m.state('trip'))
  })

  it('an owner’s stop or park still ends it at once, notice or not', async () => {
    const a = setup({ threads: [QUICK] })
    await live(a)
    a.host().screen = screenWith(UNKNOWN_RESET)
    await a.tick(2)
    await a.m.stop('trip')
    await steps(a, WORKER_TIMING.owner_stop_s + 2, 1)
    expect(a.host().signals).toContain('SIGTERM')
    a.host().exit(0, 15)
    await a.tick()
    expect(a.m.entry('trip')).toMatchObject({ state: 'off', stopped_why: 'owner' })
    expect(entryOf(a).limit_wait).toBeUndefined()
    const b = setup({ threads: [QUICK] })
    await live(b)
    b.host().screen = screenWith(UNKNOWN_RESET)
    await b.tick(2)
    await b.m.park('trip', 'owner')
    await steps(b, 3, 1)
    expect(['stopping', 'parking', 'parked']).toContain(b.m.state('trip'))
  })

  it('the skip ends at the reset plus 15 minutes, notice still showing', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    const reset = x.wall() + 60 * 60_000 // an hour from now
    x.host().screen = screenWith(at(reset))
    await x.tick(2)
    await steps(x, 6, 600) // 62 minutes in: the reset has passed, the 15 minutes have not
    expect(x.m.state('trip')).toBe('live')
    await steps(x, 1, 600) // 72 minutes
    expect(x.m.state('trip')).toBe('live')
    await steps(x, 2, 600) // 92 minutes: past the reset plus 15 minutes
    expect(['parking', 'parked']).toContain(x.m.state('trip'))
    expect(parkedIdle(x)).toBe(true)
  })

  it('the skip ends 6 hours after the notice first showed, even when it still shows (no reset to read, or one a day away)', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    x.host().screen = screenWith(UNKNOWN_RESET)
    await x.tick(2)
    await steps(x, 5, H) // five hours
    expect(x.m.state('trip')).toBe('live')
    await steps(x, 2, H) // seven hours
    expect(['parking', 'parked']).toContain(x.m.state('trip'))
    const y = setup({ threads: [QUICK] })
    await live(y)
    y.host().screen = screenWith(at(y.wall() + 20 * H * 1000))
    await y.tick(2)
    await steps(y, 5, H)
    expect(y.m.state('trip')).toBe('live')
    await steps(y, 2, H)
    expect(['parking', 'parked']).toContain(y.m.state('trip'))
  })

  it('a quoted copy of the notice in the conversation holds nothing', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    x.host().screen = screenWith(null, ['⏺ Bash(echo hi)', `  ⎿  ${UNKNOWN_RESET}`, `  ${at(x.wall() + H * 1000)}`])
    await steps(x, 8, 600)
    expect(['parking', 'parked']).toContain(x.m.state('trip'))
    expect(parkedIdle(x)).toBe(true)
    expect(entryOf(x).limit_wait).toBeUndefined()
  })

  it('the notice going away clears the skip: a quiet session then parks as before', async () => {
    const x = setup({ threads: [QUICK] })
    await live(x)
    x.host().screen = screenWith(UNKNOWN_RESET)
    await x.tick(2)
    expect(entryOf(x).limit_wait).toBeDefined()
    x.host().screen = screenWith(null)
    await steps(x, 3, 1) // gone for longer than a torn frame
    expect(entryOf(x).limit_wait).toBeUndefined()
    await x.tick(H)
    expect(['parking', 'parked']).toContain(x.m.state('trip'))
  })

  it('the skip survives a supervisor restart: the first time the notice showed is kept in the session’s own fields', async () => {
    const x = setup()
    await live(x)
    await x.tick(1000) // the notice first shows well after the start
    x.host().screen = screenWith(UNKNOWN_RESET)
    await x.tick(2)
    const since = (entryOf(x).limit_wait as { since: string }).since
    expect(Date.parse(since)).toBeGreaterThan(x.wall() - 10_000)
    // another supervisor on the same home and the same pane, five hours after the notice first showed
    const y = setup()
    // its wall clock runs with its ticks (no jump), starting five hours after the first time
    let shift = Date.parse(since) + 5 * H * 1000 - y.wall()
    ;(y.m as unknown as { d: { home: string; wallMs: () => number } }).d.home = x.home
    ;(y.m as unknown as { d: { wallMs: () => number } }).d.wallMs = () => y.wall() + shift
    const h = new FakeHost(() => 9100)
    h.pid = x.host().pid
    h.running = true
    h.screen = screenWith(UNKNOWN_RESET)
    y.hosts.set('trip', h)
    await y.tick()
    await steps(y, 40, 60) // far past the default idle_park_min (30 minutes) on its own clock: the skip still holds it
    expect(y.m.state('trip')).toBe('live')
    // its looks kept the first-seen time (a fresh first-seen would hold the session another 6 hours)
    expect((y.m.entry('trip') as unknown as { limit_wait?: { since: string } }).limit_wait?.since).toBe(since)
    shift += 2 * H * 1000 // now seven hours after the FIRST time: over, though the notice still shows
    await steps(y, 40, 60) // the wall clock's jump makes it active once; then a whole idle window passes
    expect(['parking', 'parked']).toContain(y.m.state('trip'))
  })
})
