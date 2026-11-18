// Main's lifecycle on a fake terminal host and a fake clock. The "agent" is a real process in its own group (so the group
// signalling is real), and its exit is reported the way the tmux host reports one.
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type {
  MainLaunchConfig,
  MainStatus,
  PtyDialogKey,
  PtyExit,
  PtyHost,
  PtyLaunch,
  PtySendResult,
} from '@talos-app/protocol'
import { buildMainEnv } from '../../src/supervisor/launch-env.ts'
import { MainSupervisor } from '../../src/supervisor/main.ts'
import { groupAlive, systemIdentity } from '../../src/supervisor/proc.ts'
import { PtyHostError } from '../../src/supervisor/tmux-host.ts'

const RULE = '─'.repeat(40)
const READY = ['Welcome back', RULE, '❯  ', RULE, '  ? for shortcuts']
const WARNING = readFileSync(
  new URL('../../../desktop/Tests/Fixtures/real-dev-channels/dev-channels-capture.txt', import.meta.url),
  'utf8',
).split('\n')

const children: Array<ReturnType<typeof Bun.spawn>> = []
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
})

/**
 * A real process leading its own group, as a tmux pane's agent does; `ignoreTerm` makes it need the SIGKILL. The plain agent is
 * `sleep` itself, never `sh -c 'sleep 300'`: dash forks that sleep instead of exec'ing it, and a sleep forked as the group's
 * SIGTERM lands can miss it and hold the group open until the SIGKILL deadline, which no test without a clock step reaches.
 */
function agentProcess(ignoreTerm = false): number {
  const c = Bun.spawn(ignoreTerm ? ['sh', '-c', 'trap "" TERM; while :; do sleep 1; done'] : ['sleep', '300'], {
    detached: true,
  } as never)
  children.push(c)
  return c.pid
}

class FakeHost implements PtyHost {
  readonly kind = 'tmux' as const
  launches: Array<{ how: 'start' | 'restart'; launch: PtyLaunch }> = []
  rows: string[] | null = READY
  markers: Record<string, string> = {}
  closed = 0
  attached: number | null = null
  failNext: PtyHostError | null = null
  ignoreTerm = false
  private cb: ((e: PtyExit) => void) | undefined
  pid: number | null = null
  /** When set, the matching call waits until it opens (a slow tmux), to drive the races. */
  rowsGate: Promise<void> | null = null
  restartGate: Promise<void> | null = null
  markerGate: Promise<void> | null = null
  lastOut: number | null = null

  private async run(how: 'start' | 'restart', launch: PtyLaunch): Promise<number> {
    this.launches.push({ how, launch })
    if (this.failNext) {
      const e = this.failNext
      this.failNext = null
      throw e
    }
    if (how === 'restart' && this.restartGate) await this.restartGate
    this.pid = agentProcess(this.ignoreTerm)
    return this.pid
  }
  start(l: PtyLaunch) {
    return this.run('start', l)
  }
  restart(l: PtyLaunch) {
    return this.run('restart', l)
  }
  async attachIfRunning() {
    if (this.attached !== null) this.pid = this.attached
    return this.attached
  }
  async send(): Promise<PtySendResult> {
    return 'sent'
  }
  async sendDialogKey(_k: PtyDialogKey): Promise<PtySendResult> {
    return 'sent'
  }
  async visibleRows() {
    if (this.rowsGate) await this.rowsGate
    return this.rows
  }
  async lastOutputAt() {
    return this.lastOut
  }
  async clientActivities() {
    return []
  }
  async terminate() {}
  async close() {
    this.closed++
  }
  detach() {}
  childPid() {
    return this.pid
  }
  onExit(cb: (e: PtyExit) => void) {
    this.cb = cb
  }
  async setMarker(name: string, v: string) {
    if (this.markerGate) await this.markerGate
    this.markers[name] = v
  }
  async marker(name: string) {
    return this.markers[name] ?? null
  }
  /** The agent exits (the pane is dead) with what it left on screen. */
  exit(over: Partial<PtyExit> = {}) {
    this.cb?.({ pid: this.pid as number, code: 1, signal: null, hostLost: false, lastRows: [], ...over })
  }
}

function gate() {
  let open!: () => void
  const p = new Promise<void>((r) => {
    open = r
  })
  return { p, open }
}

function setup(cfgOver: Partial<MainLaunchConfig> = {}, loginEnv: Record<string, string> = {}) {
  const host = new FakeHost()
  let t = 1000
  const cfg: MainLaunchConfig = {
    agentDir: '/agent',
    claudePath: 'auto',
    args: ['--dangerously-load-development-channels', 'server:talos-app', '--continue'],
    env: {},
    host: 'tmux',
    autoRestart: true,
    autoConfirmRestart: true,
    startOnLaunch: true,
    session: { id: null, previousIds: [] },
    ...cfgOver,
  }
  const audit: string[] = []
  let configError: string | null = null
  const emptyIds = new Set<string>()
  const told: Array<{ kind: string; [k: string]: unknown }> = []
  let seenEnv: Record<string, string> | undefined
  let bridge:
    | {
        mode: string
        pid: number
        updated_at: string
        relay?: { connected: boolean }
        unseen_oldest_at?: string | null
      }
    | undefined
  let claudeThere = true
  let status: MainStatus | undefined
  const sup = new MainSupervisor({
    host,
    identity: systemIdentity,
    session: 'agent',
    config: () => (configError ? { error: configError } : cfg),
    saveSessionId: (id) => {
      cfg.session = { id, previousIds: cfg.session.previousIds }
    },
    loginEnv: () => ({ PATH: '/usr/bin:/bin', HOME: '/home/alex', CLAUDECODE: '1', ...loginEnv }),
    resolveClaude: (p) => (p === 'missing' || !claudeThere ? null : '/usr/bin/claude'),
    isDir: (p) => p === '/agent',
    newSessionId: () => '11111111-2222-3333-4444-555555555555',
    now: () => t,
    wallMs: () => t * 1000,
    random: () => 0,
    publish: (s) => {
      status = s
    },
    audit: (e) => audit.push(e),
    readBridgeStatus: () => bridge,
    sessionSaved: (_dir, id, env) => {
      seenEnv = env
      // a new id this test made has no transcript yet, like 'never-typed'
      return id !== 'never-typed' && !id.startsWith('11111111')
    },
    conversationEmpty: (_dir, id) => emptyIds.has(id),
    tell: (e) => told.push(e as { kind: string }),
    mcpLogReason: () => 'talos-app: Connection closed',
  })
  return {
    host,
    sup,
    cfg,
    audit,
    status: () => status as MainStatus,
    setConfigError: (e: string | null) => {
      configError = e
    },
    emptyIds,
    told,
    seenEnv: () => seenEnv,
    setClaude: (there: boolean) => {
      claudeThere = there
    },
    /** The bridge writes its status: from `pid` (default Main's own, the leader of its group), stamped at clock + `ageS` ago. */
    bridgeWrites: (
      over: Partial<{
        mode: string
        pid: number
        ageS: number
        connected: boolean
        unseenAgoS: number | null
      }> = {},
    ) => {
      bridge = {
        mode: over.mode ?? 'live',
        pid: over.pid ?? (host.pid as number),
        updated_at: new Date((t - (over.ageS ?? 0)) * 1000).toISOString(),
        relay: { connected: over.connected ?? true },
        unseen_oldest_at:
          over.unseenAgoS === undefined || over.unseenAgoS === null
            ? null
            : new Date((t - over.unseenAgoS) * 1000).toISOString(),
      }
    },
    advance: async (s: number) => {
      t += s
      await sup.tick()
    },
    /** The wall clock, in seconds. */
    wallS: () => t,
  }
}

/** Ticks (no time passes) until Main is in `phase`: a cleanup finishes on a tick, as it does in production. */
const settle = async (x: { advance: (s: number) => Promise<void>; status: () => MainStatus }, phase: string) => {
  const end = Date.now() + 5_000
  while (x.status().phase !== phase) {
    if (Date.now() > end) throw new Error(`still ${x.status().phase}, not ${phase}`)
    await x.advance(0)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const until = async (f: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('Main on Linux: starting', () => {
  it('a cold start with no session owns a new id, strips session flags, and gives Main its whole environment', async () => {
    const x = setup()
    await x.sup.start()
    const l = x.host.launches[0]
    expect(l?.how).toBe('start')
    expect(l?.launch.argv).toEqual([
      '/usr/bin/claude',
      '--dangerously-load-development-channels',
      'server:talos-app',
      '--session-id=11111111-2222-3333-4444-555555555555',
    ])
    expect(x.cfg.session.id).toBe('11111111-2222-3333-4444-555555555555')
    expect(l?.launch.env).toMatchObject({
      TALOS_APP_BRIDGE: '1',
      MCP_PROTOCOL_NEGOTIATION: 'legacy',
      PATH: '/usr/bin:/bin',
    })
    expect(l?.launch.env.CLAUDECODE).toBeUndefined() // an inherited marker never reaches Main
    expect(x.host.markers.session).toBe('11111111-2222-3333-4444-555555555555')
    expect(x.status().phase).toBe('starting')
  })
  it('a start with a session resumes it; it is running once the input box is up and the warning has had its time', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    expect(x.host.launches[0]?.launch.argv.slice(-1)).toEqual(['--resume=abc'])
    await x.advance(1)
    expect(x.status().phase).toBe('starting') // the warning could still come
    await x.advance(AUTO_CONFIRM_S)
    expect(x.status().phase).toBe('running')
  })
  it('the warning on screen waits for the owner; a live dialog is named; a start that never settles is reported', async () => {
    const x = setup()
    await x.sup.start()
    x.host.rows = WARNING
    await x.advance(1)
    expect(x.status().needsYou).toEqual({ kind: 'confirm_cold_start' })
    x.host.rows = readFileSync(
      new URL('../../../desktop/Tests/Fixtures/real-2.1.318/trust-dialog.txt', import.meta.url),
      'utf8',
    ).split('\n')
    x.host.lastOut = 1001 * 1000 // it just appeared: an owner at the pane answers it first
    await x.advance(1)
    expect(x.status().needsYou).toBeUndefined()
    await x.advance(60)
    expect(x.status().needsYou).toEqual({ kind: 'dialog', dialog: 'trust' })
    x.host.lastOut = null // tmux could not say: how long the supervisor has seen it counts
    x.host.rows = ['Loading…']
    await x.advance(1)
    expect(x.status().needsYou).toBeUndefined()
    x.host.rows = readFileSync(
      new URL('../../../desktop/Tests/Fixtures/real-2.1.318/mcp-consent.txt', import.meta.url),
      'utf8',
    ).split('\n')
    await x.advance(1)
    expect(x.status().needsYou).toBeUndefined()
    await x.advance(61)
    expect(x.status().needsYou).toEqual({ kind: 'dialog', dialog: 'mcp_consent' })
    x.host.rows = ['Loading…']
    await x.advance(1)
    // the dialog is answered; the start is now past MAIN_START.stall_s without the input box
    expect(x.status().needsYou).toEqual({ kind: 'start_stalled' })
    await x.advance(121)
    expect(x.status().needsYou).toEqual({ kind: 'start_stalled' })
    expect(x.status().phase).toBe('starting')
  })
  it('an unreadable screen raises and clears nothing', async () => {
    const x = setup()
    await x.sup.start()
    x.host.rows = WARNING
    await x.advance(1)
    x.host.rows = null
    await x.advance(1)
    expect(x.status().needsYou).toEqual({ kind: 'confirm_cold_start' })
  })
  it('no claude, or no agent folder: the start fails and says why', async () => {
    const a = setup({ claudePath: 'missing' })
    await a.sup.start()
    expect(a.status()).toMatchObject({ phase: 'stopped', stopReason: 'start_failed' })
    const b = setup({ agentDir: '/nope' })
    await b.sup.start()
    expect(b.status()).toMatchObject({ phase: 'stopped', stopReason: 'start_failed' })
    expect(b.host.launches).toHaveLength(0)
  })
  it('a resume of a conversation that is gone stops (resume_missing), never loops', async () => {
    const x = setup({ session: { id: 'gone', previousIds: [] } })
    x.host.failNext = new PtyHostError('exited_immediately', 'x', ['No conversation found with session ID: gone'])
    await x.sup.start()
    expect(x.status()).toMatchObject({ phase: 'stopped', stopReason: 'resume_missing' })
  })
  it('adopts a Main that outlived the last supervisor; a pane of another conversation restarts cold', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    x.host.attached = agentProcess()
    x.host.markers.session = 'other'
    await x.sup.attachOrStart(true)
    expect(x.status()).toMatchObject({ phase: 'running', panePid: x.host.attached })
    expect(x.host.launches).toHaveLength(0)
    x.host.exit()
    await settle(x, 'waiting_to_restart')
    await x.advance(3)
    expect(x.host.launches[0]?.how).toBe('start')
  })
})

const AUTO_CONFIRM_S = 15

describe('Main on Linux: exits and restarts', () => {
  it('a crash ends the old group, waits the backoff, and restarts in place', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    const old = x.host.pid as number
    x.host.exit()
    await settle(x, 'waiting_to_restart')
    await until(() => !groupAlive(old))
    await x.advance(1)
    expect(x.host.launches).toHaveLength(1) // 2 s backoff not over yet
    await x.advance(1.5)
    expect(x.host.launches.map((l) => l.how)).toEqual(['start', 'restart'])
    expect(x.status().restarts).toHaveLength(1)
    expect(x.status().phase).toBe('starting')
  })
  it('a group that ignores SIGTERM gets SIGKILL at the cleanup deadline', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    x.host.ignoreTerm = true
    await x.sup.start()
    const old = x.host.pid as number
    await new Promise((r) => setTimeout(r, 200)) // the trap is set
    x.host.exit()
    await settle(x, 'cleaning_up')
    await x.advance(5)
    expect(groupAlive(old)).toBe(true)
    await x.advance(6)
    await until(() => !groupAlive(old))
    expect(x.audit).toContain('cleanup_kill')
  })
  it('five restarts in fifteen minutes is a crash loop: the sixth exit stops', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    for (let i = 0; i < 5; i++) {
      x.host.exit()
      await settle(x, 'waiting_to_restart')
      await x.advance(61)
      expect(x.status().phase).toBe('starting')
    }
    x.host.exit()
    await settle(x, 'stopped')
    expect(x.status().stopReason).toBe('crash_loop')
  })
  it('the resume error on the last screen stops; auto-restart off stops; a lost host restarts cold', async () => {
    const a = setup({ session: { id: 'abc', previousIds: [] } })
    await a.sup.start()
    a.host.exit({ lastRows: ['No session found with ID abc'] })
    await settle(a, 'stopped')
    expect(a.status().stopReason).toBe('resume_missing')

    const b = setup({ session: { id: 'abc', previousIds: [] }, autoRestart: false })
    await b.sup.start()
    b.host.exit()
    await settle(b, 'stopped')
    expect(b.status().stopReason).toBe('crashed_no_auto_restart')

    const c = setup({ session: { id: 'abc', previousIds: [] } })
    await c.sup.start()
    c.host.exit({ hostLost: true, code: null })
    await settle(c, 'waiting_to_restart')
    await c.advance(3)
    expect(c.host.launches.map((l) => l.how)).toEqual(['start', 'start'])
  })
  it('a restart whose agent dies at once counts as a crash and tries again', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    x.host.exit()
    await settle(x, 'waiting_to_restart')
    x.host.failNext = new PtyHostError('exited_immediately', 'x', ['boom'])
    await x.advance(3)
    expect(x.status().phase).toBe('waiting_to_restart')
    await x.advance(6)
    expect(x.host.launches.map((l) => l.how)).toEqual(['start', 'restart', 'restart'])
  })
  it('the owner’s stop ends the group and the session, and nothing restarts', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    const pid = x.host.pid as number
    await x.sup.stop()
    await until(() => !groupAlive(pid))
    await x.advance(1)
    expect(x.status()).toMatchObject({ phase: 'stopped', stopReason: 'user' })
    expect(x.host.closed).toBe(1)
    x.host.exit()
    await x.advance(100)
    expect(x.host.launches).toHaveLength(1)
  })
})

describe('Main on Linux: one thing at a time (the Swift’s serial queue)', () => {
  it('an exit while the start is still writing its marker is this launch’s exit, not lost', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    const g = gate()
    x.host.markerGate = g.p
    const starting = x.sup.start()
    await new Promise((r) => setTimeout(r, 50))
    x.host.exit()
    g.open()
    await starting
    await settle(x, 'waiting_to_restart')
  })
  it('the owner’s stop during an exit being handled stays a stop', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    const g = gate()
    x.host.rowsGate = g.p
    x.host.exit()
    const stopping = x.sup.stop() // queued behind the exit
    await new Promise((r) => setTimeout(r, 50))
    x.host.rowsGate = null
    g.open()
    await stopping
    await settle(x, 'stopped')
    expect(x.status().stopReason).toBe('user')
    for (let i = 0; i < 5; i++) await x.advance(30)
    expect(x.status().phase).toBe('stopped')
    expect(x.host.launches).toHaveLength(1)
  })
  it('the owner’s stop during a restart in flight stops the restarted Main', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    x.host.exit()
    await settle(x, 'waiting_to_restart')
    const g = gate()
    x.host.restartGate = g.p
    const ticking = x.advance(3) // the restart starts and waits on tmux
    await new Promise((r) => setTimeout(r, 50))
    const stopping = x.sup.stop()
    g.open()
    await ticking
    await stopping
    await settle(x, 'stopped')
    expect(x.status()).toMatchObject({ phase: 'stopped', stopReason: 'user', panePid: null })
    expect(groupAlive(x.host.pid as number)).toBe(false)
  })
})

describe('Main on Linux: what the Mac review found, not carried over', () => {
  it('Main’s environment is the Mac’s: the owner’s settings stay, worker switches and terminal variables go', () => {
    const env = buildMainEnv(
      {
        PATH: '/usr/bin',
        PWD: '/x',
        SHLVL: '2',
        _: '/usr/bin/env',
        TERM: 'xterm-kitty',
        TERM_PROGRAM: 'kitty',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'leak',
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        TELEGRAM_STATE_DIR: '/home/alex/.config/talos/app/workers/_nochannel',
        TALOS_APP_BRIDGE: '0',
      },
      {
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
        CLAUDE_CODE_DISABLE_FAST_MODE: '1',
        CLAUDE_EFFORT: 'max',
        CLAUDE_CODE_SESSION_ID: 'refused',
        TALOS_APP_BRIDGE: '0',
        TELEGRAM_STATE_DIR: '/home/alex/tg',
      },
    )
    expect(env).toEqual({
      PATH: '/usr/bin',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      CLAUDE_CODE_DISABLE_FAST_MODE: '1',
      CLAUDE_EFFORT: 'max',
      TELEGRAM_STATE_DIR: '/home/alex/tg',
      TALOS_APP_BRIDGE: '1',
      MCP_PROTOCOL_NEGOTIATION: 'legacy',
    })
  })
  it('settings that cannot be read start nothing and save nothing', async () => {
    const x = setup()
    x.setConfigError('supervisor.json is not valid JSON')
    await x.sup.start()
    expect(x.status()).toMatchObject({ phase: 'stopped', stopReason: 'start_failed' })
    expect(x.host.launches).toHaveLength(0)
    expect(x.cfg.session.id).toBeNull()
  })
  it('a restart that cannot launch (claude gone) backs off outside the crash loop and gives up: start_failed, one phone line', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    x.setClaude(false)
    x.host.exit()
    await settle(x, 'waiting_to_restart')
    for (let i = 0; i < 8 && x.status().phase !== 'stopped'; i++) await x.advance(61)
    expect(x.status()).toMatchObject({ phase: 'stopped', stopReason: 'start_failed' })
    expect(x.audit).toContain('gave_up')
    expect(x.audit.filter((e) => e === 'restart_cannot_launch')).toHaveLength(5)
    expect(x.told.at(-1)).toEqual({ kind: 'stopped', reason: 'start_failed', gaveUp: true })
    expect(x.host.launches).toHaveLength(1)
  })
  it('tries that could not launch never spend the crash loop: claude back, five real crashes are still allowed', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    x.setClaude(false)
    x.host.exit()
    await settle(x, 'waiting_to_restart')
    for (let i = 0; i < 3; i++) await x.advance(61)
    x.setClaude(true)
    await x.advance(61)
    expect(x.status().phase).toBe('starting')
    for (let i = 0; i < 4; i++) {
      x.host.exit({ code: 1 })
      await settle(x, 'waiting_to_restart')
      await x.advance(61)
      expect(x.status().phase).toBe('starting')
    }
  })
  it('the resume error counts only right after the spawn; later it is a crash like any other', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    await x.advance(120)
    x.host.exit({ lastRows: ['No session found with ID abc'] })
    await settle(x, 'waiting_to_restart')
  })
  it('an adopted Main is read for a live warning at once', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    x.host.attached = agentProcess()
    x.host.markers.session = 'abc'
    x.host.rows = WARNING
    await x.sup.attachOrStart(true)
    expect(x.status().phase).toBe('starting')
    expect(x.status().needsYou).toEqual({ kind: 'confirm_cold_start' })
  })
  it('a start that finds Main already running adopts it; it never fails and never starts another', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    x.host.failNext = new PtyHostError('already_running', 'session agent already runs')
    x.host.attached = agentProcess()
    x.host.markers.session = 'abc'
    await x.sup.start()
    expect(x.status()).toMatchObject({ phase: 'running', panePid: x.host.attached })
  })
  it('an adopted Main’s environment is the one its process really has, not a rebuild from today’s settings', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, env: { CLAUDE_CODE_RESTRICTED: '0' } })
    ;(x.sup as unknown as { d: { processEnv: (pid: number) => Record<string, string> | null } }).d.processEnv = () => ({
      CLAUDE_CODE_RESTRICTED: '1', // it was started restricted; today's settings say otherwise
    })
    x.host.failNext = new PtyHostError('already_running', 'session agent already runs')
    x.host.attached = agentProcess()
    x.host.markers.session = 'abc'
    await x.sup.start()
    expect(x.sup.launchEnv()).toMatchObject({ env: { CLAUDE_CODE_RESTRICTED: '1' }, known: true })
  })
  it('a pid that is no longer Main’s own process (reused) is not read as Main’s environment: not known', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    const d = (
      x.sup as unknown as {
        d: {
          processEnv: (pid: number) => Record<string, string> | null
          identity: { processStartTime: (pid: number) => string | null }
        }
      }
    ).d
    d.processEnv = () => ({ PATH: '/someone/else' })
    x.host.failNext = new PtyHostError('already_running', 'session agent already runs')
    x.host.attached = agentProcess()
    x.host.markers.session = 'abc'
    await x.sup.start()
    // the start time the adoption recorded no longer matches: another process has the pid now
    d.identity = { ...d.identity, processStartTime: () => 'a later process' }
    ;(x.sup as unknown as { launch: { env: unknown } }).launch.env = null // the first read after the swap
    expect(x.sup.launchEnv()).toMatchObject({ known: false })
    expect(x.audit).toContain('main_env_rebuilt')
  })
  it('an environment that could not be read once is read again: a passing failure does not last Main’s whole life', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    let readable = false
    ;(x.sup as unknown as { d: { processEnv: (pid: number) => Record<string, string> | null } }).d.processEnv = () =>
      readable ? { CLAUDE_CODE_RESTRICTED: '0' } : null
    x.host.failNext = new PtyHostError('already_running', 'session agent already runs')
    x.host.attached = agentProcess()
    x.host.markers.session = 'abc'
    await x.sup.start()
    expect(x.sup.launchEnv()).toMatchObject({ known: false })
    expect(x.sup.launchEnv()).toMatchObject({ known: false })
    expect(x.audit.filter((e) => e === 'main_env_rebuilt')).toHaveLength(1) // said once, not on every look
    readable = true
    expect(x.sup.launchEnv()).toMatchObject({ known: true, env: { CLAUDE_CODE_RESTRICTED: '0' } })
  })
  it('one whose process environment cannot be read is rebuilt, and that is said', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    ;(x.sup as unknown as { d: { processEnv: (pid: number) => Record<string, string> | null } }).d.processEnv = () =>
      null
    x.host.failNext = new PtyHostError('already_running', 'session agent already runs')
    x.host.attached = agentProcess()
    x.host.markers.session = 'abc'
    await x.sup.start()
    expect(x.sup.launchEnv()).toMatchObject({ env: { PATH: '/usr/bin:/bin' }, known: false })
    expect(x.audit).toContain('main_env_rebuilt')
  })
  it('the login environment is read again at every start', async () => {
    let reads = 0
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    ;(x.sup as unknown as { d: { loginEnv: () => Record<string, string> } }).d.loginEnv = () => {
      reads++
      return { PATH: `/v${reads}` }
    }
    await x.sup.start()
    x.host.exit()
    await settle(x, 'waiting_to_restart')
    await x.advance(3)
    expect(x.host.launches.map((l) => l.launch.env.PATH)).toEqual(['/v1', '/v2'])
  })
})

describe('Main on Linux: a clean exit (code 0) is not a crash', () => {
  it('restarts at the first step and never spends the crash loop', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    for (let i = 0; i < 8; i++) {
      x.host.exit({ code: 0 })
      await settle(x, 'waiting_to_restart')
      await x.advance(2.5) // the first backoff step, every time
      expect(x.status().phase).toBe('starting')
    }
    // the crash loop's five are all still there
    for (let i = 0; i < 5; i++) {
      x.host.exit({ code: 1 })
      await settle(x, 'waiting_to_restart')
      await x.advance(61)
      expect(x.status().phase).toBe('starting')
    }
  })
  it('more than ten in an hour stops Main (clean_exit_loop)', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    for (let i = 0; i < 10; i++) {
      x.host.exit({ code: 0 })
      await settle(x, 'waiting_to_restart')
      await x.advance(3)
    }
    x.host.exit({ code: 0 })
    await settle(x, 'stopped')
    expect(x.status().stopReason).toBe('clean_exit_loop')
    expect(x.audit).toContain('clean_exit_loop')
  })
  it('a code 0 with a signal, or a lost host, is not a clean exit', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    for (let i = 0; i < 5; i++) {
      x.host.exit({ code: 0, hostLost: true })
      await settle(x, 'waiting_to_restart')
      await x.advance(61)
    }
    x.host.exit({ code: 1 })
    await settle(x, 'stopped')
    expect(x.status().stopReason).toBe('crash_loop')
  })
})

describe('Main on Linux: clean exits and the owner’s settings', () => {
  it('with auto-restart off, a clean exit does not restart Main either', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, autoRestart: false })
    await x.sup.start()
    x.host.exit({ code: 0 })
    await settle(x, 'stopped')
    expect(x.status().stopReason).toBe('crashed_no_auto_restart')
    expect(x.host.launches).toHaveLength(1)
  })
  it('a clean exit followed by the owner’s stop and start leaves no free pass for the next crash', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    x.host.exit({ code: 0 })
    await settle(x, 'waiting_to_restart')
    await x.sup.stop()
    await settle(x, 'stopped')
    await x.sup.start()
    for (let i = 0; i < 5; i++) {
      x.host.exit({ code: 1 })
      await settle(x, 'waiting_to_restart')
      await x.advance(61)
    }
    x.host.exit({ code: 1 })
    await settle(x, 'stopped')
    expect(x.status().stopReason).toBe('crash_loop')
  })
})

describe('Main on Linux: is this start’s bridge live (MAIN_START)', () => {
  const ready = async (x: ReturnType<typeof setup>) => {
    await x.sup.start()
    await x.advance(16) // the warning had its time; the input box is up
    expect(x.status().phase).toBe('running')
  }
  it('a fresh live status from Main’s own group is this start’s bridge', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    await x.sup.start()
    x.bridgeWrites()
    await x.advance(1)
    expect(x.status().bridgeLive).toBe(true)
  })
  it('none within bridge_alive_s is needs-you, with the reason from the MCP log; never a stop', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    await ready(x)
    await x.advance(30)
    expect(x.status().needsYou).toBeUndefined()
    await x.advance(31)
    expect(x.status().needsYou).toEqual({ kind: 'bridge_not_live', reason: 'talos-app: Connection closed' })
    expect(x.status().phase).toBe('running')
    x.bridgeWrites()
    await x.advance(1)
    expect(x.status()).toMatchObject({ bridgeLive: true })
    expect(x.status().needsYou).toBeUndefined()
  })
  it('a status from another process, an old one, or one written before this spawn is not live', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    await x.sup.start()
    x.bridgeWrites({ pid: process.pid }) // not in Main's group
    await x.advance(1)
    x.bridgeWrites({ mode: 'headless' })
    await x.advance(1)
    x.bridgeWrites({ mode: 'superseded' })
    await x.advance(1)
    expect(x.status().bridgeLive).toBe(false)
    // after this spawn, but older than bridge_status_max_age_s
    await x.advance(60)
    x.bridgeWrites({ ageS: 50 })
    await x.advance(0)
    expect(x.status().bridgeLive).toBe(false)
    // fresh, but stamped before this spawn
    const y = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    await y.sup.start()
    y.bridgeWrites({ ageS: 5 })
    await y.advance(0)
    expect(y.status().bridgeLive).toBe(false)
  })
  it('with the warning expected, the wait starts when the owner answers it', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    x.host.rows = WARNING
    await x.advance(100) // the owner takes a while
    x.host.rows = READY
    await x.advance(1) // answered now
    await x.advance(59)
    expect(x.status().needsYou).toBeUndefined()
    await x.advance(2)
    expect(x.status().needsYou?.kind).toBe('bridge_not_live')
  })
})

describe('Main on Linux: the bridge wait, from the review', () => {
  it('a warning expected and never shown: the wait starts when Main is running', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } }) // the default args expect the warning
    await x.sup.start()
    await x.advance(16)
    expect(x.status().phase).toBe('running')
    await x.advance(59)
    expect(x.status().needsYou).toBeUndefined()
    await x.advance(2)
    expect(x.status().needsYou?.kind).toBe('bridge_not_live')
  })
  it('a frame without the warning that is not the ready box starts no clock; the latest answer counts', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    x.host.rows = WARNING
    await x.advance(1)
    x.host.rows = ['redrawing']
    await x.advance(1)
    x.host.rows = WARNING
    await x.advance(100)
    x.host.rows = READY // answered at 102 s
    await x.advance(1)
    await x.advance(30)
    expect(x.status().needsYou).toBeUndefined()
  })
  it('an adopted Main whose bridge already runs is live', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    x.host.attached = agentProcess()
    x.host.markers.session = 'abc'
    await x.sup.attachOrStart(true)
    x.bridgeWrites({ pid: x.host.attached })
    await x.advance(1)
    expect(x.status().bridgeLive).toBe(true)
  })
  it('the bridge alarm comes back after a dialog that took its place, told once', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    await x.sup.start()
    await x.advance(61)
    expect(x.status().needsYou?.kind).toBe('bridge_not_live')
    x.host.lastOut = null
    x.host.rows = readFileSync(
      new URL('../../../desktop/Tests/Fixtures/real-2.1.318/trust-dialog.txt', import.meta.url),
      'utf8',
    ).split('\n')
    await x.advance(1)
    await x.advance(61)
    expect(x.status().needsYou).toEqual({ kind: 'dialog', dialog: 'trust' })
    x.host.rows = READY
    await x.advance(1)
    await x.advance(1)
    expect(x.status().needsYou?.kind).toBe('bridge_not_live')
    expect(x.audit.filter((e) => e === 'needs_you')).toHaveLength(2) // the bridge alarm once, the dialog once
  })
  it('a crash restart asks again: bridgeLive starts false for the new start', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    await x.sup.start()
    x.bridgeWrites()
    await x.advance(1)
    expect(x.status().bridgeLive).toBe(true)
    x.host.exit()
    await settle(x, 'waiting_to_restart')
    await x.advance(3)
    expect(x.status()).toMatchObject({ phase: 'starting', bridgeLive: false })
  })
})

describe('Main on Linux: a session nobody has typed in yet (seen live on Hestia)', () => {
  it('is started again with the same id, never resumed into the resume error', async () => {
    const x = setup({ session: { id: 'never-typed', previousIds: [] } })
    await x.sup.start()
    expect(x.host.launches[0]?.launch.argv.slice(-1)).toEqual(['--session-id=never-typed'])
    expect(x.audit).toContain('session_not_saved')
    x.host.exit({ code: null, signal: 9 })
    await settle(x, 'waiting_to_restart')
    await x.advance(3)
    expect(x.host.launches[1]?.launch.argv.slice(-1)).toEqual(['--session-id=never-typed'])
    expect(x.status().phase).toBe('starting')
  })
})

describe('Main on Linux: the session errors a launch can mend (review of the live-run fix)', () => {
  it('the transcript check gets Main’s environment (its CLAUDE_CONFIG_DIR), not the supervisor’s', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, env: { CLAUDE_CONFIG_DIR: '/home/alex/.claude-work' } })
    await x.sup.start()
    expect(x.seenEnv()?.CLAUDE_CONFIG_DIR).toBe('/home/alex/.claude-work')
  })
  it('`--session-id` refused as already in use: the next launch resumes it, once', async () => {
    const x = setup({ session: { id: 'never-typed', previousIds: [] } })
    x.host.failNext = new PtyHostError('exited_immediately', 'x', ['Error: Session ID never-typed is already in use.'])
    await x.sup.start()
    expect(x.host.launches.map((l) => l.launch.argv.slice(-1))).toEqual([
      ['--session-id=never-typed'],
      ['--resume=never-typed'],
    ])
    expect(x.audit).toContain('session_in_use_resume')
    expect(x.status().phase).toBe('starting')
  })
  it('the same refusal on the exit right after the spawn restarts with --resume', async () => {
    const x = setup({ session: { id: 'never-typed', previousIds: [] } })
    await x.sup.start()
    x.host.exit({ lastRows: ['Error: Session ID never-typed is already in use.'] })
    // the restart is due at once: the clean-up goes straight on to it
    for (let i = 0; i < 100 && x.host.launches.length < 2; i++) {
      await x.advance(0)
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(x.host.launches[1]?.launch.argv.slice(-1)).toEqual(['--resume=never-typed'])
  })
  it('a transcript with no conversation (an /exit before anything was typed): a new id, never a stop', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    x.emptyIds.add('abc')
    x.host.failNext = new PtyHostError('exited_immediately', 'x', ['No conversation found with session ID: abc'])
    await x.sup.start()
    expect(x.cfg.session.id).toBe('11111111-2222-3333-4444-555555555555')
    expect(x.host.launches[1]?.launch.argv.slice(-1)).toEqual(['--session-id=11111111-2222-3333-4444-555555555555'])
    expect(x.audit).toContain('session_empty_new_id')
  })
  it('a saved conversation that cannot be resumed still stops with the resume error', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    x.host.failNext = new PtyHostError('exited_immediately', 'x', ['No conversation found with session ID: abc'])
    await x.sup.start()
    expect(x.status()).toMatchObject({ phase: 'stopped', stopReason: 'resume_missing' })
  })
})

describe('Main on Linux: what the owner is told', () => {
  it('a needs-you once, a restart after a crash (not after a clean exit), and each stop', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    x.host.rows = WARNING
    await x.advance(1)
    await x.advance(1)
    expect(x.told.filter((e) => e.kind === 'needs_you')).toHaveLength(1)
    x.host.rows = READY
    x.host.exit({ code: 1 })
    await settle(x, 'waiting_to_restart')
    await x.advance(3)
    expect(x.told.filter((e) => e.kind === 'restarted_after_crash')).toHaveLength(0) // not at the spawn
    // the restart waits on the warning: the phone hears it, once this start
    x.host.rows = WARNING
    await x.advance(1)
    x.host.rows = ['redraw']
    await x.advance(1)
    x.host.rows = WARNING
    await x.advance(1)
    expect(x.told.filter((e) => e.kind === 'needs_you' && e.unattended)).toHaveLength(1)
    x.host.rows = READY
    await x.advance(16)
    expect(x.told.filter((e) => e.kind === 'restarted_after_crash')).toEqual([
      { kind: 'restarted_after_crash', resumed: true },
    ])
    x.host.exit({ code: 0 })
    await settle(x, 'waiting_to_restart')
    await x.advance(3)
    await x.advance(16)
    expect(x.told.filter((e) => e.kind === 'restarted_after_crash')).toHaveLength(1) // a clean exit is no crash
    await x.sup.stop()
    await settle(x, 'stopped')
    expect(x.told.at(-1)).toEqual({ kind: 'stopped', reason: 'user' })
  })
  it('a tell that throws never stops supervision', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    ;(x.sup as unknown as { d: { tell: () => void } }).d.tell = () => {
      throw new Error('no notification service')
    }
    await x.sup.start()
    x.host.exit({ code: 1 })
    await settle(x, 'waiting_to_restart')
    await x.advance(3)
    await x.advance(16) // running again: the restart is told, and the tell throws
    expect(x.status().phase).toBe('running')
    expect(x.audit).toContain('tell_failed')
  })
})

describe('Main on Linux: a crash restart that comes back cold is still told', () => {
  it('a lost host restarts cold: told when running, and its wait on the warning reaches the phone', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    await x.sup.start()
    x.host.exit({ hostLost: true, code: null })
    await settle(x, 'waiting_to_restart')
    await x.advance(3)
    expect(x.host.launches.map((l) => l.how)).toEqual(['start', 'start']) // cold
    x.host.rows = WARNING
    await x.advance(1)
    expect(x.told.filter((e) => e.kind === 'needs_you' && e.unattended)).toHaveLength(1)
    x.host.rows = READY
    await x.advance(16)
    expect(x.told.filter((e) => e.kind === 'restarted_after_crash')).toHaveLength(1)
  })
})

describe('Main on Linux: another session, and a Main that stops answering', () => {
  it('another session holding the channel blocks a start (told once), and the owner’s start --anyway goes past it once', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    const d = (x.sup as unknown as { d: Record<string, unknown> }).d
    d.takeover = async () => [{ resource: 'channels', holderPid: 9, sessionPid: 9, folder: '/home/alex/other' }]
    await x.sup.start()
    expect(x.status().phase).toBe('blocked')
    expect(x.host.launches).toHaveLength(0)
    expect(x.told.filter((e) => e.kind === 'blocked')).toHaveLength(1)
    await x.sup.start({ anyway: true })
    expect(x.status().phase).toBe('starting')
    expect(x.host.launches).toHaveLength(1)
  })
  it('missing from claude agents twice in a row while running is stuck; listed again clears it', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    let listed = true
    const d = (x.sup as unknown as { d: Record<string, unknown> }).d
    d.listAgents = async () =>
      listed ? [{ kind: 'interactive', pid: x.host.pid, sessionId: 'abc', status: 'idle', cwd: '/agent' }] : []
    // the poll runs off the queue: its answer lands a moment after the tick
    const step = async (s: number) => {
      await x.advance(s)
      await new Promise((r) => setTimeout(r, 30))
      await x.advance(0)
    }
    await x.sup.start()
    x.bridgeWrites()
    await step(1)
    expect(x.status().phase).toBe('running')
    listed = false
    await step(10)
    expect(x.status().needsYou).toBeUndefined()
    await step(10)
    expect(x.status().needsYou).toEqual({ kind: 'stuck' })
    listed = true
    await step(10)
    expect(x.status().needsYou).toBeUndefined()
  })
  it('on the usage-limit screen Main waits on the owner for that, at once, and dropping out of claude agents is not "stuck"', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    let listed = true
    const d = (x.sup as unknown as { d: Record<string, unknown> }).d
    d.listAgents = async () =>
      listed ? [{ kind: 'interactive', pid: x.host.pid, sessionId: 'abc', status: 'idle', cwd: '/agent' }] : []
    const step = async (s: number) => {
      await x.advance(s)
      await new Promise((r) => setTimeout(r, 30))
      await x.advance(0)
    }
    await x.sup.start()
    x.bridgeWrites()
    await step(1)
    expect(x.status().phase).toBe('running')
    const ready = x.host.rows
    x.host.rows = readFileSync(
      new URL('../../../desktop/Tests/Fixtures/synthetic/usage-limit.txt', import.meta.url),
      'utf8',
    ).split('\n')
    await step(1)
    // never answered, so no stall to wait out first: the screen is what Main waits on, in Talos's own words
    // the reset as a moment too (the check file's resets_at): 4pm Paris on this test's wall clock's day
    const held = {
      kind: 'usage_limit',
      model: 'Fable',
      limit: 'model',
      resets: '4pm (Europe/Paris)',
      resets_at: '1970-01-01T15:00:00.000Z',
    } as const
    expect(x.status().needsYou).toEqual(held)
    const limitScreen = x.host.rows
    // on that screen Main drops out of `claude agents` because of it: still the usage limit, never "stuck" (the Mac's b401c31d)
    listed = false
    await step(10)
    await step(10)
    await step(10)
    expect(x.status().needsYou).toEqual(held)
    // and the owner was never told it is stuck in between (a raise is a notice, even one the next look replaces)
    expect(x.told.filter((e) => e.kind === 'needs_you' && (e.needs as { kind: string }).kind === 'stuck')).toEqual([])
    expect(
      x.told.filter((e) => e.kind === 'needs_you' && (e.needs as { kind: string }).kind === 'usage_limit'),
    ).toHaveLength(1)
    // one torn frame without the menu (a redraw) is not the menu gone: still the usage limit, no stuck, nothing told (Fable R1-2)
    x.host.rows = ready
    listed = true
    await step(1)
    expect(x.status().needsYou).toEqual(held)
    x.host.rows = limitScreen
    await step(1)
    expect(x.status().needsYou).toEqual(held)
    // the owner pressed Esc: gone for the watch's settle time, and so is what Main waited on
    x.host.rows = ready
    await step(1)
    await step(3)
    expect(x.status().needsYou).toBeUndefined()
    // it comes back within the hour: Main waits on it again, but the owner is not told a second time
    x.host.rows = limitScreen
    await step(1)
    expect(x.status().needsYou).toEqual(held)
    const told = x.told.filter((e) => e.kind === 'needs_you' && (e.needs as { kind: string }).kind)
    expect(told.filter((e) => (e.needs as { kind: string }).kind === 'usage_limit')).toHaveLength(1)
    expect(told.filter((e) => (e.needs as { kind: string }).kind === 'stuck')).toEqual([])
  })
  it('a session id Claude Code reports after the owner’s /clear is followed (saved, the next restart resumes it)', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    const moved = '22222222-3333-4444-5555-666666666666'
    const d = (x.sup as unknown as { d: Record<string, unknown> }).d
    d.listAgents = async () => [
      { kind: 'interactive', pid: x.host.pid, sessionId: moved, status: 'idle', cwd: '/agent' },
    ]
    await x.sup.start()
    await x.advance(1)
    await new Promise((r) => setTimeout(r, 30))
    await x.advance(0)
    expect(x.cfg.session.id).toBe(moved)
    expect(x.host.markers.session).toBe(moved)
    expect(x.audit).toContain('session_followed')
  })
  it('our own Main, missed by a failed adopt, is never blocked as another session', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    const d = (x.sup as unknown as { d: Record<string, unknown> }).d
    d.takeover = async () => {
      x.host.attached = agentProcess() // the read that failed before answers now
      x.host.markers.session = 'abc'
      return [{ resource: 'channels', holderPid: 9, sessionPid: 9, folder: '/agent' }]
    }
    await x.sup.start()
    expect(x.status().phase).toBe('running')
    expect(x.host.launches).toHaveLength(0)
  })
  it('--anyway is refused past Telegram, and when nothing is blocked; it never outlives the start it was for', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    const d = (x.sup as unknown as { d: Record<string, unknown> }).d
    d.takeover = async () => [{ resource: 'telegram', holderPid: 9, sessionPid: 9, folder: null }]
    await x.sup.start({ anyway: true }) // not blocked yet: refused
    expect(x.audit).toContain('start_anyway_refused')
    await x.sup.start()
    expect(x.status().phase).toBe('blocked')
    await x.sup.start({ anyway: true }) // Telegram: never
    expect(x.status().phase).toBe('blocked')
    expect(x.host.launches).toHaveLength(0)
    expect(x.status().blockers?.[0]).toMatchObject({ resource: 'telegram', sessionPid: 9 })
  })
  it('a crash restart that is blocked tells the phone, asks again every minute, and goes on once the holder is gone', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    let held = false
    const d = (x.sup as unknown as { d: Record<string, unknown> }).d
    d.takeover = async () => (held ? [{ resource: 'channels', holderPid: 9, sessionPid: 9, folder: '/x' }] : [])
    await x.sup.start()
    held = true
    x.host.exit({ code: 1 })
    await settle(x, 'waiting_to_restart')
    await x.advance(3)
    expect(x.status().phase).toBe('blocked')
    expect(x.told.filter((e) => e.kind === 'blocked')).toEqual([
      {
        kind: 'blocked',
        blockers: [{ resource: 'channels', holderPid: 9, sessionPid: 9, folder: '/x' }],
        afterCrash: true,
      },
    ])
    await x.advance(61)
    expect(x.status().phase).toBe('blocked')
    expect(x.told.filter((e) => e.kind === 'blocked')).toHaveLength(1) // told once
    held = false
    await x.advance(61)
    expect(x.status().phase).toBe('starting')
    expect(x.host.launches).toHaveLength(2)
  })
  it('an unreadable agents list says nothing', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    ;(x.sup as unknown as { d: Record<string, unknown> }).d.listAgents = async () => null
    await x.sup.start()
    x.bridgeWrites()
    for (let i = 0; i < 5; i++) await x.advance(10)
    expect(x.status().needsYou).toBeUndefined()
  })
})

describe('Main on Linux: a session that had a turn is never started anew (its transcript gone)', () => {
  it('resumed even with no transcript, so the resume error tells the owner', async () => {
    const x = setup({ session: { id: 'never-typed', previousIds: [], conversationSeen: true } })
    x.host.failNext = new PtyHostError('exited_immediately', 'x', [
      'No conversation found with session ID: never-typed',
    ])
    await x.sup.start()
    expect(x.host.launches[0]?.launch.argv.slice(-1)).toEqual(['--resume=never-typed'])
    expect(x.status()).toMatchObject({ phase: 'stopped', stopReason: 'resume_missing' })
  })
  it('a transcript seen while running records the turn', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    const marked: string[] = []
    const d = (x.sup as unknown as { d: Record<string, unknown> }).d
    d.markConversationSeen = (id: string) => marked.push(id)
    d.listAgents = async () => [
      { kind: 'interactive', pid: x.host.pid, sessionId: 'abc', status: 'idle', cwd: '/agent' },
    ]
    await x.sup.start() // 'abc' is saved by the fake: marked at the launch
    await x.advance(1)
    await new Promise((r) => setTimeout(r, 30))
    await x.advance(0)
    expect(marked).toEqual(['abc'])
  })
})

describe('Main on Linux: the last takeover follow-ups', () => {
  it('a session followed after /clear has its turn recorded once its transcript is there', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    const moved = '22222222-3333-4444-5555-666666666666'
    const marked: string[] = []
    const d = (x.sup as unknown as { d: Record<string, unknown> }).d
    d.markConversationSeen = (id: string) => marked.push(id)
    d.listAgents = async () => [
      { kind: 'interactive', pid: x.host.pid, sessionId: moved, status: 'idle', cwd: '/agent' },
    ]
    await x.sup.start()
    for (let i = 0; i < 2; i++) {
      await x.advance(10)
      await new Promise((r) => setTimeout(r, 30))
      await x.advance(0)
    }
    expect(marked).toContain(moved)
  })
  it('a stop while blocked clears the recheck window: a later blocked crash restart is rechecked again', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] } })
    let held = false
    const d = (x.sup as unknown as { d: Record<string, unknown> }).d
    d.takeover = async () => (held ? [{ resource: 'channels', holderPid: 9, sessionPid: 9, folder: '/x' }] : [])
    await x.sup.start()
    held = true
    x.host.exit({ code: 1 })
    await settle(x, 'waiting_to_restart')
    await x.advance(3)
    expect(x.status().phase).toBe('blocked')
    await x.sup.stop()
    held = false
    await x.sup.start()
    await x.advance(4000) // far past the first window
    held = true
    x.host.exit({ code: 1 })
    await settle(x, 'waiting_to_restart')
    await x.advance(3)
    expect(x.status().phase).toBe('blocked')
    held = false
    await x.advance(61)
    expect(x.status().phase).toBe('starting')
  })
})

describe('Main on Linux: the sandbox breaker’s silent failures (#4, #5)', () => {
  it('#4 a bridge that is up but not connected to the relay is not live; one that stays disconnected is told', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    await x.sup.start()
    x.bridgeWrites({ connected: false })
    await x.advance(1)
    expect(x.status().bridgeLive).toBe(false)
    await x.advance(61)
    expect(x.status().needsYou?.kind).toBe('bridge_not_live')
    // connected: live; then the relay goes away for good
    x.bridgeWrites({ connected: true })
    await x.advance(1)
    expect(x.status().bridgeLive).toBe(true)
    expect(x.status().needsYou).toBeUndefined()
    x.bridgeWrites({ connected: false })
    await x.advance(60)
    expect(x.status().needsYou).toBeUndefined() // a short outage is the bridge's own to ride out
    for (let i = 0; i < 11; i++) {
      x.bridgeWrites({ connected: false })
      await x.advance(60)
    }
    expect(x.status().needsYou).toEqual({ kind: 'bridge_not_live', reason: 'not connected to the relay' })
    x.bridgeWrites({ connected: true })
    await x.advance(1)
    expect(x.status().needsYou).toBeUndefined()
  })
  it('#4 a bridge whose status.json froze at "connected" (dead or hung) is off the relay too', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    await x.sup.start()
    x.bridgeWrites({ connected: true })
    await x.advance(1)
    expect(x.status().bridgeLive).toBe(true)
    for (let i = 0; i < 5; i++) await x.advance(60) // never written again
    expect(x.status().needsYou).toEqual({ kind: 'bridge_not_live', reason: 'not connected to the relay' })
  })
  it('#5 an owner message unseen for five minutes while the pane is silent is stuck, told once', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    await x.sup.start()
    x.bridgeWrites()
    await x.advance(1)
    x.host.lastOut = 1 // the screen has printed nothing for a long time
    x.bridgeWrites({ unseenAgoS: 200 })
    await x.advance(1)
    expect(x.status().needsYou).toBeUndefined()
    x.bridgeWrites({ unseenAgoS: 301 })
    await x.advance(1)
    expect(x.status().needsYou).toEqual({ kind: 'stuck' })
    await x.advance(30)
    expect(
      x.told.filter(
        (e) => e.kind === 'needs_you' && (e as unknown as { needs: { kind: string } }).needs.kind === 'stuck',
      ),
    ).toHaveLength(1)
    // it answers: cleared
    x.bridgeWrites({ unseenAgoS: null })
    await x.advance(1)
    expect(x.status().needsYou).toBeUndefined()
  })
  it('#5 a hung Main still listed by the agents poll stays stuck, told once (the poll does not clear it)', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    const d = (x.sup as unknown as { d: Record<string, unknown> }).d
    d.listAgents = async () => [
      { kind: 'interactive', pid: x.host.pid, sessionId: 'abc', status: 'busy', cwd: '/agent' },
    ]
    await x.sup.start()
    x.bridgeWrites()
    await x.advance(1)
    x.host.lastOut = 1
    const told = () =>
      x.told.filter(
        (e) => e.kind === 'needs_you' && (e as unknown as { needs: { kind: string } }).needs.kind === 'stuck',
      )
    for (let i = 0; i < 12; i++) {
      x.bridgeWrites({ unseenAgoS: 301 + i * 15 })
      await x.advance(15)
      await new Promise((r) => setTimeout(r, 5)) // the agents poll answers off the queue
      await x.advance(0)
    }
    expect(x.status().needsYou).toEqual({ kind: 'stuck' })
    expect(told()).toHaveLength(1)
  })
  it('#5 a hang both checks see is told once; the unseen check ending leaves the poll’s stuck in place', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    const d = (x.sup as unknown as { d: Record<string, unknown> }).d
    d.listAgents = async () => [] // Main is not listed: the poll's own stuck
    await x.sup.start()
    x.bridgeWrites()
    await x.advance(1)
    x.host.lastOut = 1
    const told = () =>
      x.told.filter(
        (e) => e.kind === 'needs_you' && (e as unknown as { needs: { kind: string } }).needs.kind === 'stuck',
      )
    for (let i = 0; i < 12; i++) {
      x.bridgeWrites({ unseenAgoS: 301 + i * 15 })
      await x.advance(15)
      await new Promise((r) => setTimeout(r, 5))
      await x.advance(0)
    }
    expect(x.status().needsYou).toEqual({ kind: 'stuck' })
    // the message is taken (a tool call), but Main is still not listed
    for (let i = 0; i < 4; i++) {
      x.bridgeWrites({ unseenAgoS: null })
      await x.advance(15)
      await new Promise((r) => setTimeout(r, 5))
      await x.advance(0)
    }
    expect(x.status().needsYou).toEqual({ kind: 'stuck' })
    expect(told()).toHaveLength(1)
  })
  it('#5 a short answer that called no bridge tool ("thanks", then a short turn) is not stuck', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    await x.sup.start()
    x.bridgeWrites()
    await x.advance(1)
    const sent = x.wallS()
    x.host.lastOut = (sent + 5) * 1000 // Main showed the message and its turn five seconds later, then went quiet
    for (let i = 0; i < 6; i++) {
      await x.advance(60)
      x.bridgeWrites({ unseenAgoS: x.wallS() - sent }) // the bridge still lists it: no tool touched it
      await x.advance(0)
    }
    expect(x.wallS() - sent).toBeGreaterThan(300)
    expect(x.status().needsYou).toBeUndefined()
  })
  it('#5 a long task (the pane still printing) is not stuck', async () => {
    const x = setup({ session: { id: 'abc', previousIds: [] }, args: [] })
    await x.sup.start()
    x.bridgeWrites({ unseenAgoS: 900 })
    await x.advance(1)
    for (let i = 0; i < 5; i++) {
      await x.advance(30)
      x.bridgeWrites({ unseenAgoS: 900 }) // a fresh status, as the bridge writes it every 15 s
      x.host.lastOut = (1031 + i * 30) * 1000 // the screen printed just now
      await x.advance(0)
    }
    expect(x.status().needsYou).toBeUndefined()
  })
})
