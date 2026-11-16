// A thread session ("worker") on Linux, proven end to end in a sandbox: the real relay, the real supervisor on its own tmux
// server, the real Main bridge (the hub) and, in the worker's pane, the sandbox's fake claude in its worker-hello mode, which
// starts the real bridge in worker mode from the worker's own MCP config (so the hub's hello, nonce and process-group check
// are the real ones), draws Claude Code's input box and answers what read_inbound hands it once the supervisor types the
// pointer. Only Claude Code is the fake. The supervisor is `up`'s own, as on a real install (thread sessions on by default); the
// fake's worker mode comes from the sandbox's supervisor.json env, which a thread session gets as the Mac gives it.
//
// Runs with TALOS_SANDBOX_E2E=1, like scripts/sandbox.test.ts; it takes a few minutes on a slow machine.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { processGroup } from '../apps/bridge/src/proc-identity.ts'
import { BRIDGE_CLI, BRIDGE_DIR } from '../e2e/harness/paths.ts'
import { cleanEnv, files, groupAlive, readJson, type SandboxRecord } from '../e2e/sandbox/state.ts'

const script = fileURLToPath(new URL('../e2e/sandbox.ts', import.meta.url))
const have = (tool: string) =>
  spawnSync(tool, [tool === 'tmux' ? '-V' : '--version'], { encoding: 'utf8' }).status === 0
// Linux only: this is the cross-platform supervisor's thread sessions (the Mac's are the Swift app's, tested there)
const canRun = process.platform === 'linux' && process.env.TALOS_SANDBOX_E2E === '1' && have('tmux') && have('bun')

// A short base (the Talos home holds the hub's unix socket, and those paths have a length limit): the one the caller names
// (TALOS_SANDBOX_BASE), else a fresh folder.
const given = process.env.TALOS_SANDBOX_BASE
if (given) mkdirSync(given, { recursive: true })
const base = given ? realpathSync(given) : realpathSync(mkdtempSync('/tmp/tsbw-'))
const env = { ...process.env, TALOS_SANDBOX_BASE: base }

// biome-ignore lint/suspicious/noExplicitAny: the command's JSON answers and the logs, read field by field in the assertions
type Json = Record<string, any>
type Out = { code: number | null; json: Json; err: string }
const sandbox = (...args: string[]): Out => {
  const r = spawnSync(
    'node',
    ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', script, ...args],
    { encoding: 'utf8', env, timeout: 400_000 },
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** Polls `fn` until it gives a value, or fails with `what` and the last thing it saw. Never a fixed sleep in its place. */
async function until<T>(
  what: string,
  ms: number,
  fn: () => T | null | undefined | false,
  seen?: () => unknown,
): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end)
      throw new Error(
        `timed out after ${Math.round(ms / 1000)} s waiting for ${what}: ${JSON.stringify(seen?.() ?? null)}`,
      )
    await sleep(500)
  }
}

const THREAD = 'worker_lab'
const ids: string[] = []

afterAll(() => {
  for (const id of ids) {
    const d = sandbox('down', id)
    if (d.code !== 0 || d.json.leftovers?.length) console.error(`sandbox down ${id}: ${JSON.stringify(d.json)}`)
  }
  if (!given) rmSync(base, { recursive: true, force: true })
}, 120_000)

describe.skipIf(!canRun)('the Linux supervisor’s thread sessions, end to end in a sandbox (Linux only)', () => {
  let id = ''
  let root = ''
  let home = ''
  const drive = (action: string, ...args: string[]) => sandbox('drive', id, action, ...args)
  const log = (): Json[] => {
    try {
      return readFileSync(files(root).fakeClaudeLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Json)
    } catch {
      return []
    }
  }
  const workers = () => readJson<Json>(join(home, 'workers.json'))
  const entry = () => workers()?.threads?.[THREAD] as Json | undefined
  const supervisorLog = () => {
    try {
      return readFileSync(join(home, 'supervisor.log'), 'utf8')
    } catch {
      return ''
    }
  }
  /** The sandbox's record, from the root `up` reported (never rebuilt from an environment this process may not share). */
  const record = (): SandboxRecord => {
    const rec = readJson<SandboxRecord>(files(root).record)
    if (!rec || rec.root !== root) throw new Error(`no readable sandbox.json in ${root}`)
    return rec
  }
  /** The pane pid tmux itself reports for the thread's session (never a value read from a file the test checks). */
  const tmuxPane = (): number | null => {
    const rec = record()
    const r = spawnSync(
      rec.tmux.bin,
      ['-L', rec.tmux.socket, 'list-panes', '-t', `=t-${THREAD}`, '-F', '#{pane_pid}'],
      {
        encoding: 'utf8',
      },
    )
    const pid = Number(r.stdout.split('\n')[0]?.trim())
    return r.status === 0 && Number.isInteger(pid) && pid > 1 ? pid : null
  }
  const mainPid = () => readJson<{ pid: number }>(files(root).fakeClaude)?.pid ?? 0

  /** The sandbox's own supervisor, as `up` starts it: running, with workers.json saying it hosts thread sessions (the default). */
  async function supervisorReady(): Promise<void> {
    const rec = record()
    await until(
      'the supervisor to run Main and publish workers_supported',
      90_000,
      () => {
        const w = workers()
        const s = readJson<Json>(join(rec.home, 'supervisor-status.json'))
        return w?.supervisor?.workers_supported === true && s?.phase === 'running'
      },
      () => ({ workers: workers()?.supervisor, status: readJson(join(rec.home, 'supervisor-status.json')) }),
    )
  }

  beforeAll(async () => {
    const up = sandbox('up', '--fake-claude')
    id = up.json.id ?? ''
    if (id) ids.push(id)
    expect(up.code, `${JSON.stringify(up.json)} ${up.err.slice(-2000)}`).toBe(0)
    root = up.json.root
    home = up.json.home
    await supervisorReady()
  }, 400_000)

  it('a message to a dedicated thread is answered by its own session, not by Main', async () => {
    const t0 = Date.now()
    expect(drive('thread-create', '--name', 'Worker lab').json).toMatchObject({ ok: true, applied: true })
    expect(drive('thread-dedicated', '--thread', THREAD).json).toMatchObject({ ok: true, applied: true })
    const main = mainPid()
    expect(main).toBeGreaterThan(1)
    // the seam says so in the supervisor's own log
    // a cold start: the supervisor starts the session for the wake, the hub verifies its hello, the pointer is typed
    const r = drive('send', '--thread', THREAD, '--text', 'hello worker', '--timeout_s', '240')
    console.log(`first reply after ${Math.round((Date.now() - t0) / 1000)} s`)
    expect(r.code, `${JSON.stringify(r.json)}\n${supervisorLog().slice(-3000)}`).toBe(0)
    expect(r.json.reply).toMatchObject({ author: 'agent', thread_id: THREAD, text: 'ack: hello worker' })
    // nothing in the thread says Main stood in for the session
    expect(r.json.system_rows).toEqual([])

    // workers.json: the thread is live, with the pane tmux reports
    const e = entry()
    expect(e?.state).toMatch(/^(live|busy)$/)
    const pane = tmuxPane()
    expect(pane).not.toBeNull()
    expect(e?.pane_pid).toBe(pane)
    expect(groupAlive(pane as number)).toBe(true)
    expect(pane).not.toBe(main)
    // the hub's ready file: a hello it verified, from a pid in that pane's process group
    const ready = readJson<Json>(join(home, 'workers', THREAD, 'ready'))
    expect(ready?.thread_id).toBe(THREAD)
    expect(processGroup(ready?.pid)).toBe(pane)

    // the fake's log: the worker read the message through read_inbound and replied, from the pane's own process (its line is
    // written once the reply tool has answered, which can be a moment after the phone has the row)
    await until(
      'the thread session to log its reply',
      30_000,
      () => log().some((l) => l.pid === pane && l.event === 'worker_reply'),
      () => log().slice(-10),
    )
    const mine = log().filter((l) => l.pid === pane)
    expect(mine.map((l) => l.event)).toEqual(
      expect.arrayContaining(['worker_start', 'worker_bridge_connected', 'worker_pointer', 'worker_reply']),
    )
    expect(mine.find((l) => l.event === 'worker_start')).toMatchObject({ thread: THREAD, pgid: pane })
    expect(mine.find((l) => l.event === 'worker_reply')).toMatchObject({ thread: THREAD, text: 'ack: hello worker' })
    // nothing but the thread's own session ever saw the message or answered in that thread (Main included, if it restarted)
    expect(log().filter((l) => l.thread === THREAD && l.pid !== pane)).toEqual([])
    expect(alive(main)).toBe(true)
    // the supervisor's own account
    expect(supervisorLog()).toMatch(new RegExp(`"event":"worker_live","thread":"${THREAD}","pid":"${pane}"`))
    expect(supervisorLog()).toMatch(new RegExp(`"event":"worker_pointer","thread":"${THREAD}"`))
  }, 400_000)

  it('restart-thread parks the session and starts it again; the new one answers', async () => {
    const before = entry()?.pane_pid as number
    expect(before).toBeGreaterThan(1)
    const t0 = Date.now()
    const r = spawnSync('bun', ['run', BRIDGE_CLI, 'supervise', 'restart-thread', THREAD], {
      cwd: BRIDGE_DIR,
      env: { ...cleanEnv(), TALOS_APP_HOME: home, HOME: files(root).userHome },
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
    const after = await until(
      'the thread session to come back live in a new pane',
      240_000,
      () => {
        const e = entry()
        return e && /^(live|busy)$/.test(e.state) && e.pane_pid > 1 && e.pane_pid !== before
          ? (e.pane_pid as number)
          : null
      },
      () => entry(),
    )
    console.log(`restarted after ${Math.round((Date.now() - t0) / 1000)} s`)
    expect(groupAlive(before)).toBe(false)
    expect(tmuxPane()).toBe(after)
    const _main = mainPid()
    const s = drive('send', '--thread', THREAD, '--text', 'hello again', '--timeout_s', '240')
    expect(s.code, `${JSON.stringify(s.json)}\n${supervisorLog().slice(-3000)}`).toBe(0)
    expect(s.json.reply).toMatchObject({ author: 'agent', thread_id: THREAD, text: 'ack: hello again' })
    expect(s.json.system_rows).toEqual([])
    const reply = await until(
      'the new thread session to log its reply',
      30_000,
      () => log().find((l) => l.pid === after && l.event === 'worker_reply'),
      () => log().slice(-10),
    )
    expect(reply).toMatchObject({
      thread: THREAD,
      text: 'ack: hello again',
    })
    expect(log().filter((l) => l.thread === THREAD && l.pid !== before && l.pid !== after)).toEqual([])
  }, 400_000)

  // ---- sub-threads (P3d5): the Mac's rules, the folder made inside the parent's, talos-app from --mcp-config ----
  const PARENT = 'proj_lab'
  const SUB = 'bug_lab'
  const subEntry = () => workers()?.threads?.[SUB] as Json | undefined
  const subStarts = () => log().filter((l) => l.event === 'worker_start' && l.thread === SUB)

  it('a sub-thread starts in its own folder, made inside its parent’s, and answers through talos-app from --mcp-config', async () => {
    const proj = join(root, 'userhome', 'proj')
    mkdirSync(proj, { recursive: true })
    // the bridge takes a dedicated thread's folder only when it is there (the owner picks one); the supervisor makes it again
    // when it has gone since, inside the parent's
    const bug = join(proj, 'bug')
    mkdirSync(bug)
    expect(drive('thread-create', '--name', 'Proj lab').json).toMatchObject({ ok: true, applied: true })
    expect(drive('thread-create', '--name', 'Bug lab').json).toMatchObject({ ok: true, applied: true })
    expect(drive('thread-session', '--thread', PARENT, '--cwd', proj).json).toMatchObject({ ok: true, applied: true })
    expect(drive('thread-dedicated', '--thread', PARENT).json).toMatchObject({ ok: true, applied: true })
    // the bridge takes a parent_id only while the supervisor says subthreads_supported (part D)
    expect(workers()?.supervisor?.subthreads_supported).toBe(true)
    const sub = drive('thread-session', '--thread', SUB, '--parent', PARENT, '--cwd', bug)
    expect(sub.json, JSON.stringify(sub.json)).toMatchObject({ ok: true, applied: true })
    const ded = drive('thread-dedicated', '--thread', SUB)
    expect(ded.json, JSON.stringify(ded.json)).toMatchObject({ ok: true, applied: true })
    rmSync(bug, { recursive: true })

    const r = drive('send', '--thread', SUB, '--text', 'hello sub', '--timeout_s', '240')
    expect(r.code, `${JSON.stringify(r.json)}\n${supervisorLog().slice(-3000)}`).toBe(0)
    expect(r.json.reply).toMatchObject({ author: 'agent', thread_id: SUB, text: 'ack: hello sub' })
    expect(r.json.system_rows).toEqual([])
    // made by the supervisor inside the parent's folder, and the session runs there
    expect(existsSync(bug)).toBe(true)
    const start = subStarts().at(-1)
    expect(start?.cwd).toBe(realpathSync(bug))
    // no MCP list, a folder of its own: the agent folder's talos-app server, from the file the supervisor wrote
    expect(start?.mcp_config).toBe(join(home, 'workers', SUB, 'mcp.json'))
    expect(subEntry()?.cwd).toBe(realpathSync(bug))
  }, 400_000)

  it('the parent narrowing its MCP list restarts the running sub-thread with the list it inherits', async () => {
    const before = subStarts().length
    expect(drive('thread-session', '--thread', PARENT, '--mcp_allow', '["alpha"]').json).toMatchObject({
      ok: true,
      applied: true,
    })
    await until(
      'the sub-thread to restart with the inherited list',
      180_000,
      () => subStarts().length > before && subEntry()?.launched?.mcp_allow?.[0] === 'alpha',
      () => ({ entry: subEntry(), log: supervisorLog().slice(-1500) }),
    )
    expect(supervisorLog()).toMatch(
      new RegExp(`"event":"worker_launch_changed","thread":"${SUB}","changed":"mcp_allow"`),
    )
    // with a list, the strict plan's own file, never the no-list one
    expect(subStarts().at(-1)?.mcp_config).toBe(join(home, 'workers', SUB, 'mcp', 'mcp.json'))
    // the same conversation, resumed: only the list changed
    expect(subStarts().at(-1)?.resume).toBe(true)
  }, 400_000)

  it('a hand edit archives the parent alone: the running orphan is parked after its turn, and its next start is refused with the reason', async () => {
    // the app never archives a parent without its sub-threads (the bridge refuses it): only a hand edit to config.json does
    const path = join(home, 'config.json')
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { threads: Json[] }
    const p = cfg.threads.find((t) => t.id === PARENT)
    if (!p) throw new Error('no parent thread in config.json')
    p.archived = true
    writeFileSync(`${path}.tmp`, JSON.stringify(cfg, null, 2))
    renameSync(`${path}.tmp`, path)
    // a session the rules would not start does not run on: parked after its turn (38a9fa13), never restarted
    await until(
      'the running orphan to be parked',
      180_000,
      () =>
        subEntry()?.state === 'parked' && supervisorLog().includes(`"event":"worker_sub_refused","thread":"${SUB}"`),
      () => ({ entry: subEntry(), log: supervisorLog().slice(-1500) }),
    )
    // a message for it: its start is refused with the reason (the hub's claim deadline hands the message to Main)
    drive('send', '--thread', SUB, '--text', 'are you there', '--timeout_s', '20')
    await until(
      'the orphan’s start to be refused',
      120_000,
      () => subEntry()?.state === 'failed' && subEntry(),
      () => ({ entry: subEntry(), log: supervisorLog().slice(-1500) }),
    )
    expect(subEntry()?.error).toMatchObject({ code: 'start_failed' })
    expect(subEntry()?.error?.detail).toContain('the parent thread is not there any more')
  }, 400_000)

  it('down stops the thread session with everything else and leaves nothing behind', () => {
    const pane = entry()?.pane_pid as number
    const d = sandbox('down', id)
    ids.splice(ids.indexOf(id), 1)
    expect(d.code, JSON.stringify(d.json)).toBe(0)
    expect(d.json).toMatchObject({ removed: true, leftovers: [] })
    expect(groupAlive(pane)).toBe(false)
    expect(existsSync(root)).toBe(false)
    const ps = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout
    expect(ps.split('\n').filter((l) => l.includes(`talos-sandbox-${id}`))).toEqual([])
  }, 120_000)
})
