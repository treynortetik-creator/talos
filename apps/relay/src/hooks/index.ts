// WP3: /hook/* endpoint and pipeline, claim routes, connections + inbox API, bridge raw/digest, pollers, quiet window.
import { Hono } from 'hono'
import { takeRate } from '../auth/contract.ts'
import { pickClientIp } from '../client-ip.ts'
import { FrameRejected } from '../core/hub.ts'
import { hookGate } from '../core/upload-gate.ts'
import type { AppEnv, RelayServices } from '../services.ts'
import { apiRoutes } from './api.ts'
import { bridgeRoutes } from './bridge.ts'
import { handleClaim } from './claim.ts'
import { applyInboxUpdate } from './inbox.ts'
import { type HookResponse, handleHookRequest, idle, kick } from './ingest.ts'
import { markDelivered } from './route.ts'
import { createRuntime, runtimeFor, startTicking, tick } from './runtime.ts'
import { type BodyRead, MAX_BODY_BYTES } from './types.ts'

export type { RuntimeOptions } from './types.ts'
export { createRuntime, idle, kick, runtimeFor, tick }

/** The claim body is `{"claim_code": "..."}`: a few dozen bytes. */
const CLAIM_MAX_BYTES = 1024

const BODY_IDLE_MS = 10_000
const BODY_TOTAL_MS = 30_000

/** Reads at most `max` bytes; null if the sender sends more, 'slow' if it stalls (no chunk for `idleMs`, or `totalMs` in all). */
async function readCapped(
  req: Request,
  max: number,
  idleMs: number,
  totalMs: number,
): Promise<Uint8Array | null | 'slow'> {
  const reader = req.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  const stopAt = Date.now() + totalMs
  for (;;) {
    const wait = Math.min(idleMs, stopAt - Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = await Promise.race([
      reader.read(),
      new Promise<'slow'>((res) => {
        timer = setTimeout(() => res('slow'), Math.max(0, wait))
      }),
    ]).finally(() => clearTimeout(timer))
    if (next === 'slow') {
      reader.cancel().catch(() => undefined)
      return 'slow'
    }
    if (next.done) break
    total += next.value.byteLength
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks)
}

/**
 * The body read for a hook route. It runs before the signature can be checked (the signature covers the body), so it is
 * bounded three ways: only a few reads in flight at once (in all, and per address), a deadline for a sender that stalls,
 * and the size cap. A request that cannot get a slot is told to retry; one that stalls is cut.
 */
async function readGated(rt: ReturnType<typeof runtimeFor>, req: Request, ip: string, max: number): Promise<BodyRead> {
  const release = hookGate(rt.services).enter(ip)
  if (!release) return 'busy'
  try {
    return await readCapped(req, max, rt.opts.bodyIdleMs ?? BODY_IDLE_MS, rt.opts.bodyTotalMs ?? BODY_TOTAL_MS)
  } finally {
    release()
  }
}

/** The client address (see `pickClientIp`). Behind no socket info here, an unusable header reads as `unknown`. */
function clientIp(c: { req: { header(n: string): string | undefined } }, hops: number): string {
  return pickClientIp({ realIp: c.req.header('x-real-ip'), xff: c.req.header('x-forwarded-for'), hops })
}

function send(
  c: { body(data: string, status: number, headers: Record<string, string>): Response },
  r: HookResponse,
): Response {
  return c.body(r.body, r.status, {
    'content-type': r.contentType,
    'cache-control': 'no-store',
    // A sender cut off for stalling may still be mid-body: end the connection with the answer.
    ...(r.status === 408 ? { connection: 'close' } : {}),
  })
}

function hookRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  // No blanket rate limit here: the buckets are charged inside the pipeline, AFTER the connection resolved and the
  // signature verified, so unauthenticated junk cannot spend a real sender's budget (review #3).

  app.post('/hook/:integration/:connId/claim', async (c) => {
    const rt = runtimeFor(c.get('services'))
    const ip = clientIp(c, rt.services.env.TRUST_PROXY_HOPS)
    const declared = Number(c.req.header('content-length'))
    return send(
      c,
      await handleClaim(rt, {
        integration: c.req.param('integration'),
        connId: c.req.param('connId'),
        ip,
        ...(Number.isFinite(declared) ? { declaredLength: declared } : {}),
        maxBytes: CLAIM_MAX_BYTES,
        // Called only once the connection is known, and capped: an anonymous caller cannot make the relay buffer a body.
        readBody: () => readGated(rt, c.req.raw, ip, CLAIM_MAX_BYTES),
      }),
    )
  })

  app.all('/hook/:integration/:connId', async (c) => {
    const rt = runtimeFor(c.get('services'))
    if (c.req.method !== 'POST')
      return c.body(JSON.stringify({ error: 'method_not_allowed' }), 405, {
        allow: 'POST',
        'content-type': 'application/json',
      })
    const headers: Record<string, string> = {}
    c.req.raw.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    const ip = clientIp(c, rt.services.env.TRUST_PROXY_HOPS)
    const declared = Number(headers['content-length'])
    return send(
      c,
      await handleHookRequest(rt, {
        integration: c.req.param('integration'),
        connId: c.req.param('connId'),
        method: c.req.method,
        headers,
        url: c.req.url,
        ip,
        ...(Number.isFinite(declared) ? { declaredLength: declared } : {}),
        readBody: () => readGated(rt, c.req.raw, ip, MAX_BODY_BYTES),
        // Spec 5.4: 120/min per connection, 600/min in total. Charged only for verified deliveries.
        admit: (connId) => {
          if (!takeRate(c, 'hook_conn', connId).ok) return 'conn'
          return takeRate(c, 'hook').ok ? 'ok' : 'global'
        },
      }),
    )
  })
  // Anything else under /hook: GET (and every other method) is 405 (spec 7.1), unknown paths 404.
  app.all('/hook/*', (c) =>
    c.req.method === 'POST'
      ? c.json({ error: 'not_found' }, 404)
      : c.body(JSON.stringify({ error: 'method_not_allowed' }), 405, {
          allow: 'POST',
          'content-type': 'application/json',
        }),
  )
  return app
}

export const routes = new Hono<AppEnv>()
routes.route('/', hookRoutes())
routes.route('/', apiRoutes())
routes.route('/', bridgeRoutes())

export function register(services: RelayServices): void {
  const rt = runtimeFor(services) // tests install a configured runtime first
  const failed = (err: unknown) =>
    services.log.error({ err: err instanceof Error ? err.name : 'error' }, 'inbox.update failed')
  // Returned, not detached: the hub acks the app only after this write, and a throw here becomes a retryable error.
  // A change that applied to nothing (the item is gone, a snooze already past) is refused for good, so it is never acked as done.
  services.bus.onAppFrame('inbox.update', async (f) => {
    if (!(await applyInboxUpdate(rt, f, 'app')))
      throw new FrameRejected('bad_frame', 'That inbox change did not apply.')
  })
  services.bus.onBridgeFrame('inbox.update', (f) => void applyInboxUpdate(rt, f, 'bridge').catch(failed))
  // Any ack from the Mac means it has the frame (delivered or consumed).
  services.bus.onBridgeFrame('ack', (f) => markDelivered(rt, f.ref))
  startTicking(rt)
}
