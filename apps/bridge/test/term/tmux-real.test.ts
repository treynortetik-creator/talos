// ci-requires: tmux
// (CI deals this file only to a machine that has tmux 3.2+: docs/CI-MACHINES.md, "Tools a test file needs".)
// The terminal view against a REAL tmux on a private socket (talos-test-<pid>-<n>, never the owner's `talos`): the control-mode
// reader, the keyframe with its history, the order of live output, the skip ahead after an overrun, a pane that changes size
// or ends, and the control client stopping with the last viewer. The pane prints what the test writes into a fifo, so a test
// says exactly what the pane shows. The clock is a fake one (the 16 ms coalescing, the idle times); waits are for data to arrive.

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, rmSync, write } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { b64urlDecode, type Frame, TERM_KEY_MAX_BYTES, TERM_RING_BYTES } from '@talos-app/protocol'
import { fakeClock, t, tmuxTestPrefix, waitFor } from '@talos-app/testkit'
import { parseClientActivity, TmuxCommands, versionIsSupported } from '../../src/supervisor/tmux-commands.ts'
import { TermAudit } from '../../src/term/audit.ts'
import { attachArgs, type PaneSource, tmuxSourceOpener } from '../../src/term/control.ts'
import { KEY_MIN_GAP_MS, TermService } from '../../src/term/service.ts'

setDefaultTimeout(t(300_000)) // the waits below scale with the machine; so does the limit on the whole test

const CONF = resolve(import.meta.dir, '../../../desktop/Resources/tmux.conf')
const TMUX = spawnSync('sh', ['-c', 'command -v tmux']).stdout?.toString().trim() ?? ''
const haveTmux = TMUX !== '' && versionIsSupported(spawnSync(TMUX, ['-V']).stdout?.toString() ?? '')
const writeAsync = promisify(write) as unknown as (fd: number, data: string | Uint8Array) => Promise<unknown>
const DEV = 'd_aaaaaaaaaaaaaaaaaaaa'
const dec = new TextDecoder()

// The servers live where the supervisor's own do (its environment has no TMUX_TMPDIR), so the source finds them the same way.
const tmuxEnv = (): Record<string, string> => {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR'].includes(k)) e[k] = v
  return e
}

let n = 0
const sockets: string[] = []
const dirs: string[] = []
const fds: number[] = []
const stops: Array<() => void> = []
afterEach(() => {
  for (const s of stops.splice(0)) s()
  for (const fd of fds.splice(0)) closeSync(fd)
  for (const s of sockets.splice(0)) {
    spawnSync(TMUX, ['-L', s, 'kill-server'], { env: tmuxEnv() })
    rmSync(join('/tmp', `tmux-${process.getuid?.()}`, s), { force: true })
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A tmux server of its own with a session `agent` whose pane prints whatever is written to `write()`. */
function pane(opts: { cols?: number; rows?: number; session?: string } = {}) {
  const socket = `${tmuxTestPrefix()}-${process.pid}-${n++}`
  sockets.push(socket)
  const dir = mkdtempSync(join(tmpdir(), 'talos-term-'))
  dirs.push(dir)
  const fifo = join(dir, 'feed')
  spawnSync('mkfifo', [fifo])
  const session = opts.session ?? 'agent'
  const r = spawnSync(
    TMUX,
    [
      '-L',
      socket,
      '-f',
      CONF,
      'new-session',
      '-d',
      '-s',
      session,
      '-x',
      String(opts.cols ?? 80),
      '-y',
      String(opts.rows ?? 10),
      `exec cat ${fifo}`,
    ],
    { env: tmuxEnv() },
  )
  if (r.status !== 0) throw new Error(`tmux new-session failed: ${r.stderr}`)
  // the writer end stays open for the whole test: cat would end at the first close
  const fd = openSync(fifo, 'w')
  fds.push(fd)
  const tm = (...args: string[]) => spawnSync(TMUX, ['-L', socket, '-f', CONF, ...args], { env: tmuxEnv() })
  return {
    socket,
    session, // asynchronous on purpose: a blocking write into a full fifo would stop this process reading the control client, and tmux would
    // stop reading the pane: the test would be the stall the product must never have
    write: async (s: string | Uint8Array) => void (await writeAsync(fd, s)),
    tm,
  }
}

const opener = (socket: string) => tmuxSourceOpener({ tmux: TMUX, configPath: CONF, socket, env: tmuxEnv() })
async function source(socket: string, session = 'agent'): Promise<PaneSource> {
  const s = await opener(socket)(session)
  if ('error' in s) throw new Error(`no source: ${s.error}`)
  stops.push(() => s.close())
  return s
}
const collect = (s: PaneSource) => {
  const got: number[] = []
  s.onOutput((d) => got.push(...d))
  return got
}
const rowsOf = (frame: Uint8Array) =>
  dec
    .decode(frame)
    // eslint-disable-next-line no-control-regex
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping escapes is the point
    .replace(/\x1b(?:\[[0-9;?]*[A-Za-z]|c)/g, '|')
    .split('|')
    .join('')
    .split('\r\n')

// skip: tmux 3.2 or newer is not installed on this machine
describe.skipIf(!haveTmux)('the control-mode reader (real tmux, private socket)', () => {
  test('the attach argv is a control client that ignores size and can run read commands; it is not read-only', async () => {
    const p = pane({ cols: 70, rows: 9 })
    const child = spawn(TMUX, attachArgs({ configPath: CONF, socket: p.socket }, 'agent'), { env: tmuxEnv() })
    stops.push(() => child.kill('SIGTERM'))
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stdin.write("display-message -p -t %0 '#{pane_width} #{pane_height}'\n")
    await waitFor(() => out.includes('70 9'), t(5000), 'the read command answered')
    expect(out).not.toContain('read-only')
  })

  test('ignore-size alone does not hold the size of a window the view is the only client of: the allowlist does', async () => {
    const p = pane({ cols: 70, rows: 9 })
    const size = () =>
      p.tm('display-message', '-p', '-t', '%0', '#{pane_width}x#{pane_height}').stdout.toString().trim()
    // evidence: the same client, with no allowlist in front of it, resizes a lone window with refresh-client (probed on tmux 3.8)
    const raw = spawn(TMUX, attachArgs({ configPath: CONF, socket: p.socket }, 'agent'), { env: tmuxEnv() })
    stops.push(() => raw.kill('SIGTERM'))
    raw.stdin.write('refresh-client -C 30x5\n')
    await waitFor(() => size() === '30x5', t(5000), 'the unguarded client to resize the window')
    raw.kill('SIGTERM')
    // the view, alone (no person's terminal attached), sends only what the allowlist lets through, and the size stays put
    const q = pane({ cols: 70, rows: 9 })
    const s = await source(q.socket)
    await s.snapshot()
    expect(q.tm('display-message', '-p', '-t', '%0', '#{pane_width}x#{pane_height}').stdout.toString().trim()).toBe(
      '70x9',
    )
  })

  test('the view never changes the pane: not its size, not its input, however much it reads and snapshots', async () => {
    const p = pane({ cols: 70, rows: 9 })
    const size = () =>
      p.tm('display-message', '-p', '-t', '%0', '#{pane_width}x#{pane_height}').stdout.toString().trim()
    expect(size()).toBe('70x9')
    const s = await source(p.socket)
    for (let i = 0; i < 5; i++) {
      await p.write(`line ${i}\n`)
      await s.snapshot()
    }
    await waitFor(() => s.offset() === 40, t(5000), 'all five lines read') // 5 x 'line N\\r\\n'
    // the client's flags: it ignores size and is not read-only (and is a control client)
    const flags = p.tm('list-clients', '-F', '#{client_flags}').stdout.toString()
    expect(flags).toContain('ignore-size')
    expect(flags).toContain('control-mode')
    expect(flags).not.toContain('read-only')
    // (the size check below does not tell the flag from no flag: a lone control client sets no size until refresh-client -C, which the
    // allowlist refuses. The flags assertion above is the pin for ignore-size.)
    expect(size()).toBe('70x9') // ignore-size: a control client with no size of its own does not resize the window
    expect(
      p.tm('display-message', '-p', '-t', '%0', '#{pane_in_mode} #{pane_input_off}').stdout.toString().trim(),
    ).toBe('0 0')
    // nothing was typed into the pane by the view: what it shows is only what the test printed
    const shown = p.tm('capture-pane', '-p', '-t', '%0').stdout.toString().trim().split('\n')
    expect(shown).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4'])
  })

  test('a tmux that refuses the attach flags (an old one) is unavailable, not no_pane: through the real opener and a flag tmux refuses', async () => {
    const p = pane()
    // control mode prints the refusal on STDOUT ("command attach-session: unknown flag -Z") and then %exit; stderr stays empty
    const refusing = tmuxSourceOpener({
      tmux: TMUX,
      configPath: CONF,
      socket: p.socket,
      env: tmuxEnv(),
      extraArgs: ['-Z'],
    })
    expect(await refusing('agent')).toEqual({ error: 'unavailable' })
    // control: a session that is simply not there is still no_pane
    expect(await opener(p.socket)('nope')).toEqual({ error: 'no_pane' })
  })

  test('a session that is not there has no pane to show, and a bad socket is unavailable, not a crash', async () => {
    const p = pane()
    expect(await opener(p.socket)('nope')).toEqual({ error: 'no_pane' })
    sockets.push(`${p.socket}-absent`) // tmux leaves a socket file behind even for an attach that finds no server: cleaned in afterEach
    expect(await opener(`${p.socket}-absent`)('agent')).toEqual({ error: 'no_pane' })
    expect(await tmuxSourceOpener({ tmux: '/nonexistent/tmux', configPath: CONF, socket: p.socket })('agent')).toEqual({
      error: 'unavailable',
    })
  })

  test('the first answer names the pane and its size, and the stream starts at offset 0', async () => {
    const p = pane({ cols: 90, rows: 12 })
    const s = await source(p.socket)
    expect(s.paneId).toMatch(/^%\d+$/)
    expect(s.size()).toEqual({ cols: 90, rows: 12 })
    expect(s.offset()).toBe(0)
  })

  test('live output arrives in order, byte for byte, with UTF-8 and escapes intact, and the offset counts it', async () => {
    const p = pane()
    const s = await source(p.socket)
    const got = collect(s)
    const want: number[] = []
    // the pty turns each \n the pane prints into \r\n on its way out: that is what the stream must carry
    const put = async (b: Uint8Array) => {
      for (const x of b) want.push(...(x === 0x0a ? [0x0d, 0x0a] : [x]))
      await p.write(b)
    }
    const text = new TextEncoder()
    for (let i = 1; i <= 120; i++) await put(text.encode(`line ${i} café € \x1b[1mbold\x1b[0m \\ done\n`))
    await waitFor(() => got.length >= want.length, t(8000), 'the pane output')
    expect(got.length).toBe(want.length)
    expect(got).toEqual(want)
    expect(s.offset()).toBe(want.length)
  })

  test('a keyframe has the history above the screen, the screen, and the cursor, and is exact for its offset while output pours in', async () => {
    const p = pane({ cols: 60, rows: 8 })
    const s = await source(p.socket)
    const got = collect(s)
    let i = 0
    const burst = async (k: number) => {
      for (let j = 0; j < k; j++) await p.write(`number ${String(++i).padStart(4, '0')} text\n`)
    }
    await burst(60) // well past 8 rows: most of it is history
    await waitFor(() => s.offset() === 60 * 18, t(5000), 'all sixty lines read') // 60 x 'number NNNN text\\r\\n'
    for (let round = 0; round < 6; round++) {
      await burst(25)
      const snap = await s.snapshot()
      expect(snap).not.toBeNull()
      const { at, bytes } = snap as { at: number; bytes: Uint8Array }
      expect(got.length).toBeGreaterThanOrEqual(at) // everything before `at` was delivered before the picture
      const prefix = dec.decode(Uint8Array.from(got.slice(0, at)))
      const want = prefix.split('\r\n').filter((l) => l !== '')
      const have = rowsOf(bytes).filter((l) => l !== '')
      // the picture is exactly what the stream said up to `at`: every line, the oldest included (history), nothing after
      expect(have).toEqual(want)
      expect(want.length).toBeGreaterThan(8)
      const t = dec.decode(bytes)
      expect(t.startsWith('\x1bc\x1b[H\x1b[2J\x1b[3J')).toBe(true)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is the point
      expect(t).toMatch(/\x1b\[\d+;\d+H$/)
    }
  })

  test('one 300 KB line in the pane: the keyframe still fits one frame and is valid text', async () => {
    const p = pane({ cols: 80, rows: 10 })
    const s = await source(p.socket)
    await p.write(`${'é€x'.repeat(100_000)}\nafter\n`)
    await waitFor(() => s.offset() === 600_000 + 2 + 7, t(8000), 'the long line and what follows')
    const snap = await s.snapshot()
    expect(snap).not.toBeNull()
    const bytes = (snap as { bytes: Uint8Array }).bytes
    expect(bytes.length).toBeLessThanOrEqual(TERM_KEY_MAX_BYTES)
    new TextDecoder('utf-8', { fatal: true }).decode(bytes) // never cut inside a character
    expect(dec.decode(bytes)).toContain('after')
  })

  test('a quiet pane: the picture is at the head of the stream', async () => {
    const p = pane()
    const s = await source(p.socket)
    await p.write('hello\n')
    await waitFor(() => s.offset() === 7, t(5000), 'output')
    const snap = await s.snapshot()
    expect(snap?.at).toBe(7)
    expect(rowsOf(snap?.bytes as Uint8Array).filter((l) => l)).toEqual(['hello'])
  })

  test('the pane changing size is announced; the pane ending is announced; the client stops with close()', async () => {
    const p = pane()
    const s = await source(p.socket)
    const sizes: Array<{ cols: number; rows: number }> = []
    s.onResize((x) => sizes.push(x))
    let ended: string | null = null
    s.onEnd((w) => (ended = w))
    expect(p.tm('resize-window', '-t', '=agent:', '-x', '70', '-y', '20').status).toBe(0)
    await waitFor(() => sizes.length > 0, t(5000), 'the resize')
    expect(sizes[sizes.length - 1]).toEqual({ cols: 70, rows: 20 })
    expect(s.size()).toEqual({ cols: 70, rows: 20 })
    p.tm('kill-session', '-t', '=agent')
    await waitFor(() => ended !== null, t(5000), 'the end')
    expect(ended as unknown as string).toBe('pane_gone')
  })
})

/** A pane whose program is `cat` on its own tty: what is typed into it comes back on the screen. */
function typingPane() {
  const socket = `${tmuxTestPrefix()}-${process.pid}-${n++}`
  sockets.push(socket)
  const r = spawnSync(
    TMUX,
    ['-L', socket, '-f', CONF, 'new-session', '-d', '-s', 'agent', '-x', '80', '-y', '10', 'exec cat'],
    {
      env: tmuxEnv(),
    },
  )
  if (r.status !== 0) throw new Error(`tmux new-session failed: ${r.stderr}`)
  const cmds = new TmuxCommands(TMUX, CONF, 'agent', socket).withPane('%0')
  const run = (argv: string[]) => spawnSync(argv[0] as string, argv.slice(1), { env: tmuxEnv() })
  const screen = () =>
    spawnSync(TMUX, ['-L', socket, '-f', CONF, 'capture-pane', '-p', '-t', '%0'], { env: tmuxEnv() }).stdout.toString()
  return { socket, cmds, run, screen }
}

// skip: tmux 3.2 or newer is not installed on this machine
describe.skipIf(!haveTmux)("the agent's own keys still reach the pane while a view is open", () => {
  test("the supervisor's send-keys builders (literal text, Enter, hex bytes) succeed beside the view's control client", async () => {
    const p = typingPane()
    await source(p.socket) // the real control client of a view, attached
    const lit = p.run(p.cmds.sendLiteral('typed-literal'))
    expect([lit.status, lit.stderr.toString()]).toEqual([0, ''])
    const enter = p.run(p.cmds.sendEnter())
    expect(enter.status).toBe(0)
    const hex = p.run(p.cmds.sendBytesLeavingMode(new TextEncoder().encode('typed-hex')))
    expect([hex.status, hex.stderr.toString()]).toEqual([0, ''])
    await waitFor(
      () => p.screen().includes('typed-literal') && p.screen().includes('typed-hex'),
      t(5000),
      'the typed text on screen',
    )
  })
})

// skip: tmux 3.2 or newer is not installed on this machine
describe.skipIf(!haveTmux)('a viewer is not the owner being there', () => {
  const activities = (p: ReturnType<typeof pane>) =>
    parseClientActivity(
      p.tm(...new TmuxCommands(TMUX, CONF, 'agent', p.socket).listClientsActivity().slice(5)).stdout.toString(),
    )

  test('while a view is open clientActivities is empty, and a client at a keyboard still counts', async () => {
    const p = pane()
    expect(activities(p)).toEqual([])
    await source(p.socket) // the viewer's control client
    expect(p.tm('list-clients', '-F', '#{client_pid}').stdout.toString().trim()).not.toBe('') // it is attached
    expect(activities(p)).toEqual([]) // and the startup, restart and idle checks do not see it
    // control: a client with a terminal (what the Mac app's view is) is someone who could type, and is counted
    // a client with a terminal of its own: the pane of a SECOND private tmux server is a pty, and the attach runs in it (no python or
    // script(1): neither gets a pty from a pipe, and python may be a stub). Closing that server ends the client.
    const host = `${p.socket}-host`
    sockets.push(host)
    // '=agent' quoted: the pane's shell may be zsh, which expands a bare =word
    const attach = [
      'env',
      '-u',
      'TMUX',
      '-u',
      'TMUX_PANE',
      TMUX,
      '-L',
      p.socket,
      '-f',
      CONF,
      'attach',
      '-t',
      "'=agent'",
    ].join(' ')
    const started = spawnSync(
      TMUX,
      ['-L', host, '-f', CONF, 'new-session', '-d', '-s', 'host', '-x', '80', '-y', '10', attach],
      {
        env: tmuxEnv(),
      },
    )
    expect(started.status).toBe(0)
    await waitFor(() => (activities(p) ?? []).length === 1, t(5000), 'the client with a terminal')
  })
})

// skip: tmux 3.2 or newer is not installed on this machine
describe.skipIf(!haveTmux)('the terminal view service over real tmux', () => {
  function service(socket: string) {
    const clock = fakeClock()
    const sent: Array<Record<string, unknown> & { type: string }> = []
    const svc = new TermService({
      clock,
      log: { debug() {}, info() {}, warn() {}, error() {}, security() {} },
      send: (f: Frame) => {
        sent.push(f as never)
        return true
      },
      openSource: opener(socket),
      audit: new TermAudit(new Database(':memory:')),
      sessionOf: (t) => (t === 'main' ? 'agent' : null),
    })
    stops.push(() => svc.stopAll('restart'))
    return { clock, sent, svc }
  }
  const of = (sent: Array<{ type: string }>, type: string) =>
    sent.filter((f) => f.type === type) as Array<Record<string, unknown> & { type: string }>
  const bytes = (f: Record<string, unknown>) => b64urlDecode(f.bytes_b64 as string)
  const clients = (p: ReturnType<typeof pane>) =>
    p.tm('list-clients', '-F', '#{client_pid}').stdout.toString().split('\n').filter(Boolean).map(Number)

  test('opening shows the history and screen first, then live output in order, and an ack lets more through', async () => {
    const p = pane({ cols: 60, rows: 8 })
    for (let i = 1; i <= 40; i++) await p.write(`old ${i}\n`)
    // the pane has printed all forty before the view opens (the writes are asynchronous): the keyframe is of a finished screen
    await waitFor(
      () => p.tm('capture-pane', '-p', '-t', '%0').stdout.toString().includes('old 40'),
      t(5000),
      'old 40 on screen',
    )
    const { clock, sent, svc } = service(p.socket)
    await svc.open({ term_id: 'tm_01HXTEST000000000000001', target: 'main' }, DEV)
    await waitFor(() => of(sent, 'term.key').length === 1, t(8000), 'the keyframe')
    const key = of(sent, 'term.key')[0] as Record<string, unknown>
    const rows = rowsOf(bytes(key)).filter((l) => l)
    expect(rows[0]).toBe('old 1')
    expect(rows[rows.length - 1]).toBe('old 40')
    expect(of(sent, 'term.opened')[0]).toMatchObject({ cols: 60, rows: 8, tier: 'view' })
    await p.write('live A\nlive B\n')
    await waitFor(() => (svc.head('agent') ?? 0) >= 16, t(8000), 'live output')
    clock.advance(16)
    const outs = of(sent, 'term.out')
    expect(dec.decode(Uint8Array.from(outs.flatMap((f) => [...bytes(f)])))).toBe('live A\r\nlive B\r\n')
    expect(outs[0]?.at).toBe(key.at as number) // the stream goes on exactly where the picture stopped
  })

  test('a viewer that never acks does not stall the pane; after the ring is overrun the next frame is a skip-ahead keyframe', async () => {
    const p = pane()
    const { clock, sent, svc } = service(p.socket)
    const id = 'tm_01HXTEST000000000000002'
    await svc.open({ term_id: id, target: 'main' }, DEV)
    await waitFor(() => of(sent, 'term.key').length === 1, t(8000), 'the keyframe')
    // 600 KiB, far past the 256 KiB ring and the 64 KiB window, with nobody acking
    const line = `${'x'.repeat(78)}\n`
    const total = 600 * 1024
    let written = 0
    while (written < total) {
      await p.write(line.repeat(64))
      written += (line.length + 1) * 64 // each \n comes out as \r\n
    }
    await waitFor(() => (svc.head('agent') ?? 0) >= written, t(20_000), 'the whole output read')
    expect(svc.head('agent')).toBe(written) // the pane was read to the end: never stalled
    await p.write('THE-END\n')
    await waitFor(() => (svc.head('agent') ?? 0) >= written + 9, t(8000), 'the last line')
    const keysBefore = of(sent, 'term.key').length
    clock.advance(KEY_MIN_GAP_MS) // a second picture is allowed this long after the first
    // the flush finds the viewer's next bytes gone from the ring: a fresh picture, not the bytes
    await waitFor(() => of(sent, 'term.key').length === keysBefore + 1, t(8000), 'the skip ahead')
    const keys = of(sent, 'term.key')
    const last = keys[keys.length - 1] as Record<string, unknown>
    expect(dec.decode(bytes(last))).toContain('THE-END')
    expect(last.at as number).toBe(written + 9)
    // the viewer was never sent more than its window, and nothing of the 600 KiB that was skipped
    const outBytes = of(sent, 'term.out').reduce((s, f) => s + bytes(f).length, 0)
    expect(outBytes).toBeLessThanOrEqual(64 * 1024)
    expect(written).toBeGreaterThan(TERM_RING_BYTES + outBytes)
    // the stream then goes on from the picture's offset
    await p.write('AFTER\n')
    await waitFor(() => (svc.head('agent') ?? 0) >= written + 9 + 7, t(8000), 'output after the picture')
    svc.ack(id, last.at as number)
    clock.advance(16)
    const tail = of(sent, 'term.out').filter((f) => (f.at as number) >= (last.at as number))
    expect(dec.decode(Uint8Array.from(tail.flatMap((f) => [...bytes(f)])))).toBe('AFTER\r\n')
  })

  test('the control client lives while someone watches: one for two viewers, gone with the last, and its process ends', async () => {
    const p = pane()
    const { svc, sent } = service(p.socket)
    await svc.open({ term_id: 'tm_01HXTEST000000000000003', target: 'main' }, DEV)
    await svc.open({ term_id: 'tm_01HXTEST000000000000004', target: 'main' }, DEV)
    await waitFor(() => of(sent, 'term.key').length === 2, t(8000), 'both keyframes')
    const now = clients(p)
    expect(now.length).toBe(1) // one control client for both viewers
    svc.close('tm_01HXTEST000000000000003', DEV)
    expect(clients(p).length).toBe(1)
    svc.close('tm_01HXTEST000000000000004', DEV)
    await waitFor(() => clients(p).length === 0, t(8000), 'the client to leave tmux')
    await waitFor(
      () => {
        try {
          process.kill(now[0] as number, 0)
          return false
        } catch {
          return true
        }
      },
      t(8000),
      'the process to end',
    )
    expect(svc.watchCount()).toBe(0)
  })

  test('the pane being killed closes every view with pane_gone', async () => {
    const p = pane()
    const { svc, sent } = service(p.socket)
    await svc.open({ term_id: 'tm_01HXTEST000000000000005', target: 'main' }, DEV)
    await waitFor(() => of(sent, 'term.key').length === 1, t(8000), 'the keyframe')
    p.tm('kill-session', '-t', '=agent')
    await waitFor(() => of(sent, 'term.closed').length === 1, t(8000), 'the close')
    expect(of(sent, 'term.closed')[0]?.why).toBe('pane_gone')
    expect(svc.viewCount()).toBe(0)
  })

  test("the Mac's own window changing the pane size tells the page and sends a new picture", async () => {
    const p = pane()
    const { clock, sent, svc } = service(p.socket)
    const id = 'tm_01HXTEST000000000000006'
    await svc.open({ term_id: id, target: 'main' }, DEV)
    await waitFor(() => of(sent, 'term.key').length === 1, t(8000), 'the keyframe')
    svc.ack(id, svc.position(id)?.next as number)
    clock.advance(KEY_MIN_GAP_MS)
    p.tm('resize-window', '-t', '=agent:', '-x', '50', '-y', '12')
    await waitFor(() => of(sent, 'term.opened').length === 2, t(8000), 'the new size')
    expect(of(sent, 'term.opened')[1]).toMatchObject({ cols: 50, rows: 12 })
    clock.advance(16)
    await waitFor(() => of(sent, 'term.key').length === 2, t(8000), 'the new picture')
  })
})
