// An own-device bug report is never silently lost on its way to the owner's Mac. The relay keeps a
// report until the Mac has FILED it (`consumed`), not merely taken it (`delivered`): a taken-but-unfiled report is sent again
// and kept past the buffer; one whose queue entry expired or was swept is queued again by the reconcile (at startup and every
// few minutes); the queue entry and its mark are one transaction; an operator can queue one report again over the signed
// bridge API. Deterministic: a fake clock, no wall-clock waits.
import {
  BugReportPost,
  createDeviceKey,
  type DeviceKey,
  newUlid,
  PROBLEMS_FEATURE,
  type ProblemT,
  signBridgeHttp,
  signOwnerFrame,
  Ulid,
} from '@talos-app/protocol'
import { type FakeBridge, type FakeClock, fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  backfillOwnReports,
  deliveryId,
  loadBugReport,
  queueToBridge,
  requeueBugReport,
  storeBugReport,
} from '../../src/core/bug-reports.ts'
import { ORIGIN, startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 60_000 })

const DAY = 86_400_000
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let relay: TestRelay | null = null
const bridges: FakeBridge[] = []
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.close()
  await relay?.stop()
  relay = null
  vi.restoreAllMocks()
})

async function world() {
  const c: FakeClock = fakeClock(new Date().toISOString())
  const r = await startTestRelay({ clock: c })
  relay = r
  const dev = await createDeviceKey()
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
    )
    .run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', c.now())
  return { c, r, dev }
}

const signedPost = (dev: DeviceKey, c: FakeClock, id: string = newUlid()) =>
  signOwnerFrame(
    {
      v: 1,
      type: 'bug.report',
      device_id: dev.deviceId,
      id,
      ts: new Date(c.now()).toISOString(),
      nonce: newUlid().toLowerCase(),
      report: {
        what_went_wrong: 'The send button did nothing',
        expected: 'The message to go',
        versions: { app: '1.0.0', bridge: '1.0.0', relay: '1.0.0', claude_code: '2.0.0' },
        recent_errors: [],
        logs: 'line one',
      },
      image_type: 'image/png',
      image_b64: PNG.toString('base64'),
    },
    dev.privateKey,
  )

const send = (r: TestRelay, body: unknown, deviceId: string) =>
  fetch(`${r.httpBase}/api/bug-reports`, {
    method: 'POST',
    headers: {
      'X-Test-Session': deviceId,
      Origin: ORIGIN,
      'X-Talos-CSRF': '1',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

/** A Mac that takes frames (acks `delivered`) and pushes them into Claude only when the test says so. */
async function mac(r: TestRelay, consume: 'manual' | 'auto' = 'manual') {
  const b = await kit(r)
    .bridge({ autoReply: false, verifyOwner: false, features: [PROBLEMS_FEATURE], consume })
    .connect()
  bridges.push(b)
  return b
}
const got = (b: FakeBridge) => b.rec.of('problem.item', 'in') as unknown as Array<{ id: string; problem: ProblemT }>
/** The id the report was queued under (frame id and problem id): random, made by the relay. */
const delivery = (r: TestRelay, id: string) =>
  (
    r.relay.services.db.prepare('select bridge_frame_id f from core_bug_reports where report_id = ?').get(id) as {
      f: string
    }
  ).f
const col = (r: TestRelay, name: 'bridge_queued_at' | 'bridge_consumed_at', id: string) =>
  (
    r.relay.services.db.prepare(`select ${name} v from core_bug_reports where report_id = ?`).get(id) as {
      v: number | null
    }
  ).v
const events = (r: TestRelay) =>
  (
    r.relay.services.db.prepare("select count(*) n from core_events where type = 'problem.item'").get() as {
      n: number
    }
  ).n
const outbox = (r: TestRelay) =>
  (
    r.relay.services.db.prepare("select count(*) n from core_outbox where type = 'problem.item'").get() as {
      n: number
    }
  ).n

/** The relay has heard the Mac's `delivered` for the report (the frame arriving is not enough: the ack is still on its way). */
const taken = (r: TestRelay, id: string) =>
  waitFor(() => r.runtime.store.outboxRow(delivery(r, id))?.delivered === 1, 10_000, 'the delivered ack')

async function post(r: TestRelay, dev: DeviceKey, c: FakeClock) {
  const body = await signedPost(dev, c)
  expect((await send(r, body, dev.deviceId)).status).toBe(201)
  return body
}

describe('a report the Mac took but has not filed is not forgotten', () => {
  it('is sent again on the relay timer until the Mac says consumed, then never again', async () => {
    const { c, r, dev } = await world()
    const m = await mac(r)
    const body = await post(r, dev, c)
    await waitFor(() => got(m).length === 1, 10_000, 'the first delivery')
    await taken(r, body.id)
    // the Mac acked `delivered` and filed nothing (its disk write failed): the relay must try again on its own
    await advance(c, 130_000, 10_000)
    await waitFor(() => got(m).length >= 2, 10_000, 'a timed resend of a taken report')
    expect(col(r, 'bridge_consumed_at', body.id)).toBeNull()
    m.consume(delivery(r, body.id)) // now it is filed
    await waitFor(() => col(r, 'bridge_consumed_at', body.id) !== null, 10_000, 'the consumed mark')
    expect(r.runtime.store.outboxRow(delivery(r, body.id))).toBeUndefined()
    const seen = got(m).length
    await advance(c, 600_000, 10_000)
    expect(got(m)).toHaveLength(seen)
  })

  it('stays in the relay past the 7-day buffer while the Mac has taken but not filed it', async () => {
    const { c, r, dev } = await world()
    const m = await mac(r)
    const body = await post(r, dev, c)
    await waitFor(() => got(m).length === 1, 10_000, 'the first delivery')
    await taken(r, body.id)
    c.set(c.now() + 8 * DAY)
    r.runtime.hub.sweep()
    expect(events(r)).toBe(1)
    expect(r.runtime.store.outboxRow(delivery(r, body.id))?.delivered).toBe(1)
    const shot = got(m)[0]?.problem.screenshot
    expect(shot && r.runtime.store.getMediaRow(shot.media_id)?.evicted).toBeFalsy()
  })

  it('a report the Mac took does not show as "waiting for a newer Talos"', async () => {
    const { c, r, dev } = await world()
    const m = await mac(r)
    const body = await post(r, dev, c)
    await waitFor(() => got(m).length === 1, 10_000, 'the first delivery')
    await taken(r, body.id)
    expect(r.runtime.store.waitingProblems()).toEqual([])
  })
})

describe('a queue entry that expired does not stay "queued" for good', () => {
  it('the swept entry is queued again by the reconcile, and the Mac files it once', async () => {
    const { c, r, dev } = await world()
    const body = await post(r, dev, c) // the Mac is offline: queued, not delivered
    expect(col(r, 'bridge_queued_at', body.id)).not.toBeNull()
    c.set(c.now() + 31 * DAY) // past the 30-day hold: the sweep drops the event and its queue entry
    r.runtime.hub.sweep()
    expect(events(r)).toBe(0)
    expect(outbox(r)).toBe(0)
    expect(await backfillOwnReports(r.relay.services)).toBe(1)
    expect(events(r)).toBe(1)
    const m = await mac(r)
    await waitFor(() => got(m).length === 1, 10_000, 'the report after the Mac came back')
    expect(got(m)[0]?.problem.id).toBe(delivery(r, body.id))
    m.consume(delivery(r, body.id))
    await waitFor(() => col(r, 'bridge_consumed_at', body.id) !== null, 10_000, 'the consumed mark')
    expect(await backfillOwnReports(r.relay.services)).toBe(0) // filed: nothing more is ever sent
    expect(got(m)).toHaveLength(1)
  })

  it('a report with a live queue entry is not queued twice', async () => {
    const { c, r, dev } = await world()
    await post(r, dev, c)
    expect(await backfillOwnReports(r.relay.services)).toBe(0)
    expect(events(r)).toBe(1)
  })
})

describe('a queue failure after the store is retried without a restart', () => {
  it('the periodic reconcile queues the report, with no restart', async () => {
    const { c, r, dev } = await world()
    const m = await mac(r, 'auto')
    const spy = vi.spyOn(r.runtime.hub, 'toBridge').mockRejectedValueOnce(new Error('disk'))
    const body = await post(r, dev, c)
    expect(col(r, 'bridge_queued_at', body.id)).toBeNull()
    spy.mockRestore()
    await advance(c, 6 * 60_000, 20_000)
    await waitFor(() => got(m).length === 1, 10_000, 'the report from the timed reconcile')
    expect(col(r, 'bridge_queued_at', body.id)).not.toBeNull()
  })
})

describe('the queue entry and its mark are one transaction', () => {
  it('a failed mark leaves no frame behind; the next reconcile queues it once', async () => {
    const { c, r, dev } = await world()
    const db = r.relay.services.db
    db.exec(
      "create trigger boom before update of bridge_queued_at on core_bug_reports begin select raise(abort, 'boom'); end",
    )
    const body = await post(r, dev, c)
    expect(events(r)).toBe(0)
    expect(outbox(r)).toBe(0)
    expect(col(r, 'bridge_queued_at', body.id)).toBeNull()
    db.exec('drop trigger boom')
    expect(await backfillOwnReports(r.relay.services)).toBe(1)
    expect(events(r)).toBe(1)
  })
})

describe('requeue one report over the signed bridge API', () => {
  const call = async (r: TestRelay, id: string, signed = true) => {
    const path = `/bridge/bug-reports/${id}/requeue`
    const authorization = await signBridgeHttp({
      privateKey: r.bridgeKey.privateKey,
      keyId: r.bridgeKey.keyId,
      method: 'POST',
      pathWithQuery: path,
      body: '{}',
    })
    return fetch(`${r.httpBase}${path}`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', ...(signed ? { authorization } : {}) },
    })
  }

  it('refuses an unsigned call and an unknown report', async () => {
    const { c, r, dev } = await world()
    const body = await post(r, dev, c)
    expect((await call(r, body.id, false)).status).toBe(401)
    expect((await call(r, newUlid())).status).toBe(404)
    expect((await call(r, 'not-an-id')).status).toBe(404)
  })

  it('sends a filed report again as a new frame for the same problem, with its picture', async () => {
    const { c, r, dev } = await world()
    const m = await mac(r, 'auto')
    const body = await post(r, dev, c)
    await waitFor(() => col(r, 'bridge_consumed_at', body.id) !== null, 10_000, 'the first filing')
    const res = await call(r, body.id)
    expect(res.status).toBe(200)
    await waitFor(() => got(m).length === 2, 10_000, 'the second frame')
    const [first, again] = got(m) as [{ id: string; problem: ProblemT }, { id: string; problem: ProblemT }]
    expect(again.problem.id).toBe(first.problem.id)
    expect(again.id).not.toBe(first.id) // a new frame id: the Mac has seen the first and would only confirm it
    expect(again.problem.screenshot).toBeDefined()
    expect(await r.relay.services.media.get(again.problem.screenshot?.media_id as string)).not.toBeNull()
  })
})

const media = (r: TestRelay) =>
  (r.relay.services.db.prepare('select count(*) n from core_media').get() as { n: number }).n

/** What a signed-in device can post to /api/problems. */
const posted = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  source: 'web',
  kind: 'owner',
  fingerprint: 'a'.repeat(32),
  at: new Date().toISOString(),
  name: 'bug report',
  message: 'text a device chose',
  frames: [],
  versions: { app: '1.0.0' },
  device: 'browser',
  routes: [],
  steps: 'steps a device chose',
  truncated: false,
  ...over,
})
const sendProblem = (r: TestRelay, body: unknown, deviceId: string) =>
  fetch(`${r.httpBase}/api/problems`, {
    method: 'POST',
    headers: { 'X-Test-Session': deviceId, Origin: ORIGIN, 'X-Talos-CSRF': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('a problem a device posts is never a bug report', () => {
  it('posted under the report id first: the real report is its own frame with its own words, and only its answer marks it filed', async () => {
    const { c, r, dev } = await world()
    const m = await mac(r)
    const body = await signedPost(dev, c)
    // the device knows the report id before the report is stored (the owner's own page made it)
    expect((await sendProblem(r, posted(body.id), dev.deviceId)).status).toBe(202)
    expect((await send(r, body, dev.deviceId)).status).toBe(201)
    await waitFor(() => got(m).length === 2, 10_000, 'both frames')
    const real = got(m).find((f) => f.id !== body.id) as { id: string; problem: ProblemT }
    const fake = got(m).find((f) => f.id === body.id) as { id: string; problem: ProblemT }
    expect(real.problem.message).toBe('The send button did nothing')
    expect(real.problem.id).toBe(delivery(r, body.id)) // not the id the device used: the Mac files the two apart
    expect(fake.problem.message).toBe('text a device chose')
    m.consume(fake.id) // the Mac filed what the device posted
    await waitFor(() => r.runtime.store.outboxRow(fake.id) === undefined, 10_000, 'the posted problem consumed')
    expect(col(r, 'bridge_consumed_at', body.id)).toBeNull() // the report itself is not filed yet
    m.consume(real.id)
    await waitFor(() => col(r, 'bridge_consumed_at', body.id) !== null, 10_000, 'the real report consumed')
  })

  it('a report queued before delivery ids keeps its own id as problem id, and a frame of that id holding another problem falls back to a new id', async () => {
    const { c, r, dev } = await world()
    const s = r.relay.services
    const deps = { db: s.db, crypto: s.crypto, clock: s.clock, dataDir: s.env.DATA_DIR }
    const a = BugReportPost.parse(await signedPost(dev, c))
    const b = BugReportPost.parse(await signedPost(dev, c))
    for (const x of [a, b]) {
      storeBugReport(deps, x, PNG, c.now() + 600_000)
      s.db.prepare('update core_bug_reports set bridge_queued_at = ? where report_id = ?').run(c.now(), x.id) // queued by the old build
    }
    // `b`'s id was taken by another problem a device posted
    await r.runtime.hub.toBridge(
      { type: 'problem.item', id: b.id, problem: posted(b.id, { kind: 'auto', steps: undefined }) },
      { durable: true },
    )
    expect(await backfillOwnReports(s)).toBe(1) // `b` looks queued: a frame carries its id
    const held = loadBugReport(deps, b.id) as NonNullable<ReturnType<typeof loadBugReport>>
    expect(await queueToBridge(s, held.post, held.image)).toBe(true) // asked for directly, it is not resumed from that frame
    const m = await mac(r)
    await waitFor(() => got(m).length === 3, 10_000, 'the frames')
    const mine = (id: string) => got(m).filter((f) => f.id === id)
    expect(mine(a.id)).toHaveLength(1) // the Mac already knows it as its report id
    expect(mine(a.id)[0]?.problem.id).toBe(a.id)
    const fallback = got(m).filter((f) => f.id !== a.id && f.id !== b.id)
    expect(fallback).toHaveLength(1)
    expect(fallback[0]?.id).toBe(delivery(r, b.id))
    expect(fallback[0]?.problem.message).toBe('The send button did nothing')
  })
})

describe('delivery ids', () => {
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const randomPart = (id: string) => [...id.slice(10)].reduce((n, ch) => n * 32n + BigInt(CROCKFORD.indexOf(ch)), 0n)

  it('are ULID-shaped, carry the time, and are not a sequence: ids minted in the same millisecond are far apart', () => {
    const now = Date.parse('2026-11-16T12:00:00.000Z')
    const ids = Array.from({ length: 200 }, () => deliveryId(now))
    for (const id of ids) {
      expect(Ulid.safeParse(id).success).toBe(true)
      expect(id.slice(0, 10)).toBe(ids[0]?.slice(0, 10)) // the same millisecond: the same time part
    }
    expect(new Set(ids).size).toBe(ids.length)
    // the shared monotonic generator would make each the previous plus one; these are 80 random bits each
    for (let i = 1; i < ids.length; i++) {
      const gap = randomPart(ids[i] as string) - randomPart(ids[i - 1] as string)
      expect(gap > 1000n || gap < -1000n).toBe(true)
    }
  })

  it('a report is queued under one of them, not under the shared sequence', async () => {
    const { c, r, dev } = await world()
    const a = await post(r, dev, c)
    const b = await post(r, dev, c)
    const [x, y] = [delivery(r, a.id), delivery(r, b.id)]
    const gap = randomPart(y) - randomPart(x)
    expect(gap > 1000n || gap < -1000n).toBe(true)
  })
})

describe('a problem cannot be posted under a bug report id', () => {
  it('is refused, of any kind, for a report id and for the ids it was queued under; another id is queued', async () => {
    const { c, r, dev } = await world()
    const body = await post(r, dev, c)
    const auto = { kind: 'auto', steps: undefined }
    for (const id of [body.id, delivery(r, body.id)]) {
      expect((await sendProblem(r, posted(id), dev.deviceId)).status).toBe(400)
      expect((await sendProblem(r, posted(id, auto), dev.deviceId)).status).toBe(400)
    }
    expect((await sendProblem(r, posted(newUlid()), dev.deviceId)).status).toBe(202)
    expect((await sendProblem(r, posted(newUlid(), auto), dev.deviceId)).status).toBe(202)
  })

  it('the id a report is queued under is random: the same report id gets another one on another relay', async () => {
    const { c, r, dev } = await world()
    const id = newUlid()
    expect((await send(r, await signedPost(dev, c, id), dev.deviceId)).status).toBe(201)
    const first = delivery(r, id)
    await r.stop()
    const again = await world()
    expect((await send(again.r, await signedPost(again.dev, again.c, id), again.dev.deviceId)).status).toBe(201)
    const second = delivery(again.r, id)
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(second).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(second).not.toBe(first)
  })
})

describe('a requeue does not pile up', () => {
  it('a report still on its way makes no new frame and no new picture; a filed one is queued again', async () => {
    const { c, r, dev } = await world()
    const body = await post(r, dev, c) // the Mac is offline: queued, live
    const before = { events: events(r), media: media(r) }
    expect(await requeueBugReport(r.relay.services, body.id)).toBe('already_queued')
    expect(await requeueBugReport(r.relay.services, body.id)).toBe('already_queued')
    expect({ events: events(r), media: media(r) }).toEqual(before)
    const m = await mac(r, 'auto')
    await waitFor(() => col(r, 'bridge_consumed_at', body.id) !== null, 10_000, 'filed')
    expect(await requeueBugReport(r.relay.services, body.id)).toBe('queued')
    await waitFor(() => got(m).length === 2, 10_000, 'the requeued frame')
    expect(await requeueBugReport(r.relay.services, newUlid())).toBe('not_found')
  })

  it('the reconcile counts a live requeued frame: nothing is queued beside it', async () => {
    const { c, r, dev } = await world()
    const body = await post(r, dev, c) // queued, the Mac away
    c.set(c.now() + 31 * DAY)
    r.runtime.hub.sweep() // its queue entry is gone
    expect(events(r)).toBe(0)
    expect(await requeueBugReport(r.relay.services, body.id)).toBe('queued') // an operator sends it again: a new frame id
    expect(events(r)).toBe(1)
    expect(await backfillOwnReports(r.relay.services)).toBe(0)
    expect(events(r)).toBe(1)
  })

  it('only the frame the report was queued as marks it filed: another consumed ack touches nothing', async () => {
    const { c, r, dev } = await world()
    const m = await mac(r)
    const body = await post(r, dev, c)
    await waitFor(() => got(m).length === 1, 10_000, 'delivered')
    m.send({ type: 'ack', ref: body.id, stage: 'consumed' }) // the report id is not a frame id here
    m.send({ type: 'ack', ref: newUlid(), stage: 'consumed' })
    await new Promise((res) => setTimeout(res, 150))
    expect(col(r, 'bridge_consumed_at', body.id)).toBeNull()
  })
})

describe('a requeue is one transaction', () => {
  it('a filed report is queued again as a new frame, and is unfiled until the Mac answers that frame', async () => {
    const { c, r, dev } = await world()
    const m = await mac(r, 'manual')
    const body = await post(r, dev, c)
    await waitFor(() => got(m).length === 1, 10_000, 'delivered')
    m.consume(delivery(r, body.id))
    await waitFor(() => col(r, 'bridge_consumed_at', body.id) !== null, 10_000, 'filed')
    const first = delivery(r, body.id)
    expect(await requeueBugReport(r.relay.services, body.id)).toBe('queued')
    expect(col(r, 'bridge_consumed_at', body.id)).toBeNull() // filed again is not known yet
    expect(delivery(r, body.id)).not.toBe(first)
    // so a second requeue meets a report that is still on its way
    expect(await requeueBugReport(r.relay.services, body.id)).toBe('already_queued')
    await waitFor(() => got(m).length === 2, 10_000, 'the new frame')
    m.consume(delivery(r, body.id))
    await waitFor(() => col(r, 'bridge_consumed_at', body.id) !== null, 10_000, 'filed again')
  })

  it('two requeues at once make one frame', async () => {
    const { c, r, dev } = await world()
    const m = await mac(r, 'auto')
    const body = await post(r, dev, c)
    await waitFor(() => col(r, 'bridge_consumed_at', body.id) !== null, 10_000, 'filed')
    const before = events(r)
    const done = await Promise.all([
      requeueBugReport(r.relay.services, body.id),
      requeueBugReport(r.relay.services, body.id),
      requeueBugReport(r.relay.services, body.id),
    ])
    expect(done.filter((x) => x === 'queued')).toHaveLength(1)
    expect(done.filter((x) => x === 'already_queued')).toHaveLength(2)
    expect(events(r)).toBe(before + 1)
    await waitFor(() => got(m).length === 2, 10_000, 'the one new frame')
  })

  it('a requeue frame that expires before the Mac takes it is queued again by the reconcile, under the same frame id', async () => {
    const { c, r, dev } = await world()
    const m = await mac(r, 'auto')
    const body = await post(r, dev, c)
    await waitFor(() => col(r, 'bridge_consumed_at', body.id) !== null, 10_000, 'filed')
    await m.close()
    expect(await requeueBugReport(r.relay.services, body.id)).toBe('queued')
    const recovery = delivery(r, body.id)
    c.set(c.now() + 31 * DAY)
    r.runtime.hub.sweep() // the recovery frame is gone before the Mac came back
    expect(await backfillOwnReports(r.relay.services)).toBe(1)
    const back = await mac(r, 'auto')
    await waitFor(() => got(back).some((f) => f.id === recovery), 10_000, 'the recovery frame, queued again')
    await waitFor(() => col(r, 'bridge_consumed_at', body.id) !== null, 10_000, 'filed')
  })
})

describe('the existing paths still hold', () => {
  it('a report stored the old way (no mark) is queued once by the reconcile', async () => {
    const { c, r, dev } = await world()
    const s = r.relay.services
    const body = BugReportPost.parse(await signedPost(dev, c))
    storeBugReport(
      { db: s.db, crypto: s.crypto, clock: s.clock, dataDir: s.env.DATA_DIR },
      body,
      PNG,
      c.now() + 600_000,
    )
    expect(await backfillOwnReports(s)).toBe(1)
    expect(await backfillOwnReports(s)).toBe(0)
  })
})
