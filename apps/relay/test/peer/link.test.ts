// One-paste link, relay side: mint (the Mac's signed route), redeem (anyone, with the code), collect (the Mac's signed route).
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPeerInboxUrl, PEER_LINK_TTL_MS, parsePeerLinkCode, peerInboxUrl } from '@talos-app/protocol'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeFor } from '../../src/hooks/index.ts'
import { purge } from '../../src/hooks/runtime.ts'
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../../src/migrate.ts'
import type { Logger } from '../../src/services.ts'
import { ORIGIN } from '../core/harness.ts'
import { type PeerWorld, peerWorld } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
let w: PeerWorld | null = null
afterEach(async () => {
  await w?.r.stop()
  w = null
})
const world = async (env: Record<string, string> = {}) => (w = await peerWorld(env))

const BACK_CONN = 'cn_BBBBBBBBBBBBBBBBBBBBBB'
const BACK_URL = peerInboxUrl('https://b.example.com', BACK_CONN)
const BACK_SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`
const back = { url: BACK_URL, secret: BACK_SECRET }

async function mint(x: PeerWorld, name = 'work') {
  const res = await x.mac('POST', `/bridge/peers/${name}/link`, {})
  return res
}
async function minted(x: PeerWorld, name = 'work') {
  const c = await x.create(name)
  const res = await mint(x, name)
  expect(res.status).toBe(200)
  const { code } = (await res.json()) as { code: string }
  const p = parsePeerLinkCode(code)
  if (!p.ok) throw new Error('bad code')
  return { c, code, ...p.value }
}
const redeem = (x: PeerWorld, body: unknown) =>
  fetch(`${x.r.httpBase}/peer-link/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const links = (x: PeerWorld) =>
  x.r.relay.services.db.prepare('select * from hooks_peer_links').all() as Array<Record<string, unknown>>

describe('mint', () => {
  it('returns a code for this relay, 15 minutes, with only the token hash stored', async () => {
    const x = await world()
    const m = await minted(x)
    expect(m.host).toBe('relay.example.com')
    expect(m.conn_id).toBe(m.c.conn_id)
    const rows = links(x)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.token_hash).toBe(createHash('sha256').update(m.token).digest('hex'))
    expect(rows[0]?.state).toBe('open')
    expect(rows[0]?.expires_at).toBe(x.clock.now() + PEER_LINK_TTL_MS)
    expect(JSON.stringify(rows)).not.toContain(m.token)
  })
  it('needs the bridge signature and a known peer', async () => {
    const x = await world()
    await x.create('work')
    const anon = await fetch(`${x.r.httpBase}/bridge/peers/work/link`, { method: 'POST', body: '{}' })
    expect(anon.status).toBe(401)
    expect((await mint(x, 'nobody')).status).toBe(404)
  })
  it('a new mint replaces the open code', async () => {
    const x = await world()
    const first = await minted(x)
    const second = (await (await mint(x)).json()) as { code: string }
    const p = parsePeerLinkCode(second.code)
    expect(p.ok && p.value.token).not.toBe(first.token)
    expect(links(x)).toHaveLength(1)
    const old = await redeem(x, { conn_id: first.conn_id, token: first.token, back })
    expect(old.status).toBe(404)
    if (p.ok) expect((await redeem(x, { conn_id: first.conn_id, token: p.value.token, back })).status).toBe(200)
  })
  it('refuses when the relay origin cannot make a code', async () => {
    const x = await world({ PUBLIC_ORIGIN: 'http://relay.example.com:8080' })
    await x.create('work')
    const res = await mint(x)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'link_origin' })
  })
  it('refuses to replace a redeemed code that was not collected', async () => {
    const x = await world()
    const m = await minted(x)
    expect((await redeem(x, { conn_id: m.conn_id, token: m.token, back })).status).toBe(200)
    const res = await mint(x)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'link_pending' })
  })
})

describe('redeem and collect', () => {
  it('round trip: redeem gives A secret once, collect gives B url and secret once', async () => {
    const x = await world()
    const m = await minted(x)
    const res = await redeem(x, { conn_id: m.conn_id, token: m.token, back })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { secret: string }
    expect(body).toEqual({ secret: m.c.secret }) // the connection's own secret, nothing else (no name)
    expect(res.headers.get('cache-control')).toBe('no-store')
    // the stored back secret is encrypted
    const dump = JSON.stringify(links(x))
    expect(dump).not.toContain(BACK_SECRET)
    expect(links(x)[0]).toMatchObject({ state: 'redeemed', back_url: BACK_URL })

    const g = await x.mac('GET', '/bridge/peers/work/link')
    expect(g.status).toBe(200)
    expect(await g.json()).toEqual({ state: 'redeemed', back_url: BACK_URL, back_secret: BACK_SECRET })
    // once: the ciphertext is gone and the state is collected
    expect(links(x)[0]).toMatchObject({ state: 'collected', back_secret_enc: null })
    const again = await x.mac('GET', '/bridge/peers/work/link')
    expect(await again.json()).toEqual({ state: 'collected' })
    // the secret really signs for the inbox
    expect((await x.send(m.c, x.msg())).status).toBe(200)
  })
  it('GET before redeem is open; after expiry it is expired', async () => {
    const x = await world()
    await minted(x)
    expect(await (await x.mac('GET', '/bridge/peers/work/link')).json()).toEqual({ state: 'open' })
    x.clock.set(x.clock.now() + PEER_LINK_TTL_MS + 1000)
    expect(await (await x.mac('GET', '/bridge/peers/work/link')).json()).toEqual({ state: 'expired' })
    expect((await x.mac('GET', '/bridge/peers/other/link')).status).toBe(404)
  })
  it('is single use', async () => {
    const x = await world()
    const m = await minted(x)
    expect((await redeem(x, { conn_id: m.conn_id, token: m.token, back })).status).toBe(200)
    const second = await redeem(x, { conn_id: m.conn_id, token: m.token, back })
    expect(second.status).toBe(404)
    expect(await second.json()).toEqual({ error: 'link_unusable' })
  })
  it('a second use of a valid token is noticed on the Mac read; a wrong guess is not', async () => {
    const x = await world()
    const m = await minted(x)
    expect((await redeem(x, { conn_id: m.conn_id, token: m.token, back })).status).toBe(200)
    expect((await redeem(x, { conn_id: m.conn_id, token: 'E'.repeat(43), back })).status).toBe(404)
    expect(await (await x.mac('GET', '/bridge/peers/work/link')).json()).toMatchObject({ state: 'redeemed' })
    expect((await redeem(x, { conn_id: m.conn_id, token: m.token, back })).status).toBe(404)
    expect(await (await x.mac('GET', '/bridge/peers/work/link')).json()).toEqual({ state: 'collected', replayed: true })
  })
  it('two concurrent redeems: exactly one wins', async () => {
    const x = await world()
    const m = await minted(x)
    const all = await Promise.all(
      Array.from({ length: 6 }, () => redeem(x, { conn_id: m.conn_id, token: m.token, back })),
    )
    expect(all.filter((r) => r.status === 200)).toHaveLength(1)
    expect(all.filter((r) => r.status === 404)).toHaveLength(5)
  })
  it('expires after 15 minutes', async () => {
    const x = await world()
    const m = await minted(x)
    x.clock.set(x.clock.now() + PEER_LINK_TTL_MS + 1)
    const res = await redeem(x, { conn_id: m.conn_id, token: m.token, back })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'link_unusable' })
  })
  it('every failure is the same 404', async () => {
    const x = await world()
    const m = await minted(x)
    const wrong = await redeem(x, { conn_id: m.conn_id, token: 'B'.repeat(43), back })
    const unknown = await redeem(x, { conn_id: 'cn_ZZZZZZZZZZZZZZZZZZZZZZ', token: m.token, back })
    for (const r of [wrong, unknown]) {
      expect(r.status).toBe(404)
      expect(await r.json()).toEqual({ error: 'link_unusable' })
    }
    // the real code still works after wrong guesses
    expect((await redeem(x, { conn_id: m.conn_id, token: m.token, back })).status).toBe(200)
  })
  it('a bad back.url or secret is refused and leaves the code open', async () => {
    const x = await world()
    const m = await minted(x)
    const bads = [
      { url: `http://b.example.com/hook/peer/${BACK_CONN}`, secret: BACK_SECRET },
      { url: `https://127.0.0.1/hook/peer/${BACK_CONN}`, secret: BACK_SECRET },
      { url: `https://10.1.2.3/hook/peer/${BACK_CONN}`, secret: BACK_SECRET },
      { url: BACK_URL, secret: 'whsec_short' },
      { url: BACK_URL, secret: 'not-a-secret' },
    ]
    for (const b of bads) {
      const res = await redeem(x, { conn_id: m.conn_id, token: m.token, back: b })
      expect([400, 404], JSON.stringify(b)).toContain(res.status)
    }
    expect(links(x)[0]?.state).toBe('open')
    // wait out the bucket: bad bodies count as failures, so a fresh minute
    x.clock.advance(61_000)
    expect((await redeem(x, { conn_id: m.conn_id, token: m.token, back })).status).toBe(200)
  })
  it('wrong tokens charge the bucket; once over, even the right code is refused 429 until the minute passes', async () => {
    const x = await world()
    const m = await minted(x)
    let last = 0
    for (let i = 0; i < 25; i++) {
      last = (await redeem(x, { conn_id: m.conn_id, token: 'C'.repeat(43), back })).status
      if (last === 429) break
    }
    expect(last).toBe(429)
    expect((await redeem(x, { conn_id: m.conn_id, token: m.token, back })).status).toBe(429)
    expect(links(x)[0]?.state).toBe('open')
    x.clock.advance(61_000)
    expect((await redeem(x, { conn_id: m.conn_id, token: m.token, back })).status).toBe(200)
  })
  it('refuses a body that is not json, unknown keys, and an oversized body', async () => {
    const x = await world()
    const m = await minted(x)
    const raw = (body: string) =>
      fetch(`${x.r.httpBase}/peer-link/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
    expect((await raw('nope')).status).toBe(400)
    expect((await redeem(x, { conn_id: m.conn_id, token: m.token, back, extra: 1 })).status).toBe(400)
    expect((await raw(JSON.stringify({ pad: 'x'.repeat(10_000) }))).status).toBe(413)
  })
  it('removing the peer removes its codes', async () => {
    const x = await world()
    await minted(x)
    expect((await x.mac('DELETE', '/bridge/peers/work')).status).toBe(200)
    expect(links(x)).toHaveLength(0)
  })
  it('sweeps rows 24 h after they expired or were collected', async () => {
    const x = await world()
    const m = await minted(x)
    await redeem(x, { conn_id: m.conn_id, token: m.token, back })
    await x.mac('GET', '/bridge/peers/work/link') // collected
    expect(links(x)).toHaveLength(1)
    x.clock.set(x.clock.now() + 25 * 3600_000)
    x.clock.advance(60_000)
    purge(runtimeFor(x.r.relay.services))
    expect(links(x)).toHaveLength(0)
  })
  it('never logs the token', async () => {
    const lines: string[] = []
    const mk = (): Logger => {
      const f = (...a: unknown[]) => void lines.push(JSON.stringify(a))
      return { debug: f, info: f, warn: f, error: f, child: mk } as unknown as Logger
    }
    w = await peerWorld({}, mk())
    const m = await minted(w)
    await redeem(w, { conn_id: m.conn_id, token: 'D'.repeat(43), back })
    await redeem(w, { conn_id: m.conn_id, token: m.token, back })
    await redeem(w, { conn_id: m.conn_id, token: m.token, back })
    const all = lines.join('\n')
    expect(all).not.toContain(m.token)
    expect(all).not.toContain(BACK_SECRET)
    expect(all).toContain('already_used')
    expect(all).toContain('wrong_token')
  })
})

describe('migration', () => {
  it('runs on a database that already has the earlier hooks migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    try {
      cpSync(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true })
      rmSync(join(dir, 'hooks', '0004_peer_links.sql'), { force: true })
      const db = new Database(':memory:')
      migrate(db, { dir })
      db.prepare(
        "insert into hooks_connections (id, integration, name, thread, status, filters, advanced, extra, secret_enc, created_at) values ('cn_x','peer','work','inbox','active','{}','[]','{}',x'00',1)",
      ).run()
      migrate(db) // the real directory: only the new file is pending
      expect(db.prepare('select count(*) as n from hooks_peer_links').get()).toEqual({ n: 0 })
      expect(db.prepare('select count(*) as n from hooks_connections').get()).toEqual({ n: 1 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

void checkPeerInboxUrl
void ORIGIN
