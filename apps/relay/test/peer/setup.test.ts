// Linked agents P2: the Mac's signed setup routes for peers (/bridge/peers). Only the bridge's signature reaches them; the
// secret is shown once; one connection per name; delete is a revoke; rotate keeps the old secret for the 24 h grace.
import { PEER_MAX, PeerCreated, PeerList } from '@talos-app/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORIGIN } from '../core/harness.ts'
import { type PeerWorld, peerWorld } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let w: PeerWorld | null = null
afterEach(async () => {
  await w?.r.stop()
  w = null
})
const world = async () => {
  w = await peerWorld()
  return w
}

describe('POST /bridge/peers', () => {
  it('creates a peer inbox and returns its url and secret once', async () => {
    const x = await world()
    const res = await x.mac('POST', '/bridge/peers', { name: 'work' })
    expect(res.status).toBe(201)
    const body = PeerCreated.parse(await res.json())
    expect(body.inbox_url).toBe(`${ORIGIN}/hook/peer/${body.conn_id}`)
    expect(body.secret).toMatch(/^whsec_/)
    const row = x.r.relay.services.db.prepare('select integration, name, extra from hooks_connections').get() as {
      integration: string
      name: string
      extra: string
    }
    expect(row).toMatchObject({ integration: 'peer', name: 'work' })
    expect(JSON.parse(row.extra)).toMatchObject({ peer: 'v1', daily_cap: '50' })
  })

  it('keeps only an encrypted copy of the secret', async () => {
    const x = await world()
    const c = await x.create('work')
    const dump = JSON.stringify(x.r.relay.services.db.prepare('select * from hooks_connections').all())
    expect(dump).not.toContain(c.secret)
  })

  it('takes a daily_cap from 1 to the maximum and refuses the rest', async () => {
    const x = await world()
    for (const bad of [0, 501, 1.5, '10', null]) {
      const res = await x.mac('POST', '/bridge/peers', { name: 'work', daily_cap: bad })
      expect(res.status, JSON.stringify(bad)).toBe(400)
    }
    expect((await x.mac('POST', '/bridge/peers', { name: 'work', daily_cap: 500 })).status).toBe(201)
    expect(x.count('hooks_connections')).toBe(1)
  })

  it('refuses a bad or reserved name and unknown keys', async () => {
    const x = await world()
    for (const body of [{ name: 'owner' }, { name: 'Work' }, { name: '' }, {}, { name: 'work', extra: 1 }, 'x'])
      expect((await x.mac('POST', '/bridge/peers', body)).status, JSON.stringify(body)).toBe(400)
    expect(x.count('hooks_connections')).toBe(0)
  })

  it('refuses a second create for the same name (409) and more than PEER_MAX', async () => {
    const x = await world()
    await x.create('work')
    const again = await x.mac('POST', '/bridge/peers', { name: 'work' })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: 'peer_exists' })
    for (let i = 1; i < PEER_MAX; i++) await x.create(`p${i}`)
    const over = await x.mac('POST', '/bridge/peers', { name: 'one-more' })
    expect(over.status).toBe(409)
    expect(await over.json()).toMatchObject({ error: 'too_many_peers' })
    expect(x.count('hooks_connections')).toBe(PEER_MAX)
  })
})

describe('GET /bridge/peers', () => {
  it('lists the peers with no secret, and how many arrived today', async () => {
    const x = await world()
    const a = await x.create('work', 7)
    await x.create('home')
    expect((await x.send(a, x.msg())).status).toBe(200)
    const res = await x.mac('GET', '/bridge/peers')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('whsec_')
    expect(text).not.toContain(a.secret)
    expect(text).not.toContain('secret')
    const list = PeerList.parse(JSON.parse(text))
    expect(list.map((p) => p.name).sort()).toEqual(['home', 'work'])
    expect(list.find((p) => p.name === 'work')).toEqual({
      conn_id: a.conn_id,
      name: 'work',
      daily_cap: 7,
      created_at: '2026-11-18T12:00:00.000Z',
      received_today: 1,
    })
    expect(list.find((p) => p.name === 'home')).toMatchObject({ daily_cap: 50, received_today: 0 })
  })

  it('counts the received messages of the UTC day, not the last 24 hours', async () => {
    const x = await world()
    const a = await x.create('work')
    await x.send(a, x.msg())
    x.clock.set(x.clock.now() + 12 * 3600_000) // 2026-11-19T00:00:00Z (moved, not replayed: see the rotate test)
    const list = PeerList.parse(await (await x.mac('GET', '/bridge/peers')).json())
    expect(list[0]?.received_today).toBe(0)
  })
})

describe('DELETE /bridge/peers/:name', () => {
  it('revokes: the sender gets 404 at once, nothing is stored, a second delete is fine', async () => {
    const x = await world()
    const a = await x.create('work')
    expect((await x.send(a, x.msg())).status).toBe(200)
    const del = await x.mac('DELETE', '/bridge/peers/work')
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true })
    const after = await x.send(a, x.msg())
    expect(after.status).toBe(404)
    expect(x.count('hooks_connections')).toBe(0)
    expect(x.count('hooks_inbound')).toBe(0)
    expect(x.count('hooks_dedup')).toBe(0)
    expect((await x.mac('DELETE', '/bridge/peers/work')).status).toBe(200)
    expect(PeerList.parse(await (await x.mac('GET', '/bridge/peers')).json())).toEqual([])
    // the name is free again, with a new connection and a new secret
    const b = await x.create('work')
    expect(b.conn_id).not.toBe(a.conn_id)
    expect((await x.send(a, x.msg())).status).toBe(404)
  })

  it('a name that is not a name changes nothing', async () => {
    const x = await world()
    await x.create('work')
    expect((await x.mac('DELETE', '/bridge/peers/OWNER')).status).toBe(200)
    expect(x.count('hooks_connections')).toBe(1)
  })
})

describe('POST /bridge/peers/:name/rotate', () => {
  it('returns a new secret once; the old one works for 24 hours, then not', async () => {
    const x = await world()
    const a = await x.create('work')
    const res = await x.mac('POST', '/bridge/peers/work/rotate')
    expect(res.status).toBe(200)
    const { secret } = (await res.json()) as { secret: string }
    expect(secret).toMatch(/^whsec_/)
    expect(secret).not.toBe(a.secret)
    expect((await x.send(a, x.msg())).status).toBe(200) // the old secret, inside the grace
    expect((await x.send({ conn_id: a.conn_id, secret }, x.msg())).status).toBe(200)
    // Moved, not replayed: advance() fires every relay timer due in those 24 h, one by one, which took 5.4 s, past the server's
    // 5 s keep-alive, so the next fetch went down a socket the relay was closing and failed with ECONNRESET (red main at
    // 50b976cb; 7 of 20 under load on Titan). The grace is read from the clock at each request; no timer has to run.
    x.clock.set(x.clock.now() + 24 * 3600_000 + 1000)
    expect((await x.send(a, x.msg())).status).toBe(401)
    expect((await x.send({ conn_id: a.conn_id, secret }, x.msg())).status).toBe(200)
    expect(JSON.stringify(await (await x.mac('GET', '/bridge/peers')).json())).not.toContain(secret)
  })

  it('an unknown peer is 404', async () => {
    const x = await world()
    expect((await x.mac('POST', '/bridge/peers/work/rotate')).status).toBe(404)
  })
})

describe('bridge auth', () => {
  it('refuses every route without the bridge signature, and the owner session does not count', async () => {
    const x = await world()
    await x.create('work')
    const calls: Array<[string, string, unknown?]> = [
      ['POST', '/bridge/peers', { name: 'home' }],
      ['GET', '/bridge/peers'],
      ['DELETE', '/bridge/peers/work'],
      ['POST', '/bridge/peers/work/rotate'],
    ]
    for (const [method, path, body] of calls) {
      for (const headers of [{}, x.r.appHeaders, { 'X-Test-Bridge': 'k' }]) {
        const res = await fetch(`${x.r.httpBase}${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        expect(res.status, `${method} ${path}`).toBe(401)
      }
    }
    expect(x.count('hooks_connections')).toBe(1) // nothing was made or removed
  })
})

describe('the app API', () => {
  it('never lists a peer, and can neither change it, test it, rotate it nor read its secret', async () => {
    const x = await world()
    const a = await x.create('work')
    const app = { ...x.r.appHeaders, 'content-type': 'application/json' }
    const list = await fetch(`${x.r.httpBase}/api/connections`, { headers: app })
    expect(list.status).toBe(200)
    const text = await list.text()
    expect(JSON.parse(text)).toEqual([])
    expect(text).not.toContain(a.conn_id)
    for (const [method, path] of [
      ['GET', `/api/connections/${a.conn_id}`],
      ['POST', `/api/connections/${a.conn_id}/test`],
      ['POST', `/api/connections/${a.conn_id}/rotate`],
      ['PATCH', `/api/connections/${a.conn_id}`],
    ] as const) {
      const res = await fetch(`${x.r.httpBase}${path}`, {
        method,
        headers: app,
        ...(method === 'GET' ? {} : { body: '{}' }),
      })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
    expect(x.count('hooks_connections')).toBe(1)
  })
})
