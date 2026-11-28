// The rows just above Claude's input box, kept on the idle clock and published (only after four quiet minutes) as `quiet_lines`: at most 3 lines
// of 100 characters, through the shared redact(). Pure checks on the selection; the workers.json side is in workers.test.ts.
import { describe, expect, it } from 'bun:test'
import { paneLines, QUIET_LINES_AFTER_MS, quietLinesFor } from '../../src/supervisor/pane-lines.ts'
import { noteScreen } from '../../src/supervisor/worker-idle.ts'

const rule = '─'.repeat(40)
const screen = (above: string[], box = '', status = 'model: sonnet  12% ctx') => [
  ...above,
  rule,
  `❯ ${box}`,
  rule,
  status,
]
const GH = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`

describe('paneLines: from just above the input box', () => {
  it('the last three non-blank rows above the box; never the box, its rules or the status line under it', () => {
    const rows = screen(['one', 'two', '', 'three', 'four', ''], 'my half-typed draft')
    expect(paneLines(rows)).toEqual(['two', 'three', 'four'])
  })

  it('a row of the conversation is cleaned: box edges and padding go, whitespace is collapsed', () => {
    expect(paneLines(screen(['│  ● Reading   the file  │']))).toEqual(['● Reading the file'])
  })

  it('no input box on the screen (a dialog, a blank pane): no lines, nothing is guessed', () => {
    expect(paneLines(['Do you trust this folder?', '1. Yes', '2. No'])).toEqual([])
    expect(paneLines([])).toEqual([])
  })

  it('tokens, keys and emails in those rows are redacted; each line is at most 100 characters', () => {
    const out = paneLines(screen([`token=${GH}`, `write to jane@example.com ${'z'.repeat(200)}`]))
    expect(out.join('\n')).not.toContain(GH)
    expect(out.join('\n')).not.toContain('jane@example.com')
    for (const l of out) expect([...l].length).toBeLessThanOrEqual(100)
  })
})

describe('the idle clock keeps the tail', () => {
  const clock = { lastActiveMs: 1, activeMono: 1, body: null }
  it('every look at the screen records the rows above the box', () => {
    const c = noteScreen(clock, screen(['a', 'b']), 10_000, 10)
    expect(c.tail).toEqual(['a', 'b'])
  })
})

describe('quietLinesFor: only for a quiet live pane, and only after the wait', () => {
  const idle = (lastActiveMs: number, tail: string[] | undefined) => ({ lastActiveMs, activeMono: 0, body: 'x', tail })
  const now = 10 * 60_000
  it('quiet for the wait or longer: the lines', () => {
    expect(quietLinesFor('live', idle(now - QUIET_LINES_AFTER_MS, ['a', 'b']), now)).toEqual(['a', 'b'])
  })
  it('active a moment ago: none', () => {
    expect(quietLinesFor('live', idle(now - QUIET_LINES_AFTER_MS + 1, ['a']), now)).toBeUndefined()
  })
  it('busy, parked or any other state, or no tail, or an empty one: none', () => {
    for (const s of ['busy', 'parked', 'starting', 'stopping'] as const)
      expect(quietLinesFor(s, idle(0, ['a']), now)).toBeUndefined()
    expect(quietLinesFor('live', idle(0, undefined), now)).toBeUndefined()
    expect(quietLinesFor('live', idle(0, []), now)).toBeUndefined()
  })
  it('the wait is shorter than the five minutes the bridge waits, so the lines are there when it decides', () => {
    expect(QUIET_LINES_AFTER_MS).toBeLessThan(5 * 60_000)
  })
})
