// defineScheduleFramesContract (SCHEDULES S2.2, S9): what the bridge side of the socket answers to each signed schedule
// frame. WP-S1 runs it against the real bridge (FakeRelay as the far end), WP-S2 against the real relay with FakeBridge
// behind it, and the testkit against FakeRelay + FakeBridge. Request ids, acks and errors are the point: they are what a
// relay and an app depend on and what fakes get wrong.
import {
  bindingFrom,
  type CardT,
  newUlid,
  parseFrame,
  payloadHash,
  ScheduleCardPayload,
  ScheduleDetail,
  ScheduleSnapshot,
} from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'

export type ScheduleFramesEnd = {
  /** A job that exists behind the bridge when the end starts. */
  knownScheduleId: string
  knownScheduleName: string
  /** Its prompt text (without a trailing newline), for the "status carries no prompt" check. */
  knownPrompt: string
  /** A thread the card may go to. */
  threadId: string
  /** Signs with a device the bridge has pinned and sends toward the bridge. Envelope fields are filled in. */
  sendOwner(frame: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Sends a frame toward the bridge with a well-formed but WRONG signature. */
  sendUnsigned(frame: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Waits for a frame arriving back on the sending side. */
  expect(
    type: string,
    predicate: (f: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>
  /** Everything received on the sending side so far, raw. */
  received(): Array<Record<string, unknown>>
  stop(): Promise<void>
}
export type ScheduleFramesHarness = { start(): Promise<ScheduleFramesEnd> }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function defineScheduleFramesContract(name: string, harness: ScheduleFramesHarness) {
  describe(`schedule frames contract: ${name}`, () => {
    let end: ScheduleFramesEnd | null = null
    const start = async () => {
      end = await harness.start()
      return end
    }
    afterEach(async () => {
      await end?.stop()
      end = null
    })
    const ackFor = (e: ScheduleFramesEnd, id: unknown) => e.expect('ack', (f) => f.ref === id, 5000)

    it('schedules.list: ack{ref} with no seq, then schedules.snapshot to the same request_id', async () => {
      const e = await start()
      const f = await e.sendOwner({ type: 'schedules.list', request_id: newUlid() })
      const ack = await ackFor(e, f.id)
      expect(ack.seq).toBeUndefined()
      const snap = await e.expect('schedules.snapshot', (s) => s.request_id === f.request_id, 5000)
      expect(parseFrame(snap).ok).toBe(true)
      const parsed = ScheduleSnapshot.parse(snap.snapshot)
      expect(parsed.schedules.map((s) => s.id)).toContain(e.knownScheduleId)
    })

    it('schedule.get: a detail to the same request_id; an unknown id is error{ref, schedule_not_found}', async () => {
      const e = await start()
      const f = await e.sendOwner({
        type: 'schedule.get',
        request_id: newUlid(),
        schedule_id: e.knownScheduleId,
        report_run_id: null,
      })
      const d = await e.expect('schedule.detail', (x) => x.request_id === f.request_id, 5000)
      expect(ScheduleDetail.parse(d.detail).schedule.id).toBe(e.knownScheduleId)
      expect(d.report).toBeNull()
      const g = await e.sendOwner({
        type: 'schedule.get',
        request_id: newUlid(),
        schedule_id: 'no-such-job',
        report_run_id: null,
      })
      const err = await e.expect('error', (x) => x.ref === g.id, 5000)
      expect(err.code).toBe('schedule_not_found')
    })

    it('schedule.patch writes nothing and answers with one kind:schedule card whose hash verifies', async () => {
      const e = await start()
      const draft = {
        id: 'contract-new',
        name: 'Contract New',
        description: '',
        when: { type: 'daily', time: '09:00' },
        catchup_min: 60,
        enabled: true,
        runner: 'session',
        permissions: 'full',
        allowed_tools: [],
        model: null,
        notify: 'failure',
        thread_id: null,
        prompt: 'Say hello.\n',
      }
      const f = await e.sendOwner({ type: 'schedule.patch', change: { op: 'create', draft }, thread_id: e.threadId })
      await ackFor(e, f.id)
      const cc = await e.expect(
        'card.create',
        (c) => (c.card as CardT | undefined)?.kind === 'schedule' && (c.card as CardT).thread_id === e.threadId,
        5000,
      )
      const card = cc.card as CardT
      expect(card.payload_hash).toBe(payloadHash(bindingFrom(card)))
      expect(card.allow_edit).toBe(false)
      expect(card.risk).toBe('high')
      const payload = ScheduleCardPayload.parse(card.payload)
      expect(payload.change.op).toBe('create')
      expect(payload.proposed_by).toBe('owner_form')
      // nothing written: the job is not in a fresh list
      const l = await e.sendOwner({ type: 'schedules.list', request_id: newUlid() })
      const snap = await e.expect('schedules.snapshot', (s) => s.request_id === l.request_id, 5000)
      expect(ScheduleSnapshot.parse(snap.snapshot).schedules.map((s) => s.id)).not.toContain('contract-new')
    })

    it('a patch the scheduler refuses is error{ref} with schedule_invalid (and field paths) or schedule_not_found', async () => {
      const e = await start()
      const f = await e.sendOwner({
        type: 'schedule.patch',
        change: { op: 'update', id: 'no-such-job', base_etag: `sha256:${'0'.repeat(64)}`, set: { name: 'x' } },
        thread_id: e.threadId,
      })
      const err = await e.expect('error', (x) => x.ref === f.id, 5000)
      expect(['schedule_invalid', 'schedule_not_found']).toContain(err.code)
      if (err.fields !== undefined) expect(parseFrame(err).ok).toBe(true)
    })

    it('schedule.run_now and schedule.control older than 2 min are refused as stale', async () => {
      const e = await start()
      const old = new Date(Date.now() - 3 * 60_000).toISOString()
      const r = await e.sendOwner({
        type: 'schedule.run_now',
        ts: old,
        schedule_id: e.knownScheduleId,
        again: false,
        where: 'default',
      })
      expect((await e.expect('error', (x) => x.ref === r.id, 5000)).code).toBe('stale')
      const c = await e.sendOwner({
        type: 'schedule.control',
        ts: old,
        action: 'pause',
        schedule_id: e.knownScheduleId,
      })
      expect((await e.expect('error', (x) => x.ref === c.id, 5000)).code).toBe('stale')
    })

    it('schedule.control pause: ack{ref}, then a schedule.status naming the job (ids and hashes only)', async () => {
      const e = await start()
      const c = await e.sendOwner({ type: 'schedule.control', action: 'pause', schedule_id: e.knownScheduleId })
      const ack = await ackFor(e, c.id)
      expect(ack.seq).toBeUndefined()
      const st = await e.expect(
        'schedule.status',
        (s) => (s.changed as Array<{ id: string }>).some((x) => x.id === e.knownScheduleId),
        10_000,
      )
      expect(parseFrame(st).ok).toBe(true)
      const text = JSON.stringify(st)
      expect(text).not.toContain(e.knownScheduleName)
      expect(text).not.toContain(e.knownPrompt)
    })

    it('a wrongly signed schedule frame is not acted on: error{ref, sig_invalid}, no ack, no snapshot', async () => {
      const e = await start()
      const f = await e.sendUnsigned({ type: 'schedules.list', request_id: newUlid() })
      const err = await e.expect('error', (x) => x.ref === f.id, 5000)
      expect(['sig_invalid', 'device_not_pinned']).toContain(err.code)
      await sleep(200)
      const got = e.received()
      expect(got.some((x) => x.type === 'ack' && x.ref === f.id)).toBe(false)
      expect(got.some((x) => x.type === 'schedules.snapshot' && x.request_id === f.request_id)).toBe(false)
    })
  })
}
