// Body-size and body-time guards for the upload routes.
import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../services.ts'

/** How long a request may go without a byte arriving (and, unless `stopWhenBodyIn` is set, once the body is in, without the handler finishing). */
const BODY_TIMEOUT_MS = 15_000
/** Hard ceiling for one request however steadily it trickles: a client sending a byte every 14 s must not hold a slot forever. */
const BODY_MAX_TOTAL_MS = 10 * 60_000

/** Requests the client was already told `408` for: a body that completes late must not be acted on. */
const timedOutRequests = new WeakSet<Request>()
export const lateRequest = (c: Context<AppEnv>): boolean => timedOutRequests.has(c.req.raw)

/**
 * Wrapping a body means a new `Request`, and anything keyed on the old one (the share route's token) would stop finding
 * its entry. So each replacement is remembered, and `originalRequest(c)` walks back to the request the route first saw.
 */
const replacedBy = new WeakMap<Request, Request>()
export function originalRequest(c: Context<AppEnv>): Request {
  let r = c.req.raw
  for (let prev = replacedBy.get(r); prev; prev = replacedBy.get(r)) r = prev
  return r
}

/**
 * One abort signal per request (keyed on the request the route first saw), tripped by whichever deadline guard answers
 * 408. A handler that is parked in a body read watches it, so a request the client was told "408" for stops waiting and
 * gives back anything it holds (an in-flight slot); without it the read stays parked after the answer is sent.
 */
const deadlines = new WeakMap<Request, AbortController>()
const deadlineOf = (c: Context<AppEnv>): AbortController => {
  const root = originalRequest(c)
  let ctl = deadlines.get(root)
  if (!ctl) {
    ctl = new AbortController()
    deadlines.set(root, ctl)
  }
  return ctl
}

export type BodyRead = { ok: true; body: Uint8Array } | { ok: false; why: 'timeout' | 'too_large' }

/**
 * Reads the whole body, but stops waiting the moment the request's deadline guard has answered 408 (the stream is
 * cancelled, so the socket's bytes are dropped) or the body passes `maxBytes`. A client that hangs up makes the read
 * throw, which the caller's `finally` handles. This is what lets a caller that holds a slot always give it back.
 */
export async function readBodyWithDeadline(c: Context<AppEnv>, maxBytes: number): Promise<BodyRead> {
  const signal = deadlineOf(c).signal
  const stream = c.req.raw.body
  if (!stream) return { ok: true, body: new Uint8Array(0) }
  const reader = stream.getReader()
  const aborted = new Promise<'timeout'>((resolve) => {
    if (signal.aborted) resolve('timeout')
    else signal.addEventListener('abort', () => resolve('timeout'), { once: true })
  })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted])
      if (next === 'timeout') return { ok: false, why: 'timeout' }
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) return { ok: false, why: 'too_large' }
      chunks.push(next.value)
    }
  } finally {
    reader.cancel().catch(() => undefined) // a no-op once the stream is done
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const ch of chunks) {
    body.set(ch, at)
    at += ch.byteLength
  }
  return { ok: true, body }
}

/** Passes the body through unchanged and calls `onProgress` each time a chunk arrives (false) or the body ends (true). */
function watchBody(req: Request, onProgress: (ended: boolean) => void): Request {
  const body = req.body
  if (!body) return req
  const reader = body.getReader()
  const watched = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      onProgress(done)
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel: (reason) => reader.cancel(reason),
  })
  return new Request(req, { body: watched, duplex: 'half' } as RequestInit)
}

function timeoutGuard(
  ms: number,
  maxTotalMs: number,
  idleMode: boolean,
  stopWhenBodyIn = false,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // Timers run on the relay's clock when there is one, so a test can move time; without services (a bare app) they are real.
    const clock = c.get('services')?.clock
    const setT = (fn: () => void, t: number): unknown => (clock ? clock.setTimeout(fn, t) : setTimeout(fn, t))
    const clearT = (h: unknown): void =>
      clock ? clock.clearTimeout(h) : clearTimeout(h as ReturnType<typeof setTimeout>)
    let idle: unknown
    let total: unknown
    let fire: (() => void) | undefined
    const deadline = deadlineOf(c)
    const timedOut = new Promise<'timeout'>((resolve) => {
      fire = () => {
        resolve('timeout')
        deadline.abort()
      }
    })
    if (idleMode) {
      const arm = (ended = false) => {
        clearT(idle)
        if (ended && stopWhenBodyIn) {
          // The body is in: this guard has done its job, and the handler's own deadline takes over.
          clearT(total)
          return
        }
        idle = setT(() => fire?.(), ms)
      }
      const before = c.req.raw
      c.req.raw = watchBody(before, arm)
      if (c.req.raw !== before) replacedBy.set(c.req.raw, before)
      arm()
    }
    total = setT(() => fire?.(), idleMode ? maxTotalMs : ms)
    try {
      const r = await Promise.race([next().then(() => 'done' as const), timedOut])
      if (r === 'timeout') {
        timedOutRequests.add(c.req.raw)
        c.res = c.json({ error: 'request_timeout' }, 408, { Connection: 'close' })
      }
    } finally {
      clearT(idle)
      clearT(total)
    }
  }
}

/**
 * A fixed deadline for the whole request: for routes that must read the entire body BEFORE they can check who sent it
 * (the bridge's signed routes, enroll), where a slow trickle would otherwise hold memory and a socket for an
 * unauthenticated caller. After `ms` the client gets 408 and `lateRequest(c)` is true.
 */
export const bodyTimeout = (ms: number = BODY_TIMEOUT_MS): MiddlewareHandler<AppEnv> => timeoutGuard(ms, ms, false)

/**
 * An idle timeout, not a total one: a slow phone upload (50 MB over a weak link) keeps going while bytes keep arriving.
 * After `ms` with no byte the client gets 408 and `lateRequest(c)` is true, so a handler that wakes up late saves
 * nothing. By default the idle window keeps running after the body is in, so a handler that then stalls for `ms` is cut
 * too; `opts.stopWhenBodyIn` ends the guard once the body is in and leaves the handler to its own deadline. `maxTotalMs`
 * bounds the whole request. ONLY for routes that
 * authenticate before they read the body (/api/media, /api/share): it lets an unauthenticated caller hold a slot longer.
 */
export const idleBodyTimeout = (
  ms: number = BODY_TIMEOUT_MS,
  maxTotalMs: number = BODY_MAX_TOTAL_MS,
  opts: { stopWhenBodyIn?: boolean } = {},
): MiddlewareHandler<AppEnv> => timeoutGuard(ms, maxTotalMs, true, opts.stopWhenBodyIn === true)

/** Requests whose body passed `maxSize` while it streamed. The handler was handed an error, so the answer is 413. */
const overLimit = new WeakSet<Request>()

/**
 * Caps the request body. Lazy on purpose: Hono's own `bodyLimit` reads a chunked body to the end BEFORE the handler runs
 * (to count it), so a stranger could make the relay hold `maxSize` bytes on a route that was about to refuse them anyway.
 * This one counts bytes only as the handler pulls them. A declared length over the cap is refused with 413 straight away;
 * a body that outgrows the cap while streaming is cut, the read fails, and the answer is 413 whatever the handler made of it.
 */
export function limitBody(maxSize: (c: Context<AppEnv>) => number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const before = c.req.raw
    const source = before.body
    if (!source) return next()
    const max = maxSize(c)
    const declared = before.headers.get('content-length')
    if (declared !== null && !before.headers.has('transfer-encoding')) {
      if (Number.parseInt(declared, 10) > max) return c.json({ error: 'too_large' }, 413)
      return next()
    }
    const reader = source.getReader()
    let size = 0
    const limited = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) return controller.close()
          size += value.byteLength
          if (size > max) {
            overLimit.add(limitedReq)
            reader.cancel().catch(() => undefined)
            return controller.error(new Error('request body too large'))
          }
          controller.enqueue(value)
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    ) // pull only when the handler reads: nothing is taken ahead of time
    const limitedReq = new Request(before, { body: limited, duplex: 'half' } as RequestInit)
    replacedBy.set(limitedReq, before)
    c.req.raw = limitedReq
    let thrown: unknown
    try {
      await next()
    } catch (e) {
      thrown = e
    }
    if (overLimit.has(limitedReq)) {
      c.res = c.json({ error: 'too_large' }, 413)
      return
    }
    if (thrown) throw thrown
  }
}

/** Most JSON bodies the relay takes are a few hundred bytes (a passkey ceremony is a few KB). 64 KiB is far above that. */
export const DEFAULT_BODY_CAP = 64 * 1024

/**
 * Routes that carry big bodies and cap them themselves, with their own limit and an identity check in the right order:
 * media upload (/api/media, /bridge/media), share (/api/share, and /share-target which reads nothing), the Mac's frame post (/bridge/post, 256 KiB) and
 * the hook receiver (/hook, 1 MB, read by hand). Everything else gets `DEFAULT_BODY_CAP`.
 */
export function ownsItsBodyCap(pathname: string, method: string): boolean {
  if (pathname === '/api/media') return true
  if (pathname === '/api/dictate') return true
  if (pathname.startsWith('/bridge/media/')) return true
  if (pathname === '/api/share' && method === 'POST') return true
  // The share-target POST never reads its body: it answers 303 to the page that explains the share was lost. A capped
  // 413 here would show the owner bare JSON instead of that page.
  if (pathname === '/share-target' && method === 'POST') return true
  if (pathname === '/bridge/post') return true
  if (pathname === '/hook' || pathname.startsWith('/hook/')) return true
  return false
}

/**
 * A blanket cap for the whole app, so a route added later is covered without anyone remembering. It only counts the
 * bytes as they stream (413 the moment the cap is passed), it reads nothing itself.
 */
export function globalBodyCap(): MiddlewareHandler<AppEnv> {
  const cap = limitBody(() => DEFAULT_BODY_CAP)
  return (c, next) => {
    const m = c.req.method
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next()
    if (ownsItsBodyCap(new URL(c.req.url).pathname, m)) return next()
    return cap(c, next)
  }
}

/**
 * True if the request has any body byte. Looks at the declared length, then reads at most the first chunk: it never
 * buffers the body, so it is safe in front of identity checks. A body that trickles is cut by `bodyTimeout`.
 */
export async function hasBodyBytes(req: Request): Promise<boolean> {
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > 0) return true
  const body = req.body
  if (!body) return false
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return false
      if (value.byteLength > 0) return true
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

/**
 * Size cap plus a deadline for routes that read a small body before they can tell who is asking (sign-in, enrollment,
 * revoke). Bodies there are tiny, so the deadline is short; a GET passes untouched.
 */
export function smallBodyGuard(
  maxBytes: number = DEFAULT_BODY_CAP,
  ms: number = BODY_TIMEOUT_MS,
): MiddlewareHandler<AppEnv> {
  const cap = limitBody(() => maxBytes)
  const timer = bodyTimeout(ms)
  return (c, next) => {
    const m = c.req.method
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next()
    return cap(c, async () => {
      await timer(c, next)
    })
  }
}
