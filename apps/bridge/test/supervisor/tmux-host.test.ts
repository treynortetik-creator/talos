// ci-requires: tmux
// (CI deals this file only to a machine that has tmux 3.2+: docs/CI-MACHINES.md, "Tools a test file needs".)
// The tmux PtyHost against a REAL tmux on a private socket (talos-test-<pid>-<n>): the owner's `talos` server and their own
// tmux are never touched. Skipped where tmux (>= 3.2) is missing.
import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PtyExit, PtyLaunch } from '@talos-app/protocol'
import { tmuxTestPrefix } from '@talos-app/testkit'
import { groupAlive, type ProcIdentity, runTool, signalOwnGroup, systemIdentity } from '../../src/supervisor/proc.ts'
import {
  isEmptyPaneRow,
  literalArg,
  literalPath,
  parseCapture,
  parseClientActivity,
  parsePaneState,
  parseSignal,
  parseVersion,
  saysGone,
  TmuxCommands,
  versionIsSupported,
} from '../../src/supervisor/tmux-commands.ts'
import { PtyHostError, TmuxPtyHost } from '../../src/supervisor/tmux-host.ts'
import { isUsageLimit } from '../../src/supervisor/usage-limit.ts'

const CONF = resolve(import.meta.dir, '../../../desktop/Resources/tmux.conf')
const TMUX = spawnSync('sh', ['-c', 'command -v tmux']).stdout?.toString().trim() ?? ''
// tmux alone: the host's process identity (proc-identity.ts) reads /proc on Linux and `ps` elsewhere, so this runs on a Mac too
const haveTmux = TMUX !== '' && versionIsSupported(spawnSync(TMUX, ['-V']).stdout?.toString() ?? '')

/** The shared proc-identity helper, as the host uses it by default. */
const identity: ProcIdentity = systemIdentity

describe('tmux commands', () => {
  it('a trailing `;` is escaped so tmux does not end the command there; `#` in a folder is literal', () => {
    expect(literalArg('be brief;')).toBe('be brief\\;')
    expect(literalArg('a;b')).toBe('a;b')
    expect(literalPath('/x/#{l:evil}')).toBe('/x/##{l:evil}')
  })
  it('versions, pane rows, signals, captures and clients parse the way tmux 3.8 prints them', () => {
    expect(parseVersion('tmux 3.8')).toEqual([3, 8])
    expect(parseVersion('tmux 3.3a')).toEqual([3, 3])
    expect(parseVersion('tmux next-3.6')).toEqual([3, 6])
    expect(versionIsSupported('tmux 3.1c')).toBe(false)
    expect(versionIsSupported('tmux 3.2')).toBe(true)
    expect(parsePaneState('1234|0|||1700000000|1690000000|%3')).toMatchObject({ pid: 1234, dead: false, paneId: '%3' })
    expect(parsePaneState('|1|0|term|1700000000|1690000000|%3')).toMatchObject({
      pid: null,
      dead: true,
      exitSignal: 15,
    })
    expect(parsePaneState('|0||||||')).toBeNull()
    expect(isEmptyPaneRow('||||||')).toBe(true)
    // Linux numbers, not the Mac's (usr1 is 10 here, 30 on macOS)
    expect(parseSignal('usr1')).toBe(process.platform === 'linux' ? 10 : 30)
    expect(parseSignal('SIGKILL')).toBe(9)
    expect(parseSignal('9')).toBe(9)
    expect(parseSignal('nonsense')).toBe(-1)
    expect(parseCapture('a\r\nb\n\n  \n')).toEqual(['a', 'b'])
    expect(parseClientActivity('')).toEqual([])
    expect(parseClientActivity('1700000000\n1700000001\n')).toEqual([1700000000, 1700000001])
    expect(parseClientActivity('17x\n')).toBeNull()
    expect(saysGone(1, "can't find session: =agent", false)).toBe(true)
    expect(saysGone(1, "can't find session: =agent", true)).toBe(false)
    expect(saysGone(1, 'some other error', false)).toBe(false)
  })
  it('targets our own pane by id and the session exactly', () => {
    const c = new TmuxCommands('tmux', '/c.conf', 't-trip', 'talos').withPane('%7')
    expect(c.capturePane()).toEqual(['tmux', '-L', 'talos', '-f', '/c.conf', 'capture-pane', '-p', '-J', '-t', '%7'])
    expect(c.killSession()).toContain('=t-trip')
    expect(c.withPane('not-a-pane').paneTarget).toBe('=t-trip:')
  })
})

let n = 0
const hosts: TmuxPtyHost[] = []
const sockets: string[] = []
const dirs: string[] = []
afterEach(() => {
  for (const h of hosts.splice(0)) h.detach()
  for (const s of sockets.splice(0)) {
    // the host strips TMUX_TMPDIR, so its servers live under /tmp/tmux-<uid>: clean up there, whatever this shell has set
    spawnSync(TMUX, ['-L', s, 'kill-server'], { env: { PATH: process.env.PATH ?? '' } })
    rmSync(join('/tmp', `tmux-${process.getuid?.()}`, s), { force: true }) // tmux leaves the socket file behind
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function host(session = 'agent', pollMs = 100, over: Partial<ConstructorParameters<typeof TmuxPtyHost>[0]> = {}) {
  const socket = over.socket ?? `${tmuxTestPrefix()}-${process.pid}-${n++}`
  if (!sockets.includes(socket)) sockets.push(socket)
  const h = new TmuxPtyHost({
    tmux: TMUX,
    configPath: CONF,
    session,
    socket,
    identity,
    pollMs,
    baseEnv: { PATH: process.env.PATH, SUPERVISOR_SECRET: 'sup' },
    launchDir: join(dir(), 'launch'),
    // these tests drive a plain shell (no input box): the tmux plumbing is under test here, so every key may go; the usage-limit
    // test below passes keyGuard: undefined, the real guard
    keyGuard: () => true,
    ...over,
  })
  hosts.push(h)
  return { h, socket }
}

const groupMembers = (pgid: number) =>
  spawnSync('pgrep', ['-g', String(pgid)])
    .stdout.toString()
    .trim()
    .split('\n')
    .filter(Boolean)

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'talos-tmux-'))
  dirs.push(d)
  return d
}

const launch = (argv: string[], over: Partial<PtyLaunch> = {}): PtyLaunch => ({
  session: 'agent',
  argv,
  cwd: dir(),
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
  ...over,
})

async function until<T>(
  f: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  ms = 8_000,
): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v as T
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const exited = (h: TmuxPtyHost) =>
  new Promise<PtyExit>((resolveExit) => {
    h.onExit(resolveExit)
  })

describe.skipIf(!haveTmux)('the tmux host (real tmux, private socket)', () => {
  it('starts the agent as its own process group, shows its screen, and reads typed keys', async () => {
    const { h } = host()
    const pid = await h.start(launch(['sh', '-c', 'echo ready; read line; echo "got:$line"; sleep 30']))
    expect(identity.processGroup(pid)).toBe(pid)
    expect(h.childPid()).toBe(pid)
    await until(async () => (await h.visibleRows())?.includes('ready'))
    expect(await h.send(new TextEncoder().encode('hello\r'))).toBe('sent')
    await until(async () => (await h.visibleRows())?.some((r) => r === 'got:hello'))
    expect(await h.clientActivities()).toEqual([])
    expect(await h.lastOutputAt()).toBeGreaterThan(Date.now() - 60_000)
  })
  it('passes the environment it is given and nothing else, and refuses a second start', async () => {
    const { h } = host()
    const l = launch(['sh', '-c', 'echo "v=$TALOS_X t=$TMUX c=$CLAUDECODE"; sleep 30'], {
      env: { PATH: process.env.PATH ?? '', TALOS_X: 'yes; really;', TMUX: '/tmp/x,1,0', CLAUDECODE: '1' },
    })
    await h.start(l)
    const rows = await until(async () => {
      const r = await h.visibleRows()
      return r?.some((x) => x.startsWith('v=')) ? r : null
    })
    // the launch's own TMUX is dropped, and the pane starts from an empty environment, so tmux's TMUX is not there either;
    // CLAUDECODE is the launch's own choice here (the caller scrubs it before the launch)
    expect(rows.find((x) => x.startsWith('v='))).toBe('v=yes; really; t= c=1')
    await expect(h.start(l)).rejects.toMatchObject({ code: 'already_running' })
  })
  it('the token: the launch file names its file and reads it as the pane starts, never holds the token (Pantheon)', async () => {
    const { h } = host()
    const d = dir()
    const tokenFile = join(d, 'claude-oauth-token')
    writeFileSync(tokenFile, 'sk-ant-oat01-launchread0000000000000000000000\n', { mode: 0o600 })
    // the launch file is read before it removes itself: hold a copy by watching the folder (the body is what matters)
    const l = launch(['sh', '-c', 'echo "tok=$CLAUDE_CODE_OAUTH_TOKEN f=$TALOS_APP_OAUTH_TOKEN_FILE"; sleep 30'], {
      env: {
        PATH: process.env.PATH ?? '',
        TALOS_APP_OAUTH_TOKEN_FILE: tokenFile,
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fromtheenvironment000000000000',
      },
    })
    const body = (h as unknown as { writeLaunch(l: PtyLaunch): { file: string } }).writeLaunch(l)
    const text = readFileSync(body.file, 'utf8')
    rmSync(body.file)
    expect(text).not.toContain('launchread')
    expect(text).not.toContain('fromtheenvironment')
    expect(text).toContain(`cat -- '${tokenFile}'`)
    await h.start(l)
    const rows = await until(async () => {
      const r = await h.visibleRows()
      return r?.some((x) => x.startsWith('tok=')) ? r : null
    })
    // the file's token, its trailing newline gone; the file name itself never reaches the agent
    expect(rows.find((x) => x.startsWith('tok='))).toBe('tok=sk-ant-oat01-launchread0000000000000000000000 f=')
  })
  it('the token: a link where the token file should be is never read', async () => {
    const { h } = host()
    const d = dir()
    const real = join(d, 'real')
    writeFileSync(real, 'sk-ant-oat01-throughalink00000000000000000000\n', { mode: 0o600 })
    symlinkSync(real, join(d, 'claude-oauth-token'))
    await h.start(
      launch(['sh', '-c', 'echo "tok=[$CLAUDE_CODE_OAUTH_TOKEN]"; sleep 30'], {
        env: { PATH: process.env.PATH ?? '', TALOS_APP_OAUTH_TOKEN_FILE: join(d, 'claude-oauth-token') },
      }),
    )
    const rows = await until(async () => {
      const r = await h.visibleRows()
      return r?.some((x) => x.startsWith('tok=')) ? r : null
    })
    expect(rows.find((x) => x.startsWith('tok='))).toBe('tok=[]')
  })
  it('an argument ending in `;` and a folder with `#` arrive exactly as typed', async () => {
    const { h } = host()
    const cwd = join(dir(), 'odd#{l:x}')
    mkdirSync(cwd)
    await h.start(launch(['sh', '-c', 'echo "[$1]"; pwd; sleep 30', 'sh', 'be brief;'], { cwd }))
    const rows = await until(async () => {
      const r = await h.visibleRows()
      return r && r.length >= 2 ? r : null
    })
    expect(rows).toContain('[be brief;]')
    // the pane starts with no PWD, so its pwd is the physical path: a symlinked tmp (macOS /tmp, /var) reads resolved
    expect(rows).toContain(realpathSync(cwd))
  })
  it('reports an exit with its code and last rows; a signal death reports the signal', async () => {
    const { h } = host()
    const done = exited(h)
    const pid = await h.start(launch(['sh', '-c', 'echo last words; sleep 0.5; exit 3']))
    const e = await done
    expect(e).toMatchObject({ pid, code: 3, signal: null, hostLost: false })
    expect(e.lastRows).toContain('last words')
    expect(e.lastRows.some((r) => r.startsWith('Pane is dead'))).toBe(false)

    const again = exited(h)
    const pid2 = await h.restart(launch(['sh', '-c', 'sleep 30']))
    expect(pid2).not.toBe(pid)
    process.kill(pid2, 'SIGTERM')
    expect(await again).toMatchObject({ pid: pid2, code: null, signal: 15, hostLost: false })
  })
  it('a restart clears the old screen and history: nothing from the last run is read as this run', async () => {
    const { h } = host()
    await h.start(launch(['sh', '-c', 'echo OLD-RUN; sleep 30']))
    await until(async () => (await h.visibleRows())?.includes('OLD-RUN'))
    await h.restart(launch(['sh', '-c', 'echo NEW-RUN; sleep 30']))
    const rows = await until(async () => {
      const r = await h.visibleRows({ scrollback: 200 })
      return r?.includes('NEW-RUN') ? r : null
    })
    expect(rows).not.toContain('OLD-RUN')
  })
  it('a session killed by hand is a lost host, not an agent exit', async () => {
    const { h, socket } = host()
    const done = exited(h)
    await h.start(launch(['sh', '-c', 'sleep 30']))
    spawnSync(TMUX, ['-L', socket, 'kill-session', '-t', '=agent'])
    expect(await done).toMatchObject({ hostLost: true, code: null, signal: null })
  })
  it('an agent that dies at once is a start error carrying what it printed', async () => {
    const { h } = host()
    const err = await h.start(launch(['sh', '-c', 'echo "No session found with ID abc"; exit 1'])).catch((e) => e)
    // tmux may still report the pane alive for a moment; then the exit comes through onExit instead
    if (err instanceof PtyHostError) {
      expect(err.code).toBe('exited_immediately')
      expect(err.rows.join('\n')).toContain('No session found with ID abc')
    } else {
      expect(typeof err).toBe('number')
    }
  })
  it('a later host adopts a running session, its markers survive, and terminate ends the whole group', async () => {
    const { h, socket } = host()
    const pid = await h.start(launch(['sh', '-c', 'sleep 300 & sleep 300; wait']))
    await h.setMarker('launch', 'abc;')
    h.detach()
    const later = new TmuxPtyHost({
      tmux: TMUX,
      configPath: CONF,
      session: 'agent',
      socket,
      identity,
      pollMs: 100,
      launchDir: join(dir(), 'l2'),
    })
    hosts.push(later)
    expect(await later.attachIfRunning('agent')).toBe(pid)
    expect(await later.marker('launch')).toBe('abc;')
    expect(await later.marker('session')).toBeNull()
    await until(() => {
      const r = spawnSync('pgrep', ['-g', String(pid)])
        .stdout.toString()
        .trim()
        .split('\n')
        .filter(Boolean)
      return r.length >= 3
    })
    await later.terminate(2_000)
    await until(() => spawnSync('pgrep', ['-g', String(pid)]).status !== 0)
    expect(spawnSync(TMUX, ['-L', socket, 'has-session', '-t', '=agent']).status).not.toBe(0)
  })
  it('a group is signalled only while its leader is the process that was started (same start time, still leading)', async () => {
    const child = Bun.spawn(['sleep', '30'], { detached: true } as never)
    try {
      const pid = child.pid
      await until(() => identity.processGroup(pid) === pid)
      const started = identity.processStartTime(pid) as string
      // a reused pid: same number, another start time
      expect(signalOwnGroup({ ...identity, processStartTime: () => 'another-start' }, pid, started, 'SIGTERM')).toBe(
        false,
      )
      // a pid that left its group
      expect(signalOwnGroup({ ...identity, processGroup: () => 1 }, pid, started, 'SIGTERM')).toBe(false)
      expect(groupAlive(pid)).toBe(true)
      expect(signalOwnGroup(identity, pid, started, 'SIGTERM')).toBe(true)
      await child.exited
      expect(child.signalCode).toBe('SIGTERM')
    } finally {
      child.kill()
    }
  })
  it('no key Talos sends reaches the usage-limit screen (one of its options spends usage credits): every sender refuses', async () => {
    // the pane shows the SYNTHETIC usage-limit screen (apps/desktop/Tests/Fixtures/synthetic, built from the CLI's strings) and
    // records anything that reaches it; the cursor is on the credits option, so one Enter would spend money
    const screen = join(import.meta.dir, '../../../desktop/Tests/Fixtures/synthetic/usage-limit-cursor3.txt')
    const got = join(dir(), 'got')
    const { h } = host('agent', 100, { keyGuard: undefined }) // the real guard
    await h.start(
      launch([
        'sh',
        '-c',
        `stty -echo -icanon; cat "$0"; while :; do dd bs=1 count=1 2>/dev/null >> "$1"; done`,
        screen,
        got,
      ]),
    )
    await until(async () => {
      const r = await h.visibleRows()
      return r !== null && r.some((l) => l.includes('usage credits')) && isUsageLimit(r)
    })
    expect(await h.sendDialogKey('Enter')).toBe('refused')
    expect(await h.sendDialogKey('Down')).toBe('refused')
    expect(await h.sendEnterKey()).toBe('refused')
    expect(await h.sendText('abc')).toBe('refused')
    expect(await h.sendBackspaces(1)).toBe('refused')
    expect(await h.sendLine('hello')).toBe('refused')
    expect(await h.send(new TextEncoder().encode('3'))).toBe('refused')
    expect(await h.sendText('abc')).toBe('refused')
    expect(h.lastKeyRefusal()).toEqual({ why: 'usage_limit' }) // kept for the audit (Fable R4-3)
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(got) ? readFileSync(got, 'utf8') : '').toBe('')
  })
  it('each sender states what it means to press; one with no kind states none (Fable R4-4)', async () => {
    const seen: unknown[] = []
    const { h } = host('agent', 100, {
      keyGuard: (_rows, intent) => {
        seen.push(intent)
        return false
      },
    })
    await h.start(launch(['sh', '-c', 'stty -echo; cat > /dev/null']))
    await until(async () => (await h.visibleRows()) !== null)
    expect(await h.sendText('abc')).toBe('refused')
    expect(await h.sendEnterKey()).toBe('refused')
    expect(await h.sendBackspaces(1)).toBe('refused')
    expect(await h.sendDialogKey('Enter', 'theme')).toBe('refused')
    expect(await h.sendDialogKey('Down', 'mcp_consent')).toBe('refused')
    expect(await h.sendDialogKey('Enter')).toBe('refused')
    expect(await h.send(new TextEncoder().encode('3'))).toBe('refused')
    expect(await h.sendLine('hello')).toBe('refused')
    expect(seen).toEqual([
      { type: 'box', holds: 'empty' },
      { type: 'box', holds: 'ours' },
      { type: 'box', holds: 'ours' },
      { type: 'dialog', kind: 'theme' },
      { type: 'dialog', kind: 'mcp_consent' },
      undefined,
      undefined,
      undefined,
    ])
  })
  it('sendLine looks again before its Enter: a menu that came up after the text went in gets no Enter (Fable R1-4)', async () => {
    let looks = 0
    const { h } = host('agent', 100, { keyGuard: () => ++looks === 1 }) // yes for the text, no for the Enter
    const got = join(dir(), 'got')
    await h.start(
      launch(['sh', '-c', `stty -echo -icanon; while :; do dd bs=1 count=1 2>/dev/null >> "$0"; done`, got]),
    )
    await until(async () => (await h.visibleRows()) !== null)
    looks = 0
    expect(await h.sendLine('hello')).toBe('refused')
    await until(async () => existsSync(got) && readFileSync(got, 'utf8') === 'hello')
    await new Promise((r) => setTimeout(r, 300))
    expect(readFileSync(got, 'utf8')).toBe('hello') // the text, and no Enter after it
  })
  it('dialog keys go by name and only Up, Down and Enter; a typed line is literal', async () => {
    const { h } = host()
    await h.start(launch(['sh', '-c', 'stty -echo; while IFS= read -r l; do printf "[%s]\\n" "$l"; done']))
    await until(async () => (await h.visibleRows()) !== null)
    expect(await h.sendDialogKey('Enter')).toBe('sent')
    expect(await h.sendDialogKey('Escape' as never)).toBe('failed')
    expect(await h.sendLine('$HOME; `x`')).toBe('sent')
    const rows = await until(async () => {
      const r = await h.visibleRows()
      return r?.includes('[$HOME; `x`]') ? r : null
    })
    expect(rows).toContain('[]') // the Enter key on its own
  })
  it('terminate ends what the agent left in its group after it died (the cleanup before a restart)', async () => {
    const { h } = host()
    const done = exited(h)
    const pid = await h.start(launch(['sh', '-c', '(trap "" HUP TERM; exec sleep 300) & sleep 0.5; exit 1']))
    expect(await done).toMatchObject({ pid, code: 1 })
    expect(groupMembers(pid).length).toBe(1) // the child that ignores HUP and TERM
    await h.terminate(500)
    await until(() => groupMembers(pid).length === 0)
  })
  it('a pane read that times out never kills or doubles a running agent', async () => {
    const { h, socket } = host()
    const pid = await h.start(launch(['sh', '-c', 'sleep 30']))
    let timeouts = 0
    const flaky: typeof runTool = async (argv, env, ms) => {
      if (argv.includes('display-message') && timeouts > 0) {
        timeouts--
        return { ok: false, status: -1, out: '', err: '', timedOut: true }
      }
      return runTool(argv, env, ms)
    }
    const later = host('agent', 100, { socket, run: flaky }).h
    timeouts = 1 // one slow read, then an answer: the live agent is refused, not respawned
    await expect(later.start(launch(['sh', '-c', 'sleep 30']))).rejects.toMatchObject({ code: 'already_running' })
    timeouts = 99 // no answer at all: nothing is started
    await expect(later.start(launch(['sh', '-c', 'sleep 30']))).rejects.toMatchObject({ code: 'start_failed' })
    const panes = spawnSync(TMUX, ['-L', socket, 'list-panes', '-s', '-t', '=agent', '-F', '#{pane_pid}'], {
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(panes.stdout.toString().trim()).toBe(String(pid))
    expect(h.childPid()).toBe(pid)
  })
  it('an exit during a restart is never reported against the old pid', async () => {
    const { h } = host('agent', 20)
    const seen: PtyExit[] = []
    h.onExit((e) => seen.push(e))
    const old = await h.start(launch(['sh', '-c', 'sleep 30']))
    for (let i = 0; i < 5; i++) {
      const r = await h.restart(launch(['sh', '-c', 'exit 7'])).catch((e) => e)
      await new Promise((res) => setTimeout(res, 100))
      if (typeof r === 'number') expect(seen.filter((e) => e.pid !== r && e.pid === old)).toEqual([])
      else expect(r).toMatchObject({ code: 'exited_immediately' })
    }
    expect(seen.some((e) => e.pid === old)).toBe(false)
  })
  it('a poll already running when the host detaches reports nothing', async () => {
    let gate: (() => void) | undefined
    let held = false
    const slow: typeof runTool = async (argv, env, ms) => {
      if (held && argv.includes('display-message')) await new Promise<void>((r) => (gate = r))
      return runTool(argv, env, ms)
    }
    const { h } = host('agent', 60_000, { run: slow })
    let reported = 0
    h.onExit(() => reported++)
    const pid = await h.start(launch(['sh', '-c', 'sleep 30']))
    held = true
    const polling = h.poll()
    await until(() => gate !== undefined)
    h.detach()
    process.kill(pid, 'SIGKILL')
    await until(() => spawnSync('kill', ['-0', String(pid)]).status !== 0)
    gate?.()
    await polling
    expect(reported).toBe(0)
  })
  it('a one-element argv is a program, never a shell command line; an empty one runs nothing', async () => {
    const { h } = host()
    const r = await h.start(launch(['echo A1; echo A2 $HOME; sleep 30'])).catch((e) => e)
    const read = async () => (await h.visibleRows({ scrollback: 50 })) ?? (r instanceof PtyHostError ? r.rows : [])
    // The pane draws its error a moment after start returns: one read 47 ms in found it still empty on a loaded machine. Read
    // until the command's text shows, or a shell's own `A1` line would have, at most 5 s; then judge the last read.
    const rows = await until(async () => {
      const x = await read()
      return x.join('\n').includes('echo A1; echo A2 $HOME; sleep 30') || x.includes('A1') ? x : null
    }, 5_000).catch(read)
    // nothing was run by a shell: no `A1` line of its own and no expanded $HOME (an error may quote the text itself)
    expect(rows).not.toContain('A1')
    expect(rows.join('\n')).not.toContain(`A2 ${process.env.HOME}`)
    expect(rows.join('\n')).toContain('echo A1; echo A2 $HOME; sleep 30')
    await expect(host().h.start(launch([]))).rejects.toMatchObject({ code: 'start_failed' })
  })
  it('a pane gets exactly its own launch’s environment: not the supervisor’s, not another session’s, no marker', async () => {
    const { h, socket } = host('agent')
    const show =
      'echo "s=${MAIN_SECRET:-none} u=${SUPERVISOR_SECRET:-none} c=${CLAUDECODE:-none} o=${OWN:-none}"; sleep 30'
    const line = async (x: TmuxPtyHost) => {
      await until(async () => (await x.visibleRows())?.some((r) => r.startsWith('s=')))
      return (await x.visibleRows())?.find((r) => r.startsWith('s='))
    }
    await h.start(launch(['sh', '-c', show], { env: { PATH: process.env.PATH ?? '', MAIN_SECRET: 's1', OWN: 'a' } }))
    expect(await line(h)).toBe('s=s1 u=none c=none o=a')
    // something put a marker into the running server (a polluted process started it, or set it later)
    spawnSync(TMUX, ['-L', socket, 'set-environment', '-g', 'CLAUDECODE', '1'], {
      env: { PATH: process.env.PATH ?? '' },
    })
    const second = host('t-trip', 100, { socket }).h
    await second.start(
      launch(['sh', '-c', show], { session: 't-trip', env: { PATH: process.env.PATH ?? '', OWN: 'b' } }),
    )
    expect(await line(second)).toBe('s=none u=none c=none o=b')
    // a respawn whose launch drops a variable does not keep it from the session's last launch
    await h.restart(launch(['sh', '-c', show], { env: { PATH: process.env.PATH ?? '' } }))
    expect(await line(h)).toBe('s=none u=none c=none o=none')
  })
  it('a typed line with a line break in it is refused (it would submit early)', async () => {
    const { h } = host()
    await h.start(launch(['sh', '-c', 'sleep 30']))
    expect(await h.sendLine('a\nb')).toBe('failed')
    expect(await h.sendLine('a\rb')).toBe('failed')
  })
  it('no environment value reaches any argv, set-environment is never used, and the launch file is private and gone', async () => {
    const calls: string[][] = []
    let fileMode = -1
    const spy: typeof runTool = async (argv, env, ms) => {
      calls.push(argv)
      const file = argv[argv.length - 1] as string
      if (argv.includes('new-session') && file.endsWith('.sh')) fileMode = statSync(file).mode & 0o777
      return runTool(argv, env, ms)
    }
    const launchDir = join(dir(), 'launch')
    const { h } = host('agent', 100, { run: spy, launchDir })
    const env = { PATH: process.env.PATH ?? '', SECRET: "hunter2 it's $HOME `x`", EMPTY: '' }
    await h.start(launch(['sh', '-c', 'env | sort; sleep 30'], { env }))
    const rows = await until(async () => {
      const r = await h.visibleRows()
      return r?.some((x) => x.startsWith('SECRET=')) ? r : null
    })
    expect(rows).toContain("SECRET=hunter2 it's $HOME `x`")
    expect(rows).toContain('EMPTY=')
    // exactly the launch's names, plus what sh itself sets
    const names = rows.filter((r) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(r)).map((r) => r.split('=')[0])
    for (const n of names)
      expect(['PATH', 'SECRET', 'EMPTY', 'TERM', 'PWD', 'SHLVL', 'OLDPWD', '_']).toContain(n as string)
    expect(JSON.stringify(calls)).not.toContain('hunter2')
    expect(calls.some((a) => a.includes('set-environment'))).toBe(false)
    expect(calls.some((a) => a.includes('-e'))).toBe(false)
    expect(fileMode).toBe(0o600)
    expect(statSync(launchDir).mode & 0o777).toBe(0o700)
    await until(() => readdirSync(launchDir).length === 0) // the file removed itself
  })
  it('a real login environment starts: bash functions and read-only shell names are left out, TERM is set, NUL refused', async () => {
    const { h } = host()
    const env = {
      PATH: process.env.PATH ?? '',
      'BASH_FUNC_which%%': '() {  ( alias; eval ${which_declare} ) | /usr/bin/which "$@" }',
      SHELLOPTS: 'braceexpand:hashall',
      UID: '1000',
      KEEP: 'yes',
      BASH_ENV: '/home/alex/.nvm-env',
      TERM: '',
    }
    await h.start(launch(['sh', '-c', 'echo "k=$KEEP t=$TERM b=$BASH_ENV"; sleep 30'], { env }))
    await until(async () => (await h.visibleRows())?.includes('k=yes t=xterm-256color b=/home/alex/.nvm-env'))
    expect(h.droppedEnv).toEqual(['BASH_FUNC_which%%', 'SHELLOPTS', 'UID'])
    const { h: h2 } = host()
    await expect(h2.start(launch(['true', 'x'], { env: { PATH: '/bin', Z: 'a\0b' } }))).rejects.toMatchObject({
      code: 'start_failed',
    })
    await expect(h2.start(launch(['true', 'a\0b']))).rejects.toMatchObject({ code: 'start_failed' })
  })
  it('a start removes only its own session’s leftover launch file', async () => {
    const launchDir = join(dir(), 'launch')
    mkdirSync(launchDir, { mode: 0o700 })
    const other = join(launchDir, 'launch-agent-b-0123456789abcdef.sh')
    const stale = join(launchDir, 'launch-agent-fedcba9876543210.sh')
    writeFileSync(other, 'x', { mode: 0o600 })
    writeFileSync(stale, 'x', { mode: 0o600 })
    const { h } = host('agent', 100, { launchDir })
    await h.start(launch(['sleep', '30']))
    expect(existsSync(other)).toBe(true)
    expect(existsSync(stale)).toBe(false)
  })
  it('a launch folder open to others is refused; a program name starting with - is refused', async () => {
    const open = join(dir(), 'open')
    mkdirSync(open, { mode: 0o755 })
    chmodSync(open, 0o755)
    await expect(host('agent', 100, { launchDir: open }).h.start(launch(['sleep', '30']))).rejects.toMatchObject({
      code: 'start_failed',
    })
    await expect(host().h.start(launch(['-x', 'y']))).rejects.toMatchObject({ code: 'start_failed' })
  })
  it('a pane lookup that times out never kills or doubles a running agent', async () => {
    const { h, socket } = host()
    const pid = await h.start(launch(['sh', '-c', 'sleep 30']))
    let timeouts = 0
    const flaky: typeof runTool = async (argv, env, ms) => {
      if ((argv.includes('show-options') || argv.includes('list-panes')) && timeouts > 0) {
        timeouts--
        return { ok: false, status: -1, out: '', err: '', timedOut: true }
      }
      return runTool(argv, env, ms)
    }
    for (const n of [2, 4, 99]) {
      timeouts = n
      const later = host('agent', 100, { socket, run: flaky }).h
      const r = await later.start(launch(['sh', '-c', 'sleep 30'])).catch((e) => e)
      expect(['already_running', 'start_failed']).toContain(r.code)
      const panes = spawnSync(TMUX, ['-L', socket, 'list-panes', '-s', '-t', '=agent', '-F', '#{pane_pid}'], {
        env: { PATH: process.env.PATH ?? '' },
      })
      expect(panes.stdout.toString().trim()).toBe(String(pid))
    }
    expect(h.childPid()).toBe(pid)
  })
  // P3d2: a supervisor adopting thread sessions after a restart must tell "not there" from "could not tell": only the first
  // may be marked parked; a guess is never acted on.
  it('probe tells a running pane, a dead one, a session that is gone and a read that said nothing apart', async () => {
    const { h, socket } = host('t-trip')
    expect(await h.probe()).toEqual({ kind: 'gone' })
    const pid = await h.start(launch(['sh', '-c', 'sleep 30'], { session: 't-trip' }))
    const later = host('t-trip', 100, { socket }).h
    expect(await later.probe()).toEqual({ kind: 'running', pid })
    expect(later.childPid()).toBeNull() // a probe adopts nothing
    let slow = false
    const flaky: typeof runTool = async (argv, env, ms) =>
      slow && argv.includes('has-session')
        ? { ok: false, status: -1, out: '', err: '', timedOut: true }
        : runTool(argv, env, ms)
    const blind = host('t-trip', 100, { socket, run: flaky }).h
    slow = true
    expect(await blind.probe()).toEqual({ kind: 'unknown' })
    const ex = exited(h)
    process.kill(pid, 'SIGKILL')
    await ex
    expect(await host('t-trip', 100, { socket }).h.probe()).toEqual({ kind: 'dead' })
  })
  it('signal reaches the started group without waiting, and never a pid the host did not start', async () => {
    const { h } = host('t-sig')
    expect(h.signal('SIGTERM')).toBe(false) // nothing started
    // The child says `armed` once its trap is set: start() returns before sh has run a line, so a TERM sent at once can find
    // it with no trap yet and kill it by signal (code null). Left alone it ends by itself after about 60 s, with 3. The
    // `sleep 300` beside it is in its group, deaf to the hangup when the pane closes (nohup), so it ends only if the TERM
    // reaches the whole group, not just the leader.
    const pid = await h.start(
      launch(
        [
          'sh',
          '-c',
          'nohup sleep 300 >/dev/null 2>&1 & trap "exit 7" TERM; echo armed; i=0; while [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; exit 3',
        ],
        {
          session: 't-sig',
        },
      ),
    )
    await until(async () => (await h.visibleRows())?.includes('armed'), 30_000)
    const ex = exited(h)
    const t0 = Date.now()
    expect(h.signal('SIGTERM')).toBe(true)
    // its real exit, however slow the machine: only the signal ends it with 7, and long before its own 60 s
    const r = await Promise.race([ex, new Promise<null>((res) => setTimeout(() => res(null), 30_000))])
    expect(r?.code).toBe(7)
    expect(Date.now() - t0).toBeLessThan(30_000)
    await until(() => groupMembers(pid).length === 0, 10_000) // the sleep 300 too: the whole group got it
  }, 80_000)
  // tmux marks a pane dead when its terminal closes and reads the exit status when it reaps the process: the two can come in
  // either order, so for a moment a dead pane can show neither a status nor a signal. Seen under load (the signal test above,
  // 2 runs in 10): the exit was reported with code null and signal null, which Main reads as a crash, a clean exit included.
  it('a dead pane whose exit status tmux has not read yet is asked again, never reported with no code', async () => {
    let early = 1
    const racing: typeof runTool = async (argv, env, ms) => {
      const r = await runTool(argv, env, ms)
      if (early > 0 && argv.some((a) => a.includes('#{pane_dead_status}'))) {
        const [row = '', ...rest] = r.out.split('\n')
        const f = row.split('|')
        if (f[1] === '1') {
          early--
          f[2] = ''
          f[3] = ''
          return { ...r, out: [f.join('|'), ...rest].join('\n') }
        }
      }
      return r
    }
    const { h } = host('t-early', 50, { run: racing })
    const ex = exited(h)
    await h.start(launch(['sh', '-c', 'sleep 0.3; exit 7'], { session: 't-early' }))
    const r = await Promise.race([ex, new Promise<null>((res) => setTimeout(() => res(null), 20_000))])
    expect(early).toBe(0) // the read that came too early did happen
    expect(r).toMatchObject({ code: 7, signal: null, hostLost: false })
  }, 30_000)
  // P3d3: the pointer is typed without Enter, looked at, then submitted with Enter alone; our own line can be backspaced away
  it('text without Enter, Enter alone and Backspaces arrive as typed; a line break is refused', async () => {
    const { h } = host('t-type')
    await h.start(launch(['sh', '-c', 'IFS= read -r l; echo "got:[$l]"; sleep 30'], { session: 't-type' }))
    expect(await h.sendText('abcXY')).toBe('sent')
    expect(await h.sendBackspaces(2)).toBe('sent')
    expect(await h.sendText('a\nb')).toBe('failed')
    expect(await h.sendBackspaces(0)).toBe('failed')
    expect(await h.sendEnterKey()).toBe('sent')
    await until(async () => (await h.visibleRows())?.some((r) => r.includes('got:[abc]')))
  })
  it('copy mode is read: in it after the owner scrolls back, out of it after', async () => {
    const { h, socket } = host('t-mode')
    await h.start(launch(['sh', '-c', 'seq 1 200; sleep 30'], { session: 't-mode' }))
    expect(await h.inCopyMode()).toBe(false)
    spawnSync(TMUX, ['-L', socket, 'copy-mode', '-t', '=t-mode:'], { env: { PATH: process.env.PATH ?? '' } })
    expect(await h.inCopyMode()).toBe(true)
    spawnSync(TMUX, ['-L', socket, 'send-keys', '-t', '=t-mode:', '-X', 'cancel'], {
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(await h.inCopyMode()).toBe(false)
  })
  it('in copy mode text, Enter and Backspaces are not sent (the look and the send are one tmux call); after it, they are', async () => {
    const { h, socket } = host('t-guard')
    await h.start(launch(['sh', '-c', 'seq 1 200; IFS= read -r l; echo "got:[$l]"; sleep 30'], { session: 't-guard' }))
    const env = { env: { PATH: process.env.PATH ?? '' } }
    spawnSync(TMUX, ['-L', socket, 'copy-mode', '-t', '=t-guard:'], env)
    expect(await h.inCopyMode()).toBe(true)
    expect(await h.sendText('abc')).toBe('failed')
    expect(await h.sendEnterKey()).toBe('failed')
    expect(await h.sendBackspaces(1)).toBe('failed')
    expect(await h.inCopyMode()).toBe(true) // still scrolled back: nothing typed left the mode
    spawnSync(TMUX, ['-L', socket, 'send-keys', '-t', '=t-guard:', '-X', 'cancel'], env)
    expect(await h.sendText('abc')).toBe('sent')
    expect(await h.sendEnterKey()).toBe('sent')
    await until(async () => (await h.visibleRows())?.some((r) => r.includes('got:[abc]')))
    expect(await h.sendText('a"b')).toBe('failed') // only plain text goes inside the tmux command
  })
  it('the escaped capture keeps the colours the plain one drops', async () => {
    const { h } = host('t-esc')
    await h.start(launch(['sh', '-c', `printf '\\033[2mdim\\033[0m plain\\n'; sleep 30`], { session: 't-esc' }))
    const esc = await until(async () => {
      const r = await h.visibleRowsEscaped()
      return r?.some((x) => x.includes('dim')) ? r : null
    })
    expect(esc.join('\n')).toContain('\u001b[2m')
    expect(((await h.visibleRows()) ?? []).join('\n')).not.toContain('\u001b')
  })
  it('refuses a session name tmux cannot target exactly', async () => {
    const { h } = host('a.b')
    await expect(h.start(launch(['true'], { session: 'a.b' }))).rejects.toMatchObject({ code: 'invalid_name' })
  })
})
