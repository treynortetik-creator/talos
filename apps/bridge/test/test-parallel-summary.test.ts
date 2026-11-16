// The bridge suite's failure summary (scripts/test-parallel.ts): a failed file names its failing tests and its first error
// block in the last lines of the log, so a flake seen once can still be read where only the tail is kept.
import { expect, test } from 'bun:test'
import { failureSummary } from '../scripts/test-parallel.ts'

const OUT = `bun test v1.3.11 (af24e281)

test/handoff-ledger.test.ts:
120 |     expect(oks.filter(Boolean)).toHaveLength(1)
error: expect(received).toHaveLength(expected)

Expected length: 1
Received length: 0

      at <anonymous> (/repo/apps/bridge/test/handoff-ledger.test.ts:120:33)
(fail) the hand-off ledger > three processes race for one slot: exactly one wins [9012.33ms]

 5 pass
 1 fail
`

test('names the failing test and keeps its assertion, expected, received and place', () => {
  expect(failureSummary(OUT)).toEqual([
    '(fail) the hand-off ledger > three processes race for one slot: exactly one wins',
    'error: expect(received).toHaveLength(expected)',
    'Expected length: 1',
    'Received length: 0',
    '      at <anonymous> (/repo/apps/bridge/test/handoff-ledger.test.ts:120:33)',
  ])
})

test('a test that failed with no error block still names what failed; nothing is invented', () => {
  expect(failureSummary('(fail) a > b [3ms]\n')).toEqual(['(fail) a > b'])
})

test('a long error block is cut', () => {
  const long = `error: boom\n${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}\n`
  expect(failureSummary(long, 5)).toHaveLength(5)
})

test('an error a passing test printed earlier is not taken for the failure', () => {
  const out = `Error: a warning a passing test printed\n(pass) a > logs [1ms]\nerror: expect(received).toBe(expected)\nExpected: 1\nReceived: 2\n(fail) a > real [2ms]\n`
  expect(failureSummary(out)).toEqual([
    '(fail) a > real',
    'error: expect(received).toBe(expected)',
    'Expected: 1',
    'Received: 2',
  ])
})

test("a test that timed out keeps bun's timed-out line; a killed file shows its last lines", () => {
  expect(failureSummary('(fail) a > slow [5000ms]\n  ^ this test timed out after 5000ms.\n')).toEqual([
    '(fail) a > slow',
    '  ^ this test timed out after 5000ms.',
  ])
  expect(failureSummary('one\ntwo\nkilled, it ran past 120 s\n')).toEqual(['one', 'two', 'killed, it ran past 120 s'])
})
