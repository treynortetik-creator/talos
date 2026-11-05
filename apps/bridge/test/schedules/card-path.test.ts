// WP-S1 acceptance: the card path (S3.4, S8.2, S8.4). schedule.patch writes nothing and yields one kind:'schedule' card;
// PRIMARY makes the BRIDGE write exactly the bound change under Chronos's lock; a conflict leaves the files alone.

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bindingFrom,
  type CardT,
  jcs,
  newUlid,
  parseFrame,
  payloadHash,
  ScheduleCardPayload,
  type ScheduleCardPayloadT,
  type ScheduleChangeT,
} from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { eventually, pushCardResolvePastRelay, stopRelay } from '../helpers.ts'
import { draft, longTimeouts, MON_0700_EDT, type SchedHarness, sleep, startSched, waitFor } from './harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const wireDraft = (over: Record<string, unknown> = {}) => ({
  id: 'nightly-sync',
  name: 'Nightly Sync',
  description: '',
  when: { type: 'weekdays', time: '22:00' },
  catchup_min: 120,
  enabled: true,
  runner: 'session',
  permissions: 'full',
  allowed_tools: [],
  model: null,
  notify: 'failure',
  thread_id: 'inbox',
  prompt: 'Sync the notes folder.\n',
  ...over,
})

/** Sends schedule.patch from the app and returns the ack'd frame and the card the bridge minted. */
async function patch(x: SchedHarness, change: ScheduleChangeT | Record<string, unknown>, thread = 'general') {
  const f = await x.app.patchSchedule(change as Record<string, unknown>, thread)
  await x.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in' })
  // the card for THIS request: the app opens the one whose client_ref is the patch's id
  const cc = await x.app.expectFrame(
    'card.create',
    (c) => c.card.kind === 'schedule' && (c.card.payload as { client_ref?: string } | undefined)?.client_ref === f.id,
    { direction: 'in' },
  )
  return { frame: f, card: cc.card as CardT, payload: ScheduleCardPayload.parse(cc.card.payload) }
}

async function approve(x: SchedHarness, card: CardT) {
  const token = x.relay.mintStepup(`card:${card.id}`)
  return x.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: token })
}

const jobsOnDisk = (x: SchedHarness) =>
  x.box.api<{ schedules: Array<{ id: string; etag: string }> }>(['snapshot']).schedules

const filesSnapshot = (x: SchedHarness, id: string) => {
  const dir = x.box.jobDir(id)
  return [
    readFileSync(join(x.box.home, '.config', 'chronos', 'jobs.json'), 'utf8'),
    readFileSync(join(dir, 'prompt.md'), 'utf8'),
  ].join('\n----\n')
}

describe('schedule.patch (S3.4: nothing is written)', () => {
  test('create: ack, then exactly one kind:schedule card whose hash verifies; the registry is untouched', async () => {
    h = await startSched()
    const { frame, card, payload } = await patch(h, { op: 'create', draft: wireDraft() })
    expect(card.payload_hash).toBe(payloadHash(bindingFrom(card)))
    expect(card.allow_edit).toBe(false)
    expect(card.risk).toBe('high')
    expect(card.thread_id).toBe('general')
    expect(payload.proposed_by).toBe('owner_form')
    expect(payload.client_ref).toBe(frame.id)
    expect(payload.expected_etag).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(payload.change.op).toBe('create')
    expect(parseFrame({ ...mkFrame('card.create'), card }, { direction: 'bridge_to_relay' }).ok).toBe(true)
    expect(jobsOnDisk(h)).toEqual([])
    // it is a ledger row owned by the bridge
    expect(h.bridge.ctx.ledger.get(card.id)?.actor).toBe('bridge')
    await sleep(150)
    await eventually(() =>
      expect(h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.frame.type === 'card.create').length).toBe(
        1,
      ),
    )
  })

  test('a card minted before the relay lists schedules/1 is refused (deploy order, S1.5)', async () => {
    h = await startSched({ relay: { relayFeatures: [] } })
    const f = await h.app.patchSchedule({ op: 'create', draft: wireDraft() }, 'general')
    const err = await h.app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in' })
    expect(err.code).toBe('scheduler_unavailable')
  })

  test('a draft Chronos refuses is error{ref, schedule_invalid} with field paths, and nothing is minted', async () => {
    h = await startSched()
    const f = await h.app.patchSchedule(
      { op: 'create', draft: wireDraft({ permissions: 'restricted', runner: 'session' }) },
      'general',
    )
    const err = await h.app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in' })
    expect(err.code).toBe('schedule_invalid')
    expect(err.fields?.length ?? 0).toBeGreaterThan(0)
    expect(err.fields?.[0]?.path).toMatch(/runner|permissions/)
    await sleep(100)
    expect(h.app.rec.frames.some((r) => r.direction === 'in' && r.raw.type === 'card.create')).toBe(false)
  })

  test('create on an existing id is schedule_conflict; update of an unknown id is schedule_not_found', async () => {
    h = await startSched({ jobs: [draft({ id: 'nightly-sync' })] })
    const a = await h.app.patchSchedule({ op: 'create', draft: wireDraft() }, 'general')
    expect((await h.app.expectFrame('error', (e) => e.ref === a.id, { direction: 'in' })).code).toBe(
      'schedule_conflict',
    )
    const b = await h.app.patchSchedule(
      { op: 'update', id: 'no-such-job', base_etag: `sha256:${'0'.repeat(64)}`, set: { name: 'x' } },
      'general',
    )
    expect((await h.app.expectFrame('error', (e) => e.ref === b.id, { direction: 'in' })).code).toBe(
      'schedule_not_found',
    )
  })

  test('a 17 KiB prompt is refused with a field path (the frame never parses, the signature does)', async () => {
    h = await startSched()
    const f = await h.app.sign({
      ...mkFrame('schedule.patch'),
      change: { op: 'create', draft: wireDraft({ prompt: 'x'.repeat(17 * 1024) }) },
      thread_id: 'general',
    })
    h.relay.sendToBridge(f)
    const err = await h.relay.expectFrame('error', (e) => e.ref === f.id, { direction: 'from_bridge' })
    expect(err.code).toBe('schedule_invalid')
    expect(err.fields?.some((x) => x.path.includes('prompt'))).toBe(true)
  })

  test('a 16 KiB prompt heavy in quotes and backslashes fits the card, the payload and the frame', async () => {
    h = await startSched()
    let prompt = 'say "hi" \\ then \\\\ again ✓\n'.repeat(1000)
    while (Buffer.byteLength(prompt) > 16 * 1024) prompt = prompt.slice(0, -1)
    const { card } = await patch(h, { op: 'create', draft: wireDraft({ prompt }) })
    expect(Buffer.byteLength(jcs(card.payload))).toBeLessThanOrEqual(64 * 1024)
    const sent = h.relay.frames.find((r) => r.direction === 'from_bridge' && r.frame.type === 'card.create')
    expect(Buffer.byteLength(JSON.stringify(sent?.frame))).toBeLessThan(256 * 1024)
  })

  test('update: only the touched fields go in `set`; a rename alone is low risk, a prompt change is high', async () => {
    h = await startSched({ jobs: [draft()] })
    const etag = jobsOnDisk(h)[0]?.etag as string
    const rename = await patch(h, {
      op: 'update',
      id: 'daily-digest',
      base_etag: etag,
      set: { name: 'Morning Digest' },
    })
    expect(rename.card.risk).toBe('low')
    expect(rename.payload.change.op === 'update' && Object.keys(rename.payload.change.set)).toEqual(['name'])
    const edit = await patch(h, {
      op: 'update',
      id: 'daily-digest',
      base_etag: etag,
      set: { prompt: 'Summarise yesterday and post it, briefly.\n' },
    })
    expect(edit.card.risk).toBe('high')
    expect(edit.card.body).toContain('-Summarise yesterday and post it.')
    expect(edit.card.body).toContain('+Summarise yesterday and post it, briefly.')
  })

  test('update against a stale etag is schedule_conflict at patch time', async () => {
    h = await startSched({ jobs: [draft()] })
    const f = await h.app.patchSchedule(
      { op: 'update', id: 'daily-digest', base_etag: `sha256:${'a'.repeat(64)}`, set: { name: 'x' } },
      'general',
    )
    expect((await h.app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in' })).code).toBe(
      'schedule_conflict',
    )
  })
})

describe('PRIMARY (S3.4: the bridge writes the approved change)', () => {
  test('create writes exactly the bound change: etag = expected_etag, thread_id only in the sidecar, agent told', async () => {
    h = await startSched()
    const { card, payload } = await patch(h, { op: 'create', draft: wireDraft() })
    await approve(h, card)
    const upd = await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'done', {
      direction: 'in',
      timeoutMs: 10_000,
    })
    expect(upd.result?.ok).toBe(true)
    expect(upd.result?.text).toMatch(/^Saved\. Next run \w{3} /)
    const job = jobsOnDisk(h).find((j) => j.id === 'nightly-sync')
    expect(job?.etag).toBe(payload.expected_etag as string)
    // Talos-only: the thread never reaches Chronos's files
    expect(readFileSync(join(h.box.home, '.config', 'chronos', 'jobs.json'), 'utf8')).not.toContain('thread_id')
    expect(readFileSync(join(h.box.jobDir('nightly-sync'), 'prompt.md'), 'utf8')).toBe('Sync the notes folder.\n')
    const side = JSON.parse(readFileSync(join(h.home, 'schedules-meta.json'), 'utf8')) as {
      jobs: Record<string, { thread_id: string | null }>
    }
    expect(side.jobs['nightly-sync']?.thread_id).toBe('inbox')
    // the approved record was written by Chronos in the same step: the job is not held and not "changed outside"
    const snap = h.box.api<{ schedules: Array<{ id: string; changed_outside: boolean; today: string }> }>(['snapshot'])
    expect(snap.schedules.find((j) => j.id === 'nightly-sync')?.changed_outside).toBe(false)
    // the agent hears "nothing for you to do" (a system notice, not a card_action it must act on)
    await h.waitNotes(1)
    const note = h.notes.find((n) => n.content.includes(card.id))
    expect(note?.meta.kind).toBe('system')
    expect(note?.content).toContain('The bridge applied it')
    expect(note?.content).toContain('Nothing for you to do.')
    expect(h.notes.some((n) => n.meta.kind === 'card_action')).toBe(false)
    // and the app is told to refresh
    await h.app.expectFrame('schedule.status', (s) => s.changed.some((c) => c.id === 'nightly-sync'), {
      direction: 'in',
    })
  })

  test('a card for enabled:false writes enabled:false', async () => {
    h = await startSched()
    const { card } = await patch(h, { op: 'create', draft: wireDraft({ enabled: false }) })
    await approve(h, card)
    await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'done', {
      direction: 'in',
      timeoutMs: 10_000,
    })
    const j = h.box.api<{ schedules: Array<{ id: string; enabled: boolean }> }>(['snapshot']).schedules
    expect(j.find((x) => x.id === 'nightly-sync')?.enabled).toBe(false)
  })

  test('a conflict (the job changed after the card was drawn) leaves the files unchanged and fails the card', async () => {
    h = await startSched({ jobs: [draft()] })
    const etag = jobsOnDisk(h)[0]?.etag as string
    const { card } = await patch(h, {
      op: 'update',
      id: 'daily-digest',
      base_etag: etag,
      set: { name: 'Morning Digest' },
    })
    // someone changes the job through Chronos's own writer in between
    h.box.change({ op: 'update', id: 'daily-digest', base_etag: etag, set: { catchup_min: 90 } })
    const before = filesSnapshot(h, 'daily-digest')
    await approve(h, card)
    const upd = await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'failed', {
      direction: 'in',
      timeoutMs: 10_000,
    })
    expect(upd.result?.text).toBe(
      'The job changed on your Mac after this card was drawn. Nothing was saved. Ask again.',
    )
    expect(filesSnapshot(h, 'daily-digest')).toBe(before)
  })

  test('changing only the result thread is a low-risk card that writes the sidecar and nothing in Chronos', async () => {
    h = await startSched({ jobs: [draft()] })
    const before = filesSnapshot(h, 'daily-digest')
    const etag = jobsOnDisk(h)[0]?.etag as string
    const { card, payload } = await patch(h, {
      op: 'update',
      id: 'daily-digest',
      base_etag: etag,
      set: { thread_id: 'inbox' },
    })
    expect(card.risk).toBe('low')
    expect(payload.expected_etag).toBe(etag)
    await approve(h, card)
    const upd = await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'done', {
      direction: 'in',
      timeoutMs: 10_000,
    })
    expect(upd.result?.ok).toBe(true)
    const side = JSON.parse(readFileSync(join(h.home, 'schedules-meta.json'), 'utf8')) as {
      jobs: Record<string, { thread_id: string | null }>
    }
    expect(side.jobs['daily-digest']?.thread_id).toBe('inbox')
    expect(filesSnapshot(h, 'daily-digest')).toBe(before)
    expect(jobsOnDisk(h)[0]?.etag).toBe(etag)
  })

  test('delete removes the job and says so', async () => {
    h = await startSched({ jobs: [draft()] })
    const etag = jobsOnDisk(h)[0]?.etag as string
    const { card, payload } = await patch(h, { op: 'delete', id: 'daily-digest', base_etag: etag })
    expect(payload.expected_etag).toBeNull()
    await approve(h, card)
    const upd = await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'done', {
      direction: 'in',
      timeoutMs: 10_000,
    })
    expect(upd.result?.text).toMatch(/^Deleted\./)
    expect(jobsOnDisk(h)).toEqual([])
  })

  test('PRIMARY twice: the second is card_not_pending and nothing is written twice', async () => {
    h = await startSched()
    const { card } = await patch(h, { op: 'create', draft: wireDraft() })
    await approve(h, card)
    await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'done', {
      direction: 'in',
      timeoutMs: 10_000,
    })
    const written = filesSnapshot(h, 'nightly-sync')
    // The relay stops a second tap itself (the relay contract has that case). This one goes straight to the Mac, so it is
    // the Mac's own ledger that has to refuse it.
    const again = await pushCardResolvePastRelay(h, card, card.payload_hash)
    const err = await h.relay.expectFrame('error', (e) => e.ref === again.id, { direction: 'from_bridge' })
    expect(err.code).toBe('card_not_pending')
    // the ledger's own state check refused it (a later guard in the same function says `lost_race` and would also pass the line above)
    await h.relay.expectFrame('card.update', (u) => u.card_id === card.id && u.reason === 'state_done', {
      direction: 'from_bridge',
    })
    expect(filesSnapshot(h, 'nightly-sync')).toBe(written)
    expect(jobsOnDisk(h).filter((j) => j.id === 'nightly-sync')).toHaveLength(1)
  })

  test('KILL on a form card applies nothing', async () => {
    h = await startSched()
    const { card } = await patch(h, { op: 'create', draft: wireDraft() })
    await h.app.resolveCard(card, 'kill', card.payload_hash)
    await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'resolved', { direction: 'in' })
    await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'done', { direction: 'in' })
    await sleep(200)
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('done')
    expect(jobsOnDisk(h)).toEqual([])
  })

  test('an agent-minted generic card whose payload looks like a ScheduleChange applies nothing', async () => {
    h = await startSched()
    const payload: ScheduleCardPayloadT = {
      schema: 'talos.schedule-change/1',
      change: { op: 'create', draft: wireDraft() as never },
      expected_etag: null,
      proposed_by: 'agent',
      client_ref: null,
      preview: { when_text: 'Weekdays at 10:00 PM', next_runs: [], tz: 'America/New_York' },
    }
    const res = await h.bridge.callTool('card', {
      thread_id: 'general',
      kind: 'decision',
      title: 'Totally a normal decision',
      primary_label: 'Approve',
      kill_label: 'Reject',
      risk: 'low',
      origin: 'chat',
      payload,
    })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    const created = await h.app.expectFrame('card.create', (c) => c.card.title.startsWith('Totally'), {
      direction: 'in',
    })
    await h.app.resolveCard(created.card, 'primary', created.card.payload_hash)
    await h.waitNotes(1)
    expect(h.notes[0]?.meta.kind).toBe('card_action') // the normal path: the agent is told, nothing is applied
    await sleep(300)
    expect(jobsOnDisk(h)).toEqual([])
  })

  test('the ledger migrates a pre-schedules database: the actor column appears, old rows read as agent', async () => {
    // an existing install's history.sqlite has no `actor` column
    const x = await startSched({ startBridge: false })
    const dbPath = join(x.home, 'history.sqlite')
    await x.bridge.stop()
    const db = new Database(dbPath)
    const cols = db.query('PRAGMA table_info(cards)').all() as Array<{ name: string }>
    if (cols.some((c) => c.name === 'actor')) db.exec('ALTER TABLE cards DROP COLUMN actor')
    db.query(
      "INSERT INTO cards (id, thread_id, binding_json, payload_hash, state, origin, risk, created_at, expires_at) VALUES ('c_OLD', 'general', '{}', 'sha256:x', 'pending', 'chat', 'low', ?, ?)",
    ).run(new Date().toISOString(), new Date(Date.now() + 1000).toISOString())
    db.close()
    const y = await startSched({ home: x.home, startBridge: false, box: x.box })
    h = y
    expect(y.bridge.ctx.ledger.get('c_OLD')?.actor).toBe('agent')
    await x.app.close()
    await stopRelay(x.relay)
  })
})

void MON_0700_EDT
void newUlid
void waitFor
