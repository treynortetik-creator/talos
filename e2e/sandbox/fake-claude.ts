// A stand-in for the `claude` program, for a sandbox started with --fake-claude. The supervisor runs it in tmux exactly as
// it would run Claude Code; it starts the real bridge as its MCP server (through the testkit's FakeClaude, the same client
// the end-to-end suite uses), draws an input box so the supervisor reads the session as ready, and answers the owner's
// messages. No model is called and nothing leaves this machine.
//
//   <text>                reply `ack: <text>` (over 4,000 characters: the first 200 and the length)
//   !card <title>         raise a low-risk decision card in that thread, then reply with its id
//   !slow <ms> <text>     reply after a delay
//   !burst <n>            n replies, one after another
//   !silent               no reply at all
//   !hang                 stop answering from now on (the process stays alive)
//   !exit <code>          exit with that code (0 = a clean exit, anything else = a crash)
// A PRIMARY card action is answered with `card_result ok`.
//
// `agents --json` (the supervisor's "is Main still answering" poll) lists the running fake as one interactive session.
//
// With TALOS_SANDBOX_FAKE_MODE=worker-hello in a thread session's pane (TALOS_APP_WORKER_THREAD set by the supervisor), it plays
// that session instead (workerHello below): the real bridge in worker mode, Claude Code's input box, and read_inbound on the
// pointer line. Without both variables nothing below that branch changes.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_POINTER_TEXT } from '@talos-app/protocol'
import { type ChannelNote, FakeClaude } from '@talos-app/testkit'

const argv = process.argv.slice(2)
const root = process.env.TALOS_SANDBOX_ROOT
if (!root) {
  console.error('fake claude: TALOS_SANDBOX_ROOT is not set (this program only runs inside a Talos sandbox)')
  process.exit(2)
}
const stateFile = join(root, 'fake-claude.json')
const logFile = join(root, 'fake-claude.log')

const readState = (): { pid: number; session_id: string; cwd: string } | null => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return null
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const parentOf = (pid: number): number | null => {
  const n = Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

if (argv[0] === 'agents') {
  const s = readState()
  const list =
    s && alive(s.pid) ? [{ kind: 'interactive', pid: s.pid, sessionId: s.session_id, status: 'idle', cwd: s.cwd }] : []
  console.log(JSON.stringify(list))
  process.exit(0)
}
if (argv[0] === '--version' || argv[0] === '-v') {
  console.log('0.0.0 (Talos sandbox fake)')
  process.exit(0)
}
if (argv[0] !== undefined && !argv[0].startsWith('-')) {
  console.error(`fake claude: no "${argv[0]}" command here`)
  process.exit(2)
}

const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const sessionId = flag('--session-id') ?? flag('--resume') ?? 'no-session'
const log = (event: string, fields: Record<string, unknown> = {}) => {
  try {
    appendFileSync(
      logFile,
      `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...fields })}\n`,
      {
        mode: 0o600,
      },
    )
  } catch {
    // a log that cannot be written must not stop the agent
  }
}

const workerThread = process.env.TALOS_APP_WORKER_THREAD
if (process.env.TALOS_SANDBOX_FAKE_MODE === 'worker-hello' && workerThread) await workerHello(workerThread)

// The bridge, as the agent folder's .mcp.json names it (the file `talos-app install-mcp` wrote).
type McpEntry = { command: string; args: string[]; env?: Record<string, string> }
let entry: McpEntry
try {
  const cfg = JSON.parse(readFileSync(join(process.cwd(), '.mcp.json'), 'utf8')) as {
    mcpServers?: Record<string, McpEntry>
  }
  const e = cfg.mcpServers?.['talos-app']
  if (!e || typeof e.command !== 'string' || !Array.isArray(e.args)) throw new Error('no talos-app server in it')
  entry = e
} catch (e) {
  console.error(`fake claude: cannot read .mcp.json in ${process.cwd()}: ${(e as Error).message}`)
  log('mcp_config_unreadable', { error: (e as Error).message })
  process.exit(1)
}

writeFileSync(stateFile, `${JSON.stringify({ pid: process.pid, session_id: sessionId, cwd: process.cwd() })}\n`, {
  mode: 0o600,
})
log('start', { session: sessionId, resume: argv.includes('--resume'), argv })

const claude = new FakeClaude({ command: entry.command, args: entry.args, env: entry.env ?? {}, autoReply: false })
let hung = false
let handled = 0

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join(' ')

async function reply(thread: string, body: string): Promise<void> {
  const r = await claude.callTool('reply', { thread_id: thread, text: body })
  log('reply', { thread, chars: body.length, error: r.isError === true ? text(r).slice(0, 300) : undefined })
}

async function handle(note: ChannelNote): Promise<void> {
  const kind = note.meta.kind
  const thread = note.meta.thread_id ?? note.meta.chat_id
  log('notification', { kind, thread, trust: note.meta.trust, chars: note.content.length, meta: note.meta })
  if (hung) return
  if (kind === 'card_action') {
    if (note.meta.card_action === 'primary' && note.meta.card_id) {
      const r = await claude.callTool('card_result', { card_id: note.meta.card_id, ok: true, text: 'done' })
      log('card_result', { card: note.meta.card_id, error: r.isError === true ? text(r).slice(0, 300) : undefined })
    }
    return
  }
  if (!thread || (kind !== 'text' && kind !== 'voice_note' && kind !== 'file')) return
  const body = note.content
  const [word = '', ...rest] = body.trim().split(/\s+/)
  if (word === '!silent') return
  if (word === '!hang') {
    hung = true
    return
  }
  if (word === '!exit') {
    const code = Number(rest[0] ?? '1')
    log('exit_on_request', { code })
    process.exit(Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1)
  }
  if (word === '!slow') {
    const ms = Math.min(Math.max(Number(rest[0]) || 0, 0), 600_000)
    await new Promise((r) => setTimeout(r, ms))
    return reply(thread, `ack: ${rest.slice(1).join(' ')}`)
  }
  if (word === '!burst') {
    const n = Math.min(Math.max(Number(rest[0]) || 1, 1), 200)
    for (let i = 1; i <= n; i++) await reply(thread, `burst ${i}/${n}`)
    return
  }
  if (word === '!card') {
    const title = rest.join(' ').slice(0, 120) || 'Sandbox card'
    const r = await claude.callTool('card', {
      thread_id: thread,
      kind: 'decision',
      title,
      primary_label: 'Yes',
      kill_label: 'No, drop it',
      risk: 'low',
      origin: 'chat',
    })
    log('card', { thread, title, result: text(r).slice(0, 300), error: r.isError === true })
    return reply(thread, `card: ${text(r)}`)
  }
  // a reply has the same length limit as a message: a very long one is acknowledged by its size
  return reply(thread, body.length > 4000 ? `ack: ${body.slice(0, 200)}… (${body.length} characters)` : `ack: ${body}`)
}

// What the supervisor looks for on the screen: Claude Code's input box (a rule, a `❯` row, a rule).
const rule = '─'.repeat(60)
const draw = (line: string) => process.stdout.write(`\x1b[2J\x1b[H${line}\n\n${rule}\n❯ \n${rule}\n`)
process.stdout.write(`fake claude starting (session ${sessionId})\n`)

const bye = (code: number) => {
  log('stop', { code })
  void claude
    .stop()
    .catch(() => {})
    .finally(() => process.exit(code))
  setTimeout(() => process.exit(code), 3000).unref()
}
process.on('SIGTERM', () => bye(143))
process.on('SIGINT', () => bye(130))
process.on('SIGHUP', () => bye(129))

try {
  await claude.start()
} catch (e) {
  console.error(`fake claude: the bridge did not start: ${(e as Error).message}\n${claude.stderr.slice(-2000)}`)
  log('bridge_start_failed', { error: (e as Error).message, stderr: claude.stderr.slice(-2000) })
  process.exit(1)
}
log('bridge_connected')
draw(`fake claude (Talos sandbox) · session ${sessionId} · bridge connected`)

// One note at a time, in arrival order, as a real session takes them.
let busy = false
let bridgePid: number | null = null
const home = process.env.TALOS_APP_HOME ?? entry.env?.TALOS_APP_HOME
setInterval(() => {
  // the bridge is this program's only link to the owner: when it dies, so does the session (the supervisor restarts both)
  if (home) {
    try {
      const pid = (JSON.parse(readFileSync(join(home, 'bridge.pid'), 'utf8')) as { pid?: number }).pid
      // only this session's own bridge: the file may still name the one a Main before this started
      if (bridgePid === null && typeof pid === 'number' && parentOf(pid) === process.pid) bridgePid = pid
    } catch {
      // not written yet
    }
    if (bridgePid !== null && !alive(bridgePid)) {
      log('bridge_gone', { pid: bridgePid })
      process.stdout.write('\nfake claude: the bridge process is gone\n')
      process.exit(1)
    }
  }
  if (busy || handled >= claude.notifications.length) return
  busy = true
  const note = claude.notifications[handled++] as ChannelNote
  void handle(note)
    .catch((e) => log('handle_failed', { error: String((e as Error)?.message ?? e) }))
    .finally(() => {
      busy = false
    })
}, 50)

/**
 * A thread session, as the supervisor and the hub see one. The bridge is the real one, from the worker's own MCP config
 * (`--mcp-config=<path>` when the launch has one, else the folder's .mcp.json), started as this process's child in the pane's
 * process group, with the pane's environment (TALOS_APP_WORKER_THREAD and TALOS_APP_WORKER_NONCE): its hello, nonce and
 * process-group check at the hub are the real ones. The screen is Claude Code 2.1.318's input box: two rules with `❯` U+00A0
 * between them, a dim placeholder while empty, typed text at normal intensity. Keys are read raw into the box; an Enter on
 * exactly WORKER_POINTER_TEXT calls read_inbound and answers each message with `ack: <text>`; anything else is logged and
 * dropped. Never returns. It does not write fake-claude.json: `agents --json` keeps naming Main.
 */
async function workerHello(thread: string): Promise<never> {
  const given = argv.find((a) => a.startsWith('--mcp-config='))?.slice('--mcp-config='.length)
  const cfgPath = given ?? join(process.cwd(), '.mcp.json')
  type Server = { command: string; args: string[]; env?: Record<string, string> }
  let server: Server
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { mcpServers?: Record<string, Server> }
    const e = cfg.mcpServers?.['talos-app']
    if (!e || typeof e.command !== 'string' || !Array.isArray(e.args)) throw new Error('no talos-app server in it')
    server = e
  } catch (e) {
    console.error(`fake claude (thread session): cannot read ${cfgPath}: ${(e as Error).message}`)
    log('worker_mcp_config_unreadable', { thread, path: cfgPath, error: (e as Error).message })
    process.exit(1)
  }
  const pgid = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim())
  log('worker_start', {
    thread,
    session: sessionId,
    resume: argv.includes('--resume'),
    pgid,
    mcp_config: cfgPath,
    cwd: process.cwd(),
  })
  const c = new FakeClaude({ command: server.command, args: server.args, env: server.env ?? {}, autoReply: false })
  const stop = (code: number) => {
    log('worker_stop', { thread, code })
    void c
      .stop()
      .catch(() => {})
      .finally(() => process.exit(code))
    setTimeout(() => process.exit(code), 3000).unref()
  }
  process.on('SIGTERM', () => stop(143))
  process.on('SIGINT', () => stop(130))
  process.on('SIGHUP', () => stop(129))

  const rule = '─'.repeat(60)
  let box = ''
  let status = 'starting the bridge'
  let handled = 0
  const draw = () => {
    const inner = box === '' ? '\x1b[2mTry "say hello"\x1b[22m' : box
    process.stdout.write(
      `\x1b[2J\x1b[Hfake claude (Talos sandbox) · thread session ${thread} · session ${sessionId}\n${status} · ${handled} answered\n\n${rule}\n❯\u00a0${inner}\n${rule}\n`,
    )
  }
  draw()
  try {
    await c.start()
  } catch (e) {
    console.error(
      `fake claude (thread session): the bridge did not start: ${(e as Error).message}\n${c.stderr.slice(-2000)}`,
    )
    log('worker_bridge_start_failed', { thread, error: (e as Error).message, stderr: c.stderr.slice(-2000) })
    process.exit(1)
  }
  log('worker_bridge_connected', { thread })
  status = 'bridge connected'
  draw()

  const said = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((x) => x.text ?? '').join(' ')
  async function pointer(): Promise<void> {
    const r = await c.callTool('read_inbound', {})
    let got: { messages?: Array<{ content: string; meta: Record<string, string> }>; already_handled_by_main?: string[] }
    try {
      got = JSON.parse(said(r))
    } catch {
      got = {}
    }
    const messages = got.messages ?? []
    log('worker_pointer', {
      thread,
      count: messages.length,
      ids: messages.map((m) => m.meta.message_id),
      already_handled_by_main: got.already_handled_by_main ?? [],
      error: r.isError === true ? said(r).slice(0, 300) : undefined,
    })
    for (const m of messages) {
      const to = m.meta.thread_id ?? thread
      const body = `ack: ${m.content}`
      const res = await c.callTool('reply', { thread_id: to, text: body })
      handled++
      log('worker_reply', {
        thread: to,
        message_id: m.meta.message_id,
        text: body,
        error: res.isError === true ? said(res).slice(0, 300) : undefined,
      })
    }
  }
  // one line at a time, in the order they were entered
  let queue: Promise<void> = Promise.resolve()
  const enter = (line: string) => {
    if (line !== WORKER_POINTER_TEXT) {
      log('worker_ignored', { thread, chars: line.length })
      return
    }
    queue = queue
      .then(pointer)
      .catch((e) => log('worker_pointer_failed', { thread, error: String((e as Error)?.message ?? e) }))
      .finally(draw)
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    for (const ch of chunk) {
      if (ch === '\r' || ch === '\n') {
        const line = box
        box = ''
        enter(line)
      } else if (ch === '\x7f' || ch === '\b') box = [...box].slice(0, -1).join('')
      else if (ch === '\x03') box = ''
      else if (ch >= ' ') box += ch
    }
    draw()
  })
  process.stdin.resume()
  return new Promise<never>(() => {})
}
