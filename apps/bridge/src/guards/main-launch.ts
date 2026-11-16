// Main's one `--settings` (Claude Code reads one): the optional guards and Claude Code's own computer use turned off (Talos's screen
// tools replace it), for every Main launch the bridge makes. The TypeScript twin of TalosDesktopCore GuardsSettings.applyingToMain;
// the words and the order are the same. The flag goes first, so the owner's trailing `--` and prompt stay last. The owner's own
// `--settings` stays in place: the deny rides beside it as `--disallowedTools` (review R2-4), and the guards
// stay off for that launch, as before, with a warning. The owner's file is never read or copied.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MCP_ALWAYS_DENIED } from '@talos-app/protocol'
import { writeFileAtomic } from '../fsutil.ts'
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

export function mainLaunchArgs(
  args: string[],
  talosHome: string,
  io: LaunchIo = {},
): { args: string[]; warnings: string[] } {
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
  if (i >= 0) {
    // theirs stays exactly where and what it is (a copy would change what its relative paths mean, and later edits would stop
    // reaching Main); the deny goes in as --disallowedTools right before it, so the next word is an option and ends the list
    const w =
      guards !== null
        ? [`guards installed (${file}) but the launch args already include --settings: the guards are NOT active`]
        : []
    return { args: [...args.slice(0, i), ...DISALLOWED_TOOLS_ARGS, ...args.slice(i)], warnings: w }
  }
  if (guards === null) return { args: ['--settings', JSON.stringify(denyingComputerUse({})), ...args], warnings: [] }
  const g = object(guards)
  if (!g)
    return {
      args: ['--settings', file, ...args],
      warnings: [`the guards' file cannot be read: ${MAIN_LAUNCH_NOT_DENIED}`],
    }
  // the installed rules, with any this version adds that they lack (guards installed by an older Talos)
  const perms = (typeof g.permissions === 'object' && g.permissions !== null ? g.permissions : {}) as Json
  const had = Array.isArray(perms.deny) ? (perms.deny as unknown[]) : []
  const deny = [...had, ...supervisorDenyRules(talosHome).filter((r) => !had.includes(r))]
  const current = { ...g, permissions: { ...perms, deny } }
  try {
    write(launch, JSON.stringify(sorted(denyingComputerUse(current))))
  } catch (e) {
    return {
      args: ['--settings', file, ...args],
      warnings: [`${launch} could not be written (${(e as Error).message}): ${MAIN_LAUNCH_NOT_DENIED}`],
    }
  }
  return { args: ['--settings', launch, ...args], warnings: [] }
}
