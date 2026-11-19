// The Mac's setup of its peer inboxes (linked agents, P2): signed bridge HTTP only. The app API cannot make, change, rotate or
// list a `peer` connection, so a secret the inbox trusts is only ever minted here, for the Mac, and shown once.
import { PEER_DAILY_CAP_DEFAULT, PEER_MAX, PeerCreate, PeerName, routes } from '@talos-app/protocol'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { smallBodyGuard } from '../core/body-guard.ts'
import { bridgeAuth } from '../core/index.ts'
import type { AppEnv } from '../services.ts'
import { PEER_MARK, peerByName, peerCap, peerConns, peerLimit, receivedToday, removePeer } from './peer.ts'
import { runtimeFor } from './runtime.ts'
import { countConns, insertConn, rotateSecret } from './store.ts'
import { MAX_CONNECTIONS } from './types.ts'

/** These bodies are a name and a number. The guard runs before the signature is read, so an unsigned client cannot stream or stall. */
const BODY_CAP = 4096
const NO_STORE = { 'cache-control': 'no-store' } as const

export function bridgePeerRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const guard = smallBodyGuard(BODY_CAP)
  const authed = async (c: Context<AppEnv>): Promise<{ body: Uint8Array } | Response> => {
    const a = await bridgeAuth(c, BODY_CAP)
    return a instanceof Response ? a : { body: a.body }
  }

  app.post(routes.peerCreate.path, guard, async (c) => {
    const a = await authed(c)
    if (a instanceof Response) return a
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder().decode(a.body))
    } catch {
      return c.json({ error: 'bad_request' }, 400)
    }
    const body = PeerCreate.safeParse(raw)
    if (!body.success) return c.json({ error: 'bad_request' }, 400)
    const rt = runtimeFor(c.get('services'))
    if (peerByName(rt, body.data.name)) return c.json({ error: 'peer_exists' }, 409)
    if (peerLimit(rt)) return c.json({ error: 'too_many_peers', max: PEER_MAX }, 409)
    if (countConns(rt) >= MAX_CONNECTIONS) return c.json({ error: 'too_many_connections' }, 409)
    const cap = body.data.daily_cap ?? PEER_DAILY_CAP_DEFAULT
    const made = insertConn(rt, {
      integration: 'peer',
      name: body.data.name,
      thread: 'inbox', // unused: a peer message never becomes an event, so it has no thread
      filters: {},
      advanced: [],
      extra: { peer: PEER_MARK, daily_cap: String(cap) },
      creds: {},
    })
    return c.json(
      { conn_id: made.id, inbox_url: `${rt.services.env.PUBLIC_ORIGIN}/hook/peer/${made.id}`, secret: made.secret },
      201,
      NO_STORE,
    )
  })

  app.get(routes.peersList.path, async (c) => {
    const a = await authed(c)
    if (a instanceof Response) return a
    const rt = runtimeFor(c.get('services'))
    return c.json(
      peerConns(rt).map((p) => ({
        conn_id: p.id,
        name: p.name,
        daily_cap: peerCap(p) as number,
        created_at: rt.iso(p.created_at),
        received_today: receivedToday(rt, p.id),
      })),
      200,
      NO_STORE,
    )
  })

  app.delete(routes.peerDelete.path, guard, async (c) => {
    const a = await authed(c)
    if (a instanceof Response) return a
    const name = c.req.param('name') ?? ''
    // Idempotent: a name that is not a peer (or not a name) is already gone.
    if (PeerName.safeParse(name).success) removePeer(runtimeFor(c.get('services')), name)
    return c.json({ ok: true }, 200, NO_STORE)
  })

  app.post(routes.peerRotate.path, guard, async (c) => {
    const a = await authed(c)
    if (a instanceof Response) return a
    const rt = runtimeFor(c.get('services'))
    const name = c.req.param('name') ?? ''
    const peer = PeerName.safeParse(name).success ? peerByName(rt, name) : null
    if (!peer) return c.json({ error: 'not_found' }, 404)
    return c.json({ secret: rotateSecret(rt, peer.id) }, 200, NO_STORE) // the old secret keeps verifying for the store's 24 h grace
  })

  return app
}
