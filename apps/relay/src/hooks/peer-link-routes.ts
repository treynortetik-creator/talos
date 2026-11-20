// One-paste link routes. Mint and collect are the Mac's signed routes; redeem is the OTHER install calling this relay with a code, so
// it has no signature: the code is the credential. It is rate limited before anything is read or checked, every failure is charged to
// the failed-verify bucket, and every failure of the code itself is the same answer, so a prober learns nothing.
import { PEER_LINK_UNUSABLE, PeerLinkRedeem, PeerName, routes } from '@talos-app/protocol'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { readBodyWithDeadline, smallBodyGuard } from '../core/body-guard.ts'
import { bridgeAuth } from '../core/index.ts'
import { clientIp } from '../core/util.ts'
import type { AppEnv } from '../services.ts'
import { chargeLinkFailure, linkFailuresOver } from './ingest.ts'
import { peerByName } from './peer.ts'
import { collectLink, mintLink, redeemLink } from './peer-link.ts'
import { runtimeFor } from './runtime.ts'

const BODY_CAP = 4096
const NO_STORE = { 'cache-control': 'no-store' } as const

const ipOf = (c: Context<AppEnv>): string => {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  return clientIp(
    { realIp: c.req.header('x-real-ip'), xff: c.req.header('x-forwarded-for') },
    incoming?.socket?.remoteAddress,
    c.get('services').env.TRUST_PROXY_HOPS,
  )
}

export function peerLinkRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const guard = smallBodyGuard(BODY_CAP)

  app.post(routes.peerLinkMint.path, guard, async (c) => {
    const a = await bridgeAuth(c, BODY_CAP)
    if (a instanceof Response) return a
    const rt = runtimeFor(c.get('services'))
    const name = c.req.param('name') ?? ''
    const peer = PeerName.safeParse(name).success ? peerByName(rt, name) : null
    if (!peer) return c.json({ error: 'not_found' }, 404)
    const made = mintLink(rt, peer.id)
    if (!made.ok) return c.json({ error: made.error }, 409)
    return c.json({ code: made.code }, 200, NO_STORE)
  })

  app.get(routes.peerLinkGet.path, async (c) => {
    const a = await bridgeAuth(c, BODY_CAP)
    if (a instanceof Response) return a
    const rt = runtimeFor(c.get('services'))
    const name = c.req.param('name') ?? ''
    const peer = PeerName.safeParse(name).success ? peerByName(rt, name) : null
    const state = peer ? collectLink(rt, peer.id) : null
    return state ? c.json(state, 200, NO_STORE) : c.json({ error: 'not_found' }, 404)
  })

  app.post(routes.peerLinkRedeem.path, guard, async (c) => {
    const rt = runtimeFor(c.get('services'))
    const log = rt.services.log
    const ip = ipOf(c)
    // asked first, before the body is read or anything is checked: a client past its budget gets nothing more to learn from
    if (linkFailuresOver(rt, ip)) return c.json({ error: 'too_many_requests' }, 429, { 'retry-after': '60' })
    const fail = (why: string, status: number, error: string): Response => {
      chargeLinkFailure(rt, ip)
      log.info({ why }, 'peer link redeem refused') // the reason, never the token
      return c.json({ error }, status as 400, NO_STORE)
    }
    const read = await readBodyWithDeadline(c, BODY_CAP)
    if (!read.ok)
      return c.json(
        { error: read.why === 'timeout' ? 'request_timeout' : 'payload_too_large' },
        read.why === 'timeout' ? 408 : 413,
      )
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder().decode(read.body))
    } catch {
      return fail('bad_body', 400, 'bad_request')
    }
    const body = PeerLinkRedeem.safeParse(raw)
    if (!body.success) return fail('bad_body', 400, 'bad_request')
    const done = redeemLink(rt, {
      connId: body.data.conn_id,
      token: body.data.token,
      backUrl: body.data.back.url,
      backSecret: body.data.back.secret,
    })
    if (!done.ok) return fail(done.why, 404, PEER_LINK_UNUSABLE)
    log.info({ why: 'redeemed' }, 'peer link redeemed')
    return c.json({ secret: done.secret }, 200, NO_STORE)
  })
  return app
}
