// Which `talos-app` commands a thread's own session (a worker, a lead) may run from its shell: the ones below, and nothing
// else. Every other command reads or writes across threads or inside the Talos home, or changes the app, and a thread
// works through its own thread's tools instead (docs/OPTION-C.md "Leads and the fence"). Allow list on purpose: a command
// added later is refused to a thread until someone decides.
//
// How a thread session is known: the variables the supervisor sets (TALOS_APP_WORKER_THREAD, TALOS_SESSION_ROLE=worker), or
// a `.talos-lead` marker in the current folder or any parent. That is a fence against accidents, not a lock: from outside a
// lead's folder with the variables unset (`cd /tmp && env -u TALOS_SESSION_ROLE -u TALOS_APP_WORKER_THREAD talos-app logs`)
// nothing says it is a thread session. The real protection of the Talos home is the deny rules on it.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { defaultHome } from '../config.ts'

/**
 * The commands a thread session may run, by their first words (so `hook` takes any arguments). `hook` and `guard-hook` are
 * Claude Code's own per-call entries and run inside every session; `subagent-tee` is its status-line helper; `commands` and `events` list
 * the commands and the named events; `lead check` and `codex check` read nothing of the Talos home. `talos-app` alone and `help` print the usage.
 */
export const WORKER_COMMANDS_OK: readonly string[] = [
  'hook',
  'guard-hook',
  'commands',
  'events',
  'subagent-tee',
  'lead check',
  'codex check',
]
/**
 * What a thread session may ALSO run when the owner turned `session_opts.ops_read` on for that thread: read the problem
 * folder, nothing else (`errors close` and every other command stay refused). A second list on purpose, consulted only with
 * the flag on and never merged into the first. `errors show` and `errors list` print less to such a caller (problems/cli.ts).
 * Also allowed when the owner turned the thread fence off (Settings -> Developer): then a thread reads them as Main does.
 */
export const WORKER_OPS_READ_OK: readonly string[] = ['errors list', 'errors show']
/**
 * Read-only commands every thread session may run (Pantheon 2026-11-15: a lead reads status, doctor and logs). `status` and
 * `doctor` say how the setup is; `logs` shows a thread session only its own thread's lines (cli-main.ts `cmdLogs`).
 */
export const WORKER_READ_OK: readonly string[] = ['status', 'doctor', 'logs']
/**
 * Also open to a thread session (owner ruling 2026-11-19, Pantheon's decision C): the commands the agent runs itself unless
 * "Lock Talos settings" is on (agent-cli.ts judges the lock, the outside text and the device lock-out). Everything else in the
 * fence is unchanged. `devices` alone lists; a `devices` or `peer` word not named in talos.ts AGENT_UNLESS_LOCKED stays terminal-only.
 */
export const WORKER_AGENT_OK: readonly string[] = [
  'peer link',
  'peer accept',
  'peer create',
  'peer add',
  'peer list',
  'peer remove',
  'peer rotate',
  'peer secret-forget',
  'devices',
  'relay update',
  'relay auto',
  'relay disconnect',
  'relay status',
]
const USAGE_WORDS = ['help', '--help', '-h']

/** The nearest folder at or above `cwd` that holds a `.talos-lead` marker (a lead's folder), or undefined. */
function leadFolderAbove(cwd: string): string | undefined {
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.talos-lead'))) return dir
    const up = dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

const listed = (list: readonly string[], argv: readonly string[]) =>
  list.some((entry) => entry.split(' ').every((w, i) => argv[i] === w))

/**
 * Is `argv` a command a thread session may not run? Anything not named in WORKER_COMMANDS_OK is, unless `opsRead` (the
 * thread's flag is on) and it is named in WORKER_OPS_READ_OK.
 */
export function refusedForWorkers(argv: readonly string[], opsRead = false): boolean {
  const [cmd] = argv
  if (cmd === undefined || USAGE_WORDS.includes(cmd)) return false
  if (listed(WORKER_COMMANDS_OK, argv) || listed(WORKER_READ_OK, argv) || listed(WORKER_AGENT_OK, argv)) return false
  return !(opsRead && listed(WORKER_OPS_READ_OK, argv))
}

type Caller = { how: string; folder?: string; thread?: string }

/** Who is calling from a thread session, or undefined for the main session. The thread id is the supervisor's variable, or the marker's `thread`; if both say something they must agree. */
function threadCaller(raw: Record<string, string | undefined>, cwd: string): Caller | undefined {
  const envThread = raw.TALOS_APP_WORKER_THREAD || undefined
  const byEnv = Boolean(envThread) || raw.TALOS_SESSION_ROLE === 'worker'
  const folder = leadFolderAbove(cwd)
  if (!byEnv && !folder) return undefined
  let marked: unknown
  if (folder) {
    try {
      marked = (JSON.parse(readFileSync(join(folder, '.talos-lead'), 'utf8')) as { thread?: unknown }).thread
    } catch {}
  }
  const markThread = typeof marked === 'string' && marked !== '' ? marked : undefined
  const thread = envThread && markThread && envThread !== markThread ? undefined : (envThread ?? markThread)
  return {
    how: byEnv ? 'a thread session' : `a lead's folder (${folder}/.talos-lead exists)`,
    ...(folder ? { folder } : {}),
    ...(thread ? { thread } : {}),
  }
}

/**
 * Did the owner turn `ops_read` on for this thread? Strictly `true` in config.json; any doubt (no file, junk, no such thread) is no.
 * It asks nothing more of the thread: an archived or not-dedicated thread keeps the grant (archiving leaves `session_opts` for a
 * restore; a lead folder's marker names the thread whatever its mode). The owner takes it away by editing the key.
 */
function opsReadOn(thread: string | undefined, raw: Record<string, string | undefined>): boolean {
  if (!thread) return false
  try {
    const home = raw.TALOS_APP_HOME || defaultHome()
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { threads?: unknown }
    if (!Array.isArray(cfg.threads)) return false
    const t = cfg.threads.find((x: { id?: unknown }) => x?.id === thread) as
      | { session_opts?: { ops_read?: unknown } }
      | undefined
    return t?.session_opts?.ops_read === true
  } catch {
    return false
  }
}

/** Did the owner turn the developer thread fence off (`dev.thread_fence` exactly `false` in config.json)? Any doubt is no. */
export function fenceOffFor(raw: Record<string, string | undefined>): boolean {
  // read here, not through supervisor/worker-config.ts: this file is on the CLI's early-exit path, which must load with the
  // packages missing (rollback, subagent-tee). Same rule as threadFenceOn: off only for exactly `"dev": { "thread_fence": false }`.
  try {
    const home = raw.TALOS_APP_HOME || defaultHome()
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      dev?: { thread_fence?: unknown }
    } | null
    return cfg?.dev?.thread_fence === false
  } catch {
    return false
  }
}

/**
 * Is this a thread session (the supervisor's variables, or a lead folder's marker)? Decided without the config, so what a thread
 * is shown never depends on a file read that can change between the fence and the output: it fails closed.
 */
export function isThreadCaller(raw: Record<string, string | undefined>, cwd: string = process.cwd()): boolean {
  return threadCaller(raw, cwd) !== undefined
}

/**
 * For `logs`: null for the main session; for a thread session, the thread it belongs to (the supervisor's variable or the lead
 * marker's), or undefined when that can't be told (then it is shown nothing).
 */
export function threadOfCaller(
  raw: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): string | undefined | null {
  const caller = threadCaller(raw, cwd)
  return caller ? caller.thread : null
}

/** The refusal in words when `argv` is run from a thread session, or undefined. `raw` is the environment, `cwd` the folder it runs in. */
export function workerCliRefusal(
  argv: readonly string[],
  raw: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): string | undefined {
  if (!refusedForWorkers(argv)) return undefined
  const caller = threadCaller(raw, cwd)
  if (!caller) return undefined
  if (!refusedForWorkers(argv, true) && (opsReadOn(caller.thread, raw) || fenceOffFor(raw))) return undefined
  const name = argv
    .slice(0, 2)
    .filter((a) => !a.startsWith('-'))
    .join(' ')
  return `talos-app ${name} is not available in ${caller.how}: a thread works through its own thread's tools. Ask the owner.`
}
