// What the thread-session manager (workers.ts) is given by the supervisor (P3d2, part 4): the dedicated threads as config.json
// has them, and each start's plan, built by worker-spec.ts and checked by its validateSpec against what the supervisor itself
// knows (Trusted): the Talos home, Main's ceiling read now, the claude it resolved, and the folder it checked on its own. A thread
// with an MCP allow list (session_opts.mcp_allow) gets its plan from worker-mcp.ts, written before the launch (P3d3, part 7).
import { randomBytes } from 'node:crypto'
import { accessSync, constants, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import {
  dedicatedSettings,
  SPEC_HASH_PATTERN,
  ThreadSessionOpts,
  ThreadSessionOptsStrict,
  threadSessionMode,
  workerMcpConfigPath,
} from '@talos-app/protocol'
import { ensureDir, writeFileAtomic } from '../fsutil.ts'
import { workerDir } from '../worker/files.ts'
import { claudeMdExcludes, instructionsText } from '../worker/instruction-files.ts'
import {
  FIX,
  folderNarrowingRules,
  PROJECT_CHECK_FILE,
  projectCheckText,
  projectSettingsFiles,
  sessionSettingsFolders,
  sessionSettingsProblem,
  writeProjectCheck,
} from '../worker/project-settings.ts'
import { folderChain, sessionFilesProblem } from '../worker/session-files.ts'
import { preAcceptFolderTrust, trustConfigFile } from './folder-trust.ts'
import { INSTRUCTIONS_ENTRY, instructionsDigest, type LaunchSpecInputs, launchSpecHash } from './launch-spec.ts'
import { ownerChose } from './owner-folders.ts'
import { rootedHookDir } from './rooted-kit.ts'
import { strictlyInside } from './sub-thread-folder.ts'
import { seedThreadState } from './thread-state-seed.ts'
import {
  type HookPlace,
  installWorkerHook,
  kitVendor,
  releaseHook,
  rootedWorkerHook,
  STATE_FILES,
  STATE_HOOK,
} from './worker-hook.ts'
import {
  claudeJsonHome,
  planWorkerMcp,
  visibleMcpNames,
  type WorkerMcpPlan,
  WorkerMcpWriteError,
  writeWorkerMcp,
} from './worker-mcp.ts'
import {
  absolutize,
  agentScriptDenyRules,
  type CeilingAxis,
  chainBypassLocked,
  existingSubThreadFolder,
  FOLDER_NOT_NAMEABLE,
  fenceSafe,
  INSTRUCTION_FILES_MODE,
  knownMode,
  lastFlagValue,
  type MainCeiling,
  type MainSettings,
  mainDefaultMode,
  mainDenyRules,
  mainNarrowedMode,
  mainSettings,
  managedSettings,
  narrowestMode,
  prepareSubThreadFolder,
  restricted,
  settingSources,
  settingsFileRules,
  workerFolderProblem,
} from './worker-policy.ts'
import { workerPreamble } from './worker-preamble.ts'
import {
  buildWorkerSpec,
  cleanMcpEntry,
  PERMISSION_FLAGS,
  permissionHookCommand,
  validateSpec,
  type WorkerInputs,
  WorkerSpecRefused,
  workerHookFixed,
  workerStatusLineCommand,
  workerSystemPromptPath,
} from './worker-spec.ts'
import { effectiveOpts, ownOpts, subLaunch } from './worker-subthreads.ts'
import type { UnreadOpt } from './worker-types.ts'
import type { WorkerPlan, WorkerThread } from './workers.ts'

type RawThread = {
  id?: unknown
  name?: unknown
  kind?: unknown
  archived?: unknown
  session?: unknown
  session_opts?: unknown
  parent_id?: unknown
}

const isRawObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The threads that have their own session by config alone (threadSessionMode: the master switch on, the thread asking, and
 * allowed to). Null when config.json cannot be read (the manager keeps the last good list). A sub-thread (parent_id) takes its
 * settings by the Mac's rules (worker-subthreads.ts), and its start is refused when they say so.
 */
export function dedicatedThreads(raw: unknown, agentDir: string): WorkerThread[] | null {
  const c = raw as { threads?: unknown; default_thread?: unknown; dedicated?: unknown } | null
  if (!c || !Array.isArray(c.threads) || typeof c.default_thread !== 'string') return null
  const threads = (c.threads as RawThread[]).filter(
    (t) => t && typeof t.id === 'string' && typeof t.kind === 'string',
  ) as Array<RawThread & { id: string; kind: string }>
  // the shape threadSessionMode reads; the values are judged there (an unknown session mode reads as shared)
  const like = {
    threads: threads.map((t) => ({
      id: t.id,
      kind: t.kind,
      ...(t.archived === true ? { archived: true } : {}),
      session: t.session as Parameters<typeof threadSessionMode>[0]['threads'][number]['session'],
    })),
    default_thread: c.default_thread,
    dedicated: c.dedicated,
  }
  const all = (c.threads as unknown[]).filter(isRawObject)
  const out: WorkerThread[] = []
  for (const t of threads) {
    if (threadSessionMode(like, t.id) !== 'dedicated') continue
    const opts = ThreadSessionOpts.safeParse(t.session_opts ?? {})
    // a sub-thread (any parent_id that is there, even one that cannot be read): the Mac's rules (worker-subthreads.ts). Its
    // folder is its own, never its parent's; its model, effort and MCP list are the effective ones; its idle time its own
    const sub = subLaunch(t as Record<string, unknown>, all)
    if (sub) {
      const eff = effectiveOpts(t as Record<string, unknown>, all)
      // one that shares its parent's folder runs there (the agent folder when the parent has none), follows it when it moves, and
      // has nothing of its own to check against it: no parent folder is handed on
      out.push({
        id: t.id,
        cwd: sub.shares ? (sub.parentCwd ?? agentDir) : (ownOpts(t as Record<string, unknown>).cwd ?? agentDir),
        model: eff.model ?? 'inherit',
        effort: eff.effort ?? null,
        // a parent with no folder runs in the agent folder: a child with a folder of its own is judged against that
        parentCwd: sub.shares ? null : (sub.parentCwd ?? (sub.ownCwd && !sub.refusal ? agentDir : null)),
        name: typeof t.name === 'string' ? t.name : null,
        idleParkMin: opts.success ? opts.data.idle_park_min : ThreadSessionOpts.parse({}).idle_park_min,
        ...(eff.mcpAllow !== undefined ? { mcpAllow: eff.mcpAllow } : {}),
        sub: {
          parentId: sub.parentId,
          ownCwd: sub.ownCwd,
          ...(sub.shares ? { shares: true } : {}),
          refusal: sub.refusal,
          unreadable: sub.unreadable,
        },
      })
      continue
    }
    const o = opts.success ? opts.data : ThreadSessionOpts.parse({})
    // no list is today's launch; a session_opts that is there but not an object is the EMPTY list, never none (the Mac's rule)
    const mcpAllow = opts.success ? o.mcp_allow : []
    out.push({
      id: t.id,
      cwd: o.cwd ?? agentDir,
      model: o.model,
      effort: o.effort ?? null,
      parentCwd: null,
      name: typeof t.name === 'string' ? t.name : null,
      idleParkMin: o.idle_park_min,
      ...(mcpAllow !== undefined ? { mcpAllow } : {}),
      ...unreadOpts(t.session_opts, opts.success),
    })
  }
  return out
}

const LAUNCH_FIELDS = ['cwd', 'model', 'effort'] as const

/**
 * Which launch fields of a thread's session_opts cannot be read (each falls back to its default when read): the whole object when
 * it is not one. A field that is absent is not unread: its default is what the owner chose.
 */
function unreadOpts(raw: unknown, isObject: boolean): { optsUnread?: UnreadOpt[] } {
  if (!isObject) return { optsUnread: ['session_opts'] }
  const o = (raw ?? {}) as Record<string, unknown>
  const bad = LAUNCH_FIELDS.filter(
    (k) => o[k] !== undefined && !ThreadSessionOptsStrict.shape[k].safeParse(o[k]).success,
  )
  return bad.length > 0 ? { optsUnread: bad } : {}
}

/**
 * The config.threads entries that are not a thread (not an object, or no text id or kind), by position from 1: each is left out
 * and the rest is read (never "the whole config cannot be read": that would keep every session on the last config, which can be
 * wider than what the owner just wrote). The owner is told, so a typo never silently costs a session.
 */
export function droppedThreadEntries(raw: unknown): number[] {
  const c = raw as { threads?: unknown } | null
  if (!c || !Array.isArray(c.threads)) return []
  const out: number[] = []
  c.threads.forEach((t: unknown, k: number) => {
    const o = t as { id?: unknown; kind?: unknown } | null
    if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.id !== 'string' || typeof o.kind !== 'string')
      out.push(k + 1)
  })
  return out
}

/**
 * What to tell the owner about dropped entries, once per set of them (`last` is the set told last): the line for the default
 * thread, or null when there is nothing new to say (none dropped, or the same ones as before).
 */
export function droppedEntriesNotice(
  raw: unknown,
  last: string,
): { said: string; thread: string; text: string } | null {
  const dropped = droppedThreadEntries(raw)
  const said = dropped.join(',')
  if (said === last || dropped.length === 0) return null
  const thread = (raw as { default_thread?: unknown }).default_thread
  const list = dropped.map((n) => `#${n}`).join(', ')
  const text =
    dropped.length === 1
      ? `config.threads entry ${list} isn't a thread object and was ignored; if it had its own session, that session stops.`
      : `config.threads entries ${list} aren't thread objects and were ignored; if they had their own sessions, those sessions stop.`
  return { said, thread: typeof thread === 'string' ? thread : 'general', text }
}

/** The live cap (dedicated.max_live, the default without one); null when config.json cannot be read (the last good is kept). */
export function dedicatedMaxLive(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return dedicatedSettings(raw as { dedicated?: unknown }).max_live
}

export type PlannerInputs = {
  talosHome: string
  userHome: string
  agentDir: string
  /** Main's Claude Code config folder (its CLAUDE_CONFIG_DIR), for the default mode Main starts in. */
  claudeDir: string
  /** The folder Claude Code reads `.claude.json` from (CLAUDE_CONFIG_DIR when set, else the home folder; claudeJsonHome). */
  configHome?: string
  /** Main's config folder for an environment (its CLAUDE_CONFIG_DIR, else ~/.claude): the ceiling reads Main's own env. */
  claudeDirOf?: (env: Record<string, string>) => string
  /** The claude program for this environment, or null when there is none. */
  resolveClaude: (env: Record<string, string>) => string | null
  /** Main's own launch arguments as the settings have them now: the ceiling's permission flags. */
  mainArgs: () => string[]
  /** The environment the running Main was started with (none, or null: the planner's own read of it, its baseEnv). */
  mainEnv?: () => Record<string, string> | null
  /** Claude Code's managed settings folder: managedSettingsDir() in production, a folder of the test's own in tests. */
  managedDir: string
  /** The kit's vendor folder whose sealed release supplies the hook (default: kitVendor of the supervisor's own environment). */
  kitVendor?: string
  /**
   * Every configured thread's folder (each a session may work in): the hook's release and python3 must be outside all. Null
   * until config.json has been read once: the start is refused, never fenced by fewer folders than are configured.
   */
  threadFolders: () => string[] | null
  /**
   * The developer thread fence (protocol dev.ts), read at each start: false only when the owner turned it off. Absent: on. Off, the
   * session's settings carry no Talos-home deny, so it and its sub-agents get the same access Main has; Main's own deny rules (the
   * ceiling), the guards and the deny on other sessions' settings and hooks stay.
   */
  threadFence?: () => boolean
  /** The launch config's `env` (supervisor.json), folded into every session's environment: part of the launch spec. */
  launchEnv?: () => Record<string, string> | undefined
  /** TESTS ONLY: a hook source taken as is, past the release checks (a golden's fixed path). */
  permissionHook?: string
  /** The python3 a session's PATH names outside its folders (default: findPython3); tests pin it so a golden is host-free. */
  resolvePython?: (env: Record<string, string>, outside: readonly string[]) => string | null
  /** The supervisor's audit log (a ceiling read narrowed because Main's own settings could not be read). */
  audit?: (event: string, fields?: Record<string, string>) => void
}

/**
 * Main's ceiling, read again at every start: an owner who narrows Main narrows the next worker too. Its MCP servers are every
 * server a session in the agent folder could use (the Mac's `visibleNames`): the agent folder's .mcp.json, the owner's user
 * and local scopes and the plugins that are on, plus talos-app. Only a list reads them: with none the axis is not asked.
 */
export function mainCeiling(i: PlannerInputs, read: MainRead = mainRead(i)): MainCeiling {
  const { args, own } = read
  // Main's own config folder and .claude.json, from the environment Main runs under (the worker's are its own, in the plan)
  const mainDir = i.claudeDirOf?.(read.env) ?? i.claudeDir
  const mainConfigHome = i.claudeDirOf ? claudeJsonHome(read.env, i.userHome, mainDir) : (i.configHome ?? i.userHome)
  // the rules Main runs under: the guards' and the project's (always, even when they are not Main's: stricter), and its own
  // --settings'
  const ownDeny = own.kind === 'mode' || own.kind === 'no_mode' ? own.deny : []
  const managed = managedSettings(i.managedDir, i.agentDir)
  if (managed.unreadable > 0) i.audit?.('managed_settings_unreadable', { files: String(managed.unreadable) })
  // bypass ruled out (managed disableBypassPermissionsMode, or restricted mode): Main falls through every bypass flag, so the
  // ceiling does not count them
  const noBypass =
    managed.bypassDisabled ||
    restricted(args, read.env) ||
    ((own.kind === 'mode' || own.kind === 'no_mode') && own.bypassOff) ||
    chainBypassLocked(i.agentDir, i.talosHome, mainDir, own.kind === 'none', settingSources(args, read.env))
  const mode = mainMode({ ...i, claudeDir: mainDir }, own, args, managed.modes, read.env)
  return {
    permissionArgs: noBypass ? withoutBypass(args) : args,
    // bypass ruled out: a bypass mode from settings is skipped as well, and Main runs in default
    defaultMode: noBypass && mode === 'bypassPermissions' ? 'default' : mode,
    mcpServers: visibleMcpNames(i.agentDir, mainConfigHome, mainDir),
    // the managed ones too: they bind Main (and its workers read them as well; here they are a ceiling Main cannot drop)
    denyRules: [...new Set([...mainDenyRules(i.agentDir, i.talosHome), ...ownDeny, ...managed.deny])],
  }
}

/** Main's arguments without the bypass flags (bypass is ruled out, so Main falls through them to its next mode). */
function withoutBypass(args: readonly string[]): string[] {
  // the last --permission-mode is the one Claude Code uses: if it is bypass, Main falls past every one of them
  const lastIsBypass = lastFlagValue(args, '--permission-mode') === 'bypassPermissions'
  const out: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string
    if (a === '--') {
      out.push(...args.slice(k))
      break
    }
    if (a === '--dangerously-skip-permissions' || a === '--allow-dangerously-skip-permissions') continue
    if (a === '--permission-mode=bypassPermissions' || (lastIsBypass && a.startsWith('--permission-mode='))) continue
    if (a === '--permission-mode' && (lastIsBypass || args[k + 1] === 'bypassPermissions')) {
      k++
      continue
    }
    out.push(a)
  }
  return out
}

/**
 * Main's environment when it cannot be known (an adopted Main whose process could not be read, or is no longer Main's): a
 * thread session is held to nothing guessed, so none starts (mainSettingsRefusal).
 */
export const MAIN_ENV_UNKNOWN: Record<string, string> = Object.freeze({ __TALOS_MAIN_ENV_UNKNOWN__: '1' })

/** Main's arguments and what its own --settings says, read once per start: the refusal and the ceiling see the same read. */
export type MainRead = { args: string[]; own: MainSettings; env: Record<string, string> }
/** `env` is Main's environment as a session's is built (the login shell's, the owner's env on top): its restricted switch and temp folder. */
export const mainRead = (i: PlannerInputs, env: Record<string, string> = {}): MainRead => {
  const args = i.mainArgs()
  return { args, own: mainSettings(args, i.agentDir, env), env }
}

/**
 * Why no thread session may start while Main's own --settings cannot be read (neither its mode nor its deny rules are known,
 * and nothing is guessed), or null. Asked before anything else, the live cap included: a start that is going to be refused
 * never parks another session to make room.
 */
export function mainSettingsRefusal(i: PlannerInputs, threadId: string, read: MainRead = mainRead(i)) {
  if (read.env === MAIN_ENV_UNKNOWN || read.env.__TALOS_MAIN_ENV_UNKNOWN__ === '1') {
    i.audit?.('worker_start_refused', { thread: threadId, why: 'main_env_unknown' })
    return {
      code: 'start_failed' as const,
      detail: "Main's environment can't be read, so this session can't be held to it",
      mainRestricted: "a state this supervisor can't read (an adopted Main whose environment it can't check)",
    }
  }
  // a mode that narrows Main (restricted, a config folder that is not an absolute path, and the like) reaches no thread
  // session: none starts
  const narrowed = mainNarrowedMode(read.args, read.env)
  if (narrowed) {
    i.audit?.('worker_start_refused', { thread: threadId, why: 'main_narrowed', mode: narrowed })
    return {
      code: 'start_failed' as const,
      detail: `Main runs in ${narrowed}, which a thread session cannot be held to`,
      mainRestricted: narrowed,
    }
  }
  if (read.own.kind !== 'unreadable') return null
  const what = read.own.what.slice(0, 200)
  i.audit?.('worker_start_refused', { thread: threadId, why: 'main_settings_unreadable', settings: what })
  return {
    code: 'start_failed' as const,
    detail: `Main's own --settings can't be read (${what}), so this session's limits can't be matched to Main's`,
    mainSettingsUnreadable: what,
  }
}

/** The mode no Main runs below (plan and dontAsk rank 0); `default` would be wider than a Main in plan mode. */
const NARROWEST_MODE = 'plan'

/**
 * The mode Main runs in when its arguments name none. With Main's own --settings, that file's mode (flag settings outrank the
 * project's and the user's); the guards' file is then not Main's settings and is not read (the Mac's guardsActive). A --settings
 * that cannot be read, or any mode that is not one Claude Code knows, is never guessed at: the narrowest mode, `plan` (rank 0,
 * below `default`: Main may well be in plan mode), and an audit line. Never the Mac's looser readings (it reads neither file then).
 */
function mainMode(
  i: PlannerInputs,
  own: MainSettings,
  args: string[],
  managedModes: string[],
  env: Record<string, string>,
): string | null {
  if (own.kind === 'unreadable') {
    i.audit?.('worker_ceiling_narrowed', { why: 'main_settings_unreadable', settings: own.what.slice(0, 200) })
    return NARROWEST_MODE
  }
  // Main's own --settings, then the sources Main loads (--setting-sources)
  const chain =
    own.kind === 'mode'
      ? own.mode
      : mainDefaultMode(i.agentDir, i.talosHome, i.claudeDir, own.kind === 'none', settingSources(args, env))
  if (chain !== null && !knownMode(chain)) {
    i.audit?.('worker_ceiling_narrowed', { why: 'unknown_mode', mode: chain.slice(0, 40) })
    return NARROWEST_MODE
  }
  // managed settings outrank those, but a higher managed source this cannot see (server-managed, MDM) can set the file aside
  // ("first-wins"): so the narrowest of every managed document's mode and the chain's, never wider than what Main runs
  const mode = managedModes.length > 0 ? narrowestMode([...managedModes, chain ?? 'default']) : chain
  if (mode !== null && !knownMode(mode)) {
    i.audit?.('worker_ceiling_narrowed', { why: 'unknown_mode', mode: mode.slice(0, 40) })
    return NARROWEST_MODE
  }
  return mode
}

/**
 * The deny and ask rules of a sub-thread's parent folder (its own project settings and its repo roots'), made absolute where they
 * were written: carried into a sub-thread that keeps its own folder outside the parent's, so the parent's fence (a lead's
 * privacy rules) still holds there. A rule that cannot be read refuses the start, as the folder's own do.
 */
function parentFolderRules(
  parentCwd: string,
  agentDir: string,
): { deny: string[]; ask: string[] } | { refused: string; rule: boolean } {
  const pf = sessionSettingsFolders(realOrNull(parentCwd) ?? parentCwd, agentDir)
  if ('problem' in pf)
    return { refused: `sub-thread folder: the parent's project settings: ${pf.problem}`, rule: false }
  const pr = folderNarrowingRules(pf.folders, absolutize)
  if (pr.refused)
    return {
      refused: `the parent thread folder's permission rule cannot be carried over: ${pr.refused}; ${FIX}`,
      rule: true,
    }
  return { deny: pr.deny, ask: pr.ask }
}

/** The plan function WorkerManager takes: one start's launch, or why it may not start. */
export function workerPlanner(given: PlannerInputs) {
  return (p: {
    thread: WorkerThread
    sessionId: string
    resume: boolean
    nonce: string
    baseEnv: Record<string, string>
    /**
     * The update check's plan: the same checks, launch and spec hash as a real start, with nothing made, copied, removed or
     * audited (a sub-thread's missing folder is refused, never made; helpers audit nothing either) (Fable R1 on the dry plan).
     */
    dry?: boolean
  }): WorkerPlan => {
    const i: PlannerInputs = p.dry ? { ...given, audit: undefined } : given
    const audit = i.audit
    const refuse = (
      detail: string,
      code: 'start_failed' | 'mode_escalation_denied' = 'start_failed',
      axis?: CeilingAxis,
    ): WorkerPlan => ({
      refused: { code, detail, ...(axis ? { axis } : {}) },
    })
    // one read of Main's arguments and its own --settings for this start: the refusal and the ceiling see the same (a file
    // saved between two reads cannot leave the ceiling without its deny rules)
    // Main's environment as it was started (its restricted switch, its temp folder), else the planner's own read of it
    const read = mainRead(i, i.mainEnv?.() ?? p.baseEnv)
    const blocked = mainSettingsRefusal(i, p.thread.id, read)
    if (blocked) return { refused: blocked }
    // the worker's own environment too: one set since Main started can hold a config folder Claude Code reads differently
    const ccd = p.baseEnv.CLAUDE_CONFIG_DIR
    if (ccd && !isAbsolute(ccd))
      return {
        refused: {
          code: 'start_failed',
          detail: "the thread session's CLAUDE_CONFIG_DIR is not an absolute path",
          mainRestricted: 'a CLAUDE_CONFIG_DIR that is not an absolute path',
        },
      }
    // a sub-thread: its own folder, checked strictly inside its parent's and made when missing, before anything looks at it (one that shares its parent's folder skips this)
    let wanted = p.thread.cwd
    const parentCwd = p.thread.sub ? p.thread.parentCwd : null
    let ownOutside = false // its own folder outside the parent's (c24c01f8): the parent's rules come too (parentFolderRules)
    if (p.thread.sub?.refusal) return refuse(p.thread.sub.refusal)
    if (p.thread.sub && !p.thread.sub.shares) {
      if (!p.thread.sub.ownCwd || parentCwd === null)
        return refuse("sub-thread folder: it has none of its own inside its parent's")
      if (realOrNull(parentCwd) !== realOrNull(i.agentDir)) {
        const why = workerFolderProblem(parentCwd, i.userHome, i.talosHome)
        if (why) return refuse(`sub-thread folder: the parent's folder: ${why}`)
      }
      const made = p.dry ? existingSubThreadFolder(wanted, parentCwd) : prepareSubThreadFolder(wanted, parentCwd)
      if ('refused' in made) return refuse(`sub-thread folder: ${made.refused}`)
      wanted = made.folder
      // read from the folder it will run in, not decided apart from it: a folder made by someone else in between cannot skip the rules
      ownOutside = !strictlyInside(made.folder, realOrNull(parentCwd) ?? parentCwd)
    }
    // the folder, checked here on its own and resolved: the path checked is the path launched, and validateSpec is handed it
    const problem = workerFolderProblem(wanted, i.userHome, i.talosHome)
    if (problem && realOrNull(wanted) !== realOrNull(i.agentDir))
      return refuse(`the thread folder ${wanted}: ${problem}`)
    const folder = realOrNull(wanted)
    if (!folder) return refuse(`the thread folder ${wanted} does not exist`)
    const claude = i.resolveClaude(p.baseEnv)
    if (!claude) return refuse('no claude program on the login PATH')
    // the hook is how a thread session's prompts reach the phone: one that would run nothing is a start refused, never a fallback
    // the sealed kit release's hook, never the checkout's (R1-1), and never one inside a folder a session works in
    // every folder ANY session works in, not only this one's: thread B must not be able to put the python3 (or a release)
    // thread A's hook runs in B's own folder. Read again at each start, so a thread added or moved is fenced at once.
    const others = i.threadFolders()
    if (others === null)
      return refuse("the thread folders can't be read from config.json yet, so the hook can't be fenced")
    // sorted, so a reorder in config.json changes no launch (and no spec hash); a thread added is a new fence, and does (Fable R1-2)
    const fences = [folder, i.agentDir, ...[...new Set(others)].sort()]
    // what the folder's own project settings may never carry (env a shell or python obeys, commands Claude Code runs): checked
    // here, and again by the bridge at every request from the file the start records (worker/project-settings.ts)
    // every folder whose project settings the session loads: its own, and its git root when that is another (Claude Code loads both)
    const found = sessionSettingsFolders(folder, i.agentDir)
    if ('problem' in found) {
      audit?.('worker_project_settings_refused', { thread: p.thread.id, why: found.problem })
      return refuse(`the thread folder's project settings: ${found.problem}`)
    }
    const loaded = found.folders
    // a repo root the session loads settings from is fenced by rules too: one no rule can name refuses the start (Fable R1-4)
    const unnameable = loaded.find((l) => !fenceSafe(l.folder))
    if (unnameable) return refuse(`the folder ${unnameable.folder}: ${FOLDER_NOT_NAMEABLE}`)
    const isAgentFolder = folder === realOrNull(i.agentDir)
    // every folder up to the repo roots, and the roots: what a link or a skill, command or subagent there could make the session
    // read. In the agent folder the session loads them as Main does, so they refuse; elsewhere it loads none of them
    // (--setting-sources=user), so they only warn.
    const chain = folderChain(
      folder,
      loaded.map((l) => l.folder),
    )
    const filesWhy = sessionFilesProblem(chain)
    const settingsWhy = sessionSettingsProblem(loaded)
    if (isAgentFolder && (filesWhy ?? settingsWhy)) {
      const why = (filesWhy ?? settingsWhy) as string
      audit?.('worker_project_settings_refused', { thread: p.thread.id, why })
      return refuse(`the agent folder: ${why}`)
    }
    const settingsWarning = isAgentFolder ? null : (filesWhy ?? settingsWhy)
    const narrowing = isAgentFolder ? { deny: [], ask: [], refused: null } : folderNarrowingRules(loaded, absolutize)
    // a deny or ask rule of the folder's that cannot be read is never dropped (that would widen what the session may do)
    if (narrowing.refused) {
      audit?.('worker_folder_rule_refused', { thread: p.thread.id, why: narrowing.refused })
      return refuse(`the thread folder's permission rule cannot be carried over: ${narrowing.refused}; ${FIX}`)
    }
    const parentRules =
      ownOutside && parentCwd !== null ? parentFolderRules(parentCwd, i.agentDir) : { deny: [], ask: [] }
    if ('refused' in parentRules) {
      if (parentRules.rule) audit?.('worker_folder_rule_refused', { thread: p.thread.id, why: parentRules.refused })
      return refuse(parentRules.refused)
    }
    if (settingsWarning) audit?.('worker_project_settings_ignored', { thread: p.thread.id, why: settingsWarning })
    // a worker never loads a settings source Main does not: outside the agent folder only `user` (refused when Main leaves it
    // out); in it Main's own sources, as Main's own launch names them (none named: none passed)
    const mainSources = settingSources(read.args, read.env)
    if (!isAgentFolder && mainSources !== null && !mainSources.has('user'))
      return refuse("Main's --setting-sources leaves out user settings, which a thread session loads")
    const sources = isAgentFolder ? (mainSources === null ? null : [...mainSources].sort().join(',') || null) : 'user'
    if (isAgentFolder && mainSources !== null && mainSources.size === 0)
      return refuse("Main's --setting-sources loads no settings at all, which a thread session cannot be held to")
    const src =
      i.permissionHook !== undefined
        ? { source: i.permissionHook }
        : releaseHook(i.kitVendor ?? kitVendor(process.env), fences)
    // rooted (a Talos distro): root's file runs where it is, never a copy the talos user could overwrite (Fable R2-3)
    const rootedDir = rootedHookDir()
    const rooted = rootedDir !== null
    const hook =
      'problem' in src
        ? src
        : 'rooted' in src && src.rooted
          ? rootedWorkerHook(src.source, p.baseEnv, i.resolvePython, fences)
          : installWorkerHook(
              i.talosHome,
              src.source,
              p.baseEnv,
              i.resolvePython,
              fences,
              'verified' in src ? src.verified : undefined,
              p.dry === true,
            )
    if ('problem' in hook) {
      audit?.('worker_hook_missing', { thread: p.thread.id, why: hook.problem })
      return { refused: { code: 'start_failed', detail: hook.problem, hookMissing: hook.problem } }
    }
    // the list's plan, made from the thread folder as it really is (no list: none, and the launch is as before)
    let mcp: WorkerMcpPlan | null = null
    // no list: an mcp.json an earlier launch wrote (it holds server credentials) is not left on disk
    if (p.thread.mcpAllow === undefined && !p.dry)
      rmSync(workerMcpConfigPath(i.talosHome, p.thread.id), { force: true })
    if (p.thread.mcpAllow !== undefined) {
      mcp = planWorkerMcp({
        allow: p.thread.mcpAllow,
        agentDir: i.agentDir,
        cwd: folder,
        home: i.configHome ?? i.userHome,
        claudeDir: i.claudeDir,
        talosHome: i.talosHome,
        threadId: p.thread.id,
      })
      if (!mcp) return refuse("the MCP list needs a talos-app server in the agent folder's .mcp.json")
    }
    const main = mainCeiling(i, read)
    const permissionFlag = main.permissionArgs.find((a) => PERMISSION_FLAGS.test(a)) ?? null
    // the developer thread fence: off only when the owner turned it off (read once, so the spec and its check agree)
    const threadFence = i.threadFence?.() !== false
    if (!threadFence && !p.dry) i.audit?.('worker_thread_fence_off', { thread: p.thread.id })
    try {
      const sessionRules = sessionSettingsRules(i, read, [...fences, ...chain], !threadFence)
      const inputs: WorkerInputs = {
        rooted,
        threadFence,
        threadId: p.thread.id,
        sessionId: p.sessionId,
        resume: p.resume,
        claudePath: claude,
        baseEnv: p.baseEnv,
        talosHome: i.talosHome,
        agentDir: i.agentDir,
        permissionHook: hook,
        cwd: folder === realOrNull(i.agentDir) ? null : folder,
        parentCwd,
        model: p.thread.model,
        effort: p.thread.effort,
        nonce: p.nonce,
        permissionFlag,
        preamble: workerPreamble(i.agentDir, p.thread.id),
        settingSources: sources,
        // outside the agent folder the preamble and the thread's instruction files come from the worker's own file
        systemPromptFile: !isAgentFolder,
        // no list, in a folder of its own: the agent folder's talos-app server, or the session never hears from its thread
        mcpConfigPath: mcp ? null : talosOnlyMcpConfig(i, p.thread.id, folder, p.dry === true),
        main,
        mcp,
        userHome: i.userHome,
        // no file-tool edit of a settings file any session loads: every fenced folder's, ~/.claude and Main's config folder
        // outside the agent folder its own deny and ask rules, which it does not load, copied in (they only narrow)
        // with the thread fence off, a config folder's agents, skills, commands and the like ask the owner by card instead
        settingsAsk: [...new Set([...parentRules.ask, ...narrowing.ask, ...sessionRules.ask])],
        settingsDeny: [...new Set([...parentRules.deny, ...narrowing.deny, ...sessionRules.deny])],
      }
      const spec = buildWorkerSpec(inputs)
      validateSpec(spec, {
        talosHome: i.talosHome,
        parentDeny: parentRules.deny,
        threadFence: inputs.threadFence !== false,
        main,
        claudePath: claude,
        cwd: folder,
        mcp,
        settingSources: sources,
        outsideAgentFolder: !isAgentFolder,
        rootedHookDir: rootedDir,
        // the whole command, built here from root's file and the supervisor's own values, never read back from the spec
        rootedHook: rooted
          ? {
              script: hook.script,
              command: permissionHookCommand(hook.script, hook.python, workerHookFixed(inputs)),
              statusLine: workerStatusLineCommand(inputs),
            }
          : null,
      })
      if (!p.dry) {
        prepareWorkerFolder(i, p.thread, audit, isAgentFolder ? null : folder)
        if (mcp) writeWorkerMcp(mcp)
        writeFileAtomic(join(workerDir(i.talosHome, p.thread.id), 'settings.json'), spec.settingsJSON, 0o600)
      }
      // the folder the bridge checks again at every permission request (in the fenced Talos home, out of the session's reach)
      const check = { v: 1 as const, folders: loaded, sources }
      if (!p.dry) writeProjectCheck(i.talosHome, p.thread.id, check)
      let systemPrompt: string | null = null
      // the instruction files' markers carry a random token (a file cannot fake its end); the spec hashes the text with it
      // replaced by a fixed word, so the same files are the same spec at every start (Fable R1-1)
      const promptToken = randomBytes(9).toString('hex')
      // outside the agent folder: the preamble and the thread's instruction files (Claude Code loads none of them there)
      if (!isAgentFolder) {
        const instructions = instructionsText(
          folder,
          realOrNull(i.userHome) ?? i.userHome,
          INSTRUCTION_FILES_MODE,
          promptToken,
          // what Claude Code loads itself as user memory, from Main's config folder and the owner's ~/.claude
          [
            ...new Set(
              [join(i.userHome, '.claude'), i.claudeDir].map((d) => realOrNull(d)).filter((d): d is string => !!d),
            ),
          ],
          // the owner's claudeMdExcludes, from the user settings and the folder's own (as Claude Code would honour them)
          claudeMdExcludes([
            ...[join(i.userHome, '.claude'), i.claudeDir].flatMap((d) => [
              join(d, 'settings.json'),
              join(d, 'settings.local.json'),
            ]),
            ...loaded.flatMap((l) => projectSettingsFiles(l.folder)),
          ]),
        )
        const preamble = workerPreamble(i.agentDir, p.thread.id) ?? ''
        systemPrompt = [preamble, instructions.text].filter((x) => x !== '').join('\n\n')
        if (!p.dry) writeFileAtomic(workerSystemPromptPath(i.talosHome, p.thread.id), systemPrompt, 0o600)
      }
      const argv = [spec.program, ...spec.args]
      return {
        launch: { session: `t-${p.thread.id}`, argv, cwd: spec.cwd, env: spec.env },
        settingsJSON: spec.settingsJSON,
        cwd: spec.cwd,
        ...specHashOf(
          () => ({
            argv,
            env: spec.env,
            baseEnv: p.baseEnv,
            files: specFiles(i, {
              spec,
              check,
              systemPrompt,
              promptToken,
              mcp,
              isAgentFolder,
              hook,
              talosOnly: inputs.mcpConfigPath,
            }),
          }),
          p.dry,
        ),
        ...(mcp && (mcp.missing.length > 0 || mcp.refused.length > 0)
          ? { mcpLeftOut: { missing: [...mcp.missing], refused: [...mcp.refused] } }
          : {}),
        ...(settingsWarning ? { settingsIgnored: settingsWarning } : {}),
      }
    } catch (e) {
      // the axis is recorded on its own; the detail is the reason as the ceiling put it (never a value from a definition)
      if (e instanceof WorkerSpecRefused && e.axis) return refuse(e.detail, 'mode_escalation_denied', e.axis)
      if (e instanceof WorkerSpecRefused)
        return refuse(`${e.code}: ${e.detail}`, e.code === 'escalation' ? 'mode_escalation_denied' : 'start_failed')
      if (e instanceof WorkerMcpWriteError) return refuse(e.message)
      return refuse((e as Error).message)
    }
  }
}

/**
 * The worker's own folder in the Talos home, and its live state file in the agent folder (made if missing; a problem is audited
 * and never stops the start).
 */
function prepareWorkerFolder(
  i: PlannerInputs,
  thread: { id: string; name?: string | null; cwd: string; sub?: { parentId?: string } },
  audit: PlannerInputs['audit'],
  trustFolder: string | null,
): void {
  ensureDir(workerDir(i.talosHome, thread.id))
  const seeded = seedThreadState(i.agentDir, thread.id, thread.name)
  if ('problem' in seeded) audit?.('worker_state_seed_failed', { thread: thread.id, why: seeded.problem })
  if (trustFolder !== null) acceptFolderTrust(i, thread, trustFolder, audit)
}

/**
 * The owner chose this folder for the thread: Claude Code's trust question for it is answered now (folder-trust.ts), before the
 * session starts. Never the agent folder (Main's trust is first-start's). A refusal or a failure never stops the start: it is
 * audited, and the question on the pane then reaches the phone as a card (worker-dialogs.ts).
 */
function acceptFolderTrust(
  i: PlannerInputs,
  thread: { id: string; cwd: string; sub?: { parentId?: string } },
  folder: string,
  audit: PlannerInputs['audit'],
): void {
  // only a folder the owner chose (a signed config.patch: owner-folders.ts), never one `lead init` or a hand edit wrote: for those
  // the trust card shows the folder and the owner decides
  const ids = [thread.id, ...(thread.sub?.parentId ? [thread.sub.parentId] : [])]
  if (!ownerChose(i.talosHome, ids, thread.cwd, folder)) {
    audit?.('worker_folder_trust_refused', {
      thread: thread.id,
      why: 'the folder is not recorded as the owner’s choice',
    })
    return
  }
  const r = preAcceptFolderTrust({
    configFile: trustConfigFile(i.configHome ?? i.userHome),
    folder,
    chosen: [thread.cwd],
    home: i.userHome,
    talosHome: i.talosHome,
    agentDir: i.agentDir,
  })
  if (!r.ok) audit?.('worker_folder_trust_refused', { thread: thread.id, why: r.why })
  else if (r.wrote) audit?.('worker_folder_trust_accepted', { thread: thread.id })
}

/** The files of a launch's spec (launch-spec.ts): each file the start writes, by the bytes it computed, and its other inputs. */
function specFiles(
  i: PlannerInputs,
  o: {
    spec: { settingsJSON: string }
    check: Parameters<typeof projectCheckText>[0]
    systemPrompt: string | null
    promptToken: string
    mcp: WorkerMcpPlan | null
    isAgentFolder: boolean
    hook: HookPlace
    talosOnly: string | null
  },
): LaunchSpecInputs['files'] {
  return {
    'settings.json': o.spec.settingsJSON,
    [PROJECT_CHECK_FILE]: projectCheckText(o.check),
    // the instruction files' random token replaced by a fixed word: the same files are the same spec (Fable R1-1)
    [INSTRUCTIONS_ENTRY]: o.systemPrompt === null ? null : o.systemPrompt.replaceAll(o.promptToken, 'TOKEN'),
    // the agent folder's talos-app entry, which a session there loads itself (no file written for it) (Fable R1-3)
    'agent-mcp.json': !o.mcp && o.isAgentFolder ? talosMcpText(i.agentDir) : null,
    // the launch config's env, which arrives folded into the login environment and so is never in `env` (Fable R1-3)
    'launch-env': JSON.stringify(Object.entries(i.launchEnv?.() ?? {}).sort()),
    'mcp.json': o.mcp ? o.mcp.configJSON : o.talosOnly ? talosMcpText(i.agentDir) : null,
    // the permission hook's own bytes: a release that changes the hook restarts sessions for it
    'permission-hook': o.hook.hook,
    'permission-hook-helper': o.hook.helper,
    // the thread-state hook's files, staged beside it: a release that changes them restarts sessions for it too
    'thread-state-hook': o.hook.state?.[STATE_HOOK] ?? null,
    'thread-state-compaction': o.hook.state?.[STATE_FILES[1]] ?? null,
  }
}

/**
 * `{ specHash, instructionsHash }` for a launch (restart-on-update, launch-spec.ts), from the bytes it wrote, or nothing when it
 * cannot be made: it then reads as an older entry, and a hash never refuses a start. instructionsHash: the instructions file's
 * digest, the same one the spec holds (none in the agent folder, which writes none). A dry plan also gives `specWith`, the
 * spec's hash with a recorded instructions digest in its place: equal to the recorded spec hash when only the instructions changed.
 */
export function specHashOf(
  inputs: () => LaunchSpecInputs,
  dry = false,
): { specHash?: string; instructionsHash?: string; specWith?: (instructionsHash: string) => string | undefined } {
  try {
    const i = inputs()
    const text = i.files[INSTRUCTIONS_ENTRY]
    const instructions = text === null || text === undefined ? undefined : instructionsDigest(text)
    return {
      specHash: launchSpecHash(i),
      ...(instructions ? { instructionsHash: instructions } : {}),
      ...(dry
        ? {
            specWith: (was: string) =>
              SPEC_HASH_PATTERN.test(was)
                ? launchSpecHash(
                    { ...i, files: { ...i.files, [INSTRUCTIONS_ENTRY]: undefined } },
                    {
                      [INSTRUCTIONS_ENTRY]: was.slice('sha256:'.length),
                    },
                  )
                : undefined,
          }
        : {}),
    }
  } catch {
    return {}
  }
}

/** JSON with every object's keys sorted (the Mac writes with .sortedKeys). */
function sortedJSON(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.keys(x as Record<string, unknown>)
              .sort()
              .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
          )
        : x
  return JSON.stringify(sort(v))
}

/**
 * `--mcp-config` for a session with no MCP list in a folder outside the agent folder (the Mac's WorkerManager.mcpConfig):
 * the agent folder's `talos-app` server entry, nothing else, and nothing in its env a worker must never have. Claude Code
 * reads a project .mcp.json from the session's own folder, so without this a thread folder has no talos-app server. Null in
 * the agent folder (its .mcp.json is read there), or when there is no such entry to give (the launch is as before).
 */
export function talosOnlyMcpConfig(i: PlannerInputs, threadId: string, folder: string, dry = false): string | null {
  if (folder === realOrNull(i.agentDir)) return null
  const text = talosMcpText(i.agentDir)
  if (text === null) return null
  const path = join(workerDir(i.talosHome, threadId), 'mcp.json')
  // a dry plan writes nothing, but answers as the real start would: none when the file could not be written there (R1-3)
  if (dry) return writableAt(workerDir(i.talosHome, threadId)) ? path : null
  try {
    ensureDir(workerDir(i.talosHome, threadId))
    writeFileAtomic(path, text, 0o600)
  } catch {
    return null
  }
  return path
}

/** A file could be written in `dir`: it is a writable folder of ours, or not there yet under one (ensureDir makes it). */
function writableAt(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    try {
      const st = lstatSync(d)
      if (!st.isDirectory() || st.isSymbolicLink()) return false
      accessSync(d, constants.W_OK)
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(d) === d) return false
    }
  }
}

/** The agent folder's `talos-app` server entry, cleaned, as a config of its own (sorted), or null when there is none. */
export function talosMcpText(agentDir: string): string | null {
  let talos: unknown
  try {
    const root = JSON.parse(readFileSync(join(agentDir, '.mcp.json'), 'utf8')) as { mcpServers?: unknown }
    const servers = root?.mcpServers
    talos = servers && typeof servers === 'object' ? (servers as Record<string, unknown>)['talos-app'] : undefined
  } catch {
    return null
  }
  if (!talos || typeof talos !== 'object' || Array.isArray(talos)) return null
  return sortedJSON({ mcpServers: { 'talos-app': cleanMcpEntry(talos as Record<string, unknown>) } })
}

// for folders only: a file's real path goes through realFileSync (real-file.ts), as realpath can name a hard-linked file by another of its names
function realOrNull(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** The folder of Main's own .claude.json, from the environment Main runs under (as mainCeiling reads it). */
/**
 * The edit-only rules every session gets on what other sessions load: the deny on the scripts the agent folder's own settings run
 * (its hooks and status line, kit/hooks and hooks: a PreToolUse hook can answer "allow", so no session may edit what one runs), and
 * on the settings files of every fenced folder, ~/.claude, Main's config folder and each .claude.json (Main's own included). With
 * the thread fence off (`fenceOff`), a config folder's agents, skills, commands, CLAUDE.md, rules, output styles, workflows and
 * routines are `ask` rules instead of denies: the owner answers on a card. Settings files, hooks, plugins and .claude.json stay denied.
 */
function sessionSettingsRules(
  i: PlannerInputs,
  read: MainRead,
  folders: readonly string[],
  fenceOff: boolean,
): { deny: string[]; ask: string[] } {
  const rules = settingsFileRules(
    [...new Set(folders)],
    [...new Set([join(i.userHome, '.claude'), i.claudeDir, i.claudeDirOf?.(read.env) ?? i.claudeDir])],
    [
      ...new Set([
        join(i.userHome, '.claude.json'),
        join(i.configHome ?? i.userHome, '.claude.json'),
        join(mainJsonHome(i, read), '.claude.json'),
      ]),
    ],
    { fenceOff, home: i.userHome },
  )
  return { deny: [...agentScriptDenyRules(i.agentDir), ...rules.deny], ask: rules.ask }
}

function mainJsonHome(i: PlannerInputs, read: MainRead): string {
  const mainDir = i.claudeDirOf?.(read.env) ?? i.claudeDir
  return i.claudeDirOf ? claudeJsonHome(read.env, i.userHome, mainDir) : (i.configHome ?? i.userHome)
}
