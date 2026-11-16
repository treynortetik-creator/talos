// "What would an update restart?", read-only: `talos-app update-check --dry` (the Mac's twin is `Talos --update-check`,
// UpdateCheck.swift, whose words and rules these are). For each running thread session: the update check's own dry plan against
// its launch record, one of six states, then one count line, and nothing else: no file text, no path, no hash, no environment, no
// settings and no display name, only thread ids. It starts nothing, writes nothing, audits nothing and takes no lock, so it can
// never become a way to read the Talos home (Pantheon). The plan is the supervisor's own (plan-wiring.ts), from the same
// settings; Main's environment is the one a supervisor rebuilds for a Main it adopted (the login shell's), which is what a
// restarted supervisor would plan with too.
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readWorkersFile, ThreadId, type WorkerEntryT } from '@talos-app/protocol'
import type { BridgeEnv } from '../config.ts'
import { workersJsonPath } from '../worker/files.ts'
import { loginShellEnv, mainClaudeDir, readSupervisorConfig, resolveOnPath } from './cli.ts'
import { buildLaunchEnv, processEnv } from './launch-env.ts'
import { readOAuthToken, withOAuthToken } from './oauth-token.ts'
import { supervisorPlan } from './plan-wiring.ts'
import { threadFolderReader } from './worker-config.ts'
import type { WorkerDeps, WorkerPlan, WorkerThread } from './worker-types.ts'
import { dedicatedThreads } from './workers-wiring.ts'

export const UPDATE_CHECK_STATES = [
  'unchanged',
  'spec changed',
  'instructions changed',
  'no record',
  'busy (would wait)',
  'unknown (dry plan refused)',
] as const
export type UpdateCheckState = (typeof UPDATE_CHECK_STATES)[number]
export type UpdateCheckRow = { id: string; state: UpdateCheckState }

/**
 * The state of one running session (UpdateCheck.classify). `startedInAgentFolder`: its record says it was started in the agent
 * folder, so it is never "instructions changed" (that folder's own files are not hashed). `busy`: in a turn now.
 */
export function classifyUpdate(
  plan: WorkerPlan | null,
  launched: WorkerEntryT['launched'],
  busy: boolean,
  startedInAgentFolder: boolean,
): UpdateCheckState {
  if (!plan || 'refused' in plan || plan.specHash === undefined) return 'unknown (dry plan refused)'
  const spec = plan.specHash
  // the update check's own rule (update-restart.ts): either one equal is nothing to do
  if (launched?.spec_hash === spec || launched?.update_tried_hash === spec) return 'unchanged'
  const recorded = launched?.spec_hash
  if (!launched || recorded === undefined) return 'no record'
  if (busy) return 'busy (would wait)'
  const was = launched.instructions_hash
  const now = plan.instructionsHash
  if (!startedInAgentFolder && was && now && was !== now && plan.specWith?.(was) === recorded)
    return 'instructions changed'
  return 'spec changed'
}

/** The whole output: one line per row (by id, thread ids only), then the count. */
export function updateCheckLines(rows: readonly UpdateCheckRow[]): string[] {
  const sorted = rows
    .filter((r) => ThreadId.safeParse(r.id).success)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const n = (s: readonly UpdateCheckState[]) => sorted.filter((r) => s.includes(r.state)).length
  return [
    ...sorted.map((r) => `${r.id}  ${r.state}`),
    `${sorted.length} sessions: ${n(['unchanged'])} unchanged, ${n(['spec changed', 'instructions changed', 'busy (would wait)'])} to restart, ${n(['no record'])} no record, ${n(['unknown (dry plan refused)'])} unknown`,
  ]
}

/** The sentence the help must hold (Pantheon 2026-11-14): an agent-folder instruction edit is not an update. */
export const AGENT_FOLDER_NOTE =
  "a session started in the agent folder picks up an edit to that folder's instruction files at its next restart; restart it to apply the edit now."

export const UPDATE_CHECK_HELP = `Usage: talos-app update-check [--dry] [--help]

Says, without changing anything, which running thread sessions an update would restart: one line per session,
"<thread id>  <state>", then a count. It starts nothing, writes nothing and takes no lock (--dry is the only mode).

States:
  unchanged                    a start now would launch the same spec
  spec changed                 the launch changed (the app, its settings, the thread's settings or its own instructions)
  instructions changed         only the instruction files a session outside the agent folder is handed changed
  no record                    started by an older build that kept no spec: an update restarts it once
  busy (would wait)            its spec changed and it is in a turn: the restart waits for the turn to end
  unknown (dry plan refused)   a start now would be refused, or its spec cannot be worked out: it is left alone

Note: ${AGENT_FOLDER_NOTE}

Exit status: 0 whether or not anything would restart; 1 when the saved sessions cannot be read; 2 on a usage error.`

/** Any value for the dry plan's nonce: the spec never holds it. */
const DRY_NONCE = '0'.repeat(32)

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

export type UpdateCheckInputs = {
  /** workers.json's sessions. */
  entries: Readonly<Record<string, WorkerEntryT>>
  /** The dedicated threads config.json names now (null: it cannot be read). */
  threads: readonly WorkerThread[] | null
  agentDir: string | null
  /** The environment a start would get now (null: none can be built). */
  baseEnv: Record<string, string> | null
  plan: WorkerDeps['plan']
}

/** One row per running session (live or busy, with a conversation): a session not running takes the new spec at its next start. */
export function updateCheckRows(i: UpdateCheckInputs): UpdateCheckRow[] {
  const rows: UpdateCheckRow[] = []
  const agent = i.agentDir ? realOrSelf(i.agentDir) : null
  for (const [id, e] of Object.entries(i.entries)) {
    if ((e.state !== 'live' && e.state !== 'busy') || !e.session_id) continue
    const t = i.threads?.find((x) => x.id === id)
    let plan: WorkerPlan | null = null
    if (t && i.baseEnv) {
      try {
        plan = i.plan({
          thread: t,
          sessionId: e.session_id,
          resume: true,
          nonce: DRY_NONCE,
          baseEnv: i.baseEnv,
          dry: true,
        })
      } catch {
        plan = null
      }
    }
    const busy = e.state === 'busy' || (e.turn_started_at ?? null) !== null
    const inAgent = agent !== null && e.launched !== undefined && realOrSelf(e.launched.cwd) === agent
    rows.push({ id, state: classifyUpdate(plan, e.launched, busy, inAgent) })
  }
  return rows
}

/** `talos-app update-check [--dry]`. Never echoes an argument back. */
/** Said on stderr when supervisor.json or config.json cannot be read (the Mac's UpdateCheck.launchSettingsUnreadable). */
export const LAUNCH_SETTINGS_UNREADABLE =
  'update-check: the launch settings could not be read, so every running session is unknown'

export function cmdUpdateCheck(
  env: BridgeEnv,
  args: string[],
  io: { out(line: string): void; err(line: string): void },
  /** A test's: the home folder, and the login environment in place of a login shell's. */
  seams: { userHome?: string; loginEnv?: () => Record<string, string> | null } = {},
): number {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    io.out(UPDATE_CHECK_HELP)
    return 0
  }
  if (!(args.length === 0 || (args.length === 1 && args[0] === '--dry'))) {
    io.err('update-check: unknown argument (see talos-app update-check --help)')
    return 2
  }
  const home = env.home
  const userHome = seams.userHome ?? homedir()
  let text: string
  try {
    text = readFileSync(workersJsonPath(home), 'utf8')
  } catch {
    io.err('update-check: the saved sessions cannot be read')
    return 1
  }
  const file = readWorkersFile(text)
  if (!file) {
    io.err('update-check: the saved sessions cannot be read')
    return 1
  }
  const cfg = readSupervisorConfig(home, userHome)
  const launchCfg = () => ('error' in cfg ? null : cfg)
  const c = launchCfg()
  let threads: WorkerThread[] | null = null
  if (c) {
    try {
      threads = dedicatedThreads(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), c.agentDir)
    } catch {
      threads = null
    }
  }
  // as the Mac: said once, and the rows still printed (each running session unknown), exit 0
  if (!c || threads === null) io.err(LAUNCH_SETTINGS_UNREADABLE)
  const login = c ? ((seams.loginEnv ?? loginShellEnv)() ?? processEnv()) : null
  const baseEnv = login && c ? withOAuthToken(buildLaunchEnv(login, c.env ?? {}), readOAuthToken(home), home) : null
  const fencedFolders = threadFolderReader(home)
  const plan = supervisorPlan({
    home,
    userHome,
    launchCfg,
    fencedFolders,
    mainEnv: () => null,
    claudeDirOf: mainClaudeDir,
    resolveOnPath,
    audit: () => {}, // nothing is audited: the report changes nothing
  })
  const rows = updateCheckRows({ entries: file.threads, threads, agentDir: c?.agentDir ?? null, baseEnv, plan })
  for (const l of updateCheckLines(rows)) io.out(l)
  return 0
}
