// WP-S1 acceptance: the capture step (docs/SCHEDULES.md S9, N4). The committed captures are exactly what the real bridge
// produces against the real Chronos CLI today, and every captured card.create equals composeScheduleCard() of the same
// inputs (the capture script asserts that for each card it records, reading the inputs from Chronos itself).
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindingFrom, parseFrame, payloadHash } from '@talos-app/protocol'
import { CAPTURE_DIR, diffAgainstDisk, FLOW_NAMES, indexOf } from '../../scripts/capture-schedules.ts'
import { ChronosBox, longTimeouts, MON_0700_EDT } from './harness.ts'

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

  // Re-running each scenario against the real bridge and Chronos is capture-flows-*.test.ts: one test per scenario, in three
  // files so they run side by side. What is left here is the index the full capture writes, which only describes them.
  // What a full `capture:schedules --check` checks besides each scenario's own file (capture-flows-*), so CI needs no run of it.
  test('no stale capture: every committed scenario file is one a scenario still makes', () => {
    const files = readdirSync(CAPTURE_DIR).filter((f) => f.endsWith('.json')) // captured/search and memory are others'
    expect(files.sort()).toEqual(['index.json', ...FLOW_NAMES.map((n) => `${n}.json`)].sort())
  })

  test('the --check comparison names a missing, a changed and a stale file (it is what fails the step)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-capture-diff-'))
    writeFileSync(join(dir, 'a.json'), 'same\n')
    writeFileSync(join(dir, 'b.json'), 'old\n')
    writeFileSync(join(dir, 'gone.json'), 'x\n')
    const files = { 'a.json': 'same\n', 'b.json': 'new\n', 'c.json': 'x\n' }
    expect(diffAgainstDisk(files, dir).sort()).toEqual(['b.json (differs)', 'c.json (missing)', 'gone.json (stale)'])
    // a part of the capture (--only) says nothing about the files it did not make
    expect(diffAgainstDisk(files, dir, { part: true }).sort()).toEqual(['b.json (differs)', 'c.json (missing)'])
  })

  test('capture:schedules --check --only <one scenario> exits 0 and says its file matches', () => {
    const r = Bun.spawnSync(
      [
        'bun',
        join(import.meta.dir, '../../scripts/capture-schedules.ts'),
        '--check',
        '--only',
        FLOW_NAMES[0] as string,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect({ code: r.exitCode, out: r.stdout.toString().trim() }).toEqual({
      code: 0,
      out: 'capture:schedules --check: 1 files match.',
    })
  }, 120_000)

  test('index.json is what a full capture writes for the committed scenarios: every one, in order, with its counts', () => {
    const scenarios = Object.fromEntries(
      FLOW_NAMES.map((n) => [`${n}.json`, readFileSync(join(CAPTURE_DIR, `${n}.json`), 'utf8')]),
    )
    const box = new ChronosBox(MON_0700_EDT)
    try {
      const chronos = box.cli(['--version']).out.trim()
      expect(readFileSync(join(CAPTURE_DIR, 'index.json'), 'utf8')).toBe(indexOf(scenarios, chronos))
    } finally {
      box.dispose()
    }
  })
})
