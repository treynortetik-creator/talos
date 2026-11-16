// In-app bug reports against the REAL relay: only a paired, signing device may post; the size, rate and retention limits;
// the webhook is off by default and, when on, signed the Standard Webhooks way; the named event is emitted.
import { createHmac } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  BUG_REPORT_LIMITS,
  type BugReportBodyT,
  createDeviceKey,
  type DeviceKey,
  newUlid,
  signOwnerFrame,
} from '@talos-app/protocol'
import { waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setAuthImplementation } from '../../src/auth/contract.ts'
import { RateLimiter } from '../../src/auth/limits.ts'
import {
  bugReportBytes,
  checkWebhookUrl,
  isPrivateAddress,
  pinnedLookup,
  standardWebhookSignature,
  sweepBugReports,
} from '../../src/core/bug-reports.ts'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import type { Logger } from '../../src/services.ts'
import { createTestAuth } from '../helpers/test-auth.ts'
import { ORIGIN, startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

const SECRET_BYTES = Buffer.from('0123456789abcdef0123456789abcdef')
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`
// a 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let relay: TestRelay | null = null
const closers: Array<() => void> = []
afterEach(async () => {
  for (const c of closers.splice(0)) c()
  await relay?.stop()
  relay = null
})

const report = (over: Partial<BugReportBodyT> = {}): BugReportBodyT => ({
  what_went_wrong: 'The send button did nothing',
  versions: { app: '1.0.0', bridge: '1.0.0', relay: '1.0.0', claude_code: '2.0.0' },
  recent_errors: ['TypeError: x is not a function'],
  logs: 'line one\nline two',
  ...over,
})

async function world(opts: Parameters<typeof startTestRelay>[0] = {}) {
  const r = await startTestRelay(opts)
  relay = r
  const dev = await createDeviceKey()
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
    )
    .run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', Date.now())
  return { r, dev }
}

const headers = (deviceId: string) => ({
  'X-Test-Session': deviceId,
  Origin: ORIGIN,
  'X-Talos-CSRF': '1',
  'content-type': 'application/json',
})

async function signedPost(
  dev: DeviceKey,
  over: Record<string, unknown> = {},
  image: Buffer = PNG,
  rep: BugReportBodyT = report(),
) {
  return signOwnerFrame(
    {
      v: 1,
      type: 'bug.report',
      device_id: dev.deviceId,
      id: newUlid(),
      ts: new Date().toISOString(),
      nonce: newUlid().toLowerCase(),
      report: rep,
      image_type: 'image/png',
      image_b64: image.toString('base64'),
      ...over,
    },
    dev.privateKey,
  )
}

const post = (r: TestRelay, body: unknown, h: Record<string, string>) =>
  fetch(`${r.httpBase}/api/bug-reports`, { method: 'POST', headers: h, body: JSON.stringify(body) })

const rows = (r: TestRelay) =>
  (r.relay.services.db.prepare('select count(*) n from core_bug_reports').get() as { n: number }).n

describe('who may post', () => {
  it('stores a report from a paired device that signed it (201), as encrypted files', async () => {
    const { r, dev } = await world()
    const body = await signedPost(dev)
    const res = await post(r, body, headers(dev.deviceId))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, id: body.id })
    expect(rows(r)).toBe(1)
    const files = readdirSync(join(r.dir, 'bug-reports')).sort()
    expect(files).toEqual([`${body.id}.img.bin`, `${body.id}.json.bin`])
  })

  it('answers a retry of the same report 200 and stores it once', async () => {
    const { r, dev } = await world()
    const body = await signedPost(dev)
    expect((await post(r, body, headers(dev.deviceId))).status).toBe(201)
    expect((await post(r, body, headers(dev.deviceId))).status).toBe(200)
    expect(rows(r)).toBe(1)
  })

  it('refuses a caller with no session (401) and stores nothing', async () => {
    const { r, dev } = await world()
    const h = { ...headers(dev.deviceId) } as Record<string, string>
    delete h['X-Test-Session']
    const res = await post(r, await signedPost(dev), h)
    expect(res.status).toBe(401)
    expect(rows(r)).toBe(0)
  })

  it('refuses a session whose device the Mac has not pinned (no signature can fix that)', async () => {
    const { r, dev } = await world()
    r.relay.services.db.prepare('update auth_devices set pinned = 0 where id = ?').run(dev.deviceId)
    const res = await post(r, await signedPost(dev), headers(dev.deviceId))
    expect(res.status).toBe(401)
    expect(rows(r)).toBe(0)
  })

  it('refuses an unsigned report and one with a signature from another key (401 bad_signature)', async () => {
    const { r, dev } = await world()
    const other = await createDeviceKey()
    const unsigned = { ...(await signedPost(dev)), osig: 'A'.repeat(86) }
    const res1 = await post(r, unsigned, headers(dev.deviceId))
    expect(res1.status).toBe(401)
    expect(await res1.json()).toEqual({ error: 'bad_signature' })
    const forged = await signedPost({ ...dev, privateKey: other.privateKey })
    expect((await post(r, forged, headers(dev.deviceId))).status).toBe(401)
    const missing = { ...(await signedPost(dev)) } as Record<string, unknown>
    delete missing.osig
    expect((await post(r, missing, headers(dev.deviceId))).status).toBe(400)
    expect(rows(r)).toBe(0)
  })

  it('refuses a body changed after signing, and a report signed for another device', async () => {
    const { r, dev } = await world()
    const signed = await signedPost(dev)
    const edited = { ...signed, report: report({ what_went_wrong: 'something else' }) }
    expect((await post(r, edited, headers(dev.deviceId))).status).toBe(401)
    const other = await createDeviceKey()
    const theirs = await signedPost(other)
    expect((await post(r, theirs, headers(dev.deviceId))).status).toBe(403)
    expect(rows(r)).toBe(0)
  })

  it('refuses a stale timestamp (400) and a repeated nonce (409)', async () => {
    const { r, dev } = await world()
    const stale = await signedPost(dev, { ts: new Date(Date.now() - 10 * 60_000).toISOString() })
    expect((await post(r, stale, headers(dev.deviceId))).status).toBe(400)
    const first = await signedPost(dev, { nonce: 'a'.repeat(24) })
    expect((await post(r, first, headers(dev.deviceId))).status).toBe(201)
    const replay = await signedPost(dev, { nonce: 'a'.repeat(24) })
    expect((await post(r, replay, headers(dev.deviceId))).status).toBe(409)
    expect(rows(r)).toBe(1)
  })
})

describe('size limits', () => {
  it('refuses an image over 5 MB (413) and one that is not an image (400)', async () => {
    const { r, dev } = await world()
    const big = Buffer.concat([PNG, Buffer.alloc(BUG_REPORT_LIMITS.imageBytes)])
    const res = await post(r, await signedPost(dev, {}, big), headers(dev.deviceId))
    expect(res.status).toBe(413)
    const notImage = await post(
      r,
      await signedPost(dev, {}, Buffer.from('<html>not a picture</html>')),
      headers(dev.deviceId),
    )
    expect(notImage.status).toBe(400)
    const mismatch = await post(r, await signedPost(dev, { image_type: 'image/jpeg' }), headers(dev.deviceId))
    expect(mismatch.status).toBe(400)
    expect(rows(r)).toBe(0)
  })

  it('refuses a body over the total cap (413) before reading it all, and text over its field cap (400)', async () => {
    const { r, dev } = await world()
    const huge = await fetch(`${r.httpBase}/api/bug-reports`, {
      method: 'POST',
      headers: headers(dev.deviceId),
      body: 'x'.repeat(BUG_REPORT_LIMITS.bodyBytes + 1),
    })
    expect(huge.status).toBe(413)
    const longText = await signedPost(
      dev,
      {},
      PNG,
      report({ what_went_wrong: 'x'.repeat(BUG_REPORT_LIMITS.whatChars + 1) }),
    )
    expect((await post(r, longText, headers(dev.deviceId))).status).toBe(400)
    const extra = await signedPost(dev, { extra: 'field' })
    expect((await post(r, extra, headers(dev.deviceId))).status).toBe(400)
    expect(rows(r)).toBe(0)
  })
})

describe('the per-device rate limit (real token bucket)', () => {
  it('lets 6 an hour through and answers the 7th with 429 and Retry-After; another device has its own budget', async () => {
    const { r, dev } = await world()
    const real = new RateLimiter(r.relay.services.clock)
    setAuthImplementation(
      { ...createTestAuth({ bridgeKey: r.bridgeKey }), takeRate: (_c, name, key) => real.take(name, key ?? 'ip') },
      { test: true },
    )
    for (let i = 0; i < BUG_REPORT_LIMITS.perHour; i++)
      expect((await post(r, await signedPost(dev), headers(dev.deviceId))).status).toBe(201)
    const over = await post(r, await signedPost(dev), headers(dev.deviceId))
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(rows(r)).toBe(BUG_REPORT_LIMITS.perHour)
    const second = await createDeviceKey()
    r.relay.services.db
      .prepare(
        'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
      )
      .run(second.deviceId, 'mac', JSON.stringify(second.publicJwk), 'b', Date.now())
    expect((await post(r, await signedPost(second), headers(second.deviceId))).status).toBe(201)
  })
})

describe('retention', () => {
  it('the sweep deletes a report (row and both files) after 90 days and keeps a newer one', async () => {
    const { r, dev } = await world()
    const oldOne = await signedPost(dev)
    const newer = await signedPost(dev)
    expect((await post(r, oldOne, headers(dev.deviceId))).status).toBe(201)
    expect((await post(r, newer, headers(dev.deviceId))).status).toBe(201)
    const DAY = 86_400_000
    const age = r.relay.services.db.prepare('update core_bug_reports set created_at = ? where report_id = ?')
    age.run(Date.now() - 91 * DAY, oldOne.id)
    age.run(Date.now() - 89 * DAY, newer.id)
    const deps = {
      db: r.relay.services.db,
      crypto: r.relay.services.crypto,
      clock: r.relay.services.clock,
      dataDir: r.dir,
    }
    expect(sweepBugReports(deps)).toBe(1)
    expect(rows(r)).toBe(1)
    const dir = join(r.dir, 'bug-reports')
    expect(existsSync(join(dir, `${oldOne.id}.json.bin`))).toBe(false)
    expect(existsSync(join(dir, `${oldOne.id}.img.bin`))).toBe(false)
    expect(existsSync(join(dir, `${newer.id}.json.bin`))).toBe(true)
    expect(existsSync(join(dir, `${newer.id}.img.bin`))).toBe(true)
  })

  it('the relay runs the sweep itself on its timer (the hourly sweeper calls it)', async () => {
    const { r, dev } = await world()
    const body = await signedPost(dev)
    expect((await post(r, body, headers(dev.deviceId))).status).toBe(201)
    r.relay.services.db.prepare('update core_bug_reports set created_at = ?').run(Date.now() - 100 * 86_400_000)
    r.runtime.stop()
    r.runtime.start() // start() runs one sweep straight away
    expect(rows(r)).toBe(0)
  })
})

describe('the webhook', () => {
  type Hit = { headers: IncomingMessage['headers']; body: string }
  async function sink(status = 200) {
    const hits: Hit[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
        res.statusCode = status
        res.end('ok')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => server.close())
    return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook` }
  }
  const syncUrl = async (r: TestRelay, url: string | undefined) => {
    const b = await kit(r).bridge({ autoReply: false, verifyOwner: false }).connect()
    closers.push(() => void b.close())
    b.send({
      type: 'config.sync',
      config: { ...DEFAULT_AGENT_CONFIG, rev: 1, ...(url ? { bug_webhook_url: url } : {}) },
      rev: 1,
    })
    await waitFor(() => r.relay.services.agentConfig()?.rev === 1)
  }

  it('is off by default: no URL, no secret, nothing is sent, and the event says so', async () => {
    const lines: Array<Record<string, unknown>> = []
    const log = capture(lines)
    const s = await sink()
    const { r, dev } = await world({ log })
    expect((await post(r, await signedPost(dev), headers(dev.deviceId))).status).toBe(201)
    await new Promise((res) => setTimeout(res, 150))
    expect(s.hits).toEqual([])
    const ev = lines.find((l) => l.event === 'bug.reported')
    expect(ev).toMatchObject({ webhook: 'off' })
  })

  it('stays off with a URL but no secret, and with a secret but no URL', async () => {
    const s = await sink()
    const { r, dev } = await world()
    await syncUrl(r, s.url)
    expect((await post(r, await signedPost(dev), headers(dev.deviceId))).status).toBe(201)
    await new Promise((res) => setTimeout(res, 150))
    expect(s.hits).toEqual([])
    await relay?.stop()
    const w2 = await world({ env: { BUG_WEBHOOK_SECRET: SECRET } })
    expect((await post(w2.r, await signedPost(w2.dev), headers(w2.dev.deviceId))).status).toBe(201)
    await new Promise((res) => setTimeout(res, 150))
    expect(s.hits).toEqual([])
  })

  it('with a URL and a secret sends one call with webhook-id, webhook-timestamp and a correct webhook-signature', async () => {
    const s = await sink()
    const { r, dev } = await world({ env: { BUG_WEBHOOK_SECRET: SECRET } })
    await syncUrl(r, s.url)
    const body = await signedPost(dev)
    expect((await post(r, body, headers(dev.deviceId))).status).toBe(201)
    await waitFor(() => s.hits.length === 1)
    const hit = s.hits[0] as Hit
    const id = hit.headers['webhook-id'] as string
    const ts = hit.headers['webhook-timestamp'] as string
    expect(id).toBe(`msg_${body.id}`)
    expect(ts).toMatch(/^\d{10}$/)
    const expected = `v1,${createHmac('sha256', SECRET_BYTES).update(`${id}.${ts}.${hit.body}`).digest('base64')}`
    expect(hit.headers['webhook-signature']).toBe(expected)
    expect(standardWebhookSignature(SECRET, id, Number(ts), hit.body)).toBe(expected)
    const sent = JSON.parse(hit.body)
    expect(sent.type).toBe('bug.reported')
    expect(sent.data.id).toBe(body.id)
    expect(sent.data.report.what_went_wrong).toBe('The send button did nothing')
    expect(hit.body).not.toContain(body.image_b64) // the picture stays on the relay
  })

  it("with no address of the owner's own, goes to the team inbox this relay was deployed with", async () => {
    const s = await sink()
    const { r, dev } = await world({ env: { BUG_WEBHOOK_SECRET: SECRET, BUG_TEAM_INBOX_URL: s.url } })
    await syncUrl(r, undefined)
    const body = await signedPost(dev)
    expect((await post(r, body, headers(dev.deviceId))).status).toBe(201)
    await waitFor(() => s.hits.length === 1)
    const hit = s.hits[0] as Hit
    const sent = JSON.parse(hit.body)
    expect(sent.data.id).toBe(body.id)
    // the picture rides inside the one signed body, byte for byte
    expect(sent.data.image).toEqual({ type: 'image/png', b64: body.image_b64 })
    const id = hit.headers['webhook-id'] as string
    const ts = Number(hit.headers['webhook-timestamp'])
    expect(hit.headers['webhook-signature']).toBe(standardWebhookSignature(SECRET, id, ts, hit.body))
  })

  it("the owner's own address wins over the team inbox: one call, to the owner's", async () => {
    const team = await sink()
    const own = await sink()
    const { r, dev } = await world({ env: { BUG_WEBHOOK_SECRET: SECRET, BUG_TEAM_INBOX_URL: team.url } })
    await syncUrl(r, own.url)
    expect((await post(r, await signedPost(dev), headers(dev.deviceId))).status).toBe(201)
    await waitFor(() => own.hits.length === 1)
    await new Promise((res) => setTimeout(res, 150))
    expect(team.hits).toEqual([])
    expect(JSON.parse((own.hits[0] as Hit).body).data.image).toBeUndefined() // the owner's own address: text only, as before
  })

  it('a refusal (a wrong secret, an inbox that is off) is logged as refused, never as sent', async () => {
    for (const status of [401, 404, 502]) {
      const said: Array<{ level: string; msg: string }> = []
      const mk = (): Logger => {
        const at = (level: string) => (_o: unknown, msg?: string) => void said.push({ level, msg: msg ?? '' })
        return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: mk }
      }
      const s = await sink(status)
      const { r, dev } = await world({ log: mk(), env: { BUG_WEBHOOK_SECRET: SECRET, BUG_TEAM_INBOX_URL: s.url } })
      expect((await post(r, await signedPost(dev), headers(dev.deviceId))).status).toBe(201)
      await waitFor(() => said.some((l) => l.msg.startsWith('bug report webhook')))
      expect(said.filter((l) => l.msg.startsWith('bug report webhook'))).toEqual([
        { level: 'warn', msg: 'bug report webhook refused' },
      ])
      await relay?.stop()
      relay = null
    }
  })

  it('a wrong secret does not verify (the signature depends on the secret)', () => {
    const a = standardWebhookSignature(SECRET, 'msg_1', 1700000000, '{}')
    const b = standardWebhookSignature(
      `whsec_${Buffer.from('another secret value 1234567890').toString('base64')}`,
      'msg_1',
      1700000000,
      '{}',
    )
    expect(a).not.toBe(b)
  })
})

describe('GET /api/bug-reports/destination: what the reporter says', () => {
  const ask = (r: TestRelay, h: Record<string, string>) =>
    fetch(`${r.httpBase}/api/bug-reports/destination`, { headers: h })
  const syncUrl = async (r: TestRelay, url: string) => {
    const b = await kit(r).bridge({ autoReply: false, verifyOwner: false }).connect()
    closers.push(() => void b.close())
    b.send({ type: 'config.sync', config: { ...DEFAULT_AGENT_CONFIG, rev: 1, bug_webhook_url: url }, rev: 1 })
    await waitFor(() => r.relay.services.agentConfig()?.rev === 1)
  }
  const TEAM = 'https://team-relay.example.com/api/bug-inbox'
  const OWN = 'https://hooks.example.com/t/0123456789abcdefghij'

  it('nowhere else by default', async () => {
    const { r, dev } = await world()
    const res = await ask(r, headers(dev.deviceId))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ to: 'relay' })
  })

  it('nowhere else when an address or the team inbox is set but the relay has no secret to sign with', async () => {
    const { r, dev } = await world({ env: { BUG_TEAM_INBOX_URL: TEAM } })
    await syncUrl(r, OWN)
    expect(await (await ask(r, headers(dev.deviceId))).json()).toEqual({ to: 'relay' })
  })

  it('the Talos team when the deploy named the team inbox and the owner set no address', async () => {
    const { r, dev } = await world({ env: { BUG_WEBHOOK_SECRET: SECRET, BUG_TEAM_INBOX_URL: TEAM } })
    expect(await (await ask(r, headers(dev.deviceId))).json()).toEqual({ to: 'team' })
  })

  it("the host of the owner's address, never the address, when one is set (it wins over the team inbox)", async () => {
    const { r, dev } = await world({ env: { BUG_WEBHOOK_SECRET: SECRET, BUG_TEAM_INBOX_URL: TEAM } })
    await syncUrl(r, OWN)
    const text = await (await ask(r, headers(dev.deviceId))).text()
    expect(JSON.parse(text)).toEqual({ to: 'webhook', host: 'hooks.example.com' })
    expect(text).not.toContain('0123456789abcdefghij')
  })

  it('nowhere else when the address is one the webhook would refuse', async () => {
    const { r, dev } = await world({
      env: { BUG_WEBHOOK_SECRET: SECRET, BUG_TEAM_INBOX_URL: 'ftp://team.example.com/x' },
    })
    expect(await (await ask(r, headers(dev.deviceId))).json()).toEqual({ to: 'relay' })
  })

  it('needs a session', async () => {
    const { r } = await world({ env: { BUG_WEBHOOK_SECRET: SECRET, BUG_TEAM_INBOX_URL: TEAM } })
    expect((await ask(r, { Origin: ORIGIN })).status).toBe(401)
  })
})

describe('the total disk cap', () => {
  it('refuses a new report with 507 once the kept reports would pass BUG_REPORTS_MAX_MB, and counts them in the volume sum', async () => {
    const { r, dev } = await world({ env: { BUG_REPORTS_MAX_MB: '1' } })
    const big = Buffer.concat([PNG, Buffer.alloc(600 * 1024)])
    expect((await post(r, await signedPost(dev, {}, big), headers(dev.deviceId))).status).toBe(201)
    const res = await post(r, await signedPost(dev, {}, big), headers(dev.deviceId))
    expect(res.status).toBe(507)
    expect(((await res.json()) as { error: string }).error).toBe('storage_full')
    expect(rows(r)).toBe(1)
    expect(bugReportBytes({ db: r.relay.services.db })).toBeGreaterThan(600 * 1024)
    // room again after the report ages out
    r.relay.services.db.prepare('update core_bug_reports set created_at = 0').run()
    sweepBugReports({
      db: r.relay.services.db,
      crypto: r.relay.services.crypto,
      clock: r.relay.services.clock,
      dataDir: r.dir,
    })
    expect((await post(r, await signedPost(dev, {}, big), headers(dev.deviceId))).status).toBe(201)
  })
})

describe('a failed store burns nothing', () => {
  it('a 500 leaves no files and no used nonce, so the same report stores on retry', async () => {
    const { r, dev } = await world()
    const db = r.relay.services.db
    db.exec("create trigger boom before insert on core_bug_reports begin select raise(abort, 'disk'); end")
    const body = await signedPost(dev)
    const bad = await post(r, body, headers(dev.deviceId))
    expect(bad.status).toBe(500)
    expect(existsSync(join(r.dir, 'bug-reports')) ? readdirSync(join(r.dir, 'bug-reports')) : []).toEqual([])
    expect(
      (db.prepare("select count(*) n from core_push_nonces where nonce_key like 'bug:%'").get() as { n: number }).n,
    ).toBe(0)
    db.exec('drop trigger boom')
    expect((await post(r, body, headers(dev.deviceId))).status).toBe(201)
    expect(rows(r)).toBe(1)
  })
})

describe('where the webhook may go', () => {
  it('needs https, no user:pass@, no localhost / .internal / .local names, no private IP literal', () => {
    const ok = (u: string) => checkWebhookUrl(u) !== null
    expect(ok('https://hooks.example.com/in')).toBe(true)
    expect(ok('http://hooks.example.com/in')).toBe(false)
    expect(ok(`https://name:word${'@'}hooks.example.com/in`)).toBe(false)
    for (const bad of [
      'https://localhost/x',
      'https://app.localhost/x',
      'https://db.internal/x',
      'https://printer.local/x',
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://172.20.0.1/x',
      'https://192.168.1.5/x',
      'https://169.254.169.254/latest',
      'https://100.64.0.1/x',
      'https://0.0.0.0/x',
      'https://[::1]/x',
      'https://[fd00::1]/x',
      'https://[fe80::1]/x',
      'https://[::ffff:10.0.0.1]/x',
      'not a url',
    ])
      expect(ok(bad), bad).toBe(false)
    expect(ok('https://8.8.8.8/x')).toBe(true)
    expect(ok('https://172.32.0.1/x')).toBe(true)
    expect(isPrivateAddress('93.184.216.34')).toBe(false)
  })

  it('refuses the IPv6 forms that carry an inward IPv4 address, the reserved ranges, and a name with a trailing dot', () => {
    // The same list the rest of Talos uses for a URL someone else influences (packages/protocol/src/address.ts).
    for (const inward of [
      '64:ff9b::a9fe:a9fe', // NAT64 of 169.254.169.254
      '64:ff9b::7f00:1', // NAT64 of 127.0.0.1
      '2002:a9fe:a9fe::1', // 6to4 of 169.254.169.254
      '2002:0a00:0001::1', // 6to4 of 10.0.0.1
      '::ffff:0:a00:1', // translated 10.0.0.1
      'fec0::1', // site local
      '2001:0:53aa:64c:0:0:0:1', // Teredo
      '198.18.0.1', // benchmarking
      '192.0.0.8', // protocol assignments
    ])
      expect(isPrivateAddress(inward), inward).toBe(true)
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
    expect(isPrivateAddress('64:ff9b::808:808')).toBe(false) // NAT64 of a public address
    for (const bad of [
      'https://[64:ff9b::a9fe:a9fe]/x',
      'https://[2002:a9fe:a9fe::1]/x',
      'https://198.18.0.1/x',
      'https://localhost./x',
      'https://db.internal./x',
      'https://intranet/x',
    ])
      expect(checkWebhookUrl(bad), bad).toBeNull()
  })

  it('refuses a name that resolves to a private address when it connects (DNS rebinding)', async () => {
    const res = await new Promise<{ err: Error | null }>((resolve) =>
      pinnedLookup(false)('localhost', {}, (err) => resolve({ err })),
    )
    expect(res.err?.message).toContain('refused')
    const ok = await new Promise<{ err: Error | null }>((resolve) =>
      pinnedLookup(true)('localhost', {}, (err) => resolve({ err })),
    )
    expect(ok.err).toBeNull()
  })
})

describe('the named event', () => {
  it('emits bug.reported with ids and an enum only: no words, no logs, no picture', async () => {
    const lines: Array<Record<string, unknown>> = []
    const { r, dev } = await world({ log: capture(lines) })
    const body = await signedPost(dev)
    expect((await post(r, body, headers(dev.deviceId))).status).toBe(201)
    const ev = lines.filter((l) => l.event === 'bug.reported')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ report_id: body.id, device_id: dev.deviceId, webhook: 'off' })
    const text = JSON.stringify(ev[0])
    expect(text).not.toContain('send button')
    expect(text).not.toContain('line one')
    expect(text).not.toContain(body.image_b64)
  })
})

function capture(lines: Array<Record<string, unknown>>): Logger {
  const mk = (): Logger => {
    const push = (o: object | string) => {
      if (typeof o === 'object') lines.push(o as Record<string, unknown>)
    }
    return { debug: push, info: push, warn: push, error: push, child: mk }
  }
  return mk()
}
