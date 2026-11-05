// Independent re-review of PR #63 (Option C WP-OC0) at b6d3ff8: forward compatibility of what `ready` carries. The web
// app parses every relay frame with parseFrame(direction relay_to_app) and DROPS a frame that fails
// (apps/web/src/lib/socketClient.ts onmessage: `if (!res.ok) return`). A dropped `ready` leaves the app unconnected.
// REVIEW-FAIL tests fail on b6d3ff8.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { newUlid, parseFrame } from '../src/index.ts'

const at = '2026-10-30T12:00:00.000Z'
const base = JSON.parse(readFileSync(new URL('../fixtures/frames/ready.json', import.meta.url), 'utf8'))
const ready = (extra: Record<string, unknown>) => ({ ...base, id: newUlid(), ...extra })
const status = (patch: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => ({
  supported: true,
  supervisor_online: true,
  threads: [{ thread_id: 'trip', state: 'live', ...item }],
  governor: { state: 'ok' },
  at,
  ...patch,
})

describe('recheck OC0: ready must survive a newer bridge/relay (old PWA builds stay cached)', () => {
  test('control: today’s workers_status parses inside ready', () => {
    expect(parseFrame(ready({ workers_status: status() }), { direction: 'relay_to_app' }).ok).toBe(true)
  })

  test('control: thread_session_states with a newer session.state field still parses (loose, as claimed)', () => {
    const r = ready({ thread_session_states: [{ thread_id: 'trip', state: { session_id: 's1', future_field: 1 } }] })
    expect(parseFrame(r, { direction: 'relay_to_app' }).ok).toBe(true)
  })

  test('REVIEW-FAIL: a worker state this app does not know yet must not make the whole ready unparseable', () => {
    const r = ready({ workers_status: status({}, { state: 'compacting' }) })
    expect(parseFrame(r, { direction: 'relay_to_app' })).toMatchObject({ ok: true })
  })

  test('REVIEW-FAIL: a worker failure code this app does not know yet must not make the whole ready unparseable', () => {
    const r = ready({ workers_status: status({}, { state: 'failed', error: 'disk_full' }) })
    expect(parseFrame(r, { direction: 'relay_to_app' })).toMatchObject({ ok: true })
  })

  test('REVIEW-FAIL: a governor state this app does not know yet must not make the whole ready unparseable', () => {
    const r = ready({ workers_status: status({ governor: { state: 'throttled' } }) })
    expect(parseFrame(r, { direction: 'relay_to_app' })).toMatchObject({ ok: true })
  })
})
