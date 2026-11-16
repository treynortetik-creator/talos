// Main's first start with nobody at the pane, through MainSupervisor (main.ts + first-start.ts): a fake pane that plays the real
// Claude Code 2.1.322 first-start screens (apps/desktop/Tests/Fixtures/real-first-start-2.1.322) and moves its cursor on the keys
// it gets, a fake clock, and the one-line state the Windows tray reads (main-state.ts).
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
import { MainSupervisor } from '../../src/supervisor/main.ts'
import { type MainStateExtras, mainStateText } from '../../src/supervisor/main-state.ts'
import { systemIdentity } from '../../src/supervisor/proc.ts'

const FIX = new URL('../../../desktop/Tests/Fixtures/', import.meta.url)
const capture = (name: string, dir = 'real-first-start-2.1.322') =>
  readFileSync(new URL(`${dir}/${name}.txt`, FIX), 'utf8').split('\n')
const AGENT = '/home/talos/talos-agent'

const children: Array<ReturnType<typeof Bun.spawn>> = []
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
})

/** SYNTHETIC: the cursor moved one option row, as Claude Code redraws it (nothing else on the screen changes). */
function moveCursor(rows: string[], key: 'Up' | 'Down'): string[] {
  const h = rows.findIndex((r) => /^\s*❯ /.test(r))
  const col = (rows[h] as string).indexOf('❯')
  const step = key === 'Down' ? 1 : -1
  let to = h + step
  while (to >= 0 && to < rows.length && (rows[to] as string).trim() === '') to += step
  const out = [...rows]
  const at = (r: string, c: string) => `${r.slice(0, col)}${c}${r.slice(col + 1)}`
  out[h] = at(out[h] as string, ' ')
  out[to] = at(out[to] as string, '❯')
  return out
}
const highlighted = (rows: string[]) =>
  rows
    .find((r) => /^\s*❯ /.test(r))
    ?.replace('❯', '')
    .trim()

/** A pane playing Claude Code's first start: each screen, and what an Enter on which option leads to. */
class FirstStartPane implements PtyHost {
  readonly kind = 'tmux' as const
  rows: string[] | null
  keys: PtyDialogKey[] = []
  clients: number[] | null = []
  pid: number | null = null
  launches = 0
  /** What Enter does on the screen named, given the highlighted option: the next screen, or null to stay. */
  constructor(
    private screens: Record<string, string[]>,
    private flow: (screen: string, option: string | undefined) => string | null,
    public current: string,
  ) {
    this.rows = screens[current] ?? null
  }
  async start(_l: PtyLaunch) {
    this.launches++
    const c = Bun.spawn(['sleep', '300'], { detached: true } as never)
    children.push(c)
    this.pid = c.pid
    return c.pid
  }
  restart(l: PtyLaunch) {
    return this.start(l)
  }
  /** A Main left running by a supervisor before this one (a pid to adopt), or none. */
  adopt: number | null = null
  async attachIfRunning() {
    if (this.adopt !== null) this.pid = this.adopt
    return this.adopt
  }
  async send(): Promise<PtySendResult> {
    return 'sent'
  }
  /** Reads before a key's redraw shows (0: at once); the redraw waits that many visibleRows calls. */
  lag = 0
  private pending: { rows: string[] | null; current: string; reads: number } | null = null
  /** Keys the host's key guard refuses (nothing is sent) before it lets them through. */
  refuseNext = 0
  /** The kind each key stated (the host's key guard checks the screen is that one). */
  kinds: Array<string | undefined> = []
  async sendDialogKey(k: PtyDialogKey, kind?: string): Promise<PtySendResult> {
    this.kinds.push(kind)
    if (this.refuseNext > 0) {
      this.refuseNext--
      return 'refused'
    }
    this.keys.push(k)
    if (this.lag > 0) {
      const before = { rows: this.rows, current: this.current }
      this.applyKey(k)
      this.pending = { rows: this.rows, current: this.current, reads: this.lag }
      this.rows = before.rows
      this.current = before.current
      return 'sent'
    }
    this.applyKey(k)
    return 'sent'
  }
  private applyKey(k: PtyDialogKey) {
    if (!this.rows) return
    if (k === 'Enter') {
      const next = this.flow(this.current, highlighted(this.rows))
      if (next !== null) {
        this.current = next
        this.rows = this.screens[next] ?? null
      }
    } else this.rows = moveCursor(this.rows, k)
  }
  async visibleRows() {
    if (this.pending) {
      if (this.pending.reads-- <= 0) {
        this.rows = this.pending.rows
        this.current = this.pending.current
        this.pending = null
      }
    }
    return this.rows
  }
  async lastOutputAt() {
    return null
  }
  /** Called once per read: a test can make the second read (right before a key) differ from the first. */
  clientReads = 0
  clientsOnRead?: (n: number) => number[] | null
  async clientActivities() {
    this.clientReads++
    return this.clientsOnRead ? this.clientsOnRead(this.clientReads) : this.clients
  }
  async terminate() {}
  async close() {}
  detach() {}
  childPid() {
    return this.pid
  }
  onExit(_cb: (e: PtyExit) => void) {}
  async setMarker() {}
  async marker() {
    return null
  }
}

const READY = capture('ready-auto-notice')
const WARNING = capture('dev-channels-capture', 'real-dev-channels')
const SCREENS: Record<string, string[]> = {
  theme: capture('theme'),
  trust: capture('trust'),
  mcp: capture('mcp-consent'),
  warning: WARNING,
  ready: READY,
  login: capture('login-method'),
  api_key: capture('api-key'),
  exited: ['$ '],
  refused: capture('token-refused-401'),
  notes: capture('security-notes'),
  notlogged: capture('not-logged-in'),
}
/** Claude Code's order for a signed-in install: theme, trust, MCP consent, the warning, the box. "No, exit" exits. */
const SIGNED_IN = (screen: string, option: string | undefined) => {
  if (screen === 'theme') return 'trust'
  if (screen === 'notes') return 'trust'
  if (screen === 'trust') return option === 'Yes, I trust this folder' ? 'mcp' : 'exited'
  if (screen === 'mcp') return option === 'Use this MCP server' ? 'warning' : 'ready'
  if (screen === 'warning') return 'ready'
  return null
}

function setup(
  o: {
    approved?: boolean
    talosFolder?: boolean
    first?: string
    cfg?: Partial<MainLaunchConfig>
    notesKept?: boolean
  } = {},
) {
  const host = new FirstStartPane(SCREENS, SIGNED_IN, o.first ?? 'theme')
  let t = 1000
  const cfg: MainLaunchConfig = {
    agentDir: AGENT,
    claudePath: '/home/talos/.local/bin/claude',
    args: [
      '--plugin-dir',
      '/home/talos/talos-app/plugins/talos-app-mod',
      '--dangerously-load-development-channels',
      'server:talos-app',
    ],
    env: {},
    host: 'tmux',
    autoRestart: true,
    autoConfirmRestart: true,
    startOnLaunch: true,
    session: { id: null, previousIds: [] },
    ...o.cfg,
  }
  const audit: Array<{ e: string; f?: Record<string, string> }> = []
  const told: string[] = []
  const notes: string[][] = []
  let state = ''
  let status: MainStatus | undefined
  const sup = new MainSupervisor({
    host,
    identity: systemIdentity,
    session: 'agent',
    config: () => cfg,
    saveSessionId: () => {},
    loginEnv: () => ({ PATH: '/usr/bin:/bin', HOME: '/home/talos' }),
    resolveClaude: (p) => p,
    isDir: (p) => p === AGENT,
    newSessionId: () => '11111111-2222-3333-4444-555555555555',
    now: () => t,
    wallMs: () => t * 1000,
    random: () => 0,
    publish: (s: MainStatus, x?: MainStateExtras) => {
      status = s
      state = mainStateText(s, x)
    },
    audit: (e, f) => audit.push({ e, f }),
    tell: (e) => told.push((e as { kind: string }).kind),
    readBridgeStatus: () => undefined,
    sessionSaved: () => false,
    conversationEmpty: () => false,
    mcpLogReason: () => null,
    firstStart: { approved: () => o.approved ?? true, talosFolder: () => o.talosFolder ?? true },
    notesShown: (text) => {
      notes.push(text)
      return o.notesKept ?? true
    },
  })
  return {
    host,
    sup,
    audit,
    told,
    notes,
    state: () => state,
    status: () => status as MainStatus,
    advance: async (s: number) => {
      t += s
      await sup.tick()
    },
  }
}

describe('Main’s first start with nobody at the pane', () => {
  it('theme, trust, MCP consent and the warning are answered, one key a tick, and Main comes up', async () => {
    const x = setup()
    await x.sup.start()
    for (let i = 0; i < 30 && x.host.current !== 'ready'; i++) await x.advance(1)
    expect(x.host.current).toBe('ready')
    // theme: Enter; trust: Down, Enter; MCP: Up, Up, Enter; the warning: Enter
    expect(x.host.keys).toEqual(['Enter', 'Down', 'Enter', 'Up', 'Up', 'Enter', 'Enter'])
    // each key stated the screen it was for (Fable R4-4)
    expect(x.host.kinds).toEqual([
      'theme',
      'trust',
      'trust',
      'mcp_consent',
      'mcp_consent',
      'mcp_consent',
      'dev_channels',
    ])
    expect(x.audit.filter((a) => a.e === 'first_start_key').map((a) => a.f?.kind)).toEqual([
      'theme',
      'trust',
      'trust',
      'mcp_consent',
      'mcp_consent',
      'mcp_consent',
      'dev_channels',
    ])
    await x.advance(15)
    expect(x.status().phase).toBe('running')
    expect(x.state()).toBe('main=running\n')
  })
  it('a key the guard refused answered nothing: the same screen is answered on a later tick, and Main comes up (Fable R3-1)', async () => {
    const x = setup({ first: 'notes' })
    x.host.refuseNext = 1 // the security notes' Enter, refused once
    await x.sup.start()
    for (let i = 0; i < 30 && x.host.current !== 'ready'; i++) await x.advance(1)
    expect(x.host.current).toBe('ready')
    expect(x.host.keys).toEqual(['Enter', 'Down', 'Enter', 'Up', 'Up', 'Enter', 'Enter'])
  })
  it('a key refused again and again: three tries on that screen, then waiting on it, said once (Fable R4-5)', async () => {
    const x = setup({ first: 'notes' })
    x.host.refuseNext = 1000
    await x.sup.start()
    for (let i = 0; i < 40; i++) await x.advance(1)
    expect(x.host.kinds).toHaveLength(3)
    expect(x.state()).toBe('main=waiting:security_notes\n')
    expect(x.audit.filter((a) => a.e === 'first_start_waiting')).toHaveLength(1)
    expect(x.audit.filter((a) => a.e === 'first_start_key')).toHaveLength(3)
  })
  it('with a token set: the security notes come before the trust, and get their Enter', async () => {
    const x = setup({ first: 'notes' })
    await x.sup.start()
    for (let i = 0; i < 30 && x.host.current !== 'ready'; i++) await x.advance(1)
    expect(x.host.current).toBe('ready')
    expect(x.host.keys).toEqual(['Enter', 'Down', 'Enter', 'Up', 'Up', 'Enter', 'Enter'])
    // the notes' text was kept for the owner, once
    expect(x.notes).toHaveLength(1)
    expect(x.notes[0]?.[0]).toBe('Security notes:')
    expect(x.notes[0]).toContain('1. Claude can make mistakes.')
  })
  it('without the root approval only the theme is answered: trust waits, and the state file says so', async () => {
    const x = setup({ approved: false })
    await x.sup.start()
    for (let i = 0; i < 5; i++) await x.advance(1)
    expect(x.host.keys).toEqual(['Enter'])
    expect(x.host.current).toBe('trust')
    expect(x.state()).toBe('main=waiting:trust\n')
    expect(x.audit.filter((a) => a.e === 'first_start_waiting')).toHaveLength(1) // said once, not every tick
  })
  it('the owner’s auto_confirm_restart off: the same', async () => {
    const x = setup({ cfg: { autoConfirmRestart: false } })
    await x.sup.start()
    for (let i = 0; i < 5; i++) await x.advance(1)
    expect(x.host.keys).toEqual(['Enter'])
    expect(x.state()).toBe('main=waiting:trust\n')
  })
  it('a folder without .talos-version is never trusted', async () => {
    const x = setup({ talosFolder: false, first: 'trust' })
    await x.sup.start()
    for (let i = 0; i < 5; i++) await x.advance(1)
    expect(x.host.keys).toEqual([])
    expect(x.state()).toBe('main=waiting:trust\n')
  })
  it('someone attached to the pane: nothing is pressed, not even the theme; once they leave, it goes on', async () => {
    const x = setup()
    x.host.clients = [Date.now()]
    await x.sup.start()
    for (let i = 0; i < 3; i++) await x.advance(1)
    expect(x.host.keys).toEqual([])
    expect(x.state()).toBe('main=waiting:theme\n')
    x.host.clients = null // could not be read: the same
    await x.advance(1)
    expect(x.host.keys).toEqual([])
    x.host.clients = []
    await x.advance(1)
    expect(x.host.keys).toEqual(['Enter'])
  })
  it('the sign-in screen is never answered: main=signin', async () => {
    const x = setup({ first: 'login' })
    await x.sup.start()
    for (let i = 0; i < 5; i++) await x.advance(1)
    expect(x.host.keys).toEqual([])
    expect(x.state()).toBe('main=signin\n')
    // said once in the log, however many ticks it stays
    expect(x.audit.filter((a) => a.e === 'first_start_signin')).toHaveLength(1)
  })
  it('the API-key question is never answered: main=waiting:api_key', async () => {
    const x = setup({ first: 'api_key' })
    await x.sup.start()
    for (let i = 0; i < 5; i++) await x.advance(1)
    expect(x.host.keys).toEqual([])
    expect(x.state()).toBe('main=waiting:api_key\n')
  })
  it('a screen nobody knows is reported with its text, never answered', async () => {
    const x = setup({ first: 'odd' })
    x.host.rows = [
      'Something new from Claude Code: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '❯ 1. Accept',
      '  2. Decline',
      'Enter to confirm · Esc to cancel',
    ]
    await x.sup.start()
    await x.advance(1)
    expect(x.host.keys).toEqual([])
    const [line, excerpt] = x.state().split('\n')
    expect(line).toBe('main=waiting:unknown')
    expect(excerpt).toContain('Something new from Claude Code')
    expect(excerpt).not.toContain('sk-ant-api03')
  })
  it('an Enter is sent once per kind: a warning that stays after its Enter is left to the owner', async () => {
    const x = setup({ first: 'warning' })
    // a pane whose warning does not go away on Enter
    ;(x.host as unknown as { flow: () => null }).flow = () => null
    await x.sup.start()
    for (let i = 0; i < 4; i++) await x.advance(1)
    expect(x.host.keys).toEqual(['Enter'])
    expect(x.state()).toBe('main=waiting:dev_channels\n')
  })
  it('the warning past the 60 s window after the spawn is not answered', async () => {
    const x = setup({ first: 'warning' })
    x.host.rows = null // nothing readable for a while
    await x.sup.start()
    await x.advance(61)
    x.host.rows = WARNING
    await x.advance(1)
    expect(x.host.keys).toEqual([])
    expect(x.state()).toBe('main=waiting:dev_channels\n')
  })
  it('a refused token (Claude Code’s 401 on its first answer): main=signin, never a crash loop; a later answer clears it', async () => {
    const x = setup({ first: 'refused' })
    await x.sup.start()
    for (let i = 0; i < 3; i++) await x.advance(1)
    expect(x.host.keys).toEqual([])
    expect(x.state()).toBe('main=signin\n')
    expect(x.sup.signedOut()).toBe(true)
    expect(x.host.launches).toBe(1) // started once, nothing restarted
    x.host.rows = [...(x.host.rows as string[]).slice(0, 14), '● Hello!', ...READY.slice(-5)]
    await x.advance(1)
    expect(x.sup.signedOut()).toBe(false)
    expect(x.state()).not.toContain('signin')
  })
  it('a key goes only to a screen read the same twice in a row: a screen that keeps changing gets none (Fable)', async () => {
    const x = setup({ first: 'theme' })
    await x.sup.start()
    const theme = SCREENS.theme as string[]
    for (let i = 0; i < 5; i++) {
      // each read differs from the last (a redraw in progress)
      x.host.rows = [...theme, i % 2 ? ' ' : '  ']
      await x.advance(1)
    }
    expect(x.host.keys).toEqual([])
    await x.advance(1) // the same again: now it is answered
    expect(x.host.keys).toEqual(['Enter'])
  })
  it('an owner who attaches between the decision and the key gets the screen untouched (Fable)', async () => {
    const x = setup({ first: 'theme' })
    // nobody attached at the decision, someone attached on the read right before the key
    x.host.clientsOnRead = (n) => (n % 2 === 0 ? [Date.now()] : [])
    await x.sup.start()
    for (let i = 0; i < 6; i++) await x.advance(1)
    expect(x.host.keys).toEqual([])
    expect(x.state()).toBe('main=waiting:theme\n')
  })
  it('the security notes are answered only once their text is kept: a failed write withholds the Enter (Fable)', async () => {
    const x = setup({ first: 'notes', notesKept: false })
    await x.sup.start()
    for (let i = 0; i < 6; i++) await x.advance(1)
    expect(x.host.keys).toEqual([])
    expect(x.state()).toBe('main=waiting:security_notes\n')
  })
  it('a redraw that lags behind a key never takes a second key: arrows land where meant, then Enter (Fable)', async () => {
    const x = setup()
    x.host.lag = 2 // each key shows only two reads later
    await x.sup.start()
    for (let i = 0; i < 60 && x.host.current !== 'ready'; i++) await x.advance(1)
    expect(x.host.current).toBe('ready')
    expect(x.host.keys).toEqual(['Enter', 'Down', 'Enter', 'Up', 'Up', 'Enter', 'Enter'])
  })
  it('a key the screen never answers: nothing more is sent, and after a few ticks the start says it waits', async () => {
    const x = setup({ first: 'theme' })
    ;(x.host as unknown as { flow: () => null }).flow = () => null // Enter on the theme does nothing
    await x.sup.start()
    for (let i = 0; i < 10; i++) await x.advance(1)
    expect(x.host.keys).toEqual(['Enter'])
    expect(x.state().split('\n')[0]).toBe('main=waiting:unknown')
  })
  it('notes whose text cannot be saved are tried once per screen, not every tick (Fable)', async () => {
    const x = setup({ first: 'notes', notesKept: false })
    await x.sup.start()
    for (let i = 0; i < 8; i++) await x.advance(1)
    expect(x.notes).toHaveLength(1)
    expect(x.audit.filter((a) => a.e === 'first_start_waiting' && a.f?.kind === 'security_notes')).toHaveLength(1)
  })
  it('signed out at the input box (no login screen, onboarding done): main=signin, nothing pressed', async () => {
    const x = setup({ first: 'notlogged' })
    await x.sup.start()
    for (let i = 0; i < 4; i++) await x.advance(1)
    expect(x.host.keys).toEqual([])
    expect(x.state()).toBe('main=signin\n')
    expect(x.sup.signedOut()).toBe(true) // a new token from the tray starts Main again (cli.ts)
    expect(x.audit.filter((a) => a.e === 'first_start_signin').map((a) => a.f?.why)).toEqual(['not logged in'])
  })
  it('an adopted Main (left by the supervisor before) that is signed out still reads main=signin (Fable)', async () => {
    const x = setup({ first: 'notlogged' })
    const c = Bun.spawn(['sleep', '300'], { detached: true } as never)
    children.push(c)
    x.host.adopt = c.pid
    await x.sup.attachOrStart(false)
    for (let i = 0; i < 2; i++) await x.advance(1)
    expect(x.state()).toBe('main=signin\n')
    expect(x.sup.signedOut()).toBe(true)
  })
  it('the supervisor’s own quiet stop (to start again with a new token) tells the owner nothing (Fable)', async () => {
    const x = setup({ first: 'ready' })
    await x.sup.start()
    await x.advance(1)
    await x.sup.stop({ quiet: true })
    for (let i = 0; i < 40 && x.status().phase !== 'stopped'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      await x.advance(1)
    }
    expect(x.status().phase).toBe('stopped')
    expect(x.told).not.toContain('stopped')
    await x.sup.start()
    await x.sup.stop()
    for (let i = 0; i < 40 && x.status().phase !== 'stopped'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      await x.advance(1)
    }
    expect(x.told).toContain('stopped') // the owner's own stop is still told
  })
  it('sign-in is said in the log once per start, however often it turns off and on (Codex)', async () => {
    const x = setup({ first: 'refused' })
    await x.sup.start()
    await x.advance(1)
    const refused = x.host.rows as string[]
    for (let i = 0; i < 3; i++) {
      x.host.rows = READY // off
      await x.advance(1)
      x.host.rows = refused // on again
      await x.advance(1)
    }
    expect(x.audit.filter((a) => a.e === 'first_start_signin')).toHaveLength(1)
  })
  it('a token refused after Main has answered (expired or revoked mid-session) is reported; the next answer clears it (Fable R2-2)', async () => {
    const x = setup({ first: 'ready' })
    await x.sup.start()
    const box = READY.slice(-5)
    x.host.rows = ['❯ hi', '● Hello! How can I help?', ...box]
    await x.advance(1)
    expect(x.state()).not.toContain('signin')
    x.host.rows = [
      '❯ hi',
      '● Hello! How can I help?',
      '❯ more',
      '● Please run /login · API Error: 401 Invalid bearer token',
      ...box,
    ]
    await x.advance(1)
    expect(x.state()).toBe('main=signin\n')
    expect(x.sup.signedOut()).toBe(true)
    expect(x.audit.filter((a) => a.e === 'first_start_signin').map((a) => a.f?.why)).toEqual(['the token was refused'])
    x.host.rows = ['❯ again', '● Done.', ...box]
    await x.advance(1)
    expect(x.state()).not.toContain('signin')
  })
  it('an adopted Main whose screen already ends at a refused answer reads signin at once (Fable R2-2)', async () => {
    const x = setup({ first: 'refused' })
    const c = Bun.spawn(['sleep', '300'], { detached: true } as never)
    children.push(c)
    x.host.adopt = c.pid
    x.host.rows = [
      '❯ hi',
      '● Hello!',
      '❯ more',
      '● Please run /login · API Error: 401 Invalid bearer token',
      ...READY.slice(-5),
    ]
    await x.sup.attachOrStart(false)
    await x.advance(1)
    expect(x.state()).toBe('main=signin\n')
  })
})
