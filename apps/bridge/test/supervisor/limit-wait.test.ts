// Claude Code's own wait at a usage limit (the notice it draws under its input box while its `autoContinueAtUsageLimit` wait is armed),
// read as strictly as readUsageLimit reads the menu. The strings are Claude Code 2.1.322's own footer strings (its bundle, read only):
//   `Continuing automatically at <time> · Esc to cancel`, `... when it resets · Esc to cancel`, `Continuing shortly · Esc to cancel`
// with <time> as DP() draws it (en-US, am/pm lower case with no space): `4pm`, `3:10pm`, `Dec 1, 4pm`, `Dec 1, 2027, 4pm`.
// No real capture of that row exists yet: the shape below is anchored on the real input box and status row of the after-esc screen.
import { describe, expect, it } from 'bun:test'
import {
  LIMIT_WAIT_GRACE_MS,
  LIMIT_WAIT_MAX_MS,
  limitWaitDeadlineMs,
  readLimitWait,
} from '../../src/supervisor/limit-wait.ts'

const RULE = '─'.repeat(110)
/** The pane as Claude Code draws it at rest: conversation, its box from column 0, then its status row, then `under`. */
const pane = (o: { above?: string[]; box?: string[]; under?: string[]; boxPrefix?: string } = {}): string[] => [
  '',
  ' ▐▛███▛█   Claude Code v2.1.322',
  '',
  '❯ Run the gate and tell me what failed.',
  '',
  '⏺ Running the gate now.',
  '',
  "  You've hit your Fable limit · resets 4pm",
  ...(o.above ?? []),
  '',
  `${o.boxPrefix ?? ''}${RULE}`,
  ...(o.box ?? ['❯ ']),
  `${o.boxPrefix ?? ''}${RULE}`,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ...(o.under ?? []),
]
const NOTICE = {
  at: '  Continuing automatically at 4pm · Esc to cancel',
  atMinutes: '  Continuing automatically at 3:10pm · Esc to cancel',
  atDay: '  Continuing automatically at Dec 1, 4pm · Esc to cancel',
  atYear: '  Continuing automatically at Dec 1, 2027, 9:05am · Esc to cancel',
  resets: '  Continuing automatically when it resets · Esc to cancel',
  shortly: '  Continuing shortly · Esc to cancel',
}

describe('the notice under the box is read, strictly', () => {
  it.each(Object.entries(NOTICE))('%s: a wait, with the reset when the row names it', (name, row) => {
    const w = readLimitWait(pane({ under: [row] }))
    expect(w).not.toBeNull()
    if (name === 'at') expect(w?.parts).toMatchObject({ hour: 16, minute: 0 })
    if (name === 'atMinutes') expect(w?.parts).toMatchObject({ hour: 15, minute: 10 })
    if (name === 'atDay') expect(w?.parts).toMatchObject({ month: 11, day: 1, hour: 16 })
    if (name === 'atYear') expect(w?.parts).toMatchObject({ month: 11, day: 1, hour: 9, minute: 5 })
    if (name === 'resets' || name === 'shortly') expect(w?.parts).toBeNull()
  })

  it('with a blank spacer row, or the row above the status row, under the box: still read', () => {
    expect(readLimitWait(pane({ under: ['', NOTICE.at] }))).not.toBeNull()
    const rows = pane()
    rows.splice(rows.length - 1, 0, NOTICE.at) // between the box and the status row
    expect(readLimitWait(rows)).not.toBeNull()
  })

  it('no notice, no wait: the after-esc screen, a blank pane, and Claude’s ordinary status rows', () => {
    expect(readLimitWait(pane())).toBeNull()
    expect(readLimitWait([])).toBeNull()
    expect(readLimitWait(['', ''])).toBeNull()
  })

  it('a quoted copy is not Claude Code’s notice: in the conversation, in tool output, in the typed box, above the box', () => {
    // in the conversation above the box (the model or a tool printed it), the real box live below it
    expect(readLimitWait(pane({ above: [NOTICE.at, NOTICE.resets, NOTICE.shortly] }))).toBeNull()
    expect(
      readLimitWait(
        pane({ above: ['⏺ Bash(echo Continuing shortly · Esc to cancel)', '  ⎿  Continuing shortly · Esc to cancel'] }),
      ),
    ).toBeNull()
    // typed into the box itself
    expect(readLimitWait(pane({ box: ['❯ Continuing shortly · Esc to cancel'] }))).toBeNull()
    expect(readLimitWait(pane({ box: ['❯ ', '  Continuing shortly · Esc to cancel'] }))).toBeNull()
  })

  it('only a live box from column 0 counts: a box that is indented (a quoted frame) or a pane with no box reads nothing', () => {
    expect(readLimitWait(pane({ boxPrefix: '  ', under: [NOTICE.shortly] }))).toBeNull()
    const noBox = ['', "  You've hit your Fable limit · resets 4pm", NOTICE.shortly]
    expect(readLimitWait(noBox)).toBeNull()
  })

  it('a row that is not exactly the notice is not it: reworded, other case, extra words, a paid word, another time shape', () => {
    for (const row of [
      '  Continuing automatically at 4pm · Esc to cancel now',
      '  continuing automatically at 4pm · Esc to cancel',
      '  Continuing automatically at 4pm · esc to cancel',
      '  Continuing automatically at 4pm. Esc to cancel',
      '  Continuing automatically at 4 PM · Esc to cancel',
      '  Continuing automatically at $5 · Esc to cancel',
      '  Continuing automatically at never · Esc to cancel',
      '  Continuing automatically at 25pm · Esc to cancel',
      '  Continuing automatically at 13:00pm · Esc to cancel',
      '  Continuing automatically using usage credits · Esc to cancel',
      '  Continuing automatically · Esc to cancel',
      '  Continuing shortly · Esc to cancel (add funds)',
      '  Continuing now at lower priority · Esc to cancel',
      '  Usage limit reached · continuing automatically at 4pm · esc to cancel', // the transcript notice, not the footer
      '  Claude Code will continue automatically at 4pm. Keep this session open',
    ])
      expect(readLimitWait(pane({ under: [row] })), row).toBeNull()
  })

  it('a menu is not a wait: the usage-limit menu on the pane reads nothing here', () => {
    const menu = [
      RULE,
      "  You've hit your Fable limit · resets 4pm",
      '',
      '  What do you want to do?',
      '',
      '  ❯ 1. Stop and wait for limit to reset',
      '    2. Wait here, then continue automatically when the limit resets',
      '',
      '  Enter to confirm · Esc to cancel',
      NOTICE.shortly,
    ]
    expect(readLimitWait(menu)).toBeNull()
  })
})

describe('how long the skip holds', () => {
  const since = Date.parse('2026-11-10T12:00:00.000Z')
  const H = 3600_000
  it('the reset plus 15 minutes, when that comes before 6 hours', () => {
    const reset = since + H
    expect(limitWaitDeadlineMs(since, reset)).toBe(reset + LIMIT_WAIT_GRACE_MS)
    expect(LIMIT_WAIT_GRACE_MS).toBe(15 * 60_000)
  })
  it('6 hours after the notice first showed, when the reset is later than that or unknown', () => {
    expect(LIMIT_WAIT_MAX_MS).toBe(6 * H)
    expect(limitWaitDeadlineMs(since, null)).toBe(since + 6 * H)
    expect(limitWaitDeadlineMs(since, since + 20 * H)).toBe(since + 6 * H)
    expect(limitWaitDeadlineMs(since, Number.NaN)).toBe(since + 6 * H)
  })
  it('a reset already past when the notice first showed holds for 15 minutes at most', () => {
    expect(limitWaitDeadlineMs(since, since - 2 * H)).toBe(since - 2 * H + LIMIT_WAIT_GRACE_MS)
  })
})
