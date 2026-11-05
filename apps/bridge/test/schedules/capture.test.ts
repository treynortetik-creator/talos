// WP-S1 acceptance: the capture step (docs/SCHEDULES.md S9, N4). The committed captures are exactly what the real bridge
// produces against the real Chronos CLI today, and every captured card.create equals composeScheduleCard() of the same
// inputs (the capture script asserts that for each card it records, reading the inputs from Chronos itself).
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bindingFrom, parseFrame, payloadHash } from '@talos-app/protocol'
import { CAPTURE_DIR, capture, diffAgainstDisk } from '../../scripts/capture-schedules.ts'
import { longTimeouts } from './harness.ts'

longTimeouts()

type Captured = {
  scenario: string
  steps: Array<{
    received_by_bridge: Array<Record<string, unknown>>
    sent_by_bridge: Array<Record<string, unknown>>
    channel_notifications: Array<{ content: string; meta: Record<string, string> }>
  }>
}
const load = () =>
  readdirSync(CAPTURE_DIR)
    .filter((f) => /^\d\d-.*\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CAPTURE_DIR, f), 'utf8')) as Captured)

describe('capture:schedules', () => {
  test('the committed captures exist: every scenario of S9 steps 1-7', () => {
    expect(existsSync(CAPTURE_DIR)).toBe(true)
    const names = load().map((c) => c.scenario)
    for (const want of [
      'list-empty',
      'list-three-jobs',
      'get-detail-with-report',
      'patch-create',
      'patch-update',
      'patch-delete',
      'run-now',
      'control',
      'session-run',
      'hold-and-adopt',
      'errors',
    ])
      expect(
        names.some((n) => n.endsWith(want)),
        want,
      ).toBe(true)
  })

  test('every captured frame parses, every captured card verifies, and nothing identifies a machine or person', () => {
    let frames = 0
    for (const c of load()) {
      for (const s of c.steps) {
        for (const f of [...s.received_by_bridge, ...s.sent_by_bridge]) {
          frames++
          const dir = s.received_by_bridge.includes(f) ? 'relay_to_bridge' : 'bridge_to_relay'
          expect(parseFrame(f, { direction: dir }).ok, `${c.scenario}: ${String(f.type)} (${dir})`).toBe(true)
          if (f.type === 'card.create') {
            const card = (f as { card: Parameters<typeof bindingFrom>[0] }).card
            expect(card.payload_hash).toBe(payloadHash(bindingFrom(card)))
          }
        }
        for (const n of s.channel_notifications) {
          expect(Object.values(n.meta).every((v) => typeof v === 'string')).toBe(true)
          expect(Object.keys(n.meta).every((k) => /^[A-Za-z0-9_]+$/.test(k))).toBe(true)
        }
      }
    }
    expect(frames).toBeGreaterThan(40)
    const all = readdirSync(CAPTURE_DIR)
      .filter((f) => f.endsWith('.json')) // captured/search/ belongs to WP-V2
      .map((f) => readFileSync(join(CAPTURE_DIR, f), 'utf8'))
      .join('\n')
    expect(all).not.toMatch(/\/Users\/|\/home\/|\/private\/var|\/tmp\//)
  })

  test('capture:schedules --check passes: re-running the capture reproduces the committed files', async () => {
    const { files } = await capture() // throws if any card.create differs from composeScheduleCard() of the same inputs
    expect(diffAgainstDisk(files)).toEqual([])
  }, 600_000)
})
