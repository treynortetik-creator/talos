// The app catalog (M5.1): what the owner approved, per server and resource. Written by `talos-app apps scan` (and the
// live bridge for revocations), read by the hook processes and the live bridge. Atomic writes, 0600.
import { readFileSync } from 'node:fs'
import { AppCsp, CatalogTool, type CatalogToolT, IsoTs } from '@talos-app/protocol'
import { z } from 'zod'
import { writeJsonAtomic } from '../fsutil.ts'
import type { AppPaths } from './paths.ts'

export const CatalogResource = z.object({
  uri: z.string().startsWith('ui://').max(2000),
  html_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z
    .number()
    .int()
    .max(8 * 1024 * 1024),
  csp: AppCsp,
  permissions_requested: z.array(z.string().max(40)).max(8),
  prefers_border: z.boolean().optional(),
  approval_key: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(['approved', 'declined', 'refused', 'needs_reapproval']),
  reapproval_diff: z.string().max(2000).optional(),
  reason: z.string().max(200).optional(),
  owner: z.object({
    label: z.string().min(1).max(60),
    show: z.enum(['auto', 'ask']),
    direct: z.boolean(),
  }),
  decided_at: IsoTs,
})
export type CatalogResourceT = z.infer<typeof CatalogResource>

export const CatalogDirect = z.object({
  type: z.enum(['stdio', 'http', 'sse', 'unsupported']),
  config_fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  auth: z.enum(['none', 'static', 'oauth']),
})

export const CatalogServer = z.object({
  server: z.string().max(120),
  source: z.string().max(40),
  tool_prefix: z.string().max(200),
  direct: CatalogDirect.optional(),
  // Tools whose labels Claude Code's view and the server's own list disagree on: they ask every time (M5.1 "asks you each
  // time"). Not part of the approval key; a rescan recomputes it. A spec extension: the spec names the rule, not the field.
  ask_each_time: z.array(z.string().max(128)).max(200).optional(),
  tools: z.array(CatalogTool).max(200),
  resources: z.array(CatalogResource).max(50),
})
export type CatalogServerT = z.infer<typeof CatalogServer>

export const AppCatalog = z.object({
  rev: z.number().int(),
  scanned_at: IsoTs,
  claude_code_version: z.string().max(40),
  strict: z.boolean(),
  servers: z.array(CatalogServer).max(50),
})
export type AppCatalogT = z.infer<typeof AppCatalog>

export type CatalogRead =
  | { ok: true; catalog: AppCatalogT | undefined } // undefined: no catalog file yet
  | { ok: false; reason: string }

/** A missing file is "nothing catalogued"; anything else that cannot be read or parsed is a failure the caller must treat as such. */
export function readCatalog(p: AppPaths): CatalogRead {
  let text: string
  try {
    text = readFileSync(p.catalog, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, catalog: undefined }
    return { ok: false, reason: 'catalog unreadable' }
  }
  try {
    const parsed = AppCatalog.safeParse(JSON.parse(text))
    return parsed.success ? { ok: true, catalog: parsed.data } : { ok: false, reason: 'catalog does not parse' }
  } catch {
    return { ok: false, reason: 'catalog is not JSON' }
  }
}

export function writeCatalog(p: AppPaths, c: AppCatalogT): void {
  writeJsonAtomic(p.catalog, AppCatalog.parse(c), 0o600)
}

// ---- annotations ---------------------------------------------------------------------------------------------------

export type RunLabels = { read_only: boolean; destructive: boolean; open_world: boolean }

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

/**
 * One function for both annotation shapes, so labels are always compared in one shape. Input: the SDK's
 * `{readOnly, destructive, openWorld}` (P10) or MCP's `{readOnlyHint, destructiveHint, openWorldHint}`. Anything that is
 * not an explicit boolean reads as unknown, and unknown fails safe (not read-only, destructive, open world).
 */
export function normaliseAnnotations(input: unknown): RunLabels {
  const a = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const ro = bool(a.readOnly) ?? bool(a.readOnlyHint)
  const d = bool(a.destructive) ?? bool(a.destructiveHint)
  const ow = bool(a.openWorld) ?? bool(a.openWorldHint)
  const read_only = ro === true
  const destructive = d === true ? true : read_only ? false : d !== false
  return { read_only, destructive, open_world: ow !== false }
}

/** The run rule the owner's approval grants (M4.3 step 8): no card iff read-only and not destructive. */
export const runsWithoutTap = (t: Pick<CatalogToolT, 'read_only' | 'destructive'>): boolean =>
  t.read_only === true && t.destructive !== true

/** The run rule for one tool of a catalogued server: no card iff read-only, not destructive, and not forced to ask. */
export const toolRunsWithoutTap = (s: Pick<CatalogServerT, 'ask_each_time'>, t: CatalogToolT): boolean =>
  runsWithoutTap(t) && !(s.ask_each_time ?? []).includes(t.name)

export const sameLabels = (a: CatalogToolT, b: CatalogToolT): boolean =>
  a.name === b.name &&
  a.read_only === b.read_only &&
  a.destructive === b.destructive &&
  a.open_world === b.open_world &&
  [...a.visibility].sort().join() === [...b.visibility].sort().join()

// ---- names ----------------------------------------------------------------------------------------------------------

/** Claude Code's tool-name prefix for a server (`plugin:p:s` becomes `mcp__plugin_p_s__`). */
export const toolPrefixFor = (serverName: string): string => `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__`

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const matcherFor = (prefix: string): string => `^${escapeRegex(prefix)}.*`

export function findServer(c: AppCatalogT, name: string, source: string): CatalogServerT | undefined {
  return c.servers.find((s) => s.server === name && s.source === source)
}

/**
 * The tool of `server` a Claude Code tool name refers to: exactly `prefix + name`. Anything else, including a name outside
 * the server's prefix, matches nothing.
 */
export function matchTool(server: CatalogServerT, toolName: string): CatalogToolT | undefined {
  if (!toolName.startsWith(server.tool_prefix)) return undefined
  // exact only: a suffix match gave an uncatalogued `<prefix>wipe__read_note` the authorisation for `read_note` (S8)
  return server.tools.find((t) => toolName === server.tool_prefix + t.name)
}

export function resourceFor(server: CatalogServerT, uri: string): CatalogResourceT | undefined {
  return server.resources.find((r) => r.uri === uri)
}

/** The approved resource a tool shows, if any. */
export function approvedResourceOf(server: CatalogServerT, tool: CatalogToolT): CatalogResourceT | undefined {
  if (!tool.resource_uri) return undefined
  const r = resourceFor(server, tool.resource_uri)
  return r?.state === 'approved' ? r : undefined
}
