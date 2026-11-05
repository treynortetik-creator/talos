// Starts an in-process test relay (the repo's own harness, never a deployed one) for TalosShareCore's live tests and
// prints one JSON line with what Swift needs. Run by test.sh --live:
//   node --experimental-transform-types scripts/live-relay.ts
// Stops on SIGTERM/SIGINT. Control routes (127.0.0.1 only): GET /items lists the share.item frames the bridge got.
import { createServer } from 'node:http'
import { ORIGIN, startTestRelay } from '../../../../relay/test/core/harness.ts'
import { kit } from '../../../../relay/test/core/helpers.ts'

const DEV = 'd_abcdefghijklmnopqrst'
const sess = { 'X-Test-Session': DEV, Origin: ORIGIN, 'X-Talos-CSRF': '1', 'content-type': 'application/json' }

// TRUST_PROXY_HOPS=1 lets the Swift test give every request its own client address, so the 10/min/IP bucket stays out
// of the 30/hour/token test (the same trick as apps/relay/test/share/share.test.ts).
const relay = await startTestRelay({ env: { TRUST_PROXY_HOPS: '1', SHARE_ENABLED: '1' } })
relay.relay.services.db
  .prepare(
    'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
  )
  .run(DEV, 'phone', '{}', 'b', Date.now())
const bridge = await kit(relay).bridge({ autoReply: false, consume: 'manual', verifyOwner: false }).connect()

async function mint(label: string, scopes: string[]) {
  const res = await fetch(`${relay.httpBase}/api/share/tokens`, {
    method: 'POST',
    headers: sess,
    body: JSON.stringify({ label, scopes }),
  })
  if (res.status !== 200) throw new Error(`mint ${label}: ${res.status}`)
  const j = (await res.json()) as { token: { id: string }; secret: string }
  if (!/^talos_share_[A-Za-z0-9_-]{43}$/.test(j.secret)) throw new Error('unexpected secret shape')
  return j
}

const text = await mint('live text', ['text'])
const files = await mint('live files', ['text', 'files'])
const limit = await mint('live limit', ['text'])
const revoked = await mint('live revoked', ['text'])
const del = await fetch(`${relay.httpBase}/api/share/tokens/${revoked.token.id}`, { method: 'DELETE', headers: sess })
if (del.status !== 204) throw new Error(`revoke: ${del.status}`)

const control = createServer((req, res) => {
  if (req.url === '/items') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(bridge.rec.of('share.item', 'in')))
  } else {
    res.statusCode = 404
    res.end()
  }
})
await new Promise<void>((r) => control.listen(0, '127.0.0.1', r))
const controlPort = (control.address() as { port: number }).port

console.log(
  JSON.stringify({
    relay: relay.httpBase,
    control: `http://127.0.0.1:${controlPort}`,
    tokens: { text: text.secret, files: files.secret, limit: limit.secret, revoked: revoked.secret },
  }),
)

const stop = async () => {
  control.close()
  await bridge.close()
  await relay.stop()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
