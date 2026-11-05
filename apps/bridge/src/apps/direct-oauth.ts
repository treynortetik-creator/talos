// `talos-app apps login` (M5.6, review D1): the MCP SDK's client OAuth flow behind a GUARDED fetch, because the SDK takes the
// authorization server from the resource metadata with no https or address check. Nothing is ever opened automatically.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  b64urlEncode,
  findBlockedAddress,
  isBlockedAddress,
  isBlockedHost,
  isIpLiteral,
  normalizeHost,
} from '@talos-app/protocol'
import { BlockedAddressError, createGuardedFetch } from '@talos-app/protocol/guarded-fetch'
import type { ServerSecrets } from './keychain.ts'

export class GuardError extends Error {
  constructor(
    message: string,
    readonly host?: string,
  ) {
    super(message)
    this.name = 'GuardError'
  }
}

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

export const URL_MAX = 4096
export const BODY_MAX = 1024 * 1024
export const REDIRECT_MAX = 3

// ---- addresses ---------------------------------------------------------------------------------------------------------

// The address rules are the shared ones in @talos-app/protocol: the same list the RSS poller uses. Re-exported because this
// module has always been where the bridge's tests reach for the classifier.
export { isBlockedAddress }

const BLOCKED_MESSAGE = 'the host resolves to an address Talos will not contact'

// ---- the guard ---------------------------------------------------------------------------------------------------------

export type GuardOpts = {
  /** All A/AAAA records for a host. Default: the system resolver. */
  resolve?: (host: string) => Promise<string[]>
  fetch?: FetchLike
  /**
   * The approved server's own origin when it is on a local address (a local server the owner approved at scan). That exact
   * origin, and only it, may be reached over http / on a private address for its own metadata and endpoints.
   */
  allowedLocalOrigin?: string | undefined
  /** Overall limit for ONE request of the flow, in milliseconds (connection to last body byte). Default 30 000. */
  timeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const isTimeout = (e: unknown) => e instanceof Error && e.name === 'TimeoutError'

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((r) => r.address)

/** Syntax only: parseable, no userinfo, length-capped; https unless it is the approved local origin. */
export function checkUrlSyntax(value: string | URL, allowedLocalOrigin?: string): URL {
  const s = String(value)
  if (s.length > URL_MAX) throw new GuardError('a URL in the sign-in flow is over 4096 characters')
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new GuardError('a URL in the sign-in flow does not parse')
  }
  if (u.username || u.password)
    throw new GuardError('a URL in the sign-in flow carries a user name or password', u.hostname)
  if (allowedLocalOrigin && u.origin === allowedLocalOrigin) return u
  if (u.protocol !== 'https:')
    throw new GuardError(`a URL in the sign-in flow is not https (${u.protocol.replace(':', '')})`, u.hostname)
  return u
}

async function checkAddress(u: URL, o: GuardOpts): Promise<void> {
  if (o.allowedLocalOrigin && u.origin === o.allowedLocalOrigin) return
  const host = normalizeHost(u.hostname) // no brackets, no trailing dot
  // a blocked literal, or a number-shaped host that is not an exact address (a resolver may read it as one): refuse unresolved
  if (isBlockedHost(host)) throw new GuardError(BLOCKED_MESSAGE, host)
  const addrs = isIpLiteral(host) ? [host] : await (o.resolve ?? defaultResolve)(host)
  if (addrs.length === 0) throw new GuardError('the host does not resolve', host)
  if (findBlockedAddress(addrs) !== undefined) throw new GuardError(BLOCKED_MESSAGE, host)
}

/**
 * The default transport. Checking a name and then letting `fetch` resolve it again would let a hostile DNS server answer
 * differently the second time, so the connection is opened with the address check inside its lookup (connect time). The
 * one origin the owner approved as local goes over the plain fetch, as before.
 */
function defaultTransport(o: GuardOpts): FetchLike {
  const timeoutMs = o.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const checked = createGuardedFetch({
    ...(o.resolve ? { resolve: o.resolve } : {}),
    message: BLOCKED_MESSAGE,
    timeoutMs,
  })
  return async (u, i) => {
    const t = new URL(String(u))
    if (o.allowedLocalOrigin && t.origin === o.allowedLocalOrigin) {
      // the plain fetch has no limit of its own: a stalled local server would hold `apps login` forever
      // 0 means no limit, as in the guarded fetch
      if (timeoutMs <= 0) return fetch(u, i)
      const limit = AbortSignal.timeout(timeoutMs)
      return fetch(u, { ...i, signal: i?.signal ? AbortSignal.any([i.signal, limit]) : limit })
    }
    try {
      return await checked(t, i)
    } catch (e) {
      if (e instanceof BlockedAddressError) throw new GuardError(e.message, e.host)
      throw e
    }
  }
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > max) {
      await reader.cancel().catch(() => {})
      throw new GuardError('a sign-in response was over 1 MiB')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(n)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

const WELL_KNOWN = /\/\.well-known\/(oauth-authorization-server|openid-configuration)/
const ENDPOINT_FIELDS = [
  'authorization_endpoint',
  'token_endpoint',
  'registration_endpoint',
  'jwks_uri',
  'issuer',
] as const

function expectedIssuers(u: URL): string[] {
  const m = WELL_KNOWN.exec(u.pathname)
  if (!m) return []
  const before = u.pathname.slice(0, m.index)
  const after = u.pathname.slice(m.index + m[0].length)
  const strip = (s: string) => s.replace(/\/+$/, '')
  return [strip(`${u.origin}${after}`), strip(`${u.origin}${before}`)]
}

/**
 * Every request of the sign-in flow goes through this. Refuses before sending: a non-https URL, userinfo, an over-long URL,
 * a host that resolves to a loopback/private/link-local/CGNAT/ULA/multicast (or mapped) address. Redirects are followed by
 * hand, at most 3, each one re-checked. Responses are capped at 1 MiB and a 2xx must be JSON. The authorization server's
 * `issuer` must equal the URL its metadata was fetched for (RFC 8414 3.3), and every endpoint it names is syntax-checked.
 */
export function guardedFetch(o: GuardOpts = {}): FetchLike {
  const real: FetchLike = o.fetch ?? defaultTransport(o)
  return async (input, init) => {
    let url = checkUrlSyntax(input, o.allowedLocalOrigin)
    const method = (init?.method ?? 'GET').toUpperCase()
    for (let hop = 0; ; hop++) {
      await checkAddress(url, o)
      const res = await real(url, { ...init, method, redirect: 'manual' })
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop >= REDIRECT_MAX) throw new GuardError('more than 3 redirects in the sign-in flow', url.hostname)
        if (method !== 'GET') throw new GuardError('a sign-in request was redirected', url.hostname)
        await res.body?.cancel().catch(() => {})
        url = checkUrlSyntax(new URL(res.headers.get('location') as string, url), o.allowedLocalOrigin)
        continue
      }
      const bytes = await readCapped(res, BODY_MAX)
      const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (res.ok && type !== 'application/json') throw new GuardError('a sign-in response was not JSON', url.hostname)
      if (res.ok) {
        let body: unknown
        try {
          body = JSON.parse(new TextDecoder().decode(bytes))
        } catch {
          throw new GuardError('a sign-in response was not valid JSON', url.hostname)
        }
        if (body !== null && typeof body === 'object') {
          const b = body as Record<string, unknown>
          for (const f of ENDPOINT_FIELDS)
            if (typeof b[f] === 'string') checkUrlSyntax(b[f] as string, o.allowedLocalOrigin)
          const servers = b.authorization_servers
          if (Array.isArray(servers))
            for (const s of servers) if (typeof s === 'string') checkUrlSyntax(s, o.allowedLocalOrigin)
          const wanted = expectedIssuers(url)
          if (wanted.length && typeof b.issuer === 'string' && !wanted.includes(b.issuer.replace(/\/+$/, '')))
            throw new GuardError('the authorization server named a different issuer than the one asked', url.hostname)
          if (wanted.length && typeof b.issuer !== 'string')
            throw new GuardError('the authorization server metadata has no issuer', url.hostname)
        }
      }
      const headers = new Headers(res.headers)
      headers.delete('content-encoding')
      headers.delete('content-length')
      return new Response(bytes as unknown as BodyInit, { status: res.status, statusText: res.statusText, headers })
    }
  }
}

// ---- terminal text -----------------------------------------------------------------------------------------------------

/** Control characters and escape sequences printed visibly, never interpreted by the terminal. */
export function escapeForTerminal(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is made visible here
  return s.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

// ---- provider -----------------------------------------------------------------------------------------------------------

type Stored = { tokens?: OAuthTokens; client_info?: OAuthClientInformationMixed }

/** OAuth state in the Keychain only (items `oauth`). Interactive redirects are never performed here: they are captured. */
export class TalosOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined
  private verifier = ''
  private stateValue = b64urlEncode(new Uint8Array(randomBytes(32)))
  private cache: Stored | undefined

  constructor(
    private readonly secrets: ServerSecrets,
    private readonly id: string,
    private readonly redirect: string | undefined,
  ) {}

  get redirectUrl(): string | undefined {
    return this.redirect
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Talos app',
      redirect_uris: this.redirect ? [this.redirect] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }
  get expectedState(): string {
    return this.stateValue
  }
  state(): string {
    return this.stateValue
  }

  private async load(): Promise<Stored> {
    this.cache ??= ((await this.secrets.loadOauth(this.id)) as Stored | undefined) ?? {}
    return this.cache
  }
  private async persist(): Promise<void> {
    await this.secrets.saveOauth(this.id, this.cache ?? {})
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.load()).client_info
  }
  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const s = await this.load()
    s.client_info = info
    await this.persist()
  }
  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const s = await this.load()
    s.tokens = tokens
    await this.persist()
  }
  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url
  }
  saveCodeVerifier(v: string): void {
    this.verifier = v
  }
  codeVerifier(): string {
    return this.verifier
  }
}

// ---- the login flow --------------------------------------------------------------------------------------------------

export type LoginIO = {
  print(line: string): void
  /** y/N, default N. */
  confirm(question: string): Promise<boolean>
}

export type CallbackListener = {
  /** What the socket is actually bound to: 127.0.0.1, never 0.0.0.0, never `localhost`. */
  host: string
  port: number
  /** Resolves with the first VALID callback (`state` matched); null after the timeout. */
  wait(expectedState: string): Promise<{ code: string } | null>
  close(): void
}

export type ListenFn = (opts: {
  timeoutMs: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}) => Promise<CallbackListener>

const sameString = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** 127.0.0.1 only (never 0.0.0.0 or localhost), random port, /callback only, one use, closed at the first valid callback or the timeout. */
export const bunCallbackListener: ListenFn = async ({
  timeoutMs,
  setTimer = (f, m) => setTimeout(f, m),
  clearTimer = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}) => {
  let resolveWait: ((v: { code: string } | null) => void) | undefined
  let expected = ''
  let done = false
  let server: ReturnType<typeof Bun.serve> | undefined
  const finish = (v: { code: string } | null) => {
    if (done) return
    done = true
    clearTimer(timer)
    resolveWait?.(v)
    // let the response flush before the socket goes
    setTimeout(() => server?.stop(true), 50)
  }
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      if (u.pathname !== '/callback' || req.method !== 'GET' || done) return new Response('not found', { status: 404 })
      const code = u.searchParams.get('code')
      const state = u.searchParams.get('state')
      if (!code || !state || !expected || !sameString(state, expected))
        return new Response('bad request', { status: 400 })
      queueMicrotask(() => finish({ code }))
      return new Response('Signed in. You can close this tab and return to the terminal.', {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      })
    },
  })
  const timer = setTimer(() => finish(null), timeoutMs)
  return {
    host: server.hostname as string,
    port: server.port as number,
    wait(s) {
      expected = s
      return new Promise((res) => {
        resolveWait = res
        if (done) res(null)
      })
    },
    close: () => finish(null),
  }
}

export type LoginResult = { ok: true } | { ok: false; reason: string }

export const LOGIN_TIMEOUT_MS = 5 * 60_000

export async function runLogin(a: {
  serverUrl: string
  secrets: ServerSecrets
  serverId: string
  io: LoginIO
  guard: GuardOpts
  listen?: ListenFn
}): Promise<LoginResult> {
  const fetchFn = guardedFetch(a.guard)
  const listener = await (a.listen ?? bunCallbackListener)({ timeoutMs: LOGIN_TIMEOUT_MS })
  try {
    const provider = new TalosOAuthProvider(a.secrets, a.serverId, `http://127.0.0.1:${listener.port}/callback`)
    let first: string
    try {
      first = await auth(provider, { serverUrl: a.serverUrl, fetchFn })
    } catch (e) {
      return {
        ok: false,
        reason:
          e instanceof GuardError
            ? `${e.message}${e.host ? ` (${escapeForTerminal(e.host)})` : ''}`
            : isTimeout(e)
              ? 'the server did not answer in time'
              : 'the sign-in could not start',
      }
    }
    if (first === 'AUTHORIZED') return { ok: true }
    const authUrl = provider.authorizationUrl
    if (!authUrl) return { ok: false, reason: 'the server did not offer a sign-in page' }
    let checked: URL
    try {
      checked = checkUrlSyntax(authUrl.toString(), a.guard.allowedLocalOrigin)
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
    const serverHost = new URL(a.serverUrl).host
    a.io.print(`Signing in to ${escapeForTerminal(serverHost)} through ${escapeForTerminal(checked.host)}.`)
    if (checked.host !== serverHost) {
      const go = await a.io.confirm(
        `These are different sites. Continue only if you expect ${escapeForTerminal(checked.host)} to sign you in to ${escapeForTerminal(serverHost)}.`,
      )
      if (!go) return { ok: false, reason: 'stopped at your request' }
    }
    a.io.print('Open this address in your browser (Talos does not open it for you):')
    a.io.print(escapeForTerminal(checked.toString()))
    const got = await listener.wait(provider.expectedState)
    if (!got) return { ok: false, reason: 'timed out waiting for the sign-in (5 minutes)' }
    try {
      const second = await auth(provider, { serverUrl: a.serverUrl, authorizationCode: got.code, fetchFn })
      return second === 'AUTHORIZED' ? { ok: true } : { ok: false, reason: 'the sign-in did not complete' }
    } catch (e) {
      return {
        ok: false,
        reason:
          e instanceof GuardError
            ? e.message
            : isTimeout(e)
              ? 'the server did not answer in time'
              : 'the token exchange failed',
      }
    }
  } finally {
    listener.close()
  }
}
