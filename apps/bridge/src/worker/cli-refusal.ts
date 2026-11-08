// Which `talos-app` commands a thread's own session (a worker, a lead) may run from its shell: the ones below, and nothing
// else. Every other command reads or writes across threads or inside the Talos home, or changes the app, and a thread
// works through its own thread's tools instead (docs/OPTION-C.md "Leads and the fence"). Allow list on purpose: a command
// added later is refused to a thread until someone decides.
//
// How a thread session is known: the variables the supervisor sets (TALOS_APP_WORKER_THREAD, TALOS_SESSION_ROLE=worker), or
// a `.talos-lead` marker in the current folder or any parent. That is a fence against accidents, not a lock: from outside a
// lead's folder with the variables unset (`cd /tmp && env -u TALOS_SESSION_ROLE -u TALOS_APP_WORKER_THREAD talos-app logs`)
// nothing says it is a thread session. The real protection of the Talos home is the deny rules on it.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The commands a thread session may run, by their first words (so `hook` takes any arguments). `hook` and `guard-hook` are
 * Claude Code's own per-call entries and run inside every session; `subagent-tee` is its status-line helper; `commands` lists
 * the commands; `lead check` and `codex check` read nothing of the Talos home. `talos-app` alone and `help` print the usage.
 */
export const WORKER_COMMANDS_OK: readonly string[] = [
  'hook',
  'guard-hook',
  'commands',
  'subagent-tee',
  'lead check',
  'codex check',
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

/** Is `argv` a command a thread session may not run? Anything not named in WORKER_COMMANDS_OK is. */
export function refusedForWorkers(argv: readonly string[]): boolean {
  const [cmd] = argv
  if (cmd === undefined || USAGE_WORDS.includes(cmd)) return false
  return !WORKER_COMMANDS_OK.some((entry) => {
    const words = entry.split(' ')
    return words.every((w, i) => argv[i] === w)
  })
}

/** The refusal in words when `argv` is run from a thread session, or undefined. `raw` is the environment, `cwd` the folder it runs in. */
export function workerCliRefusal(
  argv: readonly string[],
  raw: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): string | undefined {
  if (!refusedForWorkers(argv)) return undefined
  const byEnv = raw.TALOS_APP_WORKER_THREAD || raw.TALOS_SESSION_ROLE === 'worker' ? 'a thread session' : undefined
  const folder = byEnv ? undefined : leadFolderAbove(cwd)
  if (!byEnv && !folder) return undefined
  const name = argv
    .slice(0, 2)
    .filter((a) => !a.startsWith('-'))
    .join(' ')
  return `talos-app ${name} is not available in ${byEnv ?? `a lead's folder (${folder}/.talos-lead exists)`}: a thread works through its own thread's tools. Ask the owner.`
}
