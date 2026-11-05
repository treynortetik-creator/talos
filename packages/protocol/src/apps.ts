// MCP Apps (connector apps as live widgets in Talos), protocol pieces that need no other model: the CSP an owner
// approves, the MCP tool result shape, the pending-request record the hook processes share, the approval key.
// `AppView` (which embeds an AttachmentRef) lives in models.ts so models.ts and this file never import each other.
// Everything here is inert until a bridge mints an app message: nothing parses these shapes on an existing path.
import { z } from 'zod'
import { jcs, sha256Hex } from './canonical.ts'
import { b64urlDecode, b64urlEncode, fromUtf8, utf8 } from './encoding.ts'
import { AppRequestId, CardId, IsoTs, ViewId } from './ids.ts'

// ---- sizes -------------------------------------------------------------------------------------------------------

export const APP_TOOL_INPUT_MAX = 16 * 1024 // JCS bytes
export const APP_TOOL_RESULT_MAX = 128 * 1024 // JCS bytes, inline; bigger goes to JSON media
export const APP_TOOL_RESULT_MEDIA_MAX = 8 * 1024 * 1024
export const APP_MESSAGE_TEXT_MAX = 4_000

// ---- time -----------------------------------------------------------------------------------------------------------

export const APP_CARD_EXPIRY_MS = 10 * 60_000
export const APP_BRIDGE_GRACE_MS = 120_000
export const APP_CLOCK_SKEW_MS = 60_000
/** A view's `tools/call` waits no longer than this: card expiry + bridge grace + skew (13 minutes). */
export const APP_CLIENT_CEILING_MS = APP_CARD_EXPIRY_MS + APP_BRIDGE_GRACE_MS + APP_CLOCK_SKEW_MS
/** A signed `app.request` older than this is refused. */
export const APP_REQUEST_MAX_AGE_MS = 120_000

/**
 * Is a signed `app.request` timestamp usable at `nowMs`? Older than 2 minutes is stale. A timestamp more than the
 * skew allowance in the future is refused too (a clock that jumped forward must not mint a long-lived request). An
 * unreadable timestamp is not fresh.
 */
export function isAppRequestFresh(ts: string, nowMs: number): boolean {
  const t = Date.parse(ts)
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return false
  const age = nowMs - t
  return age <= APP_REQUEST_MAX_AGE_MS && age >= -APP_CLOCK_SKEW_MS
}

const enc = new TextEncoder()

/** JCS byte length, or `undefined` when the value is not plain JSON (cycle, bigint, function...). Never throws. */
export function jcsBytes(value: unknown): number | undefined {
  try {
    return enc.encode(jcs(value)).length
  } catch {
    return undefined
  }
}

/** A refinement: plain JSON whose JCS form is at most `max` bytes. Unmeasurable input fails (never passes). */
export function jcsAtMost(max: number) {
  return (value: unknown) => {
    const n = jcsBytes(value)
    return n !== undefined && n <= max
  }
}

// ---- CSP entries ---------------------------------------------------------------------------------------------------

const HOST = /[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+/

/**
 * The WHATWG URL parser decides what a host is, not a regex: `10.0.0.0x1`, `0x7f.1`, `127.1` and `2130706433` all
 * parse as IPv4 and come back as a dotted quad. A host passes only if the parser hands back exactly the lower-case
 * name that was written, that name is not an IPv4 address, and its last label holds a letter.
 */
function hostLooksLikeName(host: string): boolean {
  let parsed: string
  try {
    parsed = new URL(`https://${host}/`).hostname
  } catch {
    return false
  }
  if (parsed !== host) return false
  if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed)) return false
  const last = host.split('.').pop() ?? ''
  return /[a-z]/.test(last)
}
function portOk(port: string | undefined): boolean {
  if (port === undefined) return true
  const n = Number(port)
  return n >= 1 && n <= 65535
}

/**
 * `https://host`, `wss://host`, `https://*.host`, with an optional port. Lower case only (the scan lower-cases first).
 * No path, quote, space, `;`, `,`, bare `*`, `http:`, `data:`, `blob:`, `'self'`, `'unsafe-*'` or IP literal. A wildcard
 * needs two labels after it, so `*.com` fails.
 */
export const CspSource = z
  .string()
  .max(253)
  .regex(new RegExp(`^(https|wss)://(\\*\\.)?${HOST.source}(:\\d{1,5})?$`))
  .refine((s) => {
    const m = /^[a-z]+:\/\/(?:\*\.)?([^:]+)(?::(\d+))?$/.exec(s)
    return m !== null && hostLooksLikeName(m[1] as string) && portOk(m[2])
  })

/**
 * An exact file URL, no query, no fragment. CSP treats a path ending in `/` as a prefix, so a directory is refused, and
 * so is anything the WHATWG parser would rewrite (`//`, dot segments in any spelling including `%2e%2e`, an explicit
 * default port): the string must equal what the browser will use.
 */
export const PinnedUrl = z
  .string()
  .max(2000)
  .regex(new RegExp(`^https://${HOST.source}(:\\d{1,5})?/[A-Za-z0-9._~%/@+-]+$`))
  .refine((u) => {
    let url: URL
    try {
      url = new URL(u)
    } catch {
      return false
    }
    if (url.href !== u || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '')
      return false
    if (!hostLooksLikeName(url.hostname) || !portOk(url.port || undefined)) return false
    const segs = url.pathname.split('/').slice(1)
    if (segs.some((seg) => seg === '')) return false // a directory (trailing /) or an empty segment (//)
    return !segs.some((seg) => {
      let d: string
      try {
        d = decodeURIComponent(seg)
      } catch {
        return true
      }
      return d === '.' || d === '..' || d.includes('/') || d.includes('\\')
    })
  })

/** `sha256-` + 44 base64 chars, `sha384-` + 64, `sha512-` + 88: the exact lengths, so a short value cannot ride along. */
export const ScriptHash = z
  .string()
  .regex(/^(sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{86}==)$/)

export const AppCsp = z
  .object({
    connect_domains: z.array(CspSource).max(16),
    resource_domains: z.array(CspSource).max(16), // img/font/media only (scripts never by domain)
    frame_domains: z.array(CspSource).max(16),
    base_uri_domains: z.array(CspSource).max(16),
    script_hashes: z.array(ScriptHash).max(64), // one per inline <script> in the pinned HTML
    script_urls: z.array(PinnedUrl).max(16), // SRI-tagged remote <script src> / <link rel=modulepreload>
    style_urls: z.array(PinnedUrl).max(16), // SRI-tagged remote <link rel=stylesheet>
  })
  .strict()
export type AppCspT = z.infer<typeof AppCsp>

function entryHost(entry: string): { host: string; wildcard: boolean } | undefined {
  const m = /^[a-z]+:\/\/(\*\.)?([^/:]+)/.exec(entry)
  return m ? { host: m[2] as string, wildcard: m[1] !== undefined } : undefined
}

/**
 * The relay-host rule shared by the bridge scan and the relay: no entry's host equals the relay's own host, and no
 * wildcard covers it. `publicOrigin` is the relay's PUBLIC_ORIGIN (or just its host). Returns the first offending
 * entry or `undefined`. A relay host that cannot be read is an error, never "no problem".
 */
export function cspRelayHostProblem(csp: AppCspT, publicOrigin: string): string | undefined {
  let relay: string
  try {
    relay = new URL(publicOrigin.includes('://') ? publicOrigin : `https://${publicOrigin}`).hostname.toLowerCase()
  } catch {
    throw new Error('cspRelayHostProblem: unreadable relay origin')
  }
  if (!relay) throw new Error('cspRelayHostProblem: empty relay host')
  const all = [
    ...csp.connect_domains,
    ...csp.resource_domains,
    ...csp.frame_domains,
    ...csp.base_uri_domains,
    ...csp.script_urls,
    ...csp.style_urls,
  ]
  for (const entry of all) {
    const h = entryHost(entry)
    if (!h) continue
    if (h.host === relay) return entry
    if (h.wildcard && relay.endsWith(`.${h.host}`)) return entry
  }
  return undefined
}

/** `AppCsp` plus the relay-host rule, for the relay's PUT /bridge/media check. Build it once per process. */
export function appCspFor(publicOrigin: string) {
  return AppCsp.superRefine((csp, ctx) => {
    const bad = cspRelayHostProblem(csp, publicOrigin)
    if (bad !== undefined) ctx.addIssue({ code: 'custom', message: `relay host not allowed: ${bad}` })
  })
}

// ---- header builders ------------------------------------------------------------------------------------------------

const q = (s: string) => `'${s}'`

/**
 * The CSP for `GET /media/:id/app` (without the leading `sandbox allow-scripts;`). No `'unsafe-inline'` or `'self'` in
 * script-src, no eval, no workers, no forms. It re-validates its input, so a hand-built object with `;` in a domain
 * cannot reach a header.
 */
export function buildAppCsp(input: AppCspT): string {
  const csp = AppCsp.parse(input)
  const scripts = [...csp.script_hashes.map(q), ...csp.script_urls]
  const list = (xs: readonly string[], fallback: string) => (xs.length ? xs : [fallback])
  const directives: string[][] = [
    ['default-src', q('none')],
    ['script-src', ...list(scripts, q('none'))],
    ['style-src', q('unsafe-inline'), ...csp.style_urls],
    ['img-src', 'data:', 'blob:', ...csp.resource_domains],
    ['font-src', 'data:', ...csp.resource_domains],
    ['media-src', 'data:', 'blob:', ...csp.resource_domains],
    ['connect-src', ...list(csp.connect_domains, q('none'))],
    ['frame-src', ...list(csp.frame_domains, q('none'))],
    ['base-uri', ...list(csp.base_uri_domains, q('none'))],
    ['worker-src', q('none')],
    ['form-action', q('none')],
    ['object-src', q('none')],
  ]
  return directives.map((d) => d.join(' ')).join('; ')
}

/** The spec's (camelCase) `_meta.ui.csp`: domain lists only. */
export type SpecCsp = {
  connectDomains: string[]
  resourceDomains: string[]
  frameDomains: string[]
  baseUriDomains: string[]
}
export function toSpecCsp(csp: AppCspT): SpecCsp {
  return {
    connectDomains: [...csp.connect_domains],
    resourceDomains: [...csp.resource_domains],
    frameDomains: [...csp.frame_domains],
    baseUriDomains: [...csp.base_uri_domains],
  }
}

export type CspProblem = { field: string; value: unknown; reason: string }
const SPEC_FIELDS = [
  ['connectDomains', 'connect_domains'],
  ['resourceDomains', 'resource_domains'],
  ['frameDomains', 'frame_domains'],
  ['baseUriDomains', 'base_uri_domains'],
] as const

/**
 * Read a server's `_meta.ui.csp`. Entries are lower-cased, then checked; an entry that fails, a non-array field or an
 * unknown field is reported, never silently dropped and never carried into `csp`. Hashes and pinned URLs come from the
 * static HTML check, so they start empty. Anything that is not an object reads as "declared nothing", reported.
 */
export function fromSpecCsp(meta: unknown): { csp: AppCspT; problems: CspProblem[] } {
  const csp: AppCspT = {
    connect_domains: [],
    resource_domains: [],
    frame_domains: [],
    base_uri_domains: [],
    script_hashes: [],
    script_urls: [],
    style_urls: [],
  }
  const problems: CspProblem[] = []
  if (meta === undefined || meta === null) return { csp, problems }
  if (typeof meta !== 'object' || Array.isArray(meta)) {
    return { csp, problems: [{ field: '(root)', value: meta, reason: 'csp must be an object' }] }
  }
  const known = new Set<string>(SPEC_FIELDS.map(([camel]) => camel))
  for (const key of Object.keys(meta)) {
    if (!known.has(key))
      problems.push({ field: key, value: (meta as Record<string, unknown>)[key], reason: 'unknown field' })
  }
  for (const [camel, snake] of SPEC_FIELDS) {
    const raw = (meta as Record<string, unknown>)[camel]
    if (raw === undefined) continue
    if (!Array.isArray(raw)) {
      problems.push({ field: camel, value: raw, reason: 'must be an array' })
      continue
    }
    for (const item of raw) {
      const lowered = typeof item === 'string' ? item.toLowerCase() : item
      const r = CspSource.safeParse(lowered)
      if (!r.success) problems.push({ field: camel, value: item, reason: 'not an allowed source' })
      else if (csp[snake].length >= 16) problems.push({ field: camel, value: item, reason: 'more than 16 entries' })
      else csp[snake].push(r.data)
    }
  }
  return { csp, problems }
}

// ---- tool results and pending requests ----------------------------------------------------------------------------

/** MCP `_meta` keys that belong to Anthropic's host, not to the app. They never reach a view. */
export function stripHostMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (k.startsWith('com.anthropic/') || k.startsWith('claudecode/')) continue
    out[k] = v
  }
  return out
}

/** `stripHostMeta` on every `_meta` object at any depth inside a content block (embedded resources nest one). */
export function stripHostMetaDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripHostMetaDeep)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] =
      k === '_meta' && v !== null && typeof v === 'object' && !Array.isArray(v)
        ? stripHostMeta(stripHostMetaDeep(v) as Record<string, unknown>)
        : stripHostMetaDeep(v)
  }
  return out
}

/**
 * An MCP CallToolResult as the bridge rebuilds it. Not strict: a newer field is ignored, not fatal. Size is checked by
 * the carrier (`AppView.tool_result`, `app.response.result`).
 */
export const McpCallToolResult = z.object({
  content: z
    .array(z.record(z.string(), z.unknown()))
    .max(100)
    .transform((blocks) => blocks.map((b) => stripHostMetaDeep(b) as Record<string, unknown>)),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
  _meta: z.record(z.string(), z.unknown()).transform(stripHostMeta).optional(),
})
export type McpCallToolResultT = z.infer<typeof McpCallToolResult>

/** Shared between the live bridge and the hook processes (files under `$TALOS_APP_HOME/apps/pending`). */
export const AppPendingRequest = z
  .object({
    request_id: AppRequestId,
    view_id: ViewId,
    server: z.string().max(120),
    server_source: z.string().max(40),
    tool: z.string().max(128),
    arguments: z.record(z.string(), z.unknown()),
    state: z.enum(['authorised', 'awaiting_card', 'expired']), // 'expired' = 10-minute tombstone
    card_id: CardId.optional(),
    created_at: IsoTs,
    expires_at: IsoTs,
  })
  .strict()
export type AppPendingRequestT = z.infer<typeof AppPendingRequest>

// ---- approval key ---------------------------------------------------------------------------------------------------

/** One tool of a server as the catalog stores it (every tool, app-only included). */
export const CatalogTool = z.object({
  name: z.string().max(128),
  resource_uri: z.string().startsWith('ui://').max(2000).optional(),
  visibility: z.array(z.enum(['model', 'app'])).min(1),
  read_only: z.boolean(),
  destructive: z.boolean(),
  open_world: z.boolean(),
})
export type CatalogToolT = z.infer<typeof CatalogTool>

export const ApprovalDirect = z.object({
  type: z.enum(['stdio', 'http', 'sse', 'unsupported']),
  config_fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  auth: z.enum(['none', 'static', 'oauth']),
})

/** Everything the owner's yes covers. `owner` choices (label, show, direct) are deliberately not here. */
export const ApprovalManifest = z.object({
  server: z.string().max(120),
  source: z.string().max(40),
  resource_uri: z.string().startsWith('ui://').max(2000),
  html_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  csp: AppCsp,
  permissions_requested: z.array(z.string().max(40)).max(8),
  prefers_border: z.boolean().optional(),
  tools: z.array(CatalogTool).max(200),
  direct: ApprovalDirect.optional(),
})
export type ApprovalManifestT = z.infer<typeof ApprovalManifest>

/**
 * sha256 (hex) over the JCS form of the manifest, tools sorted by name. Fields outside the manifest (an `owner` object,
 * a label) are stripped by the parse, so they cannot move the key. Two tools with one name are refused: which one the
 * owner approved would be ambiguous. Throws on a manifest that does not parse.
 */
export function approvalKey(manifest: unknown): string {
  const m = ApprovalManifest.parse(manifest)
  const names = new Set<string>()
  for (const t of m.tools) {
    if (names.has(t.name)) throw new Error(`approvalKey: duplicate tool name ${t.name}`)
    names.add(t.name)
  }
  const tools = [...m.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({
      name: t.name,
      resource_uri: t.resource_uri,
      visibility: t.visibility,
      read_only: t.read_only,
      destructive: t.destructive,
      open_world: t.open_world,
    }))
  const body: Record<string, unknown> = {
    server: m.server,
    source: m.source,
    resource_uri: m.resource_uri,
    html_sha256: m.html_sha256,
    csp: m.csp,
    permissions_requested: m.permissions_requested,
    tools,
  }
  if (m.prefers_border !== undefined) body.prefers_border = m.prefers_border
  if (m.direct !== undefined) body.direct = m.direct
  return sha256Hex(jcs(body))
}

// ---- the upload header ----------------------------------------------------------------------------------------------

/** `PUT /bridge/media/:id` carries the approved CSP here: base64url(JCS(AppCsp)). */
export const APP_CSP_HEADER = 'X-Talos-App-Csp'
/**
 * Encoded length cap. Servers commonly limit one header to 8 KiB and the whole header block to 16 KiB; a larger CSP is
 * refused at the scan rather than truncated by a proxy into a different policy.
 */
export const APP_CSP_HEADER_MAX = 8_000

export function encodeAppCspHeader(csp: AppCspT): string {
  const value = b64urlEncode(utf8(jcs(AppCsp.parse(csp))))
  if (value.length > APP_CSP_HEADER_MAX) throw new Error('encodeAppCspHeader: csp too large for one header')
  return value
}

export type AppCspHeaderResult = { ok: true; csp: AppCspT } | { ok: false; reason: string }

/** Strict parse of the header (bad base64, bad JSON, any unknown key or bad entry, a relay-host entry): never throws. */
export function decodeAppCspHeader(value: unknown, publicOrigin: string): AppCspHeaderResult {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, reason: 'missing' }
  if (value.length > APP_CSP_HEADER_MAX) return { ok: false, reason: 'too large' }
  let json: unknown
  try {
    json = JSON.parse(fromUtf8(b64urlDecode(value)))
  } catch {
    return { ok: false, reason: 'not base64url JSON' }
  }
  const r = AppCsp.safeParse(json)
  if (!r.success) return { ok: false, reason: 'invalid csp' }
  const bad = cspRelayHostProblem(r.data, publicOrigin)
  if (bad !== undefined) return { ok: false, reason: 'relay host not allowed' }
  return { ok: true, csp: r.data }
}
