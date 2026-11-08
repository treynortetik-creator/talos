// `talos-app apps scan` (M5.1): discovery through the Agent SDK with NO model turn (control requests only), the static
// HTML check, the owner's approval, then the catalog, the hooks and the Keychain copies. Every SDK call is behind
// `McpStatusSource`, so tests inject answers. Server configs (http headers in plaintext, G8) are moved out of every status
// object the moment they arrive; nothing downstream ever sees them (M4.8).
import { appendFileSync, existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  AppCsp,
  type AppCspT,
  type ApprovalManifestT,
  type CatalogToolT,
  cspRelayHostProblem,
  fromSpecCsp,
  sha256Hex,
} from '@talos-app/protocol'
import { writeFileAtomic } from '../fsutil.ts'
import { defaultShow, diffManifests, directLines, keyOf, labelProblem, manifestOf, renderApproval } from './approval.ts'
import {
  type AppCatalogT,
  type CatalogResourceT,
  type CatalogServerT,
  matcherFor,
  normaliseAnnotations,
  readCatalog,
  runsWithoutTap,
  toolPrefixFor,
  writeCatalog,
} from './catalog.ts'
import { DirectAuthError, DirectConfig, type DirectConfigT, type DirectConnector, toCatalogTool } from './direct.ts'
import { installHookSettings } from './hooks.ts'
import { checkHtml } from './html-check.ts'
import { type ServerSecrets, serverIdOf } from './keychain.ts'
import type { AppPaths } from './paths.ts'
import { ensureAppDirs } from './pending.ts'

export const MIN_CLAUDE_CODE = '2.1.296'
export const MAX_RESOURCE_BYTES = 8 * 1024 * 1024
export const HTML_MIME = 'text/html;profile=mcp-app'

export class ScanStop extends Error {}

// ---- the SDK seam --------------------------------------------------------------------------------------------------

export type RawTool = {
  name: string
  annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean } | undefined
  _meta?: Record<string, unknown> | undefined
}
export type RawServer = {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  error?: string | undefined
  /** SECRET: http/sse headers arrive expanded, in plaintext (G8). The scan moves it out immediately. */
  config?: unknown
  source?: string | undefined
  scope?: string | undefined
  tools?: RawTool[] | undefined
}
export type RawContent = {
  uri: string
  mimeType?: string | undefined
  text?: string | undefined
  blob?: string | undefined
  _meta?: Record<string, unknown> | undefined
}

export interface McpStatusSource {
  /** Starts the session (no model turn) and returns Claude Code's version, if it reported one. */
  start(): Promise<{ claudeCodeVersion: string | undefined }>
  status(): Promise<RawServer[]>
  reconnect(name: string): Promise<void>
  readResource(server: string, uri: string): Promise<{ contents: RawContent[] }>
  close(): void
}

export type ScanIO = {
  print(line: string): void
  /** y/N, default N. */
  ask(question: string): Promise<boolean>
  askText(question: string, fallback: string): Promise<string>
}

/** Same numeric ordering as semver for `x.y.z` (anything else sorts as 0). */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// ---- config holder -----------------------------------------------------------------------------------------------------

/** The only place a reported server config lives while a scan runs. Not exported by any status object, never serialised. */
class ConfigHolder {
  private m = new Map<string, unknown>()
  put(id: string, config: unknown): void {
    this.m.set(id, config)
  }
  get(id: string): unknown {
    return this.m.get(id)
  }
  /** Replaces every header value we hold (6+ chars) in `text`, so an error string cannot carry one into output. */
  redact(text: string): string {
    let out = text
    for (const cfg of this.m.values()) {
      const headers = (cfg as { headers?: Record<string, string> } | undefined)?.headers
      if (!headers) continue
      for (const v of Object.values(headers)) {
        if (typeof v !== 'string') continue
        for (const piece of [v, v.replace(/^(Bearer|Basic)\s+/i, '')])
          if (piece.length >= 6) out = out.split(piece).join('***')
      }
    }
    return out
  }
}

// ---- results ------------------------------------------------------------------------------------------------------

export type DriftItem = { server: string; uri?: string; what: string }
export type ScanResult = {
  catalog: AppCatalogT | undefined
  skipped: Array<{ server: string; why: string }>
  drift: DriftItem[]
  approved: number
  refused: number
}

type Seen = {
  server: string
  source: string
  id: string
  status: RawServer['status']
  tools: CatalogToolT[]
  prefix: string
  uiUris: string[]
  directType: 'stdio' | 'http' | 'sse' | 'unsupported'
}

export type ScanDeps = {
  paths: AppPaths
  source: McpStatusSource
  io: ScanIO
  now: () => number
  sleep: (ms: number) => Promise<void>
  secrets: ServerSecrets
  connector: DirectConnector
  /** TALOS_APP_RELAY_URL: no CSP entry may equal or cover its host. */
  relayUrl: string | undefined
  agentDir: string
  /** apps/bridge directory (absolute), for the hook command lines. */
  bridgeDir: string
  /** apps/live-cc-version: what the live session reported, if anything. */
  liveVersion: string | undefined
  check: boolean
  agentNames: string[]
}

const iso = (ms: number) => new Date(ms).toISOString()

const appLog = (p: AppPaths, line: string) => {
  try {
    appendFileSync(p.scanLog, `${line}\n`, { mode: 0o600 })
  } catch {
    // the log must never fail a scan
  }
}

function uiOf(t: RawTool): { uri?: string; visibility?: Array<'model' | 'app'> } {
  const meta = t._meta ?? {}
  const ui = (meta.ui !== null && typeof meta.ui === 'object' ? meta.ui : {}) as {
    resourceUri?: unknown
    visibility?: unknown
  }
  const flat = typeof meta['ui/resourceUri'] === 'string' ? (meta['ui/resourceUri'] as string) : undefined
  const uri = typeof ui.resourceUri === 'string' ? ui.resourceUri : flat
  const vis = Array.isArray(ui.visibility)
    ? (ui.visibility.filter((v) => v === 'model' || v === 'app') as Array<'model' | 'app'>)
    : []
  return { ...(uri?.startsWith('ui://') ? { uri } : {}), ...(vis.length ? { visibility: vis } : {}) }
}

/** The SDK's view of a tool, in catalog shape. */
function sdkTool(t: RawTool): CatalogToolT {
  const u = uiOf(t)
  return {
    name: t.name,
    ...(u.uri ? { resource_uri: u.uri } : {}),
    visibility: u.visibility ?? ['model', 'app'],
    ...normaliseAnnotations(t.annotations),
  }
}

function directTypeOf(config: unknown): Seen['directType'] {
  const t = (config as { type?: unknown } | undefined)?.type
  if (t === 'http' || t === 'sse') return t
  if (t === 'stdio') return 'stdio'
  return 'unsupported' // sdk, claudeai-proxy, or a config Claude Code did not report
}

const isAppOnly = (t: CatalogToolT) => t.visibility.length === 1 && t.visibility[0] === 'app'

function pickText(c: RawContent): Uint8Array | undefined {
  if (typeof c.text === 'string') return new TextEncoder().encode(c.text)
  if (typeof c.blob === 'string') {
    try {
      return new Uint8Array(Buffer.from(c.blob, 'base64'))
    } catch {
      return undefined
    }
  }
  return undefined
}

const normMime = (m: string | undefined) => (m ?? '').toLowerCase().replace(/\s+/g, '')

// ---- the scan ------------------------------------------------------------------------------------------------------

export async function runScan(d: ScanDeps): Promise<ScanResult> {
  const { io, paths: P } = d
  const holder = new ConfigHolder()
  const result: ScanResult = { catalog: undefined, skipped: [], drift: [], approved: 0, refused: 0 }
  const prevRead = readCatalog(P)
  const prev: AppCatalogT | undefined = prevRead.ok ? prevRead.catalog : undefined
  if (!prevRead.ok) io.print(`The existing catalog is unusable (${prevRead.reason}); this scan starts fresh.`)

  try {
    if (!d.check) ensureAppDirs(P) // the scan log is written as decisions are made
    io.print('Every MCP server in this folder starts once, for up to a minute.')
    const init = await d.source.start()
    // 1. version
    const version = init.claudeCodeVersion
    if (!version) throw new ScanStop('This Claude Code does not report its version; update it and scan again.')
    if (cmpVersion(version, MIN_CLAUDE_CODE) < 0)
      throw new ScanStop(`Claude Code ${version} is too old for apps (need ${MIN_CLAUDE_CODE} or newer).`)
    if (d.liveVersion && d.liveVersion !== version)
      throw new ScanStop(`The live session runs ${d.liveVersion}, this scan would run ${version}; restart one of them.`)
    if (prev?.claude_code_version && prev.claude_code_version !== version)
      result.drift.push({ server: '(all)', what: `Claude Code changed from ${prev.claude_code_version} to ${version}` })

    // 4. statuses: poll until none pending (30 s), reconnect once, poll 15 s more
    let raw = await pollStatuses(d, 30_000)
    if (raw.some((s) => s.status === 'pending')) {
      for (const s of raw.filter((x) => x.status === 'pending')) await d.source.reconnect(s.name).catch(() => {})
      raw = await pollStatuses(d, 15_000)
    }
    const seen: Seen[] = []
    const skippedNames = new Set<string>()
    for (const s of raw) {
      const source = s.source ?? s.scope ?? 'unknown'
      const id = serverIdOf(s.name, source)
      if (s.config !== undefined) holder.put(id, s.config)
      if (s.status !== 'connected') {
        const why =
          s.status === 'needs-auth'
            ? "needs sign-in: sign in from an interactive `claude` session's /mcp first"
            : s.status === 'failed'
              ? `failed to start${s.error ? ` (${holder.redact(s.error).slice(0, 120)})` : ''}`
              : s.status === 'pending'
                ? 'still starting; try again'
                : 'disabled'
        result.skipped.push({ server: s.name, why })
        skippedNames.add(`${s.name}\u0000${source}`)
        io.print(`Skipped ${s.name}: ${why}.`)
        continue
      }
      const tools = (s.tools ?? []).map(sdkTool)
      const uiUris = [...new Set(tools.map((t) => t.resource_uri).filter((u): u is string => !!u))]
      seen.push({
        server: s.name,
        source,
        id,
        status: s.status,
        tools: (s.tools ?? []).map((_t, i) => tools[i] as CatalogToolT),
        prefix: toolPrefixFor(s.name),
        uiUris,
        directType: directTypeOf(s.config),
      })
    }
    // capability signal: _meta.ui on any tool (Claude Code sends it only under mcp_tool_ui_meta_v1)
    const anyUi = raw.some((s) =>
      (s.tools ?? []).some((t) => t._meta && ('ui' in t._meta || 'ui/resourceUri' in t._meta)),
    )
    if (!anyUi || seen.every((s) => s.uiUris.length === 0)) {
      io.print(
        "No app tools found. Some servers only offer apps to clients that announce MCP Apps support, which Claude Code doesn't (checked 2026-10-29).",
      )
    }

    const outServers: CatalogServerT[] = []
    const pendingConfigs: Array<{ id: string; config: unknown }> = []
    for (const s of seen.filter((x) => x.uiUris.length > 0)) {
      const entry = await evaluateServer(d, holder, s, prev, result, pendingConfigs)
      if (entry) outServers.push(entry)
    }
    // servers we skipped keep their old entry untouched; servers that vanished are reported (and dropped on a real scan)
    for (const old of prev?.servers ?? []) {
      const key = `${old.server}\u0000${old.source}`
      if (skippedNames.has(key)) {
        outServers.push(old)
        continue
      }
      if (!seen.some((x) => x.server === old.server && x.source === old.source && x.uiUris.length > 0))
        if (!outServers.some((x) => x.server === old.server && x.source === old.source))
          result.drift.push({ server: old.server, what: 'server gone' })
    }
    if (d.check) {
      for (const dr of result.drift) io.print(`drift: ${dr.server}${dr.uri ? ` ${dr.uri}` : ''}: ${dr.what}`)
      if (result.drift.length === 0) io.print('No drift: every approved app matches what the servers offer now.')
      result.catalog = prev
      return result
    }
    // 7. write: Keychain copies first (a failure leaves the old catalog in place), then catalog, resources, hooks
    ensureAppDirs(P)
    const cat: AppCatalogT = {
      rev: (prev?.rev ?? 0) + 1,
      scanned_at: iso(d.now()),
      claude_code_version: version,
      strict: prev?.strict ?? false,
      servers: outServers,
    }
    for (const pc of pendingConfigs) {
      if (!outServers.some((s) => serverIdOf(s.server, s.source) === pc.id)) continue
      await d.secrets.saveConfig(pc.id, pc.config)
    }
    writeCatalog(P, cat)
    pinResources(P, cat, d)
    const eligible = outServers.filter((s) =>
      s.resources.some((r) => r.state === 'approved' || r.state === 'needs_reapproval'),
    )
    installHookSettings(
      join(d.agentDir, '.claude', 'settings.local.json'),
      {
        bridgeDir: d.bridgeDir,
        prefixes: eligible.map((s) => s.tool_prefix),
        keychainDeny: eligible.some((s) => s.direct?.type === 'http' || s.direct?.type === 'sse'),
      },
      matcherFor,
    )
    result.catalog = cat
    io.print(`Catalog written (rev ${cat.rev}). ${result.approved} approved, ${result.refused} refused.`)
    return result
  } finally {
    d.source.close()
  }
}

async function pollStatuses(d: ScanDeps, budgetMs: number): Promise<RawServer[]> {
  const start = d.now()
  for (;;) {
    const s = await d.source.status()
    if (!s.some((x) => x.status === 'pending')) return s
    if (d.now() - start >= budgetMs) return s
    await d.sleep(1000)
  }
}

/** Keeps `resources/<sha>.html` for approved resources and removes every other one. */
function pinResources(p: AppPaths, cat: AppCatalogT, d: ScanDeps): void {
  const keep = new Set<string>()
  for (const s of cat.servers)
    for (const r of s.resources) if (r.state === 'approved' || r.state === 'needs_reapproval') keep.add(r.html_sha256)
  try {
    for (const n of readdirSync(p.resources)) {
      const sha = n.replace(/\.html$/, '')
      if (!keep.has(sha)) unlinkSync(join(p.resources, n))
    }
  } catch {
    // nothing pinned yet
  }
  void d
}

async function evaluateServer(
  d: ScanDeps,
  holder: ConfigHolder,
  s: Seen,
  prev: AppCatalogT | undefined,
  result: ScanResult,
  pendingConfigs: Array<{ id: string; config: unknown }>,
): Promise<CatalogServerT | undefined> {
  const { io } = d
  const old = prev?.servers.find((x) => x.server === s.server && x.source === s.source)
  const config = holder.get(s.id)
  let tools = s.tools
  const askEach = new Set<string>()
  const hasAppOnly = tools.some(isAppOnly)
  const hasNoTap = tools.some(runsWithoutTap)
  const needsDirect = hasAppOnly || hasNoTap
  let direct: CatalogServerT['direct']
  const lines: string[] = []
  let refuseAll: string | undefined

  if (needsDirect) {
    try {
      if (s.directType === 'http' || s.directType === 'sse') {
        const parsed = DirectConfig.safeParse({
          type: s.directType,
          url: (config as { url?: string })?.url,
          headers: (config as { headers?: Record<string, string> })?.headers,
        })
        if (!parsed.success) throw new ScanStop('The server config is not usable.')
        const cfg: DirectConfigT = parsed.data
        const hasHeaders = Object.keys(cfg.headers ?? {}).length > 0
        const fp = await d.secrets.fingerprint(s.id, {
          type: cfg.type,
          url: cfg.url,
          ...(cfg.headers ? { headers: cfg.headers } : {}),
        })
        let auth: 'none' | 'static' | 'oauth' = hasHeaders ? 'static' : 'none'
        // the one verification connect: tool list (annotation source) and OAuth detection
        try {
          const session = await d.connector.connect(cfg, { kind: auth })
          try {
            const live = (await session.listTools()).map(toCatalogTool)
            tools = tools.map((t) => {
              const l = live.find((x) => x.name === t.name)
              if (!l) return t
              if (runsWithoutTap(l) !== runsWithoutTap(t)) {
                askEach.add(t.name)
                lines.push(
                  `\`${t.name}\`: Claude Code and the server disagree on its labels, so it asks you each time.`,
                )
              }
              return { ...t, read_only: l.read_only, destructive: l.destructive, open_world: l.open_world }
            })
          } finally {
            await session.close()
          }
        } catch (e) {
          if (e instanceof DirectAuthError && !hasHeaders) auth = 'oauth'
          else if (e instanceof DirectAuthError)
            lines.push(
              "This server rejected the headers Claude Code reported; Talos's own session won't work until they are fixed.",
            )
          else
            lines.push(
              "Talos couldn't reach this server for its own session; app-only buttons won't work until it can.",
            )
        }
        direct = { type: cfg.type, config_fingerprint: fp, auth }
        pendingConfigs.push({
          id: s.id,
          config: { type: cfg.type, url: cfg.url, ...(cfg.headers ? { headers: cfg.headers } : {}) },
        })
      } else if (s.directType === 'stdio') {
        const c = config as { command?: string; args?: string[] } | undefined
        const fp = await d.secrets.fingerprint(s.id, { type: 'stdio', command: c?.command ?? '', args: c?.args ?? [] })
        direct = { type: 'stdio', config_fingerprint: fp, auth: 'none' }
      } else {
        direct = { type: 'unsupported', auth: 'none' }
      }
    } catch (e) {
      if (e instanceof ScanStop) refuseAll = e.message
      else
        refuseAll =
          "Talos couldn't keep this server's settings in your login Keychain, so it can't approve this app safely."
    }
  }

  const resources: CatalogResourceT[] = []
  for (const uri of s.uiUris) {
    const prevRes = old?.resources.find((r) => r.uri === uri)
    const boundTools = tools.filter((t) => t.resource_uri === uri)
    const decided = iso(d.now())
    const refuse = (reason: string): CatalogResourceT => {
      result.refused++
      appLog(
        d.paths,
        JSON.stringify({ at: decided, server: s.server, source: s.source, uri, decision: 'refused', reason }),
      )
      io.print(`Refused ${uri} (${s.server}): ${reason}`)
      return {
        uri,
        html_sha256: prevRes?.html_sha256 ?? '0'.repeat(64),
        size: 0,
        csp: emptyCsp(),
        permissions_requested: [],
        approval_key: prevRes?.approval_key ?? '0'.repeat(64),
        state: 'refused',
        reason: reason.slice(0, 200),
        owner: prevRes?.owner ?? {
          label: `${s.server} · ${boundTools[0]?.name ?? 'app'}`.slice(0, 60),
          show: 'ask',
          direct: false,
        },
        decided_at: decided,
      }
    }
    if (refuseAll) {
      resources.push(refuse(refuseAll))
      continue
    }
    let read: Awaited<ReturnType<McpStatusSource['readResource']>>
    try {
      read = await d.source.readResource(s.server, uri)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (/not connected/i.test(msg)) {
        resources.push(refuse('the server was not connected when the app was read'))
        continue
      }
      throw new ScanStop("This Claude Code version can't read app resources.")
    }
    const content = read.contents[0]
    if (!content) {
      resources.push(refuse('the server returned no content for this app'))
      continue
    }
    if (normMime(content.mimeType) !== HTML_MIME) {
      resources.push(refuse(`unexpected content type (${(content.mimeType ?? 'none').slice(0, 60)})`))
      continue
    }
    const bytes = pickText(content)
    if (!bytes) {
      resources.push(refuse('the app has no text or blob content'))
      continue
    }
    if (bytes.length > MAX_RESOURCE_BYTES) {
      resources.push(refuse('the app is over 8 MiB'))
      continue
    }
    const uiMeta = (content._meta?.ui ?? {}) as { csp?: unknown; permissions?: unknown; prefersBorder?: unknown }
    const spec = fromSpecCsp(uiMeta.csp)
    if (spec.problems.length > 0) {
      resources.push(
        refuse(`invalid CSP entries: ${spec.problems.map((p) => `${p.field} (${p.reason})`).join('; ')}`.slice(0, 190)),
      )
      continue
    }
    const html = new TextDecoder().decode(bytes)
    const checked = await checkHtml(html, spec.csp)
    if (!checked.ok) {
      resources.push(refuse(checked.reason))
      continue
    }
    const csp: AppCspT = {
      ...spec.csp,
      script_hashes: checked.script_hashes,
      script_urls: checked.script_urls,
      style_urls: checked.style_urls,
    }
    const cspOk = AppCsp.safeParse(csp)
    if (!cspOk.success) {
      resources.push(refuse('the declared CSP does not fit the allowed shape'))
      continue
    }
    if (d.relayUrl) {
      const bad = cspRelayHostProblem(csp, d.relayUrl)
      if (bad) {
        resources.push(refuse(bad))
        continue
      }
    }
    const permissions =
      uiMeta.permissions !== null && typeof uiMeta.permissions === 'object'
        ? Object.keys(uiMeta.permissions as object)
            .filter((k) => (uiMeta.permissions as Record<string, unknown>)[k])
            .map((k) => k.slice(0, 40))
            .slice(0, 8)
        : []
    const resource = {
      uri,
      html_sha256: sha256Hex(bytes),
      csp,
      permissions_requested: permissions,
      ...(typeof uiMeta.prefersBorder === 'boolean' ? { prefers_border: uiMeta.prefersBorder } : {}),
    }
    const input = { server: s.server, source: s.source, resource, tools, ...(direct ? { direct } : {}) }
    const key = keyOf(input)
    // unchanged key keeps the decision and the owner's choices
    if (prevRes && prevRes.approval_key === key && (prevRes.state === 'approved' || prevRes.state === 'declined')) {
      resources.push({ ...prevRes, size: bytes.length, csp, permissions_requested: permissions })
      if (prevRes.state === 'approved') {
        result.approved++
        pinHtml(d.paths, resource.html_sha256, bytes)
      }
      continue
    }
    const prevManifest = prevRes ? manifestFromCatalog(old as CatalogServerT, prevRes) : undefined
    const diff = prevManifest ? diffManifests(prevManifest, manifestOf(input)) : undefined
    if (prevRes && prevRes.approval_key !== key)
      result.drift.push({ server: s.server, uri, what: diff?.join('; ') || 'approval key changed' })
    else if (prevRes?.state === 'needs_reapproval')
      result.drift.push({ server: s.server, uri, what: prevRes.reapproval_diff ?? 'needs re-approval' })
    else if (!prevRes) result.drift.push({ server: s.server, uri, what: 'new app' })
    if (d.check) {
      resources.push(prevRes ?? refuse('not approved yet'))
      continue
    }
    const dl: string[] = [...lines]
    const hasStdioNoTap = (s.directType === 'stdio' || direct?.type === 'unsupported') && hasNoTap
    const strict = false
    if (direct?.type === 'http' || direct?.type === 'sse') {
      const url = (config as { url?: string } | undefined)?.url
      if (direct.auth === 'oauth') dl.push(directLines({ kind: 'oauth' }))
      else dl.push(directLines({ kind: 'static', ...(url ? { url: new URL(url).origin } : {}) }))
    } else if (direct) {
      const un = direct.type === 'unsupported'
      if (hasAppOnly) dl.push(directLines({ kind: un ? 'unsupported_app_only' : 'stdio_app_only' }))
      if (hasStdioNoTap) dl.push(directLines({ kind: strict ? 'strict' : un ? 'unsupported_no_tap' : 'stdio_no_tap' }))
    }
    const screen = renderApproval({
      server: s.server,
      source: s.source,
      resource: { ...resource, size: bytes.length },
      key,
      tools,
      boundTools: boundTools.map((t) => t.name),
      permissions,
      diff,
      directLines: dl,
      frameWarning: csp.frame_domains.length > 0,
    })
    for (const l of screen) io.print(l)
    const yes = await io.ask('Approve this app? y/N')
    if (!yes) {
      appLog(
        d.paths,
        JSON.stringify({ at: decided, server: s.server, source: s.source, uri, key, csp, decision: 'declined' }),
      )
      resources.push({
        uri,
        html_sha256: resource.html_sha256,
        size: bytes.length,
        csp,
        permissions_requested: permissions,
        ...(resource.prefers_border !== undefined ? { prefers_border: resource.prefers_border } : {}),
        approval_key: key,
        state: 'declined',
        owner: prevRes?.owner ?? {
          label: `${s.server} · ${boundTools[0]?.name ?? 'app'}`.slice(0, 60),
          show: 'ask',
          direct: false,
        },
        decided_at: decided,
      })
      continue
    }
    let label = prevRes?.owner.label ?? `${s.server} · ${boundTools[0]?.name ?? 'app'}`.slice(0, 60)
    for (let tries = 0; tries < 5; tries++) {
      const typed = (await io.askText('Label for this app', label)).trim() || label
      const bad = labelProblem(typed, d.agentNames)
      if (!bad) {
        label = typed
        break
      }
      io.print(bad)
      label = `${s.server} · ${boundTools[0]?.name ?? 'app'}`.slice(0, 60)
      if (tries === 4) label = 'App'
    }
    const defShow = prevRes?.owner.show ?? defaultShow(s.source, direct?.type)
    const typedShow = (await io.askText('Show results automatically or ask each time (auto/ask)', defShow))
      .trim()
      .toLowerCase()
    const show: 'auto' | 'ask' = typedShow === 'auto' ? 'auto' : 'ask'
    const ownerDirect = (direct?.type === 'http' || direct?.type === 'sse') && needsDirect
    appLog(
      d.paths,
      JSON.stringify({
        at: decided,
        server: s.server,
        source: s.source,
        uri,
        key,
        csp,
        decision: 'approved',
        label_len: label.length,
        show,
      }),
    )
    pinHtml(d.paths, resource.html_sha256, bytes)
    result.approved++
    resources.push({
      uri,
      html_sha256: resource.html_sha256,
      size: bytes.length,
      csp,
      permissions_requested: permissions,
      ...(resource.prefers_border !== undefined ? { prefers_border: resource.prefers_border } : {}),
      approval_key: key,
      state: 'approved',
      owner: { label, show, direct: ownerDirect },
      decided_at: decided,
    })
  }
  return {
    server: s.server,
    source: s.source,
    tool_prefix: s.prefix,
    ...(direct ? { direct } : {}),
    ...(askEach.size ? { ask_each_time: [...askEach].sort() } : {}),
    tools,
    resources,
  }
}

function emptyCsp(): AppCspT {
  return {
    connect_domains: [],
    resource_domains: [],
    frame_domains: [],
    base_uri_domains: [],
    script_hashes: [],
    script_urls: [],
    style_urls: [],
  }
}

function pinHtml(p: AppPaths, sha: string, bytes: Uint8Array): void {
  const f = join(p.resources, `${sha}.html`)
  if (existsSync(f)) return
  writeFileAtomic(f, bytes, 0o600)
}

/** The manifest the previous approval covered, rebuilt from the catalog entry (for the diff). */
export function manifestFromCatalog(server: CatalogServerT, r: CatalogResourceT): ApprovalManifestT {
  return manifestOf({
    server: server.server,
    source: server.source,
    resource: {
      uri: r.uri,
      html_sha256: r.html_sha256,
      csp: r.csp,
      permissions_requested: r.permissions_requested,
      prefers_border: r.prefers_border,
    },
    tools: server.tools,
    direct: server.direct,
  })
}

export function readPinnedHtml(p: AppPaths, sha: string): Uint8Array | undefined {
  try {
    const bytes = new Uint8Array(readFileSync(join(p.resources, `${sha}.html`)))
    return sha256Hex(bytes) === sha ? bytes : undefined
  } catch {
    return undefined
  }
}
