// What an installed plugin carries, read the way Claude Code reads it (checked against a real 2.1.332 by Delphi), from the folder Claude Code loads it from and, where
// it is on this computer, its marketplace entry. Only plain event names are ever shown as text; nothing else from a plugin's files is.
//
// Where Claude Code loads a plugin FROM: the cache copy under `plugins/cache` (its `installPath`), except for a LOCAL-FOLDER marketplace (`known_marketplaces.json`
// `source.source` is `directory`): there it loads from the SOURCE folder, so hooks and servers are read from the source path, and a hook added later shows up.
//
// Hooks (`hooks/hooks.json` must be the wrapper `{hooks:{Event:[…]}}`: a bare event table makes the plugin FAIL to load, `malformed`; `hooks` in `.claude-plugin/plugin.json`:
// an object (the event table itself), an array of objects and paths, or a path; and `hooks` in the marketplace entry, which loads even without `strict: false`).
// Servers: `.mcp.json` (wrapped `{mcpServers:{…}}` or bare table), `mcpServers` in plugin.json as an object, a PATH or an ARRAY (of paths and tables), and
// `mcpServers` in the marketplace entry ONLY with `strict: false`.
//
// Fail closed, both ways (a warning is never a refusal, but an unknown is never a "no"): a hooks file that is there and cannot be read (not JSON, over the size cap, a link
// out of the plugin folder) is `unreadable`, and an unreadable plugin MAY APPROVE tool calls; a plugin with a server file that cannot be read counts as having servers.
// A link inside the plugin folder is followed (`realFileSync`); one that leaves it is not.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { realFileSync } from '../real-file.ts'

/** The events whose hooks can answer "allow" to a tool call, so the phone is never asked. */
export const APPROVAL_EVENTS = ['PermissionRequest', 'PreToolUse'] as const

/** `unreadable`: the plugin's hooks could not be read, which is treated as "may approve" (never as "cannot"). A malformed hooks file means it will not load: no events, no approval. */
export const approvesToolCalls = (events: readonly string[], unreadable = false): boolean =>
  unreadable || events.some((e) => (APPROVAL_EVENTS as readonly string[]).includes(e))

const READ_MAX = 1_000_000
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/

type Json = Record<string, unknown>
/** The most characters of one command the card shows. */
const COMMAND_MAX = 400

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

/** `path` as a real file inside `root` (links followed, none may leave it), or null. */
function inside(root: string, path: string): string | null {
  try {
    const real = realFileSync(path)
    const r = relative(realFileSync(root), real)
    return r === '' || r.startsWith('..') || isAbsolute(r) ? null : real
  } catch {
    return null
  }
}

/** A JSON file's object, or undefined when it is not there, or null when it is there and cannot be read as one (over the cap, a link out, not JSON). */
function readObject(root: string, path: string): Json | undefined | null {
  try {
    lstatSync(path)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null
  }
  const real = inside(root, path)
  if (real === null) return null
  let fd: number
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > READ_MAX) return null
    const v = JSON.parse(readFileSync(fd, 'utf8')) as unknown
    return isObject(v) ? v : null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** The event names of a table `{Event: [entries]}`: the events with at least one entry. */
function tableEvents(t: Json): string[] {
  return Object.entries(t)
    .filter(([name, list]) => EVENT_NAME.test(name) && Array.isArray(list) && list.length > 0)
    .map(([name]) => name)
}

type HooksRead = { events: string[]; unreadable: boolean; malformed: boolean }

/** An event name whose value is not a list of entries: not a table Claude Code understands, so not known to be harmless. */
const oddTable = (t: Json): boolean =>
  Object.entries(t).some(([name, list]) => EVENT_NAME.test(name) && !Array.isArray(list))

/**
 * A hooks FILE must be the wrapper `{hooks:{…}}`; a bare event table at its top is a file Claude Code fails to load, and so is a `hooks` that is
 * not a table, or a table whose event is not a list. Those are malformed (the card still warns: fail closed).
 */
function fileEvents(f: Json): { events: string[]; malformed: boolean } {
  if (isObject(f.hooks)) return { events: tableEvents(f.hooks), malformed: oddTable(f.hooks) }
  return { events: [], malformed: Object.hasOwn(f, 'hooks') || tableEvents(f).length > 0 }
}

/** The hooks a manifest or a marketplace entry names: an object (the event table), an array of objects and paths, or a path (relative, inside the plugin). */
function hooksFrom(root: string, h: unknown, into: HooksRead, found: Set<string>): void {
  if (h === undefined) return
  const file = (p: string) => {
    const full = resolve(root, p)
    const f = inside(root, full) === null ? null : readObject(root, full)
    if (f === null) into.unreadable = true
    else if (f) {
      const r = fileEvents(f)
      for (const e of r.events) found.add(e)
      if (r.malformed) into.malformed = true
    }
  }
  for (const it of Array.isArray(h) ? h : [h]) {
    if (isObject(it)) {
      for (const e of tableEvents(it)) found.add(e)
      if (oddTable(it)) into.malformed = true
    } else if (typeof it === 'string') file(it)
    else into.unreadable = true // something else: not understood, so not known to be harmless
  }
}

export function pluginHookEvents(root: string, entry?: Json | null): HooksRead {
  const found = new Set<string>()
  const r: HooksRead = { events: [], unreadable: false, malformed: false }
  const f = readObject(root, join(root, 'hooks', 'hooks.json'))
  if (f === null) r.unreadable = true
  else if (f) {
    const x = fileEvents(f)
    for (const e of x.events) found.add(e)
    if (x.malformed) r.malformed = true
  }
  const manifest = readObject(root, join(root, '.claude-plugin', 'plugin.json'))
  if (manifest === null) r.unreadable = true
  else if (manifest) hooksFrom(root, manifest.hooks, r, found)
  if (entry) hooksFrom(root, entry.hooks, r, found) // a marketplace entry's hooks load with or without strict: false
  r.events = [...found].sort()
  return r
}

/** The servers of a parsed file or inline table: wrapped `{mcpServers:{…}}`, or the bare table (name to definition). */
function addServers(into: Map<string, Json>, v: Json): void {
  const t = isObject(v.mcpServers) ? v.mcpServers : v
  for (const [k, d] of Object.entries(t)) if (isObject(d) && d.type !== 'sdk') into.set(k, d)
}

/** Servers named by an `mcpServers` value: an object (the table), a path, or an array of paths and tables. `unreadable` when a path cannot be read. */
function serversFrom(root: string, v: unknown, into: Map<string, Json>): boolean {
  let unreadable = false
  for (const it of Array.isArray(v) ? v : [v]) {
    if (isObject(it)) addServers(into, it)
    else if (typeof it === 'string') {
      const full = resolve(root, it)
      const f = inside(root, full) === null ? null : readObject(root, full)
      if (f === null) unreadable = true
      else if (f) addServers(into, f)
    }
  }
  return unreadable
}

/** The MCP servers Claude Code starts for a plugin, by name (exactly the forms above); `unreadable`: a server file is there and cannot be read. */
export function pluginServerDefs(
  root: string,
  entry?: Json | null,
): { servers: Map<string, Json>; unreadable: boolean } {
  const servers = new Map<string, Json>()
  let unreadable = false
  const mcp = readObject(root, join(root, '.mcp.json'))
  if (mcp === null) unreadable = true
  else if (mcp) addServers(servers, mcp)
  const manifest = readObject(root, join(root, '.claude-plugin', 'plugin.json'))
  if (manifest === null) unreadable = true
  else if (manifest && manifest.mcpServers !== undefined)
    unreadable = serversFrom(root, manifest.mcpServers, servers) || unreadable
  if (entry && entry.strict === false && entry.mcpServers !== undefined)
    unreadable = serversFrom(root, entry.mcpServers, servers) || unreadable
  return { servers, unreadable }
}

/** Does Claude Code start any MCP server for this plugin? Unknown (a server file that cannot be read) counts as yes: a list is about servers, so it fails closed. */
export function pluginDeclaresServers(root: string, entry?: Json | null): boolean {
  const d = pluginServerDefs(root, entry)
  return d.servers.size > 0 || d.unreadable
}

/**
 * What a plugin runs WHEN IT INSTALLS (the CLI asks for confirmation then; checked on 2.1.332): the command of a marketplace entry whose source is
 * `{ source: 'command', command }`, and each server `headersHelper`. A stdio server's own `command` is NOT one (it runs when the plugin is used, and such plugins install with no
 * flag). Cleaned to one visible line each, at most 3, each shown whole up to 400 characters and cut at its END with an ellipsis beyond that.
 */
export function pluginCommands(servers: Map<string, Json>, entry?: unknown): string[] {
  const out: string[] = []
  const hidden = (c: number) =>
    c <= 0x1f ||
    (c >= 0x7f && c <= 0x9f) ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x2064) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xfeff
  const clean = (s: string) =>
    [...s]
      .map((ch) => (hidden(ch.codePointAt(0) ?? 0) ? ' ' : ch))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
  const source = isObject(entry) ? entry.source : undefined
  if (isObject(source) && source.source === 'command') {
    const c = source.command
    const words = Array.isArray(c)
      ? c.filter((a): a is string => typeof a === 'string')
      : typeof c === 'string'
        ? [c]
        : []
    if (words.join(' ').trim() !== '') out.push(clean(words.join(' ')))
  }
  for (const d of servers.values()) {
    const v = d.headersHelper
    if (typeof v === 'string' && v.trim() !== '') out.push(clean(v))
  }
  // shown whole up to COMMAND_MAX characters, then cut at the end with an ellipsis (never in the middle of a path)
  return [...new Set(out)].slice(0, 3).map((c) => (c.length > COMMAND_MAX ? `${c.slice(0, COMMAND_MAX - 1)}\u2026` : c))
}

export type MarketplaceInfo = {
  /** The marketplace is in known_marketplaces.json (it has been added). */
  known: boolean
  /** A local-folder marketplace: Claude Code loads its plugins from the SOURCE folder. */
  local: boolean
  /** The plugin's folder inside the marketplace when its source is a local `./` path; else null. */
  root: string | null
  /** The plugin's marketplace entry, or null. */
  entry: Json | null
}

/** The plugin's entry in a marketplace that is on this computer (read only). `memo`: parsed files by path, kept by the caller for one plan. */
export function marketplaceInfo(
  claudeDir: string,
  marketplace: string,
  plugin: string,
  memo?: Map<string, unknown>,
): MarketplaceInfo {
  const none: MarketplaceInfo = { known: false, local: false, root: null, entry: null }
  const read = (path: string): unknown => {
    if (memo?.has(path)) return memo.get(path)
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    memo?.set(path, v)
    return v
  }
  let known = false
  let local = false
  let loc: string | undefined
  try {
    const all = read(join(claudeDir, 'plugins', 'known_marketplaces.json')) as Record<
      string,
      { installLocation?: unknown; source?: { source?: unknown } }
    >
    const k = Object.hasOwn(all, marketplace) ? all[marketplace] : undefined
    if (k && typeof k === 'object') {
      known = true
      local = k.source?.source === 'directory'
      if (typeof k.installLocation === 'string' && k.installLocation.startsWith('/')) loc = k.installLocation
    }
  } catch {}
  if (!known) return none
  try {
    loc ??= join(claudeDir, 'plugins', 'marketplaces', marketplace)
    const m = read(join(loc, '.claude-plugin', 'marketplace.json')) as { plugins?: unknown }
    const entry = (Array.isArray(m.plugins) ? m.plugins : []).find((p) => isObject(p) && p.name === plugin)
    if (!isObject(entry)) return { known, local, root: null, entry: null }
    let root: string | null = null
    if (typeof entry.source === 'string' && entry.source.startsWith('./')) {
      const r = resolve(loc, entry.source)
      const rel = relative(loc, r)
      root = rel === '' || rel.startsWith('..') ? (rel === '' ? loc : null) : r
    }
    return { known, local, root, entry }
  } catch {
    return { known, local, root: null, entry: null }
  }
}

/** Compatibility for callers that only want the entry and folder. */
export const marketplaceEntryOf = (
  claudeDir: string,
  marketplace: string,
  plugin: string,
  memo?: Map<string, unknown>,
): { root: string | null; entry: Json | null } => {
  const m = marketplaceInfo(claudeDir, marketplace, plugin, memo)
  return { root: m.root, entry: m.entry }
}

/**
 * The folder Claude Code loads an INSTALLED plugin from, and its marketplace entry: the cache copy (`installRoot`), except for a local-folder marketplace, where
 * it is the source folder. Hooks and servers are read from here, for the card and the Settings flag.
 */
export function pluginSource(
  claudeDir: string,
  key: string,
  name: string,
  installRoot: string,
  memo?: Map<string, unknown>,
): { root: string; entry: Json | null } {
  const m = marketplaceInfo(claudeDir, key.split('@')[1] ?? '', name, memo)
  return { root: m.local && m.root && existsSync(m.root) ? m.root : installRoot, entry: m.entry }
}
