// `.mcp.json` of the AGENT FOLDER (never ~/.claude user scope, which would spawn the bridge in every session).
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { defaultHome } from './config.ts'
import { writeFileAtomic } from './fsutil.ts'
import { realFileSync } from './real-file.ts'

export type McpEntry = { command: string; args: string[]; env: Record<string, string> }

/** The bridge clone's server script and the bunfig bun is told to use in its place (the clone's own, which holds only test settings). */
export const bridgeServer = (bridgeDir: string): string => join(bridgeDir, 'src', 'server.ts')
export const bridgeBunfig = (bridgeDir: string): string => join(bridgeDir, 'bunfig.toml')

/**
 * What a talos-app entry in `.mcp.json` is: `current` (the form `mcpEntry` writes: `--no-env-file`, `--config=<bridge bunfig>`, the
 * server script, for this clone), `old` (`run --cwd <dir> --silent ...`, written before the sandbox's launch check: it still works with
 * the extra lock off, and refuses with it on) or `other`.
 */
export function mcpEntryState(entry: unknown, bridgeDir: string): 'current' | 'old' | 'other' {
  const e = entry && typeof entry === 'object' ? (entry as { args?: unknown }) : {}
  const a = Array.isArray(e.args) ? e.args : []
  if (
    a.length === 3 &&
    a[0] === '--no-env-file' &&
    a[1] === `--config=${bridgeBunfig(bridgeDir)}` &&
    a[2] === bridgeServer(bridgeDir)
  )
    return 'current'
  return a[0] === 'run' && a.includes('--cwd') ? 'old' : 'other'
}

/** Set for every bun Talos runs outside the sandbox (the guard hook, the talos-app server): bun's compiled-code cache in ~/.bun/install/cache is not read. */
export const BUN_CACHE_OFF = { name: 'BUN_RUNTIME_TRANSPILER_CACHE_PATH', value: '0' } as const

/**
 * bun by absolute path: Claude Code starts the MCP server with the PATH of its own session, and Main can start with a bare one
 * (2026-11-09: "Executable not found in $PATH: bun", the bridge never ran). The bun on PATH comes first (a stable path like
 * ~/.bun/bin/bun or /opt/homebrew/bin/bun), the running binary next (a versioned Cellar path breaks on upgrade), `bun` last.
 */
export function bunPath(): string {
  const found = typeof Bun !== 'undefined' ? Bun.which('bun', { PATH: process.env.PATH ?? '' }) : null
  if (found && isAbsolute(found)) return found
  if (isAbsolute(process.execPath) && /^bun(-|$)/.test(basename(process.execPath))) return process.execPath
  return 'bun'
}

/**
 * The env is TALOS_APP_HOME, `agentDir` as TALOS_AGENT_DIR (the server runs in the agent folder, which it cannot otherwise tell; only the
 * last-good save uses it) and the bun cache switch (`BUN_CACHE_OFF`). No PATH is written: Claude Code puts the entry's
 * env over the session's, so a PATH here would hide ~/.local/bin (claude) and /opt/homebrew/bin (ffmpeg, gh, tmux) from the bridge.
 * `server.ts` is run directly (not through the `start` script, whose shell needs a bare `bun`), by absolute path, with `--no-env-file` and
 * `--config=<the bridge clone's bunfig.toml>`: the server's working folder stays the agent folder (the bridge and its CLI read it as that),
 * and bun loads neither that folder's `.env` nor its `bunfig.toml` (a `preload` there would run outside the sandbox; MCP servers are not
 * sandboxed). Before 2026-11-22 the entry was `run --cwd <bridge> --silent src/server.ts`: `mcpEntryState` calls that one `old`.
 */
export function mcpEntry(bridgeDir: string, home: string, agentDir?: string, bun: string = bunPath()): McpEntry {
  return {
    command: bun,
    args: ['--no-env-file', `--config=${bridgeBunfig(bridgeDir)}`, bridgeServer(bridgeDir)],
    env: {
      TALOS_APP_HOME: home,
      ...(agentDir ? { TALOS_AGENT_DIR: agentDir } : {}),
      [BUN_CACHE_OFF.name]: BUN_CACHE_OFF.value,
    },
  }
}

/** The PATH an earlier Talos wrote (bun's folder, then the system ones): ours, so it goes; any other PATH is the owner's. */
const OLD_FORMULA_PATH = /^[^:]+:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Adds or updates the `talos-app` server and leaves every other server and top-level key alone. */
export function mergeMcpConfig(
  existing: unknown,
  entry: McpEntry,
): { config: Record<string, unknown>; changed: boolean; droppedEnv: string[] } {
  const cfg: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  const servers: Record<string, unknown> =
    cfg.mcpServers && typeof cfg.mcpServers === 'object' && !Array.isArray(cfg.mcpServers)
      ? { ...(cfg.mcpServers as Record<string, unknown>) }
      : {}
  // The command and arguments are Talos's; env keys the owner added stay, and only the ones Talos sets are overwritten.
  const old = servers['talos-app']
  // Each string-valued key the owner added is kept on its own; a key whose value is not a string cannot be passed to a
  // process environment, so it is dropped (and reported), without costing the others.
  const rawEnv = old && typeof old === 'object' && !Array.isArray(old) ? (old as { env?: unknown }).env : undefined
  const oldEnv: Record<string, string> = {}
  const droppedEnv: string[] = []
  if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv))
    for (const [k, v] of Object.entries(rawEnv)) {
      if (typeof v === 'string') oldEnv[k] = v
      else droppedEnv.push(k)
    }
  // A PATH the owner set is his: kept. The one an earlier Talos wrote (`OLD_FORMULA_PATH`) is dropped. The other keys Talos sets are overwritten.
  if (oldEnv.PATH && OLD_FORMULA_PATH.test(oldEnv.PATH)) delete oldEnv.PATH
  const merged: McpEntry = { ...entry, env: { ...oldEnv, ...entry.env } }
  const changed = !same(old, merged)
  servers['talos-app'] = merged
  cfg.mcpServers = servers
  return { config: cfg, changed, droppedEnv }
}

/**
 * Where `.mcp.json` really is: itself, or the target of a symlink to it (a .mcp.json kept in a dotfiles folder). Resolved once,
 * so the file read and the file written are the same one. A link is followed only to a regular file named `.mcp.json` or
 * `mcp.json`: the agent can make links in its own folder, and a link to `~/.claude.json`, the Talos home's config.json or a
 * settings.json must never turn the owner's install-mcp into a write the agent is not allowed to make (bug hunt core #8).
 */
/** Folders a link from the agent folder is never followed into: the Claude config folders and the Talos home. */
export function mcpProtectedRoots(talosHome?: string): string[] {
  const roots = [join(homedir(), '.claude'), defaultHome()]
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(process.env.CLAUDE_CONFIG_DIR)
  if (talosHome) roots.push(talosHome)
  return [...new Set(roots)]
}

// for folders only: a file's real path goes through realFileSync (real-file.ts), as realpath can name a hard-linked file by another of its names
const realOr = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function mcpTarget(path: string, protectedRoots: readonly string[]): string {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return path
  let target: string
  try {
    // on macOS the realpath of a file can report another hard-linked name; resolve files with realFileSync (real-file.ts)
    target = realFileSync(path)
  } catch {
    return path // a dangling link: a new regular file takes its place, as before
  }
  const st = statSync(target)
  if (!st.isFile() || !['.mcp.json', 'mcp.json'].includes(basename(target)))
    throw new Error(
      `${path} is a link to ${target}, which is not an mcp.json file; nothing was changed. Replace the link with the file itself, or point it at your mcp.json.`,
    )
  // the agent can make links in its own folder: never into the Claude config or the Talos home, whatever the file is called
  for (const root of protectedRoots) {
    const r = realOr(root)
    if (target === r || target.startsWith(`${r}/`))
      throw new Error(
        `${path} is a link to ${target}, inside ${r}, which this command never writes; nothing was changed. Replace the link with the file itself.`,
      )
  }
  return target
}

export function installMcp(
  agentDir: string,
  entry: McpEntry,
  dryRun: boolean,
  protectedRoots: readonly string[] = mcpProtectedRoots(),
) {
  const path = join(agentDir, '.mcp.json')
  const target = mcpTarget(path, protectedRoots)
  let existing: unknown
  if (existsSync(target)) {
    try {
      existing = JSON.parse(readFileSync(target, 'utf8'))
    } catch {
      throw new Error(`${target} is not valid JSON; fix it by hand first (nothing was changed)`)
    }
  }
  const { config, changed, droppedEnv } = mergeMcpConfig(existing, entry)
  if (changed && !dryRun) {
    // Through the link to its target (the link stays a link), keeping the file's mode (a 0600 file that holds a token stays
    // 0600; a new file is 0644), as writePlan does.
    const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644
    writeFileAtomic(target, `${JSON.stringify(config, null, 2)}\n`, mode)
  }
  return { path, target, changed, config, droppedEnv }
}

export function readMcpEntry(agentDir: string): unknown {
  try {
    const cfg = JSON.parse(readFileSync(join(agentDir, '.mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    return cfg.mcpServers?.['talos-app']
  } catch {
    return undefined
  }
}
