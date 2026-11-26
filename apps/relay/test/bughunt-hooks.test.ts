// Bughunt findings for the webhook intake (spec 5.4 rate-limit table, 7.1 pipeline, 7.5 work retention). Every test drives
// the REAL relay (startRelay, real auth, real hooks module) over real HTTP and FAILS on main at the time of writing.
import { createHmac } from 'node:crypto'
import { signStandard } from '@talos-app/integrations'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetAuthImplementation } from '../src/auth/contract.ts'
import { runtimeOf } from '../src/core/runtime.ts'
import { idle, runtimeFor, tick } from '../src/hooks/index.ts'
import { type BugRelay, startBugRelay } from './bughunt-hooks-harness.ts'

vi.setConfig({ testTimeout: 120_000 })

let r: BugRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
  resetAuthImplementation()
})

const SLACK_SECRET = 'a'.repeat(32)

function slackHeaders(nowMs: number, body: string): Record<string, string> {
  const ts = Math.floor(nowMs / 1000)
  return {
    'x-slack-request-timestamp': String(ts),
    'x-slack-signature': `v0=${createHmac('sha256', SLACK_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`,
  }
}

function slackDm(i: number, text = `hi ${i}`): string {
  return JSON.stringify({
    type: 'event_callback',
    event_id: `Ev${i}`,
    team_id: 'T1',
    event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'U2', text, ts: `${i}.0001` },
  })
}

async function slackConnection(rr: BugRelay): Promise<{ id: string }> {
  rr.setConfig((c) => {
    c.work.enabled = ['slack']
  })
  const res = await rr.api('POST', '/api/connections', {
    integration: 'slack',
    name: 'Slack',
    fields: { signing_secret: SLACK_SECRET },
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

describe('bughunt: webhook intake', () => {
  it('BH-H1: unauthenticated junk to an unknown /hook path must not starve a real, signed webhook (shared 600/min bucket)', async () => {
    r = await startBugRelay()
    const made = await r.api('POST', '/api/connections', { integration: 'generic', name: 'G' })
    const conn = (await made.json()) as { id: string; secret: string }
    // One client (one address), no secret, no valid connection id: the unknown-id throttle answers it 404 then 429...
    for (let i = 0; i < 650; i++) {
      const junk = await r.hook(`/hook/generic/cn_${'x'.repeat(22)}`, {
        body: '{}',
        headers: { 'x-forwarded-for': '198.51.100.7' },
      })
      await junk.arrayBuffer()
    }
    // ...but every one of those requests also took a token from the GLOBAL `hook` bucket, so the owner's real sender
    // (a different address, correct signature) is now refused too. Slack/Linear/Zoom disable endpoints that keep failing.
    const body = JSON.stringify({ title: 'a real event' })
    const res = await r.hook(`/hook/generic/${conn.id}`, {
      body,
      headers: {
        'x-forwarded-for': '203.0.113.9',
        ...signStandard({ secret: conn.secret, id: 'msg_real', timestampS: Math.floor(r.now() / 1000), body }),
      },
    })
    expect(res.status, 'a verified delivery from another sender after a junk flood').toBe(200)
  })

  it('BH-H2: Slack past the per-connection limit gets 200-and-drop (spec 5.4), never 429', async () => {
    r = await startBugRelay()
    const conn = await slackConnection(r)
    let last = 0
    for (let i = 0; i < 601; i++) {
      r.skew.ms += 150 // keep the global 600/min bucket topped up; this test is about the per-connection budget
      const body = slackDm(i)
      const res = await r.hook(`/hook/slack/${conn.id}`, { body, headers: slackHeaders(r.now(), body) })
      last = res.status
      await res.arrayBuffer()
    }
    // Spec 5.4: "Over the per-connection limit, providers that disable failing endpoints (Slack, Linear, Zoom) get 200
    // and the event is dropped and counted in Recent deliveries; others get 429". WP3 P0 lists the rule by name.
    expect(last, 'the 601st verified Slack delivery inside the hour').toBe(200)
  })

  it('BH-H3: a passthrough work event is held while the Mac has not taken it, and gone from the relay (app replay buffer included) after a week', async () => {
    r = await startBugRelay()
    const conn = await slackConnection(r) // default work.retention = 'passthrough'
    const body = slackDm(1, 'WORKONLY-quarterly-numbers')
    const res = await r.hook(`/hook/slack/${conn.id}`, { body, headers: slackHeaders(r.now(), body) })
    expect(res.status).toBe(200)
    const rt = runtimeFor(r.relay.services)
    await idle(rt)
    const store = runtimeOf(r.relay.services).store
    const onRelay = () => JSON.stringify(store.appEventsAfter(0, 1000)).includes('WORKONLY-quarterly-numbers')
    expect(onRelay(), 'sanity: the event reached the app buffer').toBe(true)
    // No bridge is connected, so the event is never delivered. An hour asleep drops nothing; a week undelivered does.
    r.skew.ms += 61 * 60_000
    await tick(rt)
    const db = r.relay.services.db
    const count = () => (db.prepare('select count(*) as n from hooks_events').get() as { n: number }).n
    expect(count(), 'still held after an hour').toBe(1)
    expect(onRelay(), 'still in the app buffer after an hour').toBe(true)
    r.skew.ms += 7 * 24 * 3600_000
    await tick(rt)
    expect(count(), 'the hooks table did drop it after a week').toBe(0)
    // ...and the inbox.item frame (title + DM text), which would stay in core_events for BUFFER_DAYS, goes with it.
    expect(onRelay(), 'work message text is off the relay after the week').toBe(false)
  })

  it('BH-H3b (re-check): a passthrough work event the Mac ACKED leaves nothing on the relay ("nothing is kept once it reaches your Mac")', async () => {
    r = await startBugRelay()
    const conn = await slackConnection(r)
    const body = slackDm(2, 'WORKONLY-delivered-secret')
    const res = await r.hook(`/hook/slack/${conn.id}`, { body, headers: slackHeaders(r.now(), body) })
    expect(res.status).toBe(200)
    const rt = runtimeFor(r.relay.services)
    await idle(rt)
    const db = r.relay.services.db
    const row = db.prepare('select bridge_frame_id from hooks_events').get() as { bridge_frame_id: string | null }
    // What a live bridge's `ack{ref}` does: the hub dispatches it to the hooks module, which marks the event delivered.
    const hub = runtimeOf(r.relay.services).hub
    const ack = {
      v: 1,
      type: 'ack',
      id: '01JBF3V7Q8K2M4N6P8R0S2T4V6',
      ts: new Date(r.now()).toISOString(),
      ref: row.bridge_frame_id,
    }
    await hub.runBridgeHandlers('k', ack as never, ack)
    // The ack itself purges the relay's copy (the row is gone, not merely stamped delivered).
    expect((db.prepare('select count(*) n from hooks_events').get() as { n: number }).n).toBe(0)
    expect(JSON.stringify(runtimeOf(r.relay.services).store.appEventsAfter(0, 1000))).not.toContain(
      'WORKONLY-delivered-secret',
    )
    r.skew.ms += 61 * 60_000
    await tick(rt)
    const store = runtimeOf(r.relay.services).store
    const inAppBuffer = JSON.stringify(store.appEventsAfter(0, 1000)).includes('WORKONLY-delivered-secret')
    const hooksRows = (db.prepare('select count(*) n from hooks_events').get() as { n: number }).n
    expect({ inAppBuffer, hooksRows }).toEqual({ inAppBuffer: false, hooksRows: 0 })
  })
})
