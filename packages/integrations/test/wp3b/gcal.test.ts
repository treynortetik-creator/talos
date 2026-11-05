import { NormalizedEvent } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { renderGcalScript } from '../../src/gcal/apps-script.ts'
import { getIntegration } from '../../src/index.ts'
import { newWebhookSecret, verifyStandard } from '../../src/standard-webhooks.ts'
import { conn, fixture, raw, stable } from '../wp3/helpers.ts'
import { type FakeEvent, makeCalendarGas } from './gcal-fake.ts'

const gcal = getIntegration('gcal')
const VARS = {
  hookUrl: 'https://relay.example.com/hook/gcal/cn_aaaaaaaaaaaaaaaaaaaaaa',
  claimCode: 'cc_abcdefghijklmnopqrstuv',
}
const H = 3_600_000
const mk = (i: number, over: Partial<FakeEvent> = {}): FakeEvent => ({
  id: `uid${i}@example.com`,
  title: `Event ${i}`,
  start: Date.now() + (i + 1) * H,
  end: Date.now() + (i + 2) * H,
  ...over,
})

function setup(events: () => FakeEvent[], script = renderGcalScript(VARS), maxProp?: number) {
  const secret = newWebhookSecret()
  const g = makeCalendarGas({ script, events, props: { TALOS_SECRET: secret }, ...(maxProp ? { maxProp } : {}) })
  g.run('run_(true)') // what install() does after the claim: record state silently
  return { g, secret }
}

describe('gcal Apps Script (run_ port, spec 7.6)', () => {
  it('renders with a claim code and no live secret, and escapes values', () => {
    const s = renderGcalScript(VARS)
    expect(s).toContain("CLAIM_CODE: 'cc_abcdefghijklmnopqrstuv'")
    expect(s).not.toContain('whsec_')
    expect(s).not.toContain('{{')
    expect(() => renderGcalScript({ ...VARS, claimCode: 'x' })).toThrow()
    expect(() => renderGcalScript({ ...VARS, hookUrl: 'javascript:alert(1)' })).toThrow()
  })
  it('install claims, then sync posts nothing for an unchanged calendar', () => {
    const evs = [mk(0), mk(1)]
    const g = makeCalendarGas({ script: renderGcalScript(VARS), events: () => evs })
    g.run('install()')
    expect(g.props.get('TALOS_SECRET')).toBe('whsec_x')
    g.run('sync()')
    expect(g.posted).toHaveLength(0)
  })
  it('posts a changed event, signed over the exact bytes, when called as a trigger with an event object (H10)', () => {
    const evs = [mk(0), mk(1)]
    const { g, secret } = setup(() => evs)
    evs[1] = { ...(evs[1] as FakeEvent), title: 'Event 1 (renamed)' }
    g.run("sync({triggerUid:'x'})")
    expect(g.posted).toHaveLength(1)
    const p = g.posted[0] as (typeof g.posted)[number]
    const items = JSON.parse(p.body).items
    expect(items).toHaveLength(1)
    expect(items[0].change).toBe('changed')
    const r = verifyStandard(
      { headers: p.headers, rawBody: new TextEncoder().encode(p.body), url: p.url, now: Date.now() },
      { secrets: [secret] },
    )
    expect(r.ok).toBe(true)
  })
  it('keeps the old state when the post fails, so the change is sent again; saves it after a 2xx', () => {
    const evs = [mk(0), mk(1)]
    let status = 500
    const secret = newWebhookSecret()
    const g = makeCalendarGas({
      script: renderGcalScript(VARS),
      events: () => evs,
      props: { TALOS_SECRET: secret },
      hookStatus: () => status,
    })
    g.run('run_(true)')
    const saved = g.props.get('TALOS_STATE')
    evs[1] = { ...(evs[1] as FakeEvent), title: 'Event 1 (renamed)' }
    g.run('sync()')
    expect(g.posted).toHaveLength(1)
    expect(g.props.get('TALOS_STATE')).toBe(saved)
    g.run('sync()') // the failed change is retried
    expect(g.posted).toHaveLength(2)
    status = 200
    g.run('sync()')
    expect(g.posted).toHaveLength(3)
    expect(g.props.get('TALOS_STATE')).not.toBe(saved)
    g.run('sync()')
    expect(g.posted).toHaveLength(3)
  })
  it('an invite is only reported while the status is INVITED; a starting item is sent once', () => {
    const evs = [mk(0)]
    const { g } = setup(() => evs)
    evs.push(mk(1, { status: 'INVITED' }), mk(2, { status: 'YES' }))
    evs.push({ ...mk(3), start: Date.now() + 10 * 60_000, end: Date.now() + 40 * 60_000 })
    g.run('sync()')
    const first = g.posted.flatMap((p) => JSON.parse(p.body).items.map((i: { change: string }) => i.change)).sort()
    expect(first).toEqual(['invite', 'starting'])
    g.run('sync()')
    expect(g.posted).toHaveLength(1) // nothing new the second time
  })
  it('a recurring event: 3 instances share an iCalUID but get distinct keys; a moved one is not a duplicate invite', () => {
    const evs = [0, 1, 2].map((i) => ({ ...mk(i), id: 'series@example.com', title: 'Weekly' }))
    const { g } = setup(() => evs)
    const keys = Object.keys(JSON.parse(g.props.get('TALOS_STATE') as string))
    expect(new Set(keys).size).toBe(3)
    evs[1] = {
      ...(evs[1] as FakeEvent),
      start: (evs[1] as FakeEvent).start + 24 * H,
      end: (evs[1] as FakeEvent).end + 24 * H,
    }
    g.run('sync()')
    const items = g.posted.flatMap((p) => JSON.parse(p.body).items as Array<{ change: string }>)
    // The key includes the start, so the old slot is reported gone. Nothing is reported twice and no invite is invented.
    expect(items.map((i) => i.change)).toEqual(['cancelled'])
  })
  it('an event that disappears inside the window is cancelled', () => {
    const evs = [mk(0), mk(1)]
    const { g } = setup(() => evs)
    evs.pop()
    g.run('sync()')
    const items = g.posted.flatMap((p) => JSON.parse(p.body).items as Array<{ change: string }>)
    expect(items.map((i) => i.change)).toEqual(['cancelled'])
  })
  it('the 80-event cap does not cause false cancellations', () => {
    const evs = Array.from({ length: 100 }, (_, i) => mk(i))
    const { g } = setup(() => evs)
    expect(Object.keys(JSON.parse(g.props.get('TALOS_STATE') as string))).toHaveLength(80)
    g.run('sync()')
    expect(g.posted).toHaveLength(0)
    // The calendar shifts so events 80..99 now sit inside the cap and event 0 is gone: only event 0 is cancelled.
    evs.shift()
    g.run('sync()')
    const items = g.posted.flatMap((p) => JSON.parse(p.body).items as Array<{ change: string }>)
    expect(items.map((i) => i.change)).toEqual(['cancelled'])
  })
  it('trims a state object over 8,500 characters and setProperty never throws', () => {
    const big = renderGcalScript(VARS).replace('MAX_EVENTS: 80', 'MAX_EVENTS: 400')
    const evs = Array.from({ length: 400 }, (_, i) => mk(i))
    const { g } = setup(() => evs, big, 9000)
    expect((g.props.get('TALOS_STATE') as string).length).toBeLessThan(8500)
  })
})

describe('gcal module', () => {
  it('verifies Standard Webhooks and rejects a tampered body', () => {
    const body = fixture('gcal/fixtures/batch.json')
    const secret = newWebhookSecret()
    const hdr = { ...JSON.parse(JSON.stringify({})), ...signHeaders(secret, body) }
    expect(
      gcal.verify(
        { headers: hdr, rawBody: new TextEncoder().encode(body), url: 'u', now: Date.now() },
        { secrets: [secret], extra: {} },
      ),
    ).toMatchObject({ ok: true })
    expect(
      gcal.verify(
        { headers: hdr, rawBody: new TextEncoder().encode(`${body} `), url: 'u', now: Date.now() },
        { secrets: [secret], extra: {} },
      ),
    ).toMatchObject({ ok: false })
  })
  it('normalizes the fixture (invite, changed, starting, cancelled; a bad key is skipped)', async () => {
    const events = await gcal.normalize(raw(fixture('gcal/fixtures/batch.json')), conn({ integration: 'gcal' }))
    expect(events.map((e) => e.kind)).toEqual(['gcal.invite', 'gcal.changed', 'gcal.starting', 'gcal.cancelled'])
    expect(events[3]?.title).toBe('An event was cancelled')
    expect(stable(events)).toMatchSnapshot()
    for (const e of events) expect(NormalizedEvent.safeParse(e).success).toBe(true)
  })
})

import { signStandard } from '../../src/standard-webhooks.ts'

function signHeaders(secret: string, body: string) {
  return signStandard({ secret, id: 'msg_1', timestampS: Math.floor(Date.now() / 1000), body })
}
