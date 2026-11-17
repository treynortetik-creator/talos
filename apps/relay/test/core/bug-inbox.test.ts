// The bug inbox against the REAL relay (core/bug-inbox.ts): off unless BUG_INBOX_SECRETS is set; every refusal (no
// signature, a wrong one, the wrong type, a body or a picture too large, a picture that is not what it says, an old
// timestamp, a report id seen before); one good delivery becomes one problem.item marked as another install's, with the
// install named by the secret that signed it, never by the body. The sender is faked with the relay's own signer.
import { randomBytes } from 'node:crypto'
import {
  BUG_REPORT_LIMITS,
  newUlid,
  PROBLEMS_FEATURE,
  PROBLEMS_INSTALL_FEATURE,
  type ProblemT,
} from '@talos-app/protocol'
import { type FakeBridge, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setAuthImplementation } from '../../src/auth/contract.ts'
import { RateLimiter } from '../../src/auth/limits.ts'
import { standardWebhookSignature } from '../../src/core/bug-reports.ts'
import { loadEnv } from '../../src/env.ts'
import { TEST_DATA_KEY } from '../helpers/fake-services.ts'
import { createTestAuth } from '../helpers/test-auth.ts'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

const SECRET = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`
const SECRET2 = `whsec_${Buffer.from('fedcba9876543210fedcba9876543210').toString('base64')}`
const STRANGER = `whsec_${Buffer.from('a stranger has this one, 32 bytes').toString('base64')}`
// a 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const DEVICE = 'd_abcdefghijklmnopqrst'

let relay: TestRelay | null = null
const bridges: FakeBridge[] = []
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.close()
  await relay?.stop()
  relay = null
})

async function world(env: Record<string, string> = {}, features = [PROBLEMS_FEATURE, PROBLEMS_INSTALL_FEATURE]) {
  relay = await startTestRelay({ env: { BUG_INBOX_SECRETS: `beta1=${SECRET},beta2=${SECRET2}`, ...env } })
  const b = await kit(relay).bridge({ autoReply: false, verifyOwner: false, features }).connect()
  bridges.push(b)
  return { r: relay, bridge: b }
}

type Report = Record<string, unknown>
function delivery(report: Report = {}, data: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    type: 'bug.reported',
    timestamp: new Date().toISOString(),
    data: {
      id: newUlid(),
      device_id: DEVICE,
      image_bytes: PNG.length,
      report: {
        what_went_wrong: 'The send button did nothing',
        expected: 'The message to go',
        versions: { app: '1.2.3', bridge: '1.2.0', relay: '1.2.1', claude_code: '2.1.300' },
        thread_id: 'general',
        screen: 'thread',
        recent_errors: ['TypeError: x is not a function'],
        logs: 'line one\nline two',
        ...report,
      },
      image: { type: 'image/png', b64: PNG.toString('base64') },
      ...data,
    },
    ...top,
  }
}

async function deliver(
  r: TestRelay,
  body: unknown,
  o: { secret?: string; ts?: number; id?: string; headers?: Record<string, string>; raw?: string } = {},
) {
  const text = o.raw ?? JSON.stringify(body)
  const ts = o.ts ?? Math.floor(Date.now() / 1000)
  const id = o.id ?? `msg_${(body as { data?: { id?: string } } | null)?.data?.id ?? 'x'}`
  return fetch(`${r.httpBase}/api/bug-inbox`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(ts),
      'webhook-signature': standardWebhookSignature(o.secret ?? SECRET, id, ts, text),
      ...o.headers,
    },
    body: text,
  })
}

const items = (b: FakeBridge) =>
  b.notified.filter((f) => f.type === 'problem.item') as unknown as Array<{ problem: ProblemT }>
const outbox = (r: TestRelay) =>
  (r.relay.services.db.prepare("select count(*) n from core_outbox where type = 'problem.item'").get() as { n: number })
    .n
/** Lets any frame the relay was going to send arrive, so "none came" means none. */
const settle = () => new Promise((res) => setTimeout(res, 250))

describe('off by default', () => {
  it('with no BUG_INBOX_SECRETS the route answers 404 and reads nothing, even for a well signed delivery', async () => {
    relay = await startTestRelay()
    const res = await deliver(relay, delivery())
    expect(res.status).toBe(404)
    expect(outbox(relay)).toBe(0)
  })
})

describe('refused', () => {
  it('unsigned: no Standard Webhooks headers at all', async () => {
    const { r, bridge } = await world()
    const res = await fetch(`${r.httpBase}/api/bug-inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(delivery()),
    })
    expect(res.status).toBe(401)
    await settle()
    expect(items(bridge)).toEqual([])
  })

  it('a bad signature: a secret no install has, a body changed after signing, a signature of another scheme', async () => {
    const { r, bridge } = await world()
    expect((await deliver(r, delivery(), { secret: STRANGER })).status).toBe(401)
    const d = delivery()
    const signed = JSON.stringify(d)
    const ts = Math.floor(Date.now() / 1000)
    const sig = standardWebhookSignature(SECRET, `msg_${d.data.id}`, ts, signed)
    const changed = signed.replace('did nothing', 'did something')
    const res = await fetch(`${r.httpBase}/api/bug-inbox`, {
      method: 'POST',
      headers: { 'webhook-id': `msg_${d.data.id}`, 'webhook-timestamp': String(ts), 'webhook-signature': sig },
      body: changed,
    })
    expect(res.status).toBe(401)
    expect(
      (await deliver(r, delivery(), { headers: { 'webhook-signature': `v1a,${randomBytes(32).toString('base64')}` } }))
        .status,
    ).toBe(401)
    await settle()
    expect(items(bridge)).toEqual([])
  })

  it('a signature over another timestamp than the header says', async () => {
    const { r } = await world()
    const d = delivery()
    const text = JSON.stringify(d)
    const now = Math.floor(Date.now() / 1000)
    const res = await fetch(`${r.httpBase}/api/bug-inbox`, {
      method: 'POST',
      headers: {
        'webhook-id': `msg_${d.data.id}`,
        'webhook-timestamp': String(now - 1),
        'webhook-signature': standardWebhookSignature(SECRET, `msg_${d.data.id}`, now, text),
      },
      body: text,
    })
    expect(res.status).toBe(401)
  })

  it('the wrong type, well signed', async () => {
    const { r, bridge } = await world()
    const res = await deliver(r, delivery({}, {}, { type: 'bug.deleted' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad_request' })
    expect((await deliver(r, { type: 'bug.reported' })).status).toBe(400)
    expect((await deliver(r, null, { raw: 'not json' })).status).toBe(400)
    await settle()
    expect(items(bridge)).toEqual([])
  })

  it('a body over the cap (8 MiB), before it is read', async () => {
    const { r } = await world()
    const big = 'x'.repeat(BUG_REPORT_LIMITS.bodyBytes + 1)
    const res = await deliver(r, null, { raw: big })
    expect(res.status).toBe(413)
  })

  it('a stale or future timestamp (outside 5 minutes), however well signed', async () => {
    const { r, bridge } = await world()
    const now = Math.floor(Date.now() / 1000)
    expect((await deliver(r, delivery(), { ts: now - 6 * 60 })).status).toBe(400)
    expect((await deliver(r, delivery(), { ts: now + 6 * 60 })).status).toBe(400)
    await settle()
    expect(items(bridge)).toEqual([])
  })

  it('a replay: the same delivery again, and the same report id signed afresh, are one problem', async () => {
    const { r, bridge } = await world()
    const d = delivery()
    expect((await deliver(r, d)).status).toBe(202)
    expect((await deliver(r, d)).status).toBe(409)
    expect((await deliver(r, { ...d, timestamp: new Date().toISOString() }, { id: 'msg_other' })).status).toBe(409)
    await bridge.waitNotified('problem.item')
    await settle()
    expect(items(bridge)).toHaveLength(1)
  })

  it("the same report id from another install is that install's own report, not a replay", async () => {
    const { r, bridge } = await world()
    const d = delivery()
    expect((await deliver(r, d)).status).toBe(202)
    expect((await deliver(r, d, { secret: SECRET2 })).status).toBe(202)
    await bridge.waitNotified('problem.item', 2)
    expect(items(bridge).map((i) => i.problem.install)).toEqual(['beta1', 'beta2'])
  })

  it('a picture over 5 MiB once decoded', async () => {
    const { r, bridge } = await world()
    const big = Buffer.concat([PNG, Buffer.alloc(BUG_REPORT_LIMITS.imageBytes)])
    const res = await deliver(r, delivery({}, { image: { type: 'image/png', b64: big.toString('base64') } }))
    expect([400, 413]).toContain(res.status) // the schema's base64 length cap or the decoded cap: refused either way
    await settle()
    expect(items(bridge)).toEqual([])
  })

  it('a picture whose bytes are not the type it claims, or not a picture at all, or not plain base64', async () => {
    const { r, bridge } = await world()
    const as = (type: string, b64: string) => deliver(r, delivery({}, { image: { type, b64 } }))
    expect((await as('image/jpeg', PNG.toString('base64'))).status).toBe(400)
    expect((await as('image/png', Buffer.from('<svg onload=alert(1)>').toString('base64'))).status).toBe(400)
    expect((await as('image/gif', PNG.toString('base64'))).status).toBe(400)
    expect((await as('image/png', `${PNG.toString('base64')}!!`)).status).toBe(400)
    await settle()
    expect(items(bridge)).toEqual([])
    expect(r.relay.services.db.prepare('select count(*) n from core_media').get()).toEqual({ n: 0 })
  })
})

describe('a good delivery', () => {
  it('becomes one problem.item for the Mac: from install beta1, with her words, versions, errors, log and picture', async () => {
    const { r, bridge } = await world()
    const d = delivery()
    const res = await deliver(r, d)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true })
    await bridge.waitNotified('problem.item')
    const p = items(bridge)[0]?.problem as ProblemT
    expect(p).toMatchObject({
      source: 'install',
      install: 'beta1',
      kind: 'owner',
      name: 'bug report',
      message: 'The send button did nothing',
      versions: { app: '1.2.3', bridge: '1.2.0', relay: '1.2.1' },
      attached: {
        what_went_wrong: 'The send button did nothing',
        expected: 'The message to go',
        errors: ['TypeError: x is not a function'],
        logs: 'line one\nline two',
        thread_id: 'general',
        screen: 'thread',
        claude_code: '2.1.300',
      },
    })
    expect(p.attached?.messages).toBeUndefined() // she did not tick them: nothing to carry
    // the picture is a media file on this relay, byte for byte, for the Mac to fetch and verify
    expect(p.screenshot).toMatchObject({ kind: 'image', mime: 'image/png', size: PNG.length })
    const got = await r.relay.services.media.get(p.screenshot?.media_id as string)
    expect(Buffer.from(got?.bytes ?? []).equals(PNG)).toBe(true)
  })

  it('the install is the one whose secret signed it, whatever the body says', async () => {
    const { r, bridge } = await world()
    const res = await deliver(r, delivery({}, { install: 'beta1', source: 'web' }, { install: 'beta1' }), {
      secret: SECRET2,
    })
    expect(res.status).toBe(202)
    await bridge.waitNotified('problem.item')
    expect(items(bridge)[0]?.problem.install).toBe('beta2')
  })

  it('carries the last messages only when she chose to attach them', async () => {
    const { r, bridge } = await world()
    const messages = [{ role: 'you', text: 'please send it' }]
    expect((await deliver(r, delivery({ messages }))).status).toBe(202)
    await bridge.waitNotified('problem.item')
    expect(items(bridge)[0]?.problem.attached?.messages).toEqual(messages)
  })

  it('fields nobody named never reach the Mac: an extra key in the report, the data or the top', async () => {
    const { r, bridge } = await world()
    const d = delivery(
      { cookie: 'session=abc', secret_note: 'CANARY-4417' },
      { osig: 'x', token: 'CANARY-4417' },
      {
        extra: 'CANARY-4417',
      },
    )
    expect((await deliver(r, d)).status).toBe(202)
    await bridge.waitNotified('problem.item')
    const text = JSON.stringify(items(bridge)[0]?.problem)
    expect(text).not.toContain('CANARY-4417')
    expect(text).not.toContain('session=abc')
    expect(text).not.toContain(DEVICE) // her device id stays with her
  })

  it('is scrubbed again here: a token or a key in her words, errors or log does not travel on', async () => {
    const { r, bridge } = await world()
    const key = `sk-${'A1b2C3d4'.repeat(6)}`
    const d = delivery({
      what_went_wrong: `It broke after I pasted Bearer abc.def.ghi and api_key=${key}`,
      recent_errors: [`Error: fetch failed for https://api.example.com/v1?token=${key}`],
      logs: `authorization: Bearer ${key}\npassword=hunter2`,
    })
    expect((await deliver(r, d)).status).toBe(202)
    await bridge.waitNotified('problem.item')
    const text = JSON.stringify(items(bridge)[0]?.problem)
    expect(text).not.toContain(key)
    expect(text).not.toContain('abc.def.ghi')
    expect(text).not.toContain('hunter2')
  })

  it('waits for a Mac that files reports from other installs; an older one never gets it', async () => {
    const { r, bridge: old } = await world({}, [PROBLEMS_FEATURE])
    expect((await deliver(r, delivery())).status).toBe(202)
    await settle()
    expect(items(old)).toEqual([])
    expect(outbox(r)).toBe(1)
    await old.close()
    const fresh = await kit(r)
      .bridge({ autoReply: false, verifyOwner: false, features: [PROBLEMS_FEATURE, PROBLEMS_INSTALL_FEATURE] })
      .connect()
    bridges.push(fresh)
    await fresh.waitNotified('problem.item')
    expect(items(fresh)[0]?.problem.install).toBe('beta1')
  })
})

describe('the app and the screens visited', () => {
  const one = async (report: Report, env: Record<string, string> = {}) => {
    const { r, bridge } = await world(env)
    expect((await deliver(r, delivery(report))).status).toBe(202)
    await bridge.waitNotified('problem.item')
    return items(bridge)[0]?.problem as ProblemT
  }
  it('the problem names the app and the routes', async () => {
    const p = await one({ client: 'mac_app', routes: ['thread', 'memory'] })
    expect(p).toMatchObject({ source: 'install', device: 'mac_app', routes: ['thread', 'memory'] })
  })
  it('an older sender: a browser, and its one screen', async () => {
    expect(await one({})).toMatchObject({ device: 'browser', routes: ['thread'] })
  })
  it('flag:BUG_INBOX_NO_THREAD leaves the routes out', async () => {
    const p = await one({ client: 'iphone_app', routes: ['thread', 'memory'] }, { BUG_INBOX_NO_THREAD: '1' })
    expect(p).toMatchObject({ device: 'iphone_app', routes: [] })
  })
})

describe('the switches (all off: everything she sent goes)', () => {
  const sent = async (env: Record<string, string>) => {
    const { r, bridge } = await world(env)
    expect((await deliver(r, delivery({ messages: [{ role: 'agent', text: 'hello' }] }))).status).toBe(202)
    await bridge.waitNotified('problem.item')
    return items(bridge)[0]?.problem as ProblemT
  }
  it('flag:BUG_INBOX_NO_SCREENSHOT leaves the picture out (and stores none)', async () => {
    const p = await sent({ BUG_INBOX_NO_SCREENSHOT: '1' })
    expect(p.screenshot).toBeUndefined()
    expect(relay?.relay.services.db.prepare('select count(*) n from core_media').get()).toEqual({ n: 0 })
  })
  it('flag:BUG_INBOX_NO_LOGS leaves the log out', async () => {
    const p = await sent({ BUG_INBOX_NO_LOGS: '1' })
    expect(p.attached?.logs).toBeUndefined()
    expect(p.attached?.errors).toEqual(['TypeError: x is not a function'])
  })
  it('flag:BUG_INBOX_NO_MESSAGES leaves the messages out even when she attached them', async () => {
    const p = await sent({ BUG_INBOX_NO_MESSAGES: '1' })
    expect(p.attached?.messages).toBeUndefined()
  })
  it('flag:BUG_INBOX_NO_THREAD leaves the thread id and the screen out', async () => {
    const p = await sent({ BUG_INBOX_NO_THREAD: '1' })
    expect(p.attached?.thread_id).toBeUndefined()
    expect(p.attached?.screen).toBeUndefined()
  })
  it('with every switch off (the default) all of it goes', async () => {
    const p = await sent({})
    expect(p.screenshot).toBeDefined()
    expect(p.attached?.logs).toBe('line one\nline two')
    expect(p.attached?.messages).toEqual([{ role: 'agent', text: 'hello' }])
    expect(p.attached?.thread_id).toBe('general')
  })
})

describe('rate limits', () => {
  const realLimits = (r: TestRelay) => {
    const real = new RateLimiter(r.relay.services.clock)
    setAuthImplementation(
      { ...createTestAuth({ bridgeKey: r.bridgeKey }), takeRate: (_c, name, key) => real.take(name, key ?? 'ip') },
      { test: true },
    )
  }
  it('per address before the body: the 31st delivery in a minute is 429, signed or not', async () => {
    const { r } = await world()
    realLimits(r)
    for (let i = 0; i < 30; i++) expect((await deliver(r, delivery(), { secret: STRANGER })).status).toBe(401)
    const over = await deliver(r, delivery())
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
  })
  it('per install once signed: 30 an hour', async () => {
    const { r } = await world()
    const real = new RateLimiter(r.relay.services.clock)
    setAuthImplementation(
      {
        ...createTestAuth({ bridgeKey: r.bridgeKey }),
        // the address bucket left open, so only the install's own bucket is measured
        takeRate: (_c, name, key) => (name === 'bug_inbox_ip' ? { ok: true } : real.take(name, key ?? 'ip')),
      },
      { test: true },
    )
    for (let i = 0; i < 30; i++) expect((await deliver(r, delivery({}, { image: undefined }))).status).toBe(202)
    expect((await deliver(r, delivery({}, { image: undefined }))).status).toBe(429)
    expect((await deliver(r, delivery({}, { image: undefined }), { secret: SECRET2 })).status).toBe(202)
  })
})

describe('BUG_INBOX_SECRETS', () => {
  const env = (v: string) =>
    loadEnv({
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: 'https://relay.example.com',
      RP_ID: 'relay.example.com',
      DATA_KEY: TEST_DATA_KEY,
      BUG_INBOX_SECRETS: v,
    })
  it('reads name=secret pairs', () => {
    expect(env(`beta1=${SECRET}, beta-2=${SECRET2}`).BUG_INBOX_SECRETS).toEqual([
      { name: 'beta1', secret: SECRET },
      { name: 'beta-2', secret: SECRET2 },
    ])
  })
  it('refuses a bare secret, a bad name, a name or a secret used twice', () => {
    expect(() => env(SECRET)).toThrow(/BUG_INBOX_SECRETS/)
    expect(() => env(`Beta One=${SECRET}`)).toThrow(/BUG_INBOX_SECRETS/)
    expect(() => env(`a=${SECRET},a=${SECRET2}`)).toThrow(/each name once/)
    expect(() => env(`a=${SECRET},b=${SECRET}`)).toThrow(/each secret once/)
  })
})
