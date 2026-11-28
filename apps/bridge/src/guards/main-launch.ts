// Main's one `--settings` (Claude Code reads one): the optional guards and Claude Code's own computer use turned off (Talos's screen
// tools replace it), for every Main launch the bridge makes. The TypeScript twin of TalosDesktopCore GuardsSettings.applyingToMain;
// the words and the order are the same. The flag goes first, so the owner's trailing `--` and prompt stay last. The owner's own
// `--settings` stays in place: the deny rides beside it as `--disallowedTools` (review R2-4), and the guards
// stay off for that launch, as before, with a warning. The owner's file is never read or copied.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MCP_ALWAYS_DENIED } from '@talos-app/protocol'
import { writeFileAtomic } from '../fsutil.ts'
import {
  type OsSandboxPieces,
  osSandboxRecheck,
  prepareOsSandbox,
  readOsSandboxSwitch,
  SWITCH_UNREADABLE_NOTE,
  withOsSandbox,
} from './os-sandbox.ts'
import { supervisorDenyRules } from './rules.ts'

type Json = Record<string, unknown>

export const MAIN_LAUNCH_NOT_DENIED = "Claude Code's own computer use is NOT turned off for main"
export const guardsFile = (talosHome: string) => join(talosHome, 'guards', 'settings.json')
export const mainLaunchPath = (talosHome: string) => join(talosHome, 'guards', 'main-launch.json')
/** The deny as command-line permission rules: Claude Code adds them to every settings source, and `mcp__<server>` covers every
 * tool of that server and takes them out of the agent's context. */
export const DISALLOWED_TOOLS_ARGS = ['--disallowedTools', ...MCP_ALWAYS_DENIED.map((n) => `mcp__${n}`)]

export type LaunchIo = {
  cwd?: string
  /** Claude Code's config folder (default CLAUDE_CONFIG_DIR, else `~/.claude`), whose user settings are checked for sandbox keys. */
  claudeDir?: string
  /** The owner's home (default: this user's), for his own git excludes. */
  userHome?: string
  /** The owner's own git excludes entries (default: read from his global git excludes file). */
  ownerExcludes?: (userHome: string) => string[]
  /** The folders besides the session's that a session can write (default: the shared temp folders); tests whose kit sits in a temp folder pass []. */
  writableRoots?: readonly string[]
  read?: (path: string) => string | null
  write?: (path: string, data: string) => void
}

const object = (text: string | null): Json | null => {
  if (text === null) return null
  try {
    const v = JSON.parse(text) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null
  } catch {
    return null
  }
}

/** `settings` with every always-denied server in `deniedMcpServers` (a union: what was there stays). */
export function denyingComputerUse(settings: Json): Json {
  const denied = Array.isArray(settings.deniedMcpServers) ? [...(settings.deniedMcpServers as unknown[])] : []
  for (const n of MCP_ALWAYS_DENIED)
    if (!denied.some((d) => (d as { serverName?: unknown } | null)?.serverName === n)) denied.push({ serverName: n })
  return { ...settings, deniedMcpServers: denied }
}

const sorted = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sorted)
    : typeof v === 'object' && v !== null
      ? Object.fromEntries(
          Object.keys(v as Json)
            .sort()
            .map((k) => [k, sorted((v as Json)[k])]),
        )
      : v

/** `recheck`: set when the OS sandbox is applied to this launch; run it right before the process starts (a line refuses the start). */
export type MainLaunch = {
  args: string[]
  warnings: string[]
  refusal?: string
  recheck?: () => string | null
  /** The plain line for the owner when config.json could not be read and the lock was therefore kept on (it was on at the last good reading) (audit it, tell the owner). */
  note?: string
  /** config.json could not be read: why, and which way the lock was kept (audited either way; only a lock kept on has a `note`). */
  unreadable?: { why: string; keptOn: boolean }
  /** The lock is on, but that could not be written down as the last good reading: a later damaged config.json would read as off (audit it). */
  notRecorded?: true
}

/** The words that say why the extra lock is not on for a launch that has the switch on. */
const SANDBOX_NOT_ON = 'the extra lock on protected files (OS sandbox) is NOT active'

export function mainLaunchArgs(args: string[], talosHome: string, io: LaunchIo = {}): MainLaunch {
  const read =
    io.read ??
    ((p: string) => {
      try {
        return existsSync(p) ? readFileSync(p, 'utf8') : null
      } catch {
        return null
      }
    })
  const write = io.write ?? ((p: string, d: string) => writeFileAtomic(p, d, 0o600))
  const file = guardsFile(talosHome)
  const launch = mainLaunchPath(talosHome)
  const guards = read(file)
  // only the owner's flags count: past the first `--` every word is the prompt (review R3-4)
  const end = args.indexOf('--')
  const i = args.findIndex((a, n) => (end < 0 || n < end) && (a === '--settings' || a.startsWith('--settings=')))
  // the opt-in OS sandbox (os-sandbox.ts): only when the switch is on, and then the preflight may refuse the launch
  let note: string | undefined
  let unreadable: MainLaunch['unreadable']
  let notRecorded = false
  const sandboxOn = readOsSandboxSwitch(
    talosHome,
    io.read,
    (why, keptOn) => {
      unreadable = { why, keptOn }
      if (keptOn) note = SWITCH_UNREADABLE_NOTE
    },
    () => {
      notRecorded = true
    },
  )
  if (i >= 0) {
    // theirs stays exactly where and what it is (a copy would change what its relative paths mean, and later edits would stop
    // reaching Main); the deny goes in as --disallowedTools right before it, so the next word is an option and ends the list
    const w =
      guards !== null
        ? [`guards installed (${file}) but the launch args already include --settings: the guards are NOT active`]
        : []
    if (sandboxOn) w.push(`the launch args already include --settings: ${SANDBOX_NOT_ON}`)
    return {
      args: [...args.slice(0, i), ...DISALLOWED_TOOLS_ARGS, ...args.slice(i)],
      warnings: w,
      ...(unreadable ? { unreadable } : {}),
      ...(notRecorded ? { notRecorded: true as const } : {}),
    }
  }
  let pieces: OsSandboxPieces | undefined
  if (sandboxOn) {
    const r = prepareOsSandbox(
      {
        talosHome,
        userHome: io.userHome ?? homedir(),
        folder: io.cwd ?? process.cwd(),
        launchArgs: args,
        ...(io.writableRoots ? { writableRoots: io.writableRoots } : {}),
        ...(io.claudeDir ? { claudeDir: io.claudeDir } : {}),
      },
      { ...(io.ownerExcludes ? { ownerExcludes: io.ownerExcludes } : {}), write },
    )
    if ('refusal' in r) return { args, warnings: [], refusal: r.refusal }
    pieces = r.pieces
  }
  const sandboxed = (s: Json): Json => (pieces ? withOsSandbox(s, pieces) : s)
  const recheck = {
    ...(pieces ? { recheck: osSandboxRecheck(talosHome, io.cwd ?? process.cwd()) } : {}),
    ...(note ? { note } : {}),
    ...(unreadable ? { unreadable } : {}),
    ...(notRecorded ? { notRecorded: true as const } : {}),
  }
  if (guards === null)
    return {
      args: ['--settings', JSON.stringify(sandboxed(denyingComputerUse({}))), ...args],
      warnings: [],
      ...recheck,
    }
  const g = object(guards)
  if (!g) {
    const why = `the guards' file cannot be read: ${MAIN_LAUNCH_NOT_DENIED}`
    // with the switch on, a launch that cannot carry the sandbox does not start
    if (pieces) return { args, warnings: [], refusal: `${why}; and ${SANDBOX_NOT_ON}, so Main is not started` }
    return { args: ['--settings', file, ...args], warnings: [why] }
  }
  // the installed rules, with any this version adds that they lack (guards installed by an older Talos)
  const perms = (typeof g.permissions === 'object' && g.permissions !== null ? g.permissions : {}) as Json
  const had = Array.isArray(perms.deny) ? (perms.deny as unknown[]) : []
  const deny = [...had, ...supervisorDenyRules(talosHome).filter((r) => !had.includes(r))]
  const current = { ...g, permissions: { ...perms, deny } }
  try {
    write(launch, JSON.stringify(sorted(sandboxed(denyingComputerUse(current)))))
  } catch (e) {
    const why = `${launch} could not be written (${(e as Error).message}): ${MAIN_LAUNCH_NOT_DENIED}`
    if (pieces) return { args, warnings: [], refusal: `${why}; and ${SANDBOX_NOT_ON}, so Main is not started` }
    return { args: ['--settings', file, ...args], warnings: [why] }
  }
  return { args: ['--settings', launch, ...args], warnings: [], ...recheck }
}
