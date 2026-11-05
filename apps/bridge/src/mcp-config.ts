// `.mcp.json` of the AGENT FOLDER (never ~/.claude user scope, which would spawn the bridge in every session).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './fsutil.ts'

export type McpEntry = { command: string; args: string[]; env: Record<string, string> }

/**
 * `agentDir` goes in as TALOS_AGENT_DIR: the server runs with the bridge folder as its working folder (`bun run --cwd`), so
 * the agent folder it serves cannot be read from there. Only the last-good save uses it.
 */
export function mcpEntry(bridgeDir: string, home: string, agentDir?: string): McpEntry {
  return {
    command: 'bun',
    args: ['run', '--cwd', bridgeDir, '--silent', 'start'],
    env: { TALOS_APP_HOME: home, ...(agentDir ? { TALOS_AGENT_DIR: agentDir } : {}) },
  }
}

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
  const merged: McpEntry = { ...entry, env: { ...oldEnv, ...entry.env } }
  const changed = !same(old, merged)
  servers['talos-app'] = merged
  cfg.mcpServers = servers
  return { config: cfg, changed, droppedEnv }
}

export function installMcp(agentDir: string, entry: McpEntry, dryRun: boolean) {
  const path = join(agentDir, '.mcp.json')
  let existing: unknown
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw new Error(`${path} is not valid JSON; fix it by hand first (nothing was changed)`)
    }
  }
  const { config, changed, droppedEnv } = mergeMcpConfig(existing, entry)
  if (changed && !dryRun) writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`, 0o644)
  return { path, changed, config, droppedEnv }
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
