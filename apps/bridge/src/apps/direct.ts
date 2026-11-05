// The bridge's own MCP connection (M5.6): app-only tools of approved apps on http/sse servers, and the call-time label
// check. Lazy connect, idle close after 5 minutes, at most 3 at once. No stdio transport and no child process in v1.

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import {
  type CatalogToolT,
  isLoopbackHost,
  McpCallToolResult,
  type McpCallToolResultT,
  normalizeHost,
  stripHostMetaDeep,
} from '@talos-app/protocol'
import { z } from 'zod'
import type { Clock } from '../clock.ts'
import type { Logger } from '../log.ts'
import { BRIDGE_VERSION } from '../version.ts'
import { type CatalogServerT, normaliseAnnotations, sameLabels } from './catalog.ts'
import { guardedFetch, TalosOAuthProvider } from './direct-oauth.ts'
import { type ServerSecrets, serverIdOf } from './keychain.ts'

export const DirectConfig = z.object({
  type: z.enum(['http', 'sse']),
  url: z.string().min(1).max(4096),
  headers: z.record(z.string(), z.string()).optional(),
})
export type DirectConfigT = z.infer<typeof DirectConfig>

export class DirectAuthError extends Error {}
export class DirectUnavailableError extends Error {}
export class DirectTimeoutError extends Error {}
export class DirectTooLargeError extends Error {}
/** The caller's guard said the call may no longer run (switch, view or approval moved while the pool was awaiting). */
export class DirectNotRunnable extends Error {}
/** The server's tool list no longer matches what the owner approved. */
export class DirectManifestChanged extends Error {
  constructor(readonly tool?: string) {
    super('manifest changed')
  }
}

export type DirectTool = { name: string; annotations?: unknown; _meta?: Record<string, unknown> | undefined }

export interface DirectSession {
  listTools(): Promise<DirectTool[]>
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpCallToolResultT>
  close(): Promise<void>
  /** Called once if the transport drops on its own. */
  onClose(cb: () => void): void
}
export type DirectAuthSpec = { kind: 'none' | 'static' | 'oauth'; provider?: OAuthClientProvider | undefined }
export interface DirectConnector {
  connect(cfg: DirectConfigT, auth: DirectAuthSpec): Promise<DirectSession>
}

/** The capabilities Claude Code sent in P1: the tasks extension only, no `io.modelcontextprotocol/ui` (review D4). */
export const DIRECT_CAPABILITIES = { extensions: { 'io.modelcontextprotocol/tasks': {} } } as const

export function mapDirectError(e: unknown): Error {
  if (e instanceof UnauthorizedError) return new DirectAuthError('sign-in needed')
  if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) return new DirectTimeoutError('timeout')
  const code = (e as { code?: unknown })?.code
  if (code === 401 || code === 403) return new DirectAuthError('sign-in needed')
  return new DirectUnavailableError('connection failed')
}

/**
 * The named exception for a local server the owner approved: loopback only (`localhost`, 127/8, `::1`), the same rule
 * `apps login` applies (`cli.ts`). A LAN address is not exempt: login refuses a non-loopback http server, so no real LAN
 * server can have a token here, and the exemption would only let a token carried over from an earlier URL go over plain
 * http to a new one. A name is never local by its looks, and a blocked literal such as the metadata address is never
 * local. The exempt origin may be reached over http and without the address check; every other origin is still checked.
 */
export function isLocalServerHost(host: string): boolean {
  return isLoopbackHost(normalizeHost(host))
}

/** The connector, with the host lookup of the sign-in address check replaceable (tests only; production uses the system one). */
export function makeDirectConnector(opts: { resolve?: (host: string) => Promise<string[]> } = {}): DirectConnector {
  return {
    async connect(cfg, auth) {
      const headers = cfg.headers ?? {}
      const client = new Client(
        { name: 'talos-app', version: BRIDGE_VERSION },
        { capabilities: DIRECT_CAPABILITIES as never },
      )
      const authProvider = auth.kind === 'oauth' ? auth.provider : undefined
      const url = new URL(cfg.url)
      // The SDK runs its OAuth discovery and refresh through the transport's fetch. Those requests (anything that is not the
      // MCP endpoint itself) go through the guard; the MCP traffic keeps the plain fetch (it streams).
      const host = url.hostname.replace(/^\[|\]$/g, '')
      const guard = guardedFetch({
        allowedLocalOrigin: isLocalServerHost(host) ? url.origin : undefined,
        ...(opts.resolve ? { resolve: opts.resolve } : {}),
      })
      const guarded: typeof fetch = ((u: string | URL, i?: RequestInit) => {
        const t = new URL(String(u))
        return t.origin === url.origin && t.pathname === url.pathname ? fetch(u, i) : guard(u, i)
      }) as never
      const transport =
        cfg.type === 'sse'
          ? new SSEClientTransport(url, {
              requestInit: { headers },
              ...(authProvider ? { fetch: guarded } : {}),
              eventSourceInit: {
                fetch: (u: string | URL, init?: RequestInit) =>
                  fetch(u, {
                    ...init,
                    headers: { ...(init?.headers as Record<string, string> | undefined), ...headers },
                  }),
              } as never,
              ...(authProvider ? { authProvider } : {}),
            })
          : new StreamableHTTPClientTransport(url, {
              requestInit: { headers },
              ...(authProvider ? { authProvider, fetch: guarded } : {}),
            })
      let closeCb: (() => void) | undefined
      let closedByUs = false
      client.onclose = () => {
        if (!closedByUs) closeCb?.()
      }
      try {
        await client.connect(transport)
      } catch (e) {
        await client.close().catch(() => {})
        throw mapDirectError(e)
      }
      return {
        async listTools() {
          const out: DirectTool[] = []
          let cursor: string | undefined
          try {
            for (let i = 0; i < 10; i++) {
              const page = await client.listTools(cursor ? { cursor } : undefined)
              for (const t of page.tools)
                out.push({ name: t.name, annotations: t.annotations, _meta: t._meta as never })
              cursor = page.nextCursor
              if (!cursor) break
            }
          } catch (e) {
            throw mapDirectError(e)
          }
          return out
        },
        async callTool(name, args, timeoutMs) {
          let res: unknown
          try {
            res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })
          } catch (e) {
            throw mapDirectError(e)
          }
          const parsed = McpCallToolResult.safeParse(stripHostMetaDeep(res))
          if (!parsed.success) throw new DirectTooLargeError('result not usable')
          return parsed.data
        },
        async close() {
          closedByUs = true
          await client.close().catch(() => {})
        },
        onClose(cb) {
          closeCb = cb
        },
      }
    },
  }
}

export const realDirectConnector: DirectConnector = makeDirectConnector()

// ---- tools as the catalog stores them ------------------------------------------------------------------------------

export function toCatalogTool(t: DirectTool): CatalogToolT {
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
  return {
    name: t.name,
    ...(uri?.startsWith('ui://') ? { resource_uri: uri } : {}),
    visibility: vis.length ? vis : ['model', 'app'],
    ...normaliseAnnotations(t.annotations),
  }
}

// ---- the pool ------------------------------------------------------------------------------------------------------

/** The runtime provider never opens a sign-in; a redirect URL only makes the SDK take its refresh path instead of the non-interactive one. */
const RUNTIME_REDIRECT = 'http://127.0.0.1/callback'
export const IDLE_CLOSE_MS = 5 * 60_000
export const LIST_CACHE_MS = 60_000
export const CALL_TIMEOUT_MS = 60_000
export const LABEL_CHECK_TIMEOUT_MS = 10_000
export const MAX_DIRECT_CONNECTIONS = 3
const DROP_WINDOW_MS = 5 * 60_000
const QUARANTINE_MS = 3600_000
/** The one live tool with this name. Two entries with one name is a server we cannot trust to label either: no match (S7). */
function uniqueByName(live: CatalogToolT[], name: string): CatalogToolT | undefined {
  const hits = live.filter((t) => t.name === name)
  return hits.length === 1 ? hits[0] : undefined
}

const FAIL_WINDOW_MS = 10 * 60_000

type Entry = {
  key: string
  session: DirectSession
  busy: number
  lastUsed: number
  timer: unknown
  tools?: { at: number; list: CatalogToolT[] }
}

export type PoolDeps = {
  connector: DirectConnector
  secrets: ServerSecrets
  clock: Clock
  log: Logger
}

export type LabelCheck = 'identical' | 'changed' | 'failed'

export class DirectPool {
  private entries = new Map<string, Entry>()
  private drops = new Map<string, number[]>()
  private quarantine = new Map<string, number>()
  private fails = new Map<string, number[]>()
  private opening = new Map<string, Promise<Entry>>()

  constructor(private readonly d: PoolDeps) {}

  get openCount(): number {
    return this.entries.size
  }

  private keyOf(s: CatalogServerT): string {
    return serverIdOf(s.server, s.source)
  }

  /** Failures for a server inside the last 10 minutes (the caller raises a notice at 3). */
  failuresInWindow(s: CatalogServerT): number {
    const now = this.d.clock.now()
    const l = (this.fails.get(this.keyOf(s)) ?? []).filter((t) => now - t < FAIL_WINDOW_MS)
    this.fails.set(this.keyOf(s), l)
    return l.length
  }

  noteFailure(s: CatalogServerT): number {
    const k = this.keyOf(s)
    const l = this.fails.get(k) ?? []
    l.push(this.d.clock.now())
    this.fails.set(k, l)
    return this.failuresInWindow(s)
  }

  /** Three drops in five minutes close the server for an hour (M5.6 failure table). */
  private recordDrop(key: string): void {
    const t = this.d.clock.now()
    const l = (this.drops.get(key) ?? []).filter((x) => t - x < DROP_WINDOW_MS)
    l.push(t)
    this.drops.set(key, l)
    if (l.length >= 3) this.quarantine.set(key, t + QUARANTINE_MS)
  }

  private arm(e: Entry): void {
    this.d.clock.clearTimeout(e.timer)
    e.timer = this.d.clock.setTimeout(() => void this.idleCheck(e), IDLE_CLOSE_MS)
  }

  private async idleCheck(e: Entry): Promise<void> {
    if (this.entries.get(e.key) !== e) return
    if (e.busy > 0 || this.d.clock.now() - e.lastUsed < IDLE_CLOSE_MS) {
      this.arm(e)
      return
    }
    await this.drop(e)
  }

  private async drop(e: Entry): Promise<void> {
    this.d.clock.clearTimeout(e.timer)
    if (this.entries.get(e.key) === e) this.entries.delete(e.key)
    await e.session.close().catch(() => {})
  }

  async closeAll(): Promise<void> {
    for (const e of [...this.entries.values()]) await this.drop(e)
  }

  /** Closes this server's session (revocation, logout). */
  async closeServer(s: CatalogServerT): Promise<void> {
    const e = this.entries.get(this.keyOf(s))
    if (e) await this.drop(e)
  }

  private async open(s: CatalogServerT): Promise<Entry> {
    const key = this.keyOf(s)
    const now = this.d.clock.now()
    const q = this.quarantine.get(key)
    if (q !== undefined && now < q) throw new DirectUnavailableError('connection paused after repeated drops')
    // load the config only from the Keychain
    let raw: Record<string, unknown> | undefined
    try {
      raw = await this.d.secrets.loadConfig(key)
    } catch {
      throw new DirectAuthError('Keychain locked or item missing')
    }
    if (!raw) throw new DirectAuthError('Keychain locked or item missing')
    const cfg = DirectConfig.safeParse(raw)
    if (!cfg.success) throw new DirectAuthError('stored server settings are not usable')
    const kind = s.direct?.auth ?? 'none'
    const provider = kind === 'oauth' ? new TalosOAuthProvider(this.d.secrets, key, RUNTIME_REDIRECT) : undefined
    if (provider) {
      const tokens = await provider.tokens().catch(() => {
        throw new DirectAuthError('Keychain locked or item missing')
      })
      if (!tokens) throw new DirectAuthError('sign-in needed')
    }
    // room: oldest idle first
    while (this.entries.size >= MAX_DIRECT_CONNECTIONS) {
      const idle = [...this.entries.values()].filter((x) => x.busy === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (!idle) throw new DirectUnavailableError('too many direct connections')
      await this.drop(idle)
    }
    const session = await this.d.connector.connect(cfg.data, { kind, provider })
    const entry: Entry = { key, session, busy: 0, lastUsed: now, timer: null }
    session.onClose(() => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key)
        this.d.clock.clearTimeout(entry.timer)
        this.recordDrop(key)
      }
    })
    this.entries.set(key, entry)
    this.arm(entry)
    return entry
  }

  private async ensure(s: CatalogServerT): Promise<Entry> {
    const key = this.keyOf(s)
    const have = this.entries.get(key)
    if (have) return have
    const inflight = this.opening.get(key)
    if (inflight) return inflight
    const p = this.open(s).finally(() => this.opening.delete(key))
    this.opening.set(key, p)
    return p
  }

  /** Runs `fn` on the server's session; the entry counts as busy meanwhile. */
  private async use<T>(s: CatalogServerT, fn: (e: Entry) => Promise<T>): Promise<T> {
    const e = await this.ensure(s)
    e.busy++
    try {
      return await fn(e)
    } catch (err) {
      // a connection that died under a call is not worth keeping: the next call connects afresh
      if (err instanceof DirectUnavailableError) {
        if (this.entries.get(e.key) === e) this.recordDrop(e.key)
        await this.drop(e)
      }
      throw err
    } finally {
      e.busy--
      e.lastUsed = this.d.clock.now()
      if (this.entries.get(e.key) === e) this.arm(e)
    }
  }

  /** Every direct connect lists tools and compares each app-only tool with the approved manifest (M5.6). */
  async tools(s: CatalogServerT, opts: { fresh?: boolean } = {}): Promise<CatalogToolT[]> {
    return this.use(s, async (e) => {
      const now = this.d.clock.now()
      if (!opts.fresh && e.tools && now - e.tools.at <= LIST_CACHE_MS) return e.tools.list
      const list = (await e.session.listTools()).map(toCatalogTool)
      e.tools = { at: now, list }
      return list
    })
  }

  /** The approved app-only tools against the live list; a difference is `DirectManifestChanged`. */
  async verifyAppOnly(s: CatalogServerT): Promise<void> {
    const live = await this.freshToolsBounded(s)
    for (const want of s.tools.filter((t) => t.visibility.length === 1 && t.visibility[0] === 'app')) {
      const got = uniqueByName(live, want.name)
      if (!got || !sameLabels(want, got)) throw new DirectManifestChanged(want.name)
    }
  }

  /** A fresh list, bounded by the same timeout as the label check so a stalling server cannot hold it for the SDK's 60 s. */
  private async freshToolsBounded(s: CatalogServerT): Promise<CatalogToolT[]> {
    let timer: unknown
    try {
      return await Promise.race([
        this.tools(s, { fresh: true }), // a relabel after the last check must be seen, so never the 60 s list
        new Promise<never>((_, rej) => {
          timer = this.d.clock.setTimeout(
            () => rej(new DirectTimeoutError('label check timed out')),
            LABEL_CHECK_TIMEOUT_MS,
          )
        }),
      ])
    } finally {
      this.d.clock.clearTimeout(timer)
    }
  }

  /**
   * `stillRunnable` is the caller's guard: it runs after every await in here (the second list, the connection) and right
   * before the server call, with no await between the check and the call.
   */
  async callTool(
    s: CatalogServerT,
    name: string,
    args: Record<string, unknown>,
    stillRunnable?: () => boolean,
  ): Promise<McpCallToolResultT> {
    await this.verifyAppOnly(s)
    return this.use(s, (e) => {
      if (stillRunnable && !stillRunnable()) throw new DirectNotRunnable('no longer runnable')
      return e.session.callTool(name, args, CALL_TIMEOUT_MS)
    })
  }

  /** Before any call that would run without a card: the tool's current labels against the approved ones (D3). */
  async labelCheck(s: CatalogServerT, tool: CatalogToolT): Promise<LabelCheck> {
    try {
      const live = await this.freshToolsBounded(s)
      const got = uniqueByName(live, tool.name)
      return got && sameLabels(tool, got) ? 'identical' : 'changed'
    } catch (e) {
      this.d.log.warn('label check failed', {
        server: s.server,
        kind: e instanceof Error ? e.constructor.name : 'error',
      })
      return 'failed'
    }
  }
}
