// `pnpm sandbox`, run through the real script: a whole sandbox (the built relay, the real supervisor on its own tmux server,
// the real bridge behind the fake claude, an enrolled phone) is started, driven and taken down again. Nothing here is a
// double of the product; only Claude Code itself is the fake. Needs tmux and bun, like the supervisor's own tmux tests.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rowsAfterAck } from '../e2e/sandbox/frames.ts'
import { connectFailure } from '../e2e/sandbox/phone.ts'

const script = fileURLToPath(new URL('../e2e/sandbox.ts', import.meta.url))
const have = (tool: string) =>
  spawnSync(tool, [tool === 'tmux' ? '-V' : '--version'], { encoding: 'utf8' }).status === 0
// The whole-sandbox run takes about half a minute, so it is not part of the default test run: `pnpm test:sandbox` turns it on.
const wanted = process.env.TALOS_SANDBOX_E2E === '1'
const canRun = wanted && have('tmux') && have('bun')

// A short base: the sandbox's Talos home holds a unix socket, and those paths have a length limit.
const base = realpathSync(mkdtempSync('/tmp/tsbx-'))
// What a thread session or an installed Talos would leave in the environment of whoever runs the command. A sandbox that
// let any of it through would be refused by the CLI's thread-session gate, or would write into the home named here.
const poisoned = join(base, 'not-the-sandbox-home')
const env = {
  ...process.env,
  TALOS_SANDBOX_BASE: base,
  TALOS_APP_HOME: poisoned,
  TALOS_APP_BRIDGE: '1',
  TALOS_APP_WORKER_THREAD: 'general',
  TALOS_APP_WORKER_NONCE: 'x',
  TALOS_SESSION_ROLE: 'worker',
}

// biome-ignore lint/suspicious/noExplicitAny: the command's JSON answers, read field by field in the assertions
type Json = Record<string, any>
type Out = { code: number | null; json: Json; err: string }
const sandbox = (...args: string[]): Out => {
  const r = spawnSync(
    'node',
    ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', script, ...args],
    { encoding: 'utf8', env, timeout: 150_000 },
  )
  let json: Json = {}
  try {
    json = JSON.parse(r.stdout)
  } catch {
    // a usage error prints no JSON
  }
  return { code: r.status, json, err: r.stderr }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterAll(() => {
  if (canRun) sandbox('down', '--all')
  rmSync(base, { recursive: true, force: true })
})

describe('sandbox arguments', () => {
  it('a command line it cannot read exits 2 and starts nothing', () => {
    expect(sandbox('nope').code).toBe(2)
    expect(sandbox('up', '--fake-claude', '--real-claude').code).toBe(2)
    expect(sandbox('up', '--fake-claude', '--auto-dev-channels').code).toBe(2) // only a real claude shows the warning
    expect(sandbox('up', '--model', '; rm -rf /').code).toBe(2)
    expect(sandbox('status', '../../etc').code).toBe(2)
    expect(sandbox('drive', 'zzzzzzzz', 'send').code).toBe(2)
    expect(sandbox('list').json.sandboxes).toEqual([])
  })

  it('drive help lists every action with what it does', () => {
    const r = sandbox('drive', 'help')
    expect(r.code).toBe(0)
    for (const a of ['send', 'threads', 'thread-create', 'thread-rename', 'thread-archive', 'thread-dedicated'])
      expect(r.json.actions[a].about).toBeTruthy()
    for (const a of ['cards', 'card-answer', 'history', 'config', 'offline', 'online', 'kill-main', 'kill-worker'])
      expect(r.json.actions[a].about).toBeTruthy()
    for (const a of ['corrupt', 'restore', 'log', 'supervisor']) expect(r.json.actions[a].about).toBeTruthy()
  })

  it('an unknown or missing sandbox is an error, never an empty answer', () => {
    const r = sandbox('status', 'abcdef01')
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('no_sandbox')
    expect(sandbox('down', 'abcdef01').code).toBe(1)
  })
})

describe('which rows count as the answer to a message', () => {
  const row = (type: string, thread: string, author: string, text: string) => ({
    type,
    message: { thread_id: thread, author, text },
  })
  const texts = (rows: Array<Record<string, unknown>>) => rows.map((m) => m.text)

  it('only rows after the relay took the message, in its thread, by that author', () => {
    const frames = [
      row('reply', 'general', 'agent', 'answer to an earlier message'),
      row('reply', 'general', 'system', 'a notice from before'),
      { type: 'ack', ref: 'OTHER' },
      { type: 'ack', ref: 'MINE' },
      row('reply', 'other', 'agent', 'another thread'),
      row('reply', 'general', 'system', 'Main answered for this thread'),
      row('message.stored', 'general', 'agent', 'stored answer'),
      row('reply', 'general', 'agent', 'the answer'),
    ]
    expect(texts(rowsAfterAck(frames, 'MINE', 'general', 'agent'))).toEqual(['stored answer', 'the answer'])
    expect(texts(rowsAfterAck(frames, 'MINE', 'general', 'system'))).toEqual(['Main answered for this thread'])
  })

  it('a message the relay never acknowledged has no answer, whatever else arrived', () => {
    const frames = [row('reply', 'general', 'agent', 'unrelated'), { type: 'error', ref: 'MINE', code: 'bad_frame' }]
    expect(rowsAfterAck(frames, 'MINE', 'general', 'agent')).toEqual([])
  })
})

describe('why the phone could not connect', () => {
  it('a 429 is the relay slowing the phone down, another status a refusal, and only no answer is unreachable', () => {
    expect(connectFailure(new Error('Unexpected server response: 429')).code).toBe('relay_rate_limited')
    expect(connectFailure(new Error('Unexpected server response: 403')).code).toBe('relay_refused')
    expect(connectFailure(new Error('Unexpected server response: 503')).code).toBe('relay_refused')
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })
    expect(connectFailure(refused)).toMatchObject({
      code: 'relay_unreachable',
      detail: expect.stringMatching(/^ECONNREFUSED/),
    })
  })
})

describe('down only signals what the sandbox itself started', () => {
  let bystander: ChildProcess
  afterAll(() => bystander?.kill('SIGKILL'))

  it('a recorded pid that now belongs to another process is left alone', async () => {
    bystander = spawn('sleep', ['120'], { stdio: 'ignore' })
    const pid = bystander.pid as number
    const root = join(base, 'talos-sandbox-0badc0de')
    mkdirSync(join(root, 'home'), { recursive: true })
    const stale = { pid, start: 'Thu Jan  1 00:00:00 1970' } // the pid is real, the start time is someone else's
    writeFileSync(
      join(root, 'sandbox.json'),
      JSON.stringify({
        v: 1,
        id: '0badc0de',
        root,
        mode: 'fake',
        model: 'haiku',
        relay: { port: 1, origin: 'http://localhost:1', proc: stale },
        supervisor: { proc: stale },
        tmux: { bin: 'tmux', socket: 'talos-sandbox-0badc0de' },
        home: join(root, 'home'),
        agent_dir: join(root, 'agent'),
        claude_path: '/usr/bin/false',
      }),
    )
    const r = sandbox('down', '0badc0de')
    // the record was read and acted on (not skipped as unreadable): both recorded processes were considered
    expect(r.json).toMatchObject({ removed: true, leftovers: [] })
    expect(r.json.stopped).toEqual(expect.arrayContaining(['supervisor', 'relay']))
    expect(existsSync(root)).toBe(false)
    // a killed child stays a zombie until its exit is collected: give the exit event its turn before judging
    await new Promise((r) => setTimeout(r, 500))
    expect({ exitCode: bystander.exitCode, signal: bystander.signalCode }).toEqual({ exitCode: null, signal: null })
    expect(alive(pid)).toBe(true)
  })
})

describe.skipIf(!canRun)('a sandbox with the fake claude, end to end', () => {
  let id = ''
  let up: Out
  const drive = (action: string, ...args: string[]) => sandbox('drive', id, action, ...args)

  beforeAll(() => {
    up = sandbox('up', '--fake-claude')
    id = up.json.id ?? ''
  }, 180_000)

  it('up starts a relay, the supervisor with Main and its bridge, and an enrolled phone, all inside its own root', () => {
    expect(up.code, up.err + JSON.stringify(up.json)).toBe(0)
    expect(id).toMatch(/^[0-9a-f]{8}$/)
    const s = up.json
    expect(s.root).toBe(join(base, `talos-sandbox-${id}`))
    expect(s.relay).toMatchObject({ alive: true, healthy: true })
    expect(s.supervisor.alive).toBe(true)
    expect(s.supervisor.status).toMatchObject({ phase: 'running', bridgeLive: true })
    expect(s.main).toMatchObject({ alive: true, ready: true })
    expect(s.bridge).toMatchObject({ mode: 'live', relay_connected: true })
    expect(s.phone.enrolled).toBe(true)
    // its own Talos home, its own tmux server, never the names an installed Talos uses
    expect(s.home).toBe(join(s.root, 'home'))
    expect(s.tmux.socket).toBe(`talos-sandbox-${id}`)
    expect(existsSync(poisoned)).toBe(false)
    const mcp = JSON.parse(readFileSync(join(s.agent_dir, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers['talos-app'].env).toMatchObject({ TALOS_APP_HOME: s.home, HOME: join(s.root, 'userhome') })
    const sup = JSON.parse(readFileSync(join(s.home, 'supervisor.json'), 'utf8'))
    expect(sup.env.TELEGRAM_STATE_DIR.startsWith(s.root)).toBe(true)
    expect(sup.env.IMESSAGE_STATE_DIR.startsWith(s.root)).toBe(true)
    expect(sup.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
  }, 120_000)

  it('the relay listens on the loopback address only', async () => {
    const port = Number(new URL(up.json.relay.origin).port)
    const outside = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal)?.address
    const reach = (host: string) =>
      new Promise<boolean>((resolve) => {
        const s = connect({ host, port, timeout: 2000 })
        s.once('connect', () => {
          s.destroy()
          resolve(true)
        })
        s.once('error', () => resolve(false))
        s.once('timeout', () => {
          s.destroy()
          resolve(false)
        })
      })
    expect(await reach('127.0.0.1')).toBe(true)
    if (outside) expect(await reach(outside)).toBe(false)
  }, 120_000)

  it('a message sent as the phone reaches the agent and its reply comes back', () => {
    const r = drive('send', '--thread', 'general', '--text', 'hello from the test')
    expect(r.code, JSON.stringify(r.json)).toBe(0)
    expect(r.json).toMatchObject({ ok: true, relay_acked: true, errors: [] })
    expect(r.json.reply).toMatchObject({ author: 'agent', thread_id: 'general', text: 'ack: hello from the test' })
    const h = drive('history', '--thread', 'general')
    expect(h.json.messages.map((m: { text: string }) => m.text)).toEqual(
      expect.arrayContaining(['hello from the test', 'ack: hello from the test']),
    )
  }, 120_000)

  it('a reply that arrived while the phone was away is caught up, and is not taken for the answer to a later message', () => {
    expect(drive('send', '--text', '!slow 1500 late', '--wait', 'false').json).toMatchObject({
      relay_acked: true,
      reply: null,
    })
    spawnSync('sleep', ['3']) // the late reply lands while no phone is connected
    const quiet = drive('send', '--text', '!silent', '--timeout_s', '3')
    expect(quiet.code).toBe(1)
    expect(quiet.json).toMatchObject({
      ok: false,
      relay_acked: true,
      reply: null,
      replies: [],
      timed_out_after_ms: 3000,
    })
    const seen = drive('catchup', '--from_seq', '1').json.frames
    expect(seen.filter((f: Json) => f.type === 'reply').map((f: Json) => f.message.text)).toContain('ack: late')
  }, 120_000)

  it('a backlog longer than one catch-up page (200 frames) is read in full, and the next visit has nothing left', () => {
    // count the fake's own replies in its log: waiting with a phone visit (history, send) would read the backlog itself
    const replies = () =>
      (drive('log', '--which', 'claude', '--lines', '5000').json.lines as string[]).filter((l) =>
        l.includes('"event":"reply"'),
      ).length
    drive('catchup') // the phone's cursor at the end of everything so far
    const before = replies()
    expect(drive('send', '--text', '!burst 200', '--wait', 'false').json.relay_acked).toBe(true)
    expect(drive('send', '--text', '!burst 120', '--wait', 'false').json.relay_acked).toBe(true)
    for (let i = 0; i < 60 && replies() < before + 320; i++) spawnSync('sleep', ['1'])
    expect(replies()).toBeGreaterThanOrEqual(before + 320)
    const first = drive('catchup').json
    const bursts = first.frames.filter((f: Json) => f.type === 'reply' && /^burst \d+\/120$/.test(f.message.text))
    expect(first.pages, 'more than one page was asked for').toBeGreaterThan(1)
    expect(bursts).toHaveLength(120) // the whole second burst, though it sits past the first page
    const again = drive('catchup').json.frames.filter((f: Json) => f.type === 'reply' && /^burst /.test(f.message.text))
    expect(again).toEqual([])
  }, 180_000)

  it('a thread is created, renamed, given its own session and archived over the owner path', () => {
    expect(drive('thread-create', '--name', 'Break lab').json).toMatchObject({ ok: true, applied: true })
    expect(drive('thread-rename', '--thread', 'break_lab', '--name', 'Renamed').json.ok).toBe(true)
    expect(drive('thread-dedicated', '--thread', 'break_lab').json.ok).toBe(true)
    let t = drive('threads').json.threads.find((x: { id: string }) => x.id === 'break_lab')
    expect(t).toMatchObject({ name: 'Renamed', session: 'dedicated', archived: false })
    expect(drive('thread-archive', '--thread', 'break_lab').json.ok).toBe(true)
    t = drive('threads').json.threads.find((x: { id: string }) => x.id === 'break_lab')
    expect(t.archived).toBe(true)
    // a field the phone may not set is refused by the Mac, and the refusal is the answer (exit 1), not a silent success
    const bad = drive('config', '--patch', '{"not_a_setting":1}')
    expect(bad.code).toBe(1)
    expect(bad.json).toMatchObject({ ok: false, applied: false, error: { code: 'config_field_forbidden' } })
    const ok = drive('config', '--patch', '{"agent":{"name":"Sandy"}}')
    expect(ok.json).toMatchObject({ ok: true, applied: true })
    expect(drive('config').json.config.agent.name).toBe('Sandy')
  }, 120_000)

  it('a card is listed and answered; a second tap on the same card is refused', () => {
    expect(drive('send', '--text', '!card Ship it?').json.reply.text).toMatch(/^card: card c_/)
    const cards = drive('cards').json.cards
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ title: 'Ship it?', state: 'pending' })
    const r = drive('card-answer', '--card', cards[0].id, '--action', 'primary', '--times', '2')
    expect(r.json.update).toMatchObject({ state: 'done', result: { ok: true } })
    expect(r.json.errors.map((e: { code: string }) => e.code)).toEqual(['card_not_pending'])
    expect(drive('cards').json.count).toBe(0)
  }, 120_000)

  it('damage is limited to the sandbox’s own named files and can be put back', () => {
    expect(drive('corrupt', '--file', '../../../etc/hosts').code).toBe(2)
    // every named file is the bridge's real one: history is history.sqlite, and it exists once the bridge has run
    expect(drive('corrupt').json.files.history).toEqual({ path: join(up.json.home, 'history.sqlite'), exists: true })
    const c = drive('corrupt', '--file', 'config', '--how', 'bad-json')
    expect(c.json.path).toBe(join(up.json.home, 'config.json'))
    const refused = drive('config', '--patch', '{"agent":{"name":"Other"}}')
    expect(refused.json).toMatchObject({ ok: false, applied: false })
    expect(drive('restore', '--file', 'config').json.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(up.json.home, 'config.json'), 'utf8')).agent.name).toBe('Sandy')
  }, 120_000)

  it('with the relay down a send fails loudly; back up, the Mac reconnects and answers again', () => {
    expect(drive('offline').json).toMatchObject({ ok: true, relay_running: false })
    const lost = drive('send', '--text', 'into the void')
    expect(lost.code).toBe(1)
    expect(lost.json.error.code).toBe('relay_unreachable')
    expect(drive('online').json).toMatchObject({ ok: true, relay_healthy: true, bridge_reconnected: true })
    expect(drive('send', '--text', 'back again').json.reply.text).toBe('ack: back again')
  }, 120_000)

  it('STOP on Main is refused with the reason, not reported as done: tmux resumes a stopped pane at once', () => {
    const stop = drive('kill-main', '--signal', 'STOP')
    expect(stop.code).toBe(1)
    expect(stop.json.error).toMatchObject({
      code: 'stop_not_possible',
      message: expect.stringContaining('freeze-bridge'),
    })
    expect(drive('send', '--text', 'still running').json.reply.text).toBe('ack: still running')
  }, 120_000)

  it('status never calls a bridge healthy from the file a dead one left', () => {
    const k = drive('kill-bridge', '--signal', 'KILL')
    expect(k.json.bridge_alive).toBe(false)
    const s = sandbox('status', id).json
    if (s.bridge.pid === k.json.bridge_pid) {
      expect(s.bridge).toMatchObject({ alive: false, mode: null, relay_connected: false })
      expect(s.bridge.stale_file).toBeDefined()
      expect(s.main.ready).toBe(false)
    } else expect(s.bridge.alive).toBe(true) // the supervisor already put a new one in its place
    // the fake exits when its bridge dies and the supervisor restarts Main after its backoff: wait for that, so the tests
    // after this one find the sandbox as it was
    for (let i = 0; i < 60 && !sandbox('status', id).json.main?.ready; i++) spawnSync('sleep', ['1'])
    const back = sandbox('status', id).json
    expect(back.main.ready, JSON.stringify(back.supervisor.status)).toBe(true)
    expect(back.bridge).toMatchObject({ alive: true, mode: 'live', relay_connected: true })
  }, 120_000)

  it('killing Main’s claude is seen by the supervisor, which restarts it; the new Main answers', () => {
    const before = sandbox('status', id).json
    const r = drive('kill-main')
    expect(r.code, JSON.stringify(r.json)).toBe(0)
    expect(r.json).toMatchObject({
      restarted: true,
      phase: 'running',
      bridge_live: true,
      old_pid: before.main.pane_pid,
    })
    expect(r.json.new_pid).not.toBe(before.main.pane_pid)
    expect(alive(before.main.pane_pid)).toBe(false)
    expect(alive(before.bridge.pid)).toBe(false)
    const log = drive('log', '--which', 'supervisor', '--lines', '20').json.lines.join('\n')
    expect(log).toMatch(/"event":"exit","pid":"\d+","code":"-","signal":"9"/)
    expect(log).toMatch(/"event":"restart"/)
    expect(drive('send', '--text', 'after the restart').json.reply.text).toBe('ack: after the restart')
  }, 120_000)

  it('down stops every process it started, removes the socket and the root, and leaves nothing behind', () => {
    const s = sandbox('status', id).json
    const pids = [s.relay.pid, s.supervisor.pid, s.main.pane_pid, s.bridge.pid] as number[]
    for (const pid of pids) expect(alive(pid), `pid ${pid} before down`).toBe(true)
    const socket = join('/tmp', `tmux-${process.getuid?.()}`, s.tmux.socket)
    expect(existsSync(socket)).toBe(true)
    const d = sandbox('down', id)
    expect(d.code, JSON.stringify(d.json)).toBe(0)
    expect(d.json).toMatchObject({ removed: true, leftovers: [] })
    expect(d.json.stopped).toEqual(expect.arrayContaining(['supervisor', 'main', 'bridge', 'tmux', 'relay']))
    for (const pid of pids) expect(alive(pid), `pid ${pid} after down`).toBe(false)
    expect(existsSync(socket)).toBe(false)
    expect(existsSync(s.root)).toBe(false)
    // no process anywhere still names the sandbox's folders
    const ps = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout
    expect(ps.split('\n').filter((l) => l.includes(`talos-sandbox-${id}`))).toEqual([])
    expect(sandbox('down', id).code).toBe(1)
    expect(sandbox('list').json.sandboxes).toEqual([])
  }, 120_000)
})
