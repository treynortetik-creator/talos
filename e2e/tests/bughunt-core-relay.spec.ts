// Bughunt: the real stack (built relay, real bridge behind FakeClaude) driven by a browserless phone through the real
// HTTP and WebSocket seams. Tests marked BUG fail on main at 7cd80ce and describe the behaviour the spec requires.
import { expect, test } from '@playwright/test'
import { apiGet, apiPost, enrollNodePhone, loginWith, stepup } from '../harness/bughunt-node-app.ts'
import { type Stack, startStack, waitUntil } from '../harness/stack.ts'

let stack: Stack
test.beforeEach(async () => {
  stack = await startStack()
  await stack.startBridge()
})
test.afterEach(async () => {
  await stack.stop()
})

// ---- BUG B: a refused stranger keeps a working passkey and can sign the owner out everywhere -----------------------
test('BUG B: after the Mac answers N, the stranger cannot sign in again or log the owner out', async () => {
  const owner = await enrollNodePhone(stack)
  expect((await apiGet(stack, '/api/me', owner.cookie)).status).toBe(200)
  // A stranger who saw the next enrollment link registers a passkey and binds a device; the Mac says N.
  const stranger = await enrollNodePhone(stack, { answer: 'N', label: 'not mine' })
  await waitUntil(async () => {
    const r = await apiGet(stack, '/api/devices', owner.cookie)
    const list = (await r.json()) as Array<{ name: string; pinned: boolean }>
    return list.some((d) => d.name === 'not mine' && !d.pinned)
  }, 'the refusal to reach the relay')
  // (that list check is true from the moment the device exists: also wait until the Mac has recorded the N)
  await waitUntil(() => stack.bridgeLog().includes('device not pinned'), 'the Mac to record the refusal')
  await new Promise((r) => setTimeout(r, 500))
  // Days later the stranger signs in again with the passkey the relay kept...
  const again = await loginWith(stack, stranger.passkey)
  const strangerSignedIn = again.res.status === 200
  // ...and an unpinned session ("may only finish pairing", spec 5.4 addendum) reaches logout-all.
  let ownerKickedOut = false
  if (strangerSignedIn) {
    const r = await apiPost(stack, '/api/auth/logout-all', {}, again.cookie)
    ownerKickedOut = r.status === 204 && (await apiGet(stack, '/api/me', owner.cookie)).status === 401
  }
  expect({ strangerSignedIn, ownerKickedOut }).toEqual({ strangerSignedIn: false, ownerKickedOut: false })
})

// ---- BUG C: a full overnight digest is bigger than a frame; the bridge drops it as a bad frame ------------------------
test('BUG C: a 200-event hook.digest reaches the agent even when the events use their full field sizes', async () => {
  const conn = 'cn_AAAAAAAAAAAAAAAAAAAAAA'
  const now = new Date().toISOString()
  const events = Array.from({ length: 200 }, (_, i) => ({
    id: `e_${String(i)
      .padStart(26, '0')
      .replace(/[ILOU]/g, '0')}`,
    source: 'generic',
    connection: conn,
    kind: 'generic.event',
    title: `Event ${i} `.padEnd(200, 't'),
    summary: 's'.repeat(280),
    url: `https://example.com/${'p'.repeat(600)}`,
    actor: { name: 'a'.repeat(120) },
    ts: now,
    thread: 'inbox',
    work: false,
    priority: 'normal',
    dedup_key: `generic:${i}:${'d'.repeat(200)}`,
  }))
  await stack.relay.services.bus.toBridge(
    {
      type: 'hook.digest',
      window: { start: now, end: now },
      threads: [{ thread_id: 'inbox', counts: { generic: 200 } }],
      events,
    },
    { durable: true },
  )
  const note = await stack.claude.waitForNotification((n) => n.meta.kind === 'hook_digest', 8_000).catch(() => null)
  if (!note)
    console.log(
      'BUGC',
      stack
        .bridgeLog()
        .split('\n')
        .filter((l) => /parse|large/.test(l))
        .slice(-3)
        .join('\n'),
    )
  expect(
    note,
    'the digest notification (bridge.log shows "relay frame did not parse" when it is dropped)',
  ).not.toBeNull()
})

// ---- BUG E: revoking a device (or logging out everywhere) leaves its open socket fully working ---------------------
test('BUG E: a revoked device loses its live socket; it cannot keep reading replies or pull the backlog', async () => {
  const a = await enrollNodePhone(stack, { label: 'phone a' })
  const b = await enrollNodePhone(stack, { label: 'stolen phone', passkey: a.passkey })
  await b.app.connect()
  b.app.ws?.on('error', () => {})
  const sent = await b.app.sendMessage('general', 'before the theft')
  await b.app.expectFrame('ack', (f) => f.ref === sent.id)
  // The owner revokes the stolen phone from phone A, with Face ID (step-up device:revoke).
  const token = await stepup(stack, a.passkey, a.cookie, 'device:revoke')
  const r = await fetch(`${stack.origin}/api/devices/${b.device.deviceId}/revoke`, {
    method: 'POST',
    headers: { origin: stack.origin, 'x-talos-csrf': '1', cookie: a.cookie, 'x-talos-stepup': token },
  })
  expect(r.status).toBe(204)
  expect((await apiGet(stack, '/api/me', b.cookie)).status).toBe(401) // the HTTP session is gone...
  await new Promise((res) => setTimeout(res, 500))
  // ...but the socket that was already open is still served.
  await stack.claude.callTool('reply', { thread_id: 'general', text: 'secret after revoke' })
  const leaked = await b.app
    .expectFrame('reply', (f) => f.message.text === 'secret after revoke', { timeoutMs: 3_000 })
    .then(() => true)
    .catch(() => false)
  b.app.send({ type: 'catchup.request', since_seq: 0 })
  const backlog = await b.app
    .expectFrame('catchup.batch', () => true, { timeoutMs: 3_000 })
    .then(() => true)
    .catch(() => false)
  expect({ socketOpen: b.app.connected, leakedReply: leaked, pulledBacklog: backlog }).toEqual({
    socketOpen: false,
    leakedReply: false,
    pulledBacklog: false,
  })
})

// ---- BUG F: one pin, two "New device pinned" pushes ------------------------------------------------------------------
test('BUG F: pinning a device sends exactly one "New device pinned" push', async () => {
  const { createECDH, randomBytes } = await import('node:crypto')
  const a = await enrollNodePhone(stack, { label: 'a' })
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const sub = await apiPost(
    stack,
    '/api/push/subscribe',
    {
      endpoint: 'https://push.example.com/sub/1',
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    },
    a.cookie,
  )
  expect(sub.status).toBe(204)
  const base = stack.relayLog.length
  await enrollNodePhone(stack, { label: 'b', passkey: a.passkey })
  await new Promise((r) => setTimeout(r, 1500))
  // The relay logs one line per push it sends (ok or not). One pin should be one "New device pinned" push.
  const pinnedPushes = stack.relayLog
    .slice(base)
    .filter((l) => l.includes('"msg":"push sent"') && l.includes('"template":"device_pinned"')).length
  expect(pinnedPushes).toBe(1)
})
