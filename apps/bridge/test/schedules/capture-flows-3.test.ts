// capture:schedules --check, scenarios 13 to the last: each re-runs one scenario against the real bridge and the real
// Chronos CLI and must reproduce its committed file (capture() also throws if any card.create differs from
// composeScheduleCard() of the same inputs). The scenarios are independent (each starts its own bridge and Chronos box), so
// they are split over three files that run side by side; capture.test.ts checks the index that lists them.
import { describe, expect, test } from 'bun:test'
import { CAPTURE_DIR, capture, diffAgainstDisk, FLOW_NAMES } from '../../scripts/capture-schedules.ts'
import { longTimeouts } from './harness.ts'

longTimeouts()

const NAMES = FLOW_NAMES.slice(12)

describe('capture:schedules --check, by scenario', () => {
  test('this part covers its scenarios', () => expect(NAMES.length).toBeGreaterThan(0))
  for (const name of NAMES)
    test(`${name}: re-running it reproduces the committed file`, async () => {
      const { files } = await capture([name])
      expect(Object.keys(files)).toEqual([`${name}.json`])
      expect(diffAgainstDisk(files, CAPTURE_DIR, { part: true })).toEqual([])
    }, 300_000)
})
