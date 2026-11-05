// Adversarial review of PR #52 (Share P1), relay part: the two signed bridge routes POST /bridge/share/tokens and
// DELETE /bridge/share/tokens/:id against the REAL relay (startTestRelay: real hub, real share module, test auth that
// verifies the real TalosBridge signature and burns nonces).
//
// Tests under "FAILS on PR #52" are defects. Everything else is a guard that held on the PR head (11e543e).
import { request } from 'node:http'
import { generateBridgeKey, MAX_FRAME_BYTES, signBridgeHttp } from '@talos-app/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORIGIN, startTestRelay, type TestRelay } from '../core/harness.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const DEV = 'd_abcdefghijklmnopqrst'
const DEV2 = 'd_bcdefghijklmnopqrstu'
const sess = (device = DEV) => ({ 'X-Test-Session': device, Origin: ORIGIN, 'X-Talos-CSRF': '1' })

function addDevice(r: TestRelay, id = DEV, o: { pinned?: number; revoked?: number } = {}) {
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, 'phone', '{}', 'b', o.pinned ?? 1, o.revoked ?? 0, Date.now())
}

type Signer = { privateKey: CryptoKey; keyId: string }

/** A signed bridge request, plus the raw pieces so a test can replay or redirect it. */
async function signed(r: TestRelay, method: string, path: string, body?: unknown, key: Signer = r.bridgeKey) {
  const raw = body === undefined ? undefined : JSON.stringify(body)
  const authorization = await signBridgeHttp({
    privateKey: key.privateKey,
    keyId: key.keyId,
    method,
    pathWithQuery: path,
    ...(raw !== undefined ? { body: raw } : {}),
  })
  const send = (p = path, m = method) =>
    fetch(`${r.httpBase}${p}`, {
      method: m,
      ...(raw !== undefined ? { body: raw } : {}),
      headers: { authorization, ...(raw !== undefined ? { 'content-type': 'application/json' } : {}) },
    })
  return { authorization, raw, send }
}

const mintBody = (over: Record<string, unknown> = {}) => ({
  label: 'iPhone (exported 2026-10-29)',
  device_id: DEV,
  scopes: ['text'],
  ...over,
})

async function bridgeMint(r: TestRelay, over: Record<string, unknown> = {}) {
  const res = await (await signed(r, 'POST', '/bridge/share/tokens', mintBody(over))).send()
  expect(res.status).toBe(200)
  return (await res.json()) as { token: { id: string; device_id: string; scopes: string[] }; secret: string }
}

const share = (r: TestRelay, secret: string, text = 'hi') =>
  fetch(`${r.httpBase}/api/share`, {
    method: 'POST',
    body: JSON.stringify({ text }),
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
  })

const live = (r: TestRelay) =>
  (
    r.relay.services.db.prepare('select count(*) n from core_share_tokens where revoked_at is null').get() as {
      n: number
    }
  ).n

describe('held: bridge-sig on the new routes', () => {
  it('a recorded signed DELETE replayed is 401 (nonce burned); a recorded signed POST replayed mints nothing', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const a = await bridgeMint(relay)
    const del = await signed(relay, 'DELETE', `/bridge/share/tokens/${a.token.id}`)
    expect((await del.send()).status).toBe(204)
    expect((await del.send()).status).toBe(401)

    const post = await signed(relay, 'POST', '/bridge/share/tokens', mintBody())
    expect((await post.send()).status).toBe(200)
    const before = live(relay)
    expect((await post.send()).status).toBe(401)
    expect(live(relay)).toBe(before)
  })

  it("a signature over token A's path does not revoke token B (the path is signed)", async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const a = await bridgeMint(relay)
    const b = await bridgeMint(relay)
    const forA = await signed(relay, 'DELETE', `/bridge/share/tokens/${a.token.id}`)
    expect((await forA.send(`/bridge/share/tokens/${b.token.id}`)).status).toBe(401)
    expect((await share(relay, b.secret)).status).toBe(202)
    // and a signed POST cannot be turned into a DELETE
    const p = await signed(relay, 'POST', '/bridge/share/tokens', mintBody())
    expect((await p.send(`/bridge/share/tokens/${a.token.id}`, 'DELETE')).status).toBe(401)
    expect((await share(relay, a.secret)).status).toBe(202)
  })

  it('a key the relay does not trust is 401 on both routes; nothing is minted or revoked', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const a = await bridgeMint(relay)
    const stranger = await generateBridgeKey()
    expect((await (await signed(relay, 'POST', '/bridge/share/tokens', mintBody(), stranger)).send()).status).toBe(401)
    expect(
      (await (await signed(relay, 'DELETE', `/bridge/share/tokens/${a.token.id}`, undefined, stranger)).send()).status,
    ).toBe(401)
    // the stranger reusing the real key_id with its own signature
    const forged = { privateKey: stranger.privateKey, keyId: relay.bridgeKey.keyId }
    expect(
      (await (await signed(relay, 'DELETE', `/bridge/share/tokens/${a.token.id}`, undefined, forged)).send()).status,
    ).toBe(401)
    expect((await share(relay, a.secret)).status).toBe(202)
    expect(live(relay)).toBe(1)
  })

  it('a session (Settings cookie path) cannot reach the bridge routes', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const a = await bridgeMint(relay)
    const res = await fetch(`${relay.httpBase}/bridge/share/tokens`, {
      method: 'POST',
      headers: { ...sess(), 'content-type': 'application/json' },
      body: JSON.stringify(mintBody()),
    })
    expect(res.status).toBe(401)
    const del = await fetch(`${relay.httpBase}/bridge/share/tokens/${a.token.id}`, {
      method: 'DELETE',
      headers: sess(),
    })
    expect(del.status).toBe(401)
  })
})

describe('held: the bridge POST keeps every Settings rule', () => {
  it('cap of 10 counts Settings and bridge tokens together; an 11th via the bridge is 409; a bridge revoke frees a slot', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${relay.httpBase}/api/share/tokens`, {
        method: 'POST',
        headers: { ...sess(), 'content-type': 'application/json' },
        body: JSON.stringify({ label: `s${i}`, scopes: ['text'] }),
      })
      expect(res.status).toBe(200)
    }
    const minted = []
    for (let i = 0; i < 5; i++) minted.push(await bridgeMint(relay, { label: `b${i}` }))
    const eleventh = await (await signed(relay, 'POST', '/bridge/share/tokens', mintBody({ label: 'b5' }))).send()
    expect(eleventh.status).toBe(409)
    expect(live(relay)).toBe(10)
    const settings11 = await fetch(`${relay.httpBase}/api/share/tokens`, {
      method: 'POST',
      headers: { ...sess(), 'content-type': 'application/json' },
      body: JSON.stringify({ label: 's5', scopes: ['text'] }),
    })
    expect(settings11.status).toBe(409)
    expect((await (await signed(relay, 'DELETE', `/bridge/share/tokens/${minted[0]?.token.id}`)).send()).status).toBe(
      204,
    )
    await bridgeMint(relay, { label: 'b6' })
    expect(live(relay)).toBe(10)
  })

  it('device binding: unpinned, revoked and unknown devices are 403; a minted token dies when its device is revoked', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    addDevice(relay, 'd_unpinnedunpinnedunpi', { pinned: 0 })
    addDevice(relay, 'd_revokedrevokedrevoke', { revoked: 1 })
    for (const device_id of ['d_unpinnedunpinnedunpi', 'd_revokedrevokedrevoke', 'd_zzzzzzzzzzzzzzzzzzzz'])
      expect((await (await signed(relay, 'POST', '/bridge/share/tokens', mintBody({ device_id }))).send()).status).toBe(
        403,
      )
    const a = await bridgeMint(relay)
    expect(a.token.device_id).toBe(DEV)
    expect((await share(relay, a.secret)).status).toBe(202)
    relay.relay.services.db.prepare('update auth_devices set revoked = 1 where id = ?').run(DEV)
    expect((await share(relay, a.secret)).status).toBe(401)
  })

  it('cross-device: the Mac can revoke a token a phone minted in Settings for ANOTHER device (by design, same as Settings)', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    addDevice(relay, DEV2)
    const res = await fetch(`${relay.httpBase}/api/share/tokens`, {
      method: 'POST',
      headers: { ...sess(DEV2), 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'other phone', scopes: ['text'] }),
    })
    const other = (await res.json()) as { token: { id: string }; secret: string }
    expect((await (await signed(relay, 'DELETE', `/bridge/share/tokens/${other.token.id}`)).send()).status).toBe(204)
    expect((await share(relay, other.secret)).status).toBe(401)
  })

  it('scopes: files alone, an unknown scope, a "trusted"/thread field, a 41-char label are all 400', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const bad = [
      mintBody({ scopes: ['files'] }),
      mintBody({ scopes: ['text', 'owner'] }),
      mintBody({ scopes: [] }),
      mintBody({ trusted: true }),
      mintBody({ thread_id: 'general' }),
      mintBody({ label: 'x'.repeat(41) }),
      mintBody({ label: '   ' }),
    ]
    for (const b of bad)
      expect((await (await signed(relay, 'POST', '/bridge/share/tokens', b)).send()).status).toBe(400)
    const dup = await bridgeMint(relay, { scopes: ['text', 'text'] })
    expect(dup.token.scopes).toEqual(['text'])
  })

  it('SHARE_ENABLED=0: both routes are 404, signed or not, and nothing is minted', async () => {
    relay = await startTestRelay({ env: { SHARE_ENABLED: '0' } })
    addDevice(relay)
    expect((await (await signed(relay, 'POST', '/bridge/share/tokens', mintBody())).send()).status).toBe(404)
    expect((await fetch(`${relay.httpBase}/bridge/share/tokens`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect(
      (await (await signed(relay, 'DELETE', '/bridge/share/tokens/sh_00000000000000000000000000')).send()).status,
    ).toBe(404)
    expect(live(relay)).toBe(0)
  })
})

// ---- defects ----------------------------------------------------------------------------------------------------------

/**
 * Opens an UNSIGNED chunked request (no Content-Length), writes `bytes`, then stalls without ending the body. Resolves
 * with the status if the relay answers within `ms`, else 'no answer'. A body cap that works while the body streams
 * answers 413 as soon as the cap is passed; a cap that reads the whole body first never answers a stalled client.
 */
function stalledChunked(
  r: TestRelay,
  method: string,
  path: string,
  bytes: number,
  ms = 3000,
  headers: Record<string, string> = {},
): Promise<number | string> {
  const u = new URL(`${r.httpBase}${path}`)
  return new Promise((resolve) => {
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        clearTimeout(t)
        resolve(res.statusCode ?? 0)
        req.destroy()
      },
    )
    req.on('error', () => {})
    const t = setTimeout(() => {
      resolve('no answer')
      req.destroy()
    }, ms)
    req.write(Buffer.alloc(bytes, 0x61)) // chunked transfer-encoding: Node sets it when no length is given
  })
}

describe('FAILS on PR #52: the 4 KiB body cap is only checked after the WHOLE unauthenticated body is read', () => {
  // share.ts `bridgeSigned()` checks Content-Length (absent on a chunked body) and then `await c.req.arrayBuffer()`
  // BEFORE the signature: an unauthenticated client can stream any size into relay memory, or hold the request open
  // forever (no bodyTimeout either). /bridge/post uses `frameBodyGuard` (limitBody + bodyTimeout) for exactly this.
  // Fix: `shareRoutes.post('/bridge/share/tokens', limitBody(() => BRIDGE_BODY_CAP), bodyTimeout(), ...)`, same on DELETE.
  // The size cap is only reached by a caller that gets past the header check, so these name the real key id with a fresh
  // time (the signature covers the body, so it cannot be checked until the body is in). A caller that names no trusted
  // key never gets that far: it is turned away with 401 before a body byte is read.
  const named =
    (path: string, method = 'POST') =>
    async (r: TestRelay) => ({
      authorization: await signBridgeHttp({
        privateKey: r.bridgeKey.privateKey,
        keyId: r.bridgeKey.keyId,
        method,
        pathWithQuery: path,
        body: '',
      }),
    })

  it('control: /bridge/post answers 413 to a stalled chunked body past its cap, while it streams', async () => {
    relay = await startTestRelay()
    const h = await named('/bridge/post')(relay)
    expect(await stalledChunked(relay, 'POST', '/bridge/post', MAX_FRAME_BYTES + 64 * 1024, 3000, h)).toBe(413)
  })

  it('POST /bridge/share/tokens: a stalled chunked body past 4 KiB gets 413 while it streams', async () => {
    relay = await startTestRelay()
    const h = await named('/bridge/share/tokens')(relay)
    expect(await stalledChunked(relay, 'POST', '/bridge/share/tokens', 64 * 1024, 3000, h)).toBe(413)
  })

  it('POST /bridge/share/tokens: a caller naming no trusted key is 401 before any body is read', async () => {
    relay = await startTestRelay()
    expect(await stalledChunked(relay, 'POST', '/bridge/share/tokens', 64 * 1024)).toBe(401)
  })

  // Held, but only thanks to Node: its HTTP parser refuses a chunked DELETE outright (400 from the clientError handler),
  // and a declared Content-Length over 4 KiB is 413 before any read. A small declared length that never arrives still
  // holds the request until Node's own requestTimeout (300 s), because the route has no bodyTimeout.
  it('held (by Node): DELETE /bridge/share/tokens/:id with a chunked body is refused, not buffered', async () => {
    relay = await startTestRelay()
    expect(await stalledChunked(relay, 'DELETE', '/bridge/share/tokens/sh_00000000000000000000000000', 64 * 1024)).toBe(
      400,
    )
  })
})
