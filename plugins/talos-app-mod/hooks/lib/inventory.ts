// The inventory: commands (built-ins, skills, plugin commands and MCP prompts all come through `$.command.list()`),
// plugins, MCP servers, and the model and effort lists (docs/CLAUDE-CODE.md C2.2). Every entry also gets a hash so the
// mod resends only on change. The bridge recomputes each command's `route` from (source, name) and never trusts one
// from here, so rows go out with the safest value, `local_only`.

import type { EngineLike } from './engine.ts'
import { sha256Hex } from './hash.ts'
import { attempt, configFacts } from './state.ts'

const MODEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,79}$/
const SOURCES = new Set(['builtin', 'plugin', 'user', 'mcp'])

export type InventoryEntry = { kind: 'command' | 'plugin' | 'mcp_server'; name: string; source: string; hash: string }

export type InventoryOut = {
  commands: Array<{ name: string; description: string; source: string; plugin?: string; route: 'local_only' }>
  models: Array<{ value: string; label: string }>
  efforts: string[]
  mcp_servers: Array<{ name: string; tools: number; status: 'connected' }>
  plugins: Array<{ name: string; enabled: true }>
  at: string
}

export type BuiltInventory = { inventory: InventoryOut; entries: InventoryEntry[]; digest: string }

const hashEntry = (kind: string, name: string, source: string, extra: string) =>
  sha256Hex(`${kind}\n${name}\n${source}\n${extra}`)

/** `mcp__<server>__<tool>` → server. Servers are named by the middle segment, as the tool-name spelling `$.mcp.call` takes. */
export function mcpServerOf(toolName: string): string | undefined {
  const m = /^mcp__(.+?)__.+$/.exec(toolName)
  return m?.[1]
}

/** The bridge's own server, found by its `talos_mod_hello` tool, never by a hard-coded name (generic installs differ). */
export function bridgeServerOf(tools: ReadonlyArray<{ name: string }>): string | undefined {
  for (const t of tools) {
    const m = /^mcp__(.+)__talos_mod_hello$/.exec(t.name)
    if (m?.[1]) return m[1]
  }
  return undefined
}

export async function buildInventory($: EngineLike): Promise<BuiltInventory | undefined> {
  const [cmds, tools, rows] = await Promise.all([
    attempt(() => $.command.list()),
    attempt(() => $.tool.list()),
    attempt(() => $.config.list()),
  ])
  if (!Array.isArray(cmds)) return undefined // no command list, no inventory: the app greys the palette out

  const entries: InventoryEntry[] = []
  const commands: InventoryOut['commands'] = []
  const pluginNames = new Set<string>([$.plugin.name])
  for (const c of cmds.slice(0, 1000)) {
    if (typeof c?.name !== 'string' || !SOURCES.has(String(c.source))) continue
    const description = typeof c.description === 'string' ? c.description.slice(0, 200) : ''
    const plugin = typeof c.plugin === 'string' && c.plugin.length > 0 && c.plugin.length <= 64 ? c.plugin : undefined
    if (plugin) pluginNames.add(plugin)
    if (commands.length >= 400) continue
    commands.push({
      name: c.name,
      description,
      source: String(c.source),
      ...(plugin ? { plugin } : {}),
      route: 'local_only',
    })
    entries.push({
      kind: 'command',
      name: c.name,
      source: String(c.source),
      hash: await hashEntry('command', c.name, String(c.source), description),
    })
  }

  // MCP health is honest (C2.2): a server with tools in `$.tool.list()` is connected; anything else is not listed.
  const perServer = new Map<string, number>()
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t?.mcp || typeof t.name !== 'string') continue
    const s = mcpServerOf(t.name)
    if (s) perServer.set(s, (perServer.get(s) ?? 0) + 1)
  }
  const mcp_servers: InventoryOut['mcp_servers'] = []
  for (const [name, count] of [...perServer].slice(0, 100)) {
    if (name.length > 64) continue
    mcp_servers.push({ name, tools: count, status: 'connected' })
    entries.push({
      kind: 'mcp_server',
      name,
      source: 'mcp',
      hash: await hashEntry('mcp_server', name, 'mcp', String(count)),
    })
  }

  for (const r of Array.isArray(rows) ? rows : []) {
    const p = r?.provider?.plugin
    if (typeof p === 'string' && p !== 'engine' && p.length <= 64) pluginNames.add(p)
  }
  const plugins: InventoryOut['plugins'] = []
  for (const name of [...pluginNames].slice(0, 200)) {
    if (name.length > 80) continue
    plugins.push({ name, enabled: true })
    entries.push({ kind: 'plugin', name, source: 'plugin', hash: await hashEntry('plugin', name, 'plugin', '') })
  }

  const facts = configFacts(rows)
  const models = facts.modelOptions
    .filter((m) => MODEL_VALUE.test(m))
    .slice(0, 20)
    .map((value) => ({ value, label: value.slice(0, 60) }))
  const efforts = facts.effortOptions.filter((e) => e.length > 0 && e.length <= 16).slice(0, 8)

  const digest = await sha256Hex(
    JSON.stringify([entries.map((e) => e.hash).sort(), models.map((m) => m.value), efforts]),
  )
  return {
    inventory: { commands, models, efforts, mcp_servers, plugins, at: new Date(await $.clock.now()).toISOString() },
    entries,
    digest,
  }
}
