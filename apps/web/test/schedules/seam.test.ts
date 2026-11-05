// The WP-S0 schedules seam on fakeClient: every call signs a real owner frame, data comes from the golden-derived
// fixtures, and a proposal lands as a composeScheduleCard() card matched by client_ref.
import { parseFrame, ScheduleCardPayload, verifyOwnerFrame } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { TalosClientError } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

describe('schedules seam (fakeClient)', () => {
  it('starts with an idle slice', () => {
    const c = createFakeClient()
    expect(c.store.getState().schedules).toEqual({ snapshot: null, details: {}, status: 'idle', error: null, revs: {} })
  })

  it('listSchedules signs schedules.list and fills the slice from the golden-derived snapshot', async () => {
    const c = createFakeClient()
    const snap = await c.schedules.listSchedules()
    expect(snap.schedules.map((s) => s.id)).toContain('daily-digest')
    expect(c.store.getState().schedules.status).toBe('ready')
    const f = c.sent.at(-1) as Record<string, unknown>
    expect(f.type).toBe('schedules.list')
    expect(parseFrame(f).ok).toBe(true)
    expect(await verifyOwnerFrame(f, await c.publicJwk())).toBe(true)
  })

  it('controlSchedule pause sends a signed schedule.control and flips the row', async () => {
    const c = createFakeClient()
    await c.schedules.listSchedules()
    await c.schedules.controlSchedule('pause', 'daily-digest')
    const f = c.sent.at(-1) as Record<string, unknown>
    expect(parseFrame(f).ok).toBe(true)
    expect(f).toMatchObject({ type: 'schedule.control', action: 'pause', schedule_id: 'daily-digest' })
    expect(await verifyOwnerFrame(f, await c.publicJwk())).toBe(true)
    const row = c.store.getState().schedules.snapshot?.schedules.find((s) => s.id === 'daily-digest')
    expect(row?.paused).toBe(true)
  })

  it('proposeScheduleChange writes nothing and adds a schedule card whose client_ref is the patch id', async () => {
    const c = createFakeClient()
    await c.schedules.listSchedules()
    const before = c.store.getState().cards.length
    const base = c.store.getState().schedules.snapshot?.schedules.find((s) => s.id === 'daily-digest')
    const { clientRef } = await c.schedules.proposeScheduleChange(
      { op: 'update', id: 'daily-digest', base_etag: base?.etag as string, set: { name: 'Morning Digest' } },
      'general',
    )
    const cards = c.store.getState().cards
    expect(cards.length).toBe(before + 1)
    const card = cards.at(-1)
    expect(card?.kind).toBe('schedule')
    expect(ScheduleCardPayload.parse(card?.payload).client_ref).toBe(clientRef)
    expect(card?.risk).toBe('low')
    expect(c.store.getState().schedules.snapshot?.schedules.find((s) => s.id === 'daily-digest')?.name).toBe(
      'Daily Digest',
    )
  })

  it('refuses a change drawn against another revision than the one shown (schedule_conflict, no card)', async () => {
    const c = createFakeClient()
    await c.schedules.listSchedules()
    const before = c.store.getState().cards.length
    const e = await c.schedules
      .proposeScheduleChange(
        { op: 'update', id: 'daily-digest', base_etag: `sha256:${'0'.repeat(64)}`, set: { name: 'x' } },
        'general',
      )
      .catch((x: unknown) => x)
    expect((e as TalosClientError).code).toBe('schedule_conflict')
    expect(c.store.getState().cards.length).toBe(before)
  })

  it('rejects with mac_offline while the Mac is offline, and schedule_not_found for an unknown id', async () => {
    const c = createFakeClient({ macOffline: true })
    const e = await c.schedules.listSchedules().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TalosClientError)
    expect((e as TalosClientError).code).toBe('mac_offline')
    const on = createFakeClient()
    const g = await on.schedules.getSchedule('no-such-job', null).catch((x: unknown) => x)
    expect((g as TalosClientError).code).toBe('schedule_not_found')
  })
})
