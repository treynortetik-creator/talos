// Bridge-signed reads: `GET /bridge/raw/:event_id` and `GET /bridge/digest?since=` (spec 3.8, 7.4).
import { EventId, IsoTs, newUlid } from '@talos-app/protocol'
import { Hono } from 'hono'
import { verifyBridgeHttp } from '../auth/contract.ts'
import type { AppEnv } from '../services.ts'
import { buildDigestBody, eventsSince } from './digest.ts'
import { runtimeFor } from './runtime.ts'
import { DAY_MS } from './types.ts'

export function bridgeRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/bridge/raw/:event_id', async (c) => {
    const rt = runtimeFor(c.get('services'))
    const auth = await verifyBridgeHttp(c, new Uint8Array())
    if (!auth.ok) return c.json({ error: 'unauthorized' }, 401)
    const id = c.req.param('event_id')
    if (!EventId.safeParse(id).success) return c.json({ error: 'bad_request' }, 400)
    const { db, crypto } = rt.services
    const row = db
      .prepare(
        `select i.id, i.raw_enc from hooks_events e join hooks_inbound i on i.id = e.raw_id
         where e.event_id = ? and i.state != 'wiped'`,
      )
      .get(id) as { id: string; raw_enc: Buffer } | undefined
    if (!row || row.raw_enc.length === 0) return c.json({ error: 'not_found' }, 404)
    const bytes = crypto.decrypt(row.raw_enc, `hooks_inbound:${row.id}`)
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
  })

  app.get('/bridge/digest', async (c) => {
    const rt = runtimeFor(c.get('services'))
    const auth = await verifyBridgeHttp(c, new Uint8Array())
    if (!auth.ok) return c.json({ error: 'unauthorized' }, 401)
    const q = c.req.query('since')
    let since = rt.now() - DAY_MS
    if (q !== undefined) {
      const ok = IsoTs.safeParse(q)
      if (!ok.success) return c.json({ error: 'bad_request' }, 400)
      since = Date.parse(q)
    }
    const now = rt.now()
    const body = buildDigestBody(rt, eventsSince(rt, since), { start: since, end: now })
    return c.json({ v: 1, id: newUlid(), ts: rt.iso(now), type: 'hook.digest', ...body })
  })

  return app
}
