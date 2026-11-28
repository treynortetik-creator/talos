// The opt-in OS sandbox ("Extra lock on protected files", config.json `os_sandbox`, docs/SECURITY.md "OS sandbox"). With the switch on,
// Main and every thread session start inside Claude Code's own sandbox (bubblewrap on Linux, Seatbelt on macOS), locked: no command can
// leave it and a session does not start without it. The sandbox's `denyWrite` makes the Talos home's protected files unwritable at the
// kernel, whatever way a command is written (python, awk -i, vim, eval, xargs, sort -o, ln, rm, mv, git): the shell guard cannot see
// those spellings. This file is the one builder every TypeScript launch path uses (guards/main-launch.ts, supervisor/worker-spec.ts);
// the Mac app's Swift launches build the same JSON (docs/SECURITY.md). Pure apart from `readOsSandboxSwitch`, `osSandboxPreflight`
// and `writeSandboxExcludes`, which read and write files the caller names.
//
// Two holes the builder and the preflight close (spike: a hard link made before launch reaches a protected file through the
// sandbox; on macOS a rule whose path is not the real path is silently not enforced):
//  - the preflight refuses a launch unless every protected file has link count 1 and is a regular file (no other name, no symlink);
//  - every path in the settings is the real path (a symlinked home gives the real one; a path that cannot be resolved is refused).
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { WORKER_FILES } from '@talos-app/protocol'
import { writeFileAtomic } from '../fsutil.ts'
import { CACHE_ENV, LEAD_SANDBOX } from '../lead/settings.ts'
import { realFileSync } from '../real-file.ts'
import { kitVendorDir } from '../talos.ts'
import {
  entryProblem,
  folderDenyWrite,
  folderLaunchProblem,
  folderLinkProblem,
  realName,
  recordedBridgePaths,
  type TrustedBridge,
  trustedBridge,
  WALK_CAP,
} from './os-sandbox-folder.ts'
import { lastKnownSwitch, rememberSwitch, SWITCH_RECORD } from './os-sandbox-record.ts'
import { HOME_NEVER, HOME_READ_ONLY, HOME_WRITE_DENIED, SUPERVISOR_READ_ONLY } from './rules.ts'

type Json = Record<string, unknown>

/** The folder inside the Talos home that holds the git excludes file the sessions read (written by the bridge, read-only to them). */
export const SANDBOX_DIR = 'sandbox'
export const SANDBOX_EXCLUDES = 'gitignore'

/** What the sandbox mounts into a session's folder as placeholders (they make `git add -A` fail unless git is told to leave them). */
export const SANDBOX_PLACEHOLDERS = [
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.gitconfig',
  '.gitmodules',
  '.mcp.json',
  '.ripgreprc',
  '.idea',
  '.vscode',
] as const

/** Names under the Talos home that are unwritable in the sandbox: every file the guards protect from writes, the launch files, and the excludes folder. */
export const OS_SANDBOX_DENY_WRITE = [
  ...new Set<string>([...HOME_WRITE_DENIED, ...HOME_READ_ONLY, SANDBOX_DIR, 'workers', 'workers.json']),
]
/** Names under the Talos home that no command may read: the signing keys, the secret store, the supervisor's control files (HOME_NEVER). */
export const OS_SANDBOX_DENY_READ = [...new Set<string>(HOME_NEVER)]
/** Names checked by the preflight: the denied-write ones (the excludes folder is the bridge's own and written fresh each launch). */
const PREFLIGHT_NAMES = [
  ...OS_SANDBOX_DENY_WRITE.filter((n) => n !== SANDBOX_DIR && n !== 'workers'),
  // workers/ holds the thread folders (their files may have several names legitimately): only the permission-hook copy every
  // thread runs outside the sandbox is walked, and each thread's control files by name
  'workers/_hook',
]
/** The files in each `workers/<thread>/` that pass between the supervisor and the bridge or configure the session (never written from a session). */
const WORKER_CONTROL_NAMES = [
  ...Object.values(WORKER_FILES),
  'settings.json',
  'mcp.json',
  'project-check.json',
  'system-prompt.md',
]

/** The launch is refused: a path cannot be resolved, so nothing is emitted for it. */
export class OsSandboxError extends Error {}

export type OsSandboxInput = {
  talosHome: string
  userHome: string
  /** The session's own folder: its package caches live in `.cache` there. */
  folder: string
  platform: NodeJS.Platform
  /** Git's own `GIT_CONFIG_COUNT` where the session starts (the owner's): the sandbox's entry is added after his, never in place of them. */
  gitConfigCount?: number
  /** The session loads the folder's project and local settings (Main and a thread in the agent folder); false: a thread outside it loads user settings only. Default true. */
  loadsProject?: boolean
  /** Claude Code's config folder (its user settings are checked for sandbox keys); default CLAUDE_CONFIG_DIR, else `<userHome>/.claude`. */
  claudeDir?: string
  /** Entries of the owner's own git excludes file, appended to the sandbox's so his ignores still hold. */
  ownerExcludes?: readonly string[]
  /** What Talos recorded about its bridge (the bun and the clone); undefined: this process's own (trustedBridge), null: none. */
  trusted?: TrustedBridge | null
  /** The folders besides the session's that a session can write (default: the shared temp folders); a kit inside one is never credited. Tests whose kit sits in a temp folder pass []. */
  writableRoots?: readonly string[]
  /** Main's launch arguments (past `--` is the prompt): `--add-dir` in them refuses the start. */
  launchArgs?: readonly string[]
}

export type OsSandboxPieces = {
  /** The `sandbox` block of the settings JSON. */
  sandbox: {
    enabled: true
    failIfUnavailable: true
    allowUnsandboxedCommands: false
    /** Both off, so no settings level can turn them on by itself being silent: Apple events and the weaker network isolation reach outside. */
    allowAppleEvents: false
    autoAllowBashIfSandboxed: false
    enableWeakerNetworkIsolation: false
    filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] }
  }
  /** Added to the settings' `env`: package caches in the folder, and git's excludes file. */
  env: Record<string, string>
  /** The excludes file the bridge writes before the launch: where, and its lines. */
  excludes: { path: string; lines: string[] }
}

const resolveReal = (p: string, what: string): string => {
  try {
    return realFileSync(resolve(p))
  } catch (e) {
    throw new OsSandboxError(
      `the OS sandbox cannot be set up: ${what} (${p}) cannot be resolved (${(e as Error).message})`,
    )
  }
}

/** The real path of `name` under the real home: the entry itself when it exists (it must resolve), else where it would be. */
function protectedPath(realHome: string, name: string): string {
  const p = join(realHome, name)
  try {
    lstatSync(p)
  } catch {
    return p // not there yet: a rule for where it would be
  }
  return resolveReal(p, name)
}

/** Denied for writing besides the home's and the folder's names: where login items live (~/Library/LaunchAgents) and the kit release, by real path, even when missing. */
const extraDenyWrite = (userHome: string, trusted: TrustedBridge | null): string[] => {
  const rec = trusted ? recordedBridgePaths(trusted) : null
  return [
    realName(join(userHome, 'Library', 'LaunchAgents')),
    realName(kitVendorDir(process.env, userHome)),
    // the recorded clone, its bridge folder and the bun(s), whatever the session's folder: the builder alone never skips them (a folder that
    // contains or is inside them is refused at launch by cloneFenceProblem)
    ...(rec ? [...new Set([rec.clone, rec.bridgeDir, ...rec.buns])] : []),
  ]
}

/**
 * The sandbox block, the environment and the excludes file for one session. Every path is a real path (the home may be a symlink, the
 * folder too); on macOS each also in lower case, as its disks compare names without case. A path that cannot be resolved makes it
 * throw `OsSandboxError`: nothing partial is returned.
 */
export function osSandboxSettings(i: OsSandboxInput): OsSandboxPieces {
  const home = resolveReal(i.talosHome, 'the Talos home')
  const folder = resolveReal(i.folder, "the session's folder")
  const forms = (p: string): string[] => (i.platform === 'darwin' ? [...new Set([p, p.toLowerCase()])] : [p])
  const under = (names: readonly string[]) => names.flatMap((n) => forms(protectedPath(home, n)))
  const excludesPath = join(home, SANDBOX_DIR, SANDBOX_EXCLUDES)
  const gitCount =
    Number.isInteger(i.gitConfigCount) && (i.gitConfigCount as number) > 0 ? (i.gitConfigCount as number) : 0
  // the cache folder is the folder's own `.cache`, by its real path (it may be a link inside the folder)
  let cacheRoot = `${folder}/.cache`
  try {
    cacheRoot = realFileSync(cacheRoot)
  } catch {}
  const cache = Object.fromEntries(Object.entries(CACHE_ENV).map(([k, dir]) => [k, `${cacheRoot}/${dir}`]))
  return {
    sandbox: {
      ...LEAD_SANDBOX,
      allowAppleEvents: false,
      autoAllowBashIfSandboxed: false,
      enableWeakerNetworkIsolation: false,
      filesystem: {
        // nothing is added to what Claude Code lets a session write by default (its folder and tmp): the Talos home is NOT writable
        // (the one stated exception to Edit allow rules is a thread session's own state file, `threads/<id>.state.md`, in its generated settings)
        // from a session. The agent's Talos work goes through the talos-app MCP server, which runs outside the sandbox.
        allowWrite: [],
        // the home's protected names, and the files in the session's own folder that Claude Code runs outside the sandbox
        denyWrite: [
          ...under(OS_SANDBOX_DENY_WRITE),
          ...folderDenyWrite(folder).flatMap(forms),
          ...extraDenyWrite(i.userHome, i.trusted === undefined ? trustedBridge() : i.trusted).flatMap(forms),
        ],
        denyRead: under(OS_SANDBOX_DENY_READ),
      },
    },
    env: {
      ...cache,
      GIT_CONFIG_COUNT: String(gitCount + 1),
      [`GIT_CONFIG_KEY_${gitCount}`]: 'core.excludesFile',
      [`GIT_CONFIG_VALUE_${gitCount}`]: excludesPath,
    },
    excludes: {
      path: excludesPath,
      lines: [...new Set([...SANDBOX_PLACEHOLDERS, '.claude/', '.cache/', ...(i.ownerExcludes ?? [])])],
    },
  }
}

/** `settings` with the sandbox block and the environment added; any `sandbox` the settings had keeps only its `network` object. */
export function withOsSandbox(settings: Json, p: OsSandboxPieces): Json {
  const old = settings.sandbox
  const net = old && typeof old === 'object' && !Array.isArray(old) ? (old as Json).network : undefined
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {}
  return {
    ...settings,
    sandbox: { ...p.sandbox, ...(net && typeof net === 'object' && !Array.isArray(net) ? { network: net } : {}) },
    env: { ...(env as Json), ...p.env },
  }
}

// ---- the switch ---------------------------------------------------------------------------------------------------------------

export { SWITCH_RECORD }

/** What the owner is told when config.json cannot be read and the lock is kept on because it was on at the last good reading. */
export const SWITCH_UNREADABLE_NOTE = "Talos couldn't read its settings, so the extra lock stays on"

/**
 * Is the switch on? `"os_sandbox": true` in config.json is on; no file, or no such key (or any other value), is off. A config.json
 * that exists but cannot be read, is not JSON or is not an object does not say: the switch then keeps the state of its last good
 * reading (the record above), and is OFF when there never was one: the lock is off unless the owner chose it. `onUnreadable` is
 * told why and which way it was kept, once per call, for the audit line and the owner's notice.
 */
export function readOsSandboxSwitch(
  talosHome: string,
  read?: (p: string) => string | null,
  onUnreadable?: (why: string, keptOn: boolean) => void,
  onNotRecorded?: () => void,
): boolean {
  const file = join(talosHome, 'config.json')
  let parsed: unknown
  try {
    const text = read ? read(file) : existsSync(file) ? readFileSync(file, 'utf8') : null
    if (text === null) return false
    parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('it is not a settings object')
  } catch (e) {
    const kept = lastKnownSwitch(talosHome)
    onUnreadable?.((e as Error).message, kept)
    return kept
  }
  const on = (parsed as { os_sandbox?: unknown }).os_sandbox === true
  if (rememberSwitch(talosHome, on) === 'failed' && on) onNotRecorded?.()
  return on
}

// ---- the preflight ------------------------------------------------------------------------------------------------------------

/**
 * The sandbox cannot protect a file that has a second name, so a launch with the switch on is refused unless every protected file
 * that exists is a regular file with link count 1 (not a symlink) and every protected folder holds only such files. One plain line
 * naming the file and how to fix it, or null when all is fine.
 */
export function osSandboxPreflight(talosHome: string): string | null {
  const budget = { left: WALK_CAP }
  for (const name of PREFLIGHT_NAMES) {
    const why = entryProblem(join(talosHome, name), name, budget)
    if (why) return why
  }
  let threads: string[] = []
  try {
    threads = readdirSync(join(talosHome, 'workers'))
  } catch {}
  for (const t of threads)
    for (const n of WORKER_CONTROL_NAMES) {
      const why = entryProblem(join(talosHome, 'workers', t, n), `workers/${t}/${n}`, budget)
      if (why) return why
    }
  return null
}

/**
 * The preflight again, for the last moment before a session process is started: a second name made after the first check (and after
 * the settings were written) is caught here. The same check and the same line; the host (tmux-host.ts), `talos-app start` and the
 * launch hand it to whoever starts the process.
 */
export const osSandboxRecheck =
  (talosHome: string, folder?: string): (() => string | null) =>
  () =>
    osSandboxPreflight(talosHome) ?? (folder ? folderLinkProblem(folder) : null)

// ---- the git excludes file ----------------------------------------------------------------------------------------------------

/**
 * The entries of the owner's own global git excludes file (core.excludesFile, else git's default location), read only: his ignores
 * are appended to the sandbox's file, because the session's git is pointed at that one file. Lines only; a file that cannot be read
 * adds nothing.
 */
export function readOwnerExcludes(
  userHome: string = homedir(),
  deps: { gitConfig?: (home: string) => string | null; read?: (p: string) => string | null } = {},
): string[] {
  const read =
    deps.read ??
    ((p: string) => {
      try {
        return statSync(p).size <= 256 * 1024 ? readFileSync(p, 'utf8') : null
      } catch {
        return null
      }
    })
  const configured =
    deps.gitConfig?.(userHome) ??
    (() => {
      try {
        const r = spawnSync('git', ['config', '--global', '--get', 'core.excludesFile'], {
          env: { HOME: userHome, PATH: process.env.PATH ?? '' },
          encoding: 'utf8',
          timeout: 5000,
        })
        return r.status === 0 ? r.stdout.trim() || null : null
      } catch {
        return null
      }
    })()
  const expand = (p: string) => (p.startsWith('~/') ? join(userHome, p.slice(2)) : p)
  const file = configured ? expand(configured) : join(userHome, '.config', 'git', 'ignore')
  const text = read(file)
  if (text === null) return []
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '')
}

/** Writes the excludes file of `pieces` (the bridge's own write; sessions get it read-only). */
export function writeSandboxExcludes(
  pieces: OsSandboxPieces,
  write: (path: string, data: string) => void = (p, d) => writeFileAtomic(p, d, 0o644),
): void {
  // never through a link: a folder or file planted at sandbox/ (made outside) would send the bridge's write elsewhere
  for (const p of [dirname(pieces.excludes.path), pieces.excludes.path])
    try {
      if (lstatSync(p).isSymbolicLink())
        throw new OsSandboxError(`${p} is a symbolic link; remove it, then start again`)
    } catch (e) {
      if (e instanceof OsSandboxError) throw e
    }
  write(pieces.excludes.path, `${pieces.excludes.lines.join('\n')}\n`)
}

/**
 * Everything one launch needs with the switch on: the preflight (a refusal line, or the pieces and the excludes file written).
 * `folder` is the session's folder. A refusal is one plain line.
 */
export function prepareOsSandbox(
  i: Omit<OsSandboxInput, 'ownerExcludes' | 'platform'> & { platform?: NodeJS.Platform },
  io: {
    ownerExcludes?: (userHome: string) => string[]
    write?: (path: string, data: string) => void
  } = {},
): { refusal: string } | { pieces: OsSandboxPieces } {
  const bad = osSandboxPreflight(i.talosHome)
  if (bad) return { refusal: bad }
  // --add-dir makes a folder outside the working folder writable inside the lock (the home's check first, then Main's arguments)
  const dashes = i.launchArgs?.indexOf('--') ?? -1
  const ownFlags = (dashes < 0 ? i.launchArgs : i.launchArgs?.slice(0, dashes)) ?? []
  if (ownFlags.some((a) => a === '--add-dir' || a.startsWith('--add-dir=')))
    return {
      refusal:
        "Main's launch arguments include --add-dir, which lets a session write outside its folder; remove it, then start again",
    }
  try {
    const folder = resolveReal(i.folder, "the session's folder")
    const problem = folderLaunchProblem(folder, i.claudeDir ?? defaultClaudeDir(i.userHome), i.loadsProject !== false, {
      userHome: i.userHome,
      talosHome: i.talosHome,
      trusted: i.trusted,
      writableRoots: i.writableRoots,
    })
    if (problem) return { refusal: problem }
    const pieces = osSandboxSettings({
      ...i,
      platform: i.platform ?? process.platform,
      ownerExcludes: (io.ownerExcludes ?? ((h: string) => readOwnerExcludes(h)))(i.userHome),
      gitConfigCount: Number(process.env.GIT_CONFIG_COUNT),
    })
    writeSandboxExcludes(pieces, io.write)
    return { pieces }
  } catch (e) {
    return { refusal: (e as Error).message }
  }
}

/** Claude Code's config folder when the caller did not name one. */
export const defaultClaudeDir = (userHome: string): string => process.env.CLAUDE_CONFIG_DIR || join(userHome, '.claude')

/** What a launch needs from the Talos home's protected launch files by name (so a test can check the list covers them). */
export const OS_SANDBOX_LAUNCH_FILES: readonly string[] = SUPERVISOR_READ_ONLY

/** One start of a thread session: the sandbox it gets (null while the switch is off), or the one plain line that refuses the start. `dry`: nothing is written. */
export function planOsSandbox(
  on: boolean,
  i: { talosHome: string; userHome: string; folder: string; claudeDir?: string; loadsProject?: boolean },
  dry: boolean,
): { refusal: string } | { pieces: OsSandboxPieces | null } {
  if (!on) return { pieces: null }
  return prepareOsSandbox(i, dry ? { write: () => {} } : {})
}
