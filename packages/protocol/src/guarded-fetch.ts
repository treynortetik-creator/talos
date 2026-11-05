// The connect-time half of the web-address check (node and bun only: import it as `@talos-app/protocol/guarded-fetch`).
//
// Checking a name and then calling `fetch(name)` resolves the name twice, and a hostile DNS server can answer differently the
// second time (DNS rebinding). This fetch opens the socket itself with a `lookup` that classifies EVERY address the name
// resolves to, and hands the socket only an address it just approved. The check and the connection use the same answer.
// Redirects are never followed here: the caller reads the `location` header and runs the next URL through its own checks.
import { lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { isBlockedAddress, isBlockedHost, isLoopbackHost, parseIPv4 } from './address.ts'

export class BlockedAddressError extends Error {
  constructor(
    message: string,
    readonly host: string,
  ) {
    super(message)
    this.name = 'BlockedAddressError'
  }
}

export type GuardedFetchOptions = {
  /** Every A/AAAA address of a name. Default: the system resolver. Used for the connection too, so a test double cannot disagree with it. */
  resolve?: (host: string) => Promise<readonly string[]>
  /**
   * Named exception: let a loopback address (127.0.0.0/8, ::1) through. Off by default. Only for a local server the owner
   * approved; every other blocked range stays blocked.
   */
  allowLoopback?: boolean
  /** The error text for a refused address. */
  message?: string
  /**
   * The whole exchange, connection to last body byte, must finish inside this many milliseconds or the fetch (or its body)
   * fails with a `TimeoutError`. Default 30 000. 0 turns it off (a caller that streams for as long as it likes).
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MESSAGE = 'the host resolves to an address Talos will not contact'

const systemResolve = (host: string): Promise<string[]> =>
  new Promise((ok, fail) => {
    dnsLookup(host, { all: true }, (err, addrs) => (err ? fail(err) : ok(addrs.map((a) => a.address))))
  })

type LookupCb = (err: Error | null, addr: string | Array<{ address: string; family: number }>, family?: number) => void

/**
 * A `lookup` for http(s).request. Resolves, refuses unless every address is allowed, and returns only addresses that passed.
 * Exported so a test can drive the same function the production socket uses.
 */
export function checkedLookup(opts: GuardedFetchOptions = {}) {
  const resolve = opts.resolve ?? systemResolve
  const message = opts.message ?? DEFAULT_MESSAGE
  const allowed = (a: string) => !isBlockedAddress(a) || (opts.allowLoopback === true && isLoopbackHost(a))
  return (host: string, o: unknown, cb: LookupCb): void => {
    const wantAll = typeof o === 'object' && o !== null && (o as { all?: boolean }).all === true
    resolve(host).then(
      (addrs) => {
        const bad = addrs.length === 0 ? '' : addrs.find((a) => !allowed(a))
        if (addrs.length === 0 || bad !== undefined) return cb(new BlockedAddressError(message, host), '', 4)
        const list = addrs.map((address) => ({ address, family: parseIPv4(address) ? 4 : 6 }))
        if (wantAll) return cb(null, list)
        const first = list[0] as { address: string; family: number }
        cb(null, first.address, first.family)
      },
      (err: Error) => cb(err, '', 4),
    )
  }
}

function bodyOf(body: unknown): Uint8Array | string | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  throw new TypeError('guarded fetch: unsupported request body type') // never send a half-converted body
}

/** A fetch whose connection is checked at connect time. Rejects with `BlockedAddressError` for a blocked literal or a blocked resolution. */
export type GuardedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function createGuardedFetch(opts: GuardedFetchOptions = {}): GuardedFetch {
  const message = opts.message ?? DEFAULT_MESSAGE
  const lookup = checkedLookup(opts)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return (input, init) => {
    let url: URL
    try {
      url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url,
      )
    } catch (e) {
      return Promise.reject(e)
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      return Promise.reject(new TypeError(`guarded fetch: ${url.protocol} is not http(s)`))
    const literal = url.hostname
    // A literal never reaches `lookup` (the socket connects straight to it), so it is judged here.
    const literalBlocked = isBlockedHost(literal) && !(opts.allowLoopback === true && isLoopbackHost(literal))
    if (literalBlocked) return Promise.reject(new BlockedAddressError(message, literal))
    let payload: Uint8Array | string | undefined
    try {
      payload = bodyOf(init?.body)
    } catch (e) {
      return Promise.reject(e)
    }
    const headers: Record<string, string> = { 'accept-encoding': 'identity' }
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    const mod = url.protocol === 'https:' ? https : http
    const signal = init?.signal ?? undefined
    return new Promise<Response>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let req: http.ClientRequest | undefined
      let res: http.IncomingMessage | undefined
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      // Ends the exchange from outside the socket: before the headers it rejects the fetch, afterwards it errors the body.
      // Bun may never turn an aborted signal into a request error, so the signal and the timer are handled here, not by http.
      const stop = (why: unknown) => {
        const err = why instanceof Error ? why : new Error(String(why))
        if (!settled) {
          settled = true
          reject(err)
        }
        cleanup()
        res?.destroy(err)
        req?.destroy(err)
      }
      const onAbort = () => stop(signal?.reason ?? new DOMException('guarded fetch: aborted', 'AbortError'))
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs > 0)
        timer = setTimeout(() => stop(new DOMException('guarded fetch: timed out', 'TimeoutError')), timeoutMs)
      // Anything that throws while the response is being handed over becomes a rejected fetch, never an uncaught exception
      // (this callback runs outside the promise executor).
      const onResponse = (r: http.IncomingMessage) => {
        res = r
        r.on('error', () => {}) // a stream error after the hand-over reaches the reader through the body; none may go uncaught
        r.once('close', cleanup)
        try {
          const status = r.statusCode ?? 0
          if (!Number.isInteger(status) || status < 200 || status > 599)
            throw new Error(
              `guarded fetch: the server answered with status ${status}, which is not a usable HTTP status`,
            )
          const h = new Headers()
          for (const [k, v] of Object.entries(r.headers)) {
            if (Array.isArray(v)) for (const x of v) h.append(k, x)
            else if (v !== undefined) h.set(k, v)
          }
          const nullBody = status === 204 || status === 205 || status === 304
          const out = new Response(nullBody ? null : (Readable.toWeb(r) as unknown as ReadableStream), {
            status,
            headers: h,
          })
          if (settled) return r.destroy()
          settled = true
          resolve(out)
        } catch (e) {
          stop(e)
        }
      }
      try {
        req = mod.request(
          url,
          { method: init?.method ?? 'GET', headers, lookup: lookup as never, agent: false },
          // One fresh connection per request (agent: false). A pooled socket is keyed by host:port and skips `lookup`, so a
          // connection made when the name answered one way would be reused after it answered another.
          onResponse,
        )
        req.on('error', (e) => stop(e))
        if (payload !== undefined) req.write(payload)
        req.end()
      } catch (e) {
        stop(e)
      }
    })
  }
}
