// Claude Code's usage-limit screen on Linux (supervisor/usage-limit.ts, the Mac's UsageLimitScreenTests ported): read loosely on
// the words and strictly on the shape, never a key, the owner's line, one line an hour, and the reset as a moment. The screens are
// SYNTHETIC (apps/desktop/Tests/Fixtures/synthetic/usage-limit*.txt, README): no real capture exists yet.
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { USAGE_RECORDER_PY } from '@talos-app/protocol'
import { refusedShape } from '../../src/supervisor/box-frame.ts'
import { detectPrompt, readDialog } from '../../src/supervisor/dialog-reader.ts'
import { firstStartScreen, keyToward } from '../../src/supervisor/first-start.ts'
import { auditRow, type KeyIntent, keyRefusal, keysAllowed, takeUnknownShapes } from '../../src/supervisor/key-guard.ts'
import { classify, inputBox, liveDialog } from '../../src/supervisor/screen.ts'
import { parseCapture } from '../../src/supervisor/tmux-commands.ts'
import {
  isUsageLimit,
  modelIn,
  readUsageLimit,
  resetParts,
  resetsAt,
  resetWords,
  UsageLimitWatch,
  usageLimitThreadLine,
} from '../../src/supervisor/usage-limit.ts'

/** Every intent a sender may state. */
const INTENTS: Array<[string, KeyIntent]> = [
  ['box-empty', { type: 'box', holds: 'empty' }],
  ['box-ours', { type: 'box', holds: 'ours' }],
  ...(['theme', 'security_notes', 'trust', 'mcp_consent', 'dev_channels'] as const).map(
    (k) => [k, { type: 'dialog', kind: k }] as [string, KeyIntent],
  ),
]
/** The table both key guards are checked against (the Mac's KeyGuardTests reads it too). */
const VECTORS = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../desktop/Tests/Fixtures/key-guard-vectors.json'), 'utf8'),
) as {
  captures: Record<string, string[]>
  usage_limit: Record<string, { model: string | null; resets: string | null }>
  not_usage_limit: string[]
  status_row_vectors: { vectors: Array<{ name: string; rows: string[]; box_empty: boolean }> }
  status_row_probes: { probes: Array<{ name: string; rows: string[]; note: string; box_empty: boolean }> }
}
const rows = (name: string) =>
  parseCapture(readFileSync(join(import.meta.dir, '../../../desktop/Tests/Fixtures/synthetic', `${name}.txt`), 'utf8'))
const words = (text: string) => {
  const p = resetParts(text)
  return p ? resetWords(p) : null
}

describe('the usage-limit screen', () => {
  const ALL = Object.keys(VECTORS.usage_limit)
  for (const name of ALL)
    it(`${name}: read, and no key may go to it`, () => {
      expect(readUsageLimit(rows(name))).not.toBeNull()
      expect(isUsageLimit(rows(name))).toBe(true)
      for (const i of INTENTS) expect(keysAllowed(rows(name), i[1]), i[0]).toBe(false)
    })
  it('every reader sees it as its own kind: the screen classifiers say usage_limit; no prompt, no dialog to answer', () => {
    for (const name of ALL) {
      const r = rows(name)
      expect(liveDialog(r).kind, name).toBe('usage_limit')
      expect(classify(r).kind, name).toBe('usage_limit')
      // no other reader takes it for a prompt it may announce with "answer", or a dialog a tap may press
      expect(detectPrompt(r), name).toBeNull()
      expect(readDialog(r), name).toBeNull()
    }
  })
  it('a wrapped option is read whole: a form split over two rows is still that form (Fable R2-4)', () => {
    const base = rows('usage-limit-narrow')
    const r = base
      .map((l) => l.replace('1. Stop and wait for', '1. Keep going').replace('limit to reset', ''))
      .map((l) => l.replace('2. Wait here, then', '2. Upgrade your').replace('continue automatically', 'plan'))
      .map((l) =>
        l.replace('when the limit resets', '').replace('3. Switch to usage', '3. Something').replace('  credits', ''),
      )
    expect(readUsageLimit(r)).not.toBeNull()
  })
  it('each waiting or paying form is enough on its own (any one of them, with a neutral option beside it)', () => {
    const base = rows('usage-limit')
    const forms = [
      'Wait for limit to reset',
      'Stop and wait',
      'Wait here, then continue automatically shortly',
      'Continue with usage credits',
      'Add funds to continue with extra usage',
      'Switch to usage billing',
      'Adjust monthly spend limit: $50',
      'Upgrade your plan',
      'Upgrade to Max or Ultra for higher session limits every month',
      'Ask your admin for more usage',
    ]
    for (const f of forms) {
      const r = base.map((l) =>
        l
          .replace('1. Stop and wait for limit to reset', `1. ${f}`)
          .replace('2. Wait here, then continue automatically when the limit resets', '2. Keep going')
          .replace('3. Switch to usage credits', '3. Something else'),
      )
      expect(readUsageLimit(r), f).not.toBeNull()
    }
  })
  it('the model and the reset are read in Talos’s own words (the Mac’s)', () => {
    expect(readUsageLimit(rows('usage-limit'))).toMatchObject({
      model: 'Fable',
      kind: 'model',
      resets: '4pm (Europe/Paris)',
    })
    expect(readUsageLimit(rows('usage-limit-session'))).toMatchObject({ model: null, resets: 'Aug 8, 3:10pm' })
    expect(readUsageLimit(rows('usage-limit-weekly-model'))).toMatchObject({
      model: 'Opus 5.5',
      kind: 'model',
      resets: null,
    })
    expect(readUsageLimit(rows('usage-limit-switch-to-usage'))).toMatchObject({ kind: 'weekly', resets: 'Dec 1' })
    expect(readUsageLimit(rows('usage-limit-upgrade-only'))).toMatchObject({ kind: 'five_hour', resets: '3:10pm' })
    expect(readUsageLimit(rows('usage-limit-admin'))).toMatchObject({ kind: 'team_budget', resets: null })
    expect(readUsageLimit(rows('usage-limit-narrow'))).toMatchObject({ model: 'Fable', resets: '4pm' })
    expect(words('limit · resets 15:10')).toBe('15:10')
    expect(words('limit · resets at 9 AM')).toBe('9am')
    expect(words('limit · resets Dec 1')).toBe('Dec 1')
    expect(words('limit · resets in 3 hours')).toBeNull()
    expect(words('limit · resets 13pm')).toBeNull()
    // a zone the system does not know is dropped, never copied
    expect(words('resets 4pm (Talos/approve_the_payment)')).toBe('4pm')
    expect(modelIn("You've hit your weekly limit")).toBeNull()
    expect(modelIn("You've hit your Approve-everything limit")).toBeNull()
    expect(modelIn("You've hit your sonnet limit")).toBe('Sonnet')
  })
  it('each screen gives the model and the reset the shared table says (the Mac reads the same table)', () => {
    for (const [name, want] of Object.entries(VECTORS.usage_limit))
      expect(readUsageLimit(rows(name)), name).toMatchObject({ model: want.model, resets: want.resets })
    for (const name of VECTORS.not_usage_limit) expect(readUsageLimit(rows(name)), name).toBeNull()
  })
  it('anything but the whole screen is not it', () => {
    expect(readUsageLimit(rows('usage-limit-quoted'))).toBeNull() // the words in a conversation, ending in the input box
    expect(isUsageLimit(rows('usage-limit-after-esc'))).toBe(false)
    const real = rows('usage-limit')
    const swap = (a: string, b: string) => real.map((r) => r.replaceAll(a, b))
    // no option of a known waiting or paying form: not this menu (but still a select: no key, key-guard.ts)
    const none = real.map((r) =>
      r
        .replaceAll('Stop and wait for limit to reset', 'Keep going')
        .replaceAll('Wait here, then continue automatically when the limit resets', 'Something else')
        .replaceAll('Switch to usage credits', 'Switch models'),
    )
    expect(readUsageLimit(none)).toBeNull()
    for (const i of INTENTS) expect(keysAllowed(none, i[1]), i[0]).toBe(false)
    expect(readUsageLimit(swap('    2. Wait', '  ❯ 2. Wait'))).toBeNull() // two cursors
    // no title and no headline: nothing says it is this menu (the select still gets no key: key-guard.ts)
    const bare = swap('What do you want to do?', 'Pick one').map((r) =>
      r.replaceAll("You've hit your Fable limit", 'Something'),
    )
    expect(readUsageLimit(bare)).toBeNull()
    for (const i of INTENTS) expect(keysAllowed(bare, i[1]), i[0]).toBe(false)
    expect(readUsageLimit(swap('1. Stop', '4. Stop'))).toBeNull()
    // the headline is not needed: the title and the options are the menu
    expect(readUsageLimit(swap("You've hit your Fable limit", 'Something else'))).toMatchObject({ kind: 'unnamed' })
    expect(isUsageLimit(null)).toBe(false)
  })
  it('the thread’s line says what kind of limit it is, the reset and the way on; /model only for one model’s limit; never "answer"', () => {
    const a = 'talos-app supervise attach trip'
    const line = usageLimitThreadLine({ model: 'Fable', kind: 'model', resets: '4pm (Europe/Paris)', parts: null }, a)
    expect(line).toBe(
      `This thread's session hit the usage limit for Fable. It resets 4pm (Europe/Paris). Talos pressed nothing on that screen: some of its options spend money or change your plan. To go on now, press Esc in this thread's pane (${a}), then /model <another model>.`,
    )
    const weekly = usageLimitThreadLine({ model: null, kind: 'weekly', resets: 'Dec 1', parts: null }, a)
    expect(weekly).toContain('hit its weekly limit, which covers every model. It resets Dec 1.')
    expect(weekly).toContain('Another model will not help')
    expect(weekly).not.toContain('/model')
    expect(usageLimitThreadLine({ model: null, kind: 'five_hour', resets: null, parts: null }, a)).not.toContain(
      '/model',
    )
    const team = usageLimitThreadLine({ model: null, kind: 'team_budget', resets: null, parts: null }, a)
    expect(team).toContain("hit the team's shared budget")
    expect(team).not.toContain('/model')
    expect(usageLimitThreadLine({ model: null, kind: 'trial', resets: null, parts: null }, a)).toContain(
      'reached the end of the Claude Code trial',
    )
    expect(
      readUsageLimit(rows('usage-limit').map((l) => l.replace('Fable limit', 'trial has ended, limit'))),
    ).toMatchObject({ kind: 'trial' })
    for (const kind of ['model', 'weekly', 'five_hour', 'team_budget', 'spend', 'trial', 'unnamed'] as const) {
      const l = usageLimitThreadLine({ model: 'Fable', kind, resets: null, parts: null }, a).toLowerCase()
      for (const w of ['answer', 'approve', 'accept', 'confirm']) expect(l).not.toContain(w)
    }
  })
})

describe('one line an appearance, at most one an hour (the Mac’s UsageLimitWatch)', () => {
  it('a torn frame is not the screen gone; a new appearance inside the hour gets no second line; a clock set back none', () => {
    const w = new UsageLimitWatch()
    expect(w.look(false, 0)).toBe('none')
    expect(w.look(true, 1)).toBe('appeared')
    expect(w.mayTellOwner(1)).toBe(true)
    expect(w.look(true, 2)).toBe('still')
    expect(w.look(false, 3)).toBe('fading')
    expect(w.look(true, 3.5)).toBe('still')
    expect(w.look(false, 4)).toBe('fading')
    expect(w.look(false, 4 + UsageLimitWatch.GONE_AFTER_S)).toBe('gone')
    expect(w.look(true, 100)).toBe('appeared')
    expect(w.mayTellOwner(100)).toBe(false)
    expect(w.mayTellOwner(1 + UsageLimitWatch.WINDOW_S)).toBe(true)
    const c = new UsageLimitWatch()
    expect(c.mayTellOwner(5000)).toBe(true)
    expect(c.mayTellOwner(4990)).toBe(false)
  })
})

describe('needs_you.resets_at: the reset as the next such moment after now', () => {
  const now = Date.parse('2026-11-13T10:00:00Z') // 11:00 in Paris
  it('a time in a named zone: today when still to come, else tomorrow', () => {
    expect(resetsAt(resetParts('resets 4pm (Europe/Paris)'), now, 'UTC')).toBe('2026-11-13T15:00:00.000Z')
    expect(resetsAt(resetParts('resets 9am (Europe/Paris)'), now, 'UTC')).toBe('2026-11-14T08:00:00.000Z')
  })
  it('no zone on the screen: the supervisor’s own', () => {
    expect(resetsAt(resetParts('resets 15:10'), now, 'UTC')).toBe('2026-11-13T15:10:00.000Z')
    expect(resetsAt(resetParts('resets 15:10'), now, 'America/New_York')).toBe('2026-11-13T20:10:00.000Z')
  })
  it('a day: this year, or next once it has passed; no time is the start of that day', () => {
    expect(resetsAt(resetParts('resets Dec 1, 3:10pm'), now, 'UTC')).toBe('2026-12-01T15:10:00.000Z')
    expect(resetsAt(resetParts('resets Aug 8, 3:10pm'), now, 'UTC')).toBe('2027-08-08T15:10:00.000Z')
    expect(resetsAt(resetParts('resets Dec 1'), now, 'UTC')).toBe('2026-12-01T00:00:00.000Z')
  })
  it('across a change of the clocks (Paris goes to summer time on 2027-03-28)', () => {
    const before = Date.parse('2027-03-27T12:00:00Z')
    expect(resetsAt(resetParts('resets Mar 28, 4pm (Europe/Paris)'), before, 'UTC')).toBe('2027-03-28T14:00:00.000Z')
  })
  it('a reset that has only just passed is that moment, not tomorrow; a time the clocks skip is absent (Fable R1-6)', () => {
    // 11:30 in Paris: "resets 11am" passed half an hour ago and is still on the menu
    expect(resetsAt(resetParts('resets 11am (Europe/Paris)'), now + 30 * 60_000, 'UTC')).toBe(
      '2026-11-13T10:00:00.000Z',
    )
    // two hours past: tomorrow's
    expect(resetsAt(resetParts('resets 9am (Europe/Paris)'), now, 'UTC')).toBe('2026-11-14T08:00:00.000Z')
    // a day that is today, read after its time: not next year's (Fable R2-6)
    expect(resetsAt(resetParts('resets Nov 13'), now, 'UTC')).toBeNull()
    expect(resetsAt(resetParts('resets Nov 13, 8am'), now, 'UTC')).toBeNull()
    expect(resetsAt(resetParts('resets Nov 14'), now, 'UTC')).toBe('2026-11-14T00:00:00.000Z')
    // 2:30am on the day Paris springs forward does not exist there
    expect(
      resetsAt(resetParts('resets Mar 28, 2:30am (Europe/Paris)'), Date.parse('2027-03-20T12:00:00Z'), 'UTC'),
    ).toBeNull()
  })
  it('nothing to read, a day the month does not have, a zone nobody knows: absent', () => {
    expect(resetsAt(resetParts('resets in 3 hours'), now, 'UTC')).toBeNull()
    expect(resetsAt(null, now, 'UTC')).toBeNull()
    expect(resetsAt(resetParts('resets Feb 30, 4pm'), now, 'UTC')).toBeNull()
    expect(resetsAt(resetParts('resets 4pm'), now, 'Not/AZone')).toBeNull()
  })
})

describe('the key guard: an allowlist, by what the sender means to press (key-guard.ts, Fable R3)', () => {
  const FIX = join(import.meta.dir, '../../../desktop/Tests/Fixtures')
  /** A capture's rows, coloured when its .ansi.txt exists (the live guard always has colours). */
  const capture = (rel: string) => {
    const ansi = join(FIX, rel.replace(/\.txt$/, '.ansi.txt'))
    return parseCapture(readFileSync(existsSync(ansi) ? ansi : join(FIX, rel), 'utf8'))
  }
  const allowed = (r: string[]) =>
    INTENTS.filter(([, i]) => keysAllowed(r, i))
      .map(([n]) => n)
      .join(',') || '-'
  // EVERY real capture, and what each intent may do on it (reviewed by hand, 2026-11-13), from the table the Mac's key guard is checked
  // against too (Fixtures/key-guard-vectors.json): the intents this side has, in INTENTS order. The dialog captures allow only their
  // own kind; the input box allows typing only when it is empty (a plain capture's placeholder reads as a draft: the live guard
  // reads colours) and the Enter only when it holds Talos's line; every permission prompt and unknown select allows nothing.
  const TABLE: Record<string, string> = Object.fromEntries(
    Object.entries(VECTORS.captures).map(([rel, names]) => [
      rel,
      INTENTS.map(([n]) => n)
        .filter((n) => names.includes(n))
        .join(',') || '-',
    ]),
  )
  it('every real capture: each intent allowed exactly as reviewed; none of them missing from the table', () => {
    const seen: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(join(FIX, d))) {
        const rel = `${d}/${n}`
        if (statSync(join(FIX, rel)).isDirectory()) walk(rel)
        else if (n.endsWith('.txt') && !n.endsWith('.ansi.txt')) seen.push(rel)
      }
    }
    for (const d of readdirSync(FIX)) if (d.startsWith('real')) walk(d)
    expect(seen.sort()).toEqual(Object.keys(TABLE).sort())
    for (const rel of seen) expect(allowed(capture(rel)), rel).toBe(TABLE[rel] as string)
  })
  it('no real capture with a select or dialog live has a live input box (if a future Claude draws one under a box, this fails)', () => {
    let selects = 0
    for (const rel of Object.keys(TABLE)) {
      const r = capture(rel)
      const dialog = liveDialog(r).kind
      if (detectPrompt(r) === null && (dialog === 'none' || dialog === 'login_expired' || dialog === 'usage_limit'))
        continue
      selects++
      // no input box at all, live or not (as KeyGuardTests.swift): a select drawn under a box would leave one (Fable R4-1)
      expect(inputBox([...r]), rel).toBeNull()
    }
    expect(selects).toBeGreaterThanOrEqual(10)
    // and the check itself sees one: a real select capture with Claude's empty box drawn under it
    const sel = Object.keys(TABLE).find((rel) => detectPrompt(capture(rel)) !== null) as string
    expect(inputBox([...capture(sel), ...box])).not.toBeNull()
  })
  it('a menu quoted in the conversation, the empty box live under it: typed into (Fable R2-1); the menu live: never', () => {
    expect(keysAllowed(rows('usage-limit-quoted'), { type: 'box', holds: 'empty' })).toBe(true)
    expect(isUsageLimit(rows('usage-limit-quoted'))).toBe(false)
  })
  it('Talos’s own status line (the usage recorder): exactly its prefix shape, one row only', () => {
    const empty = { type: 'box', holds: 'empty' } as const
    const base = ['⏺ Done.', ...box]
    const mode = '  ⏵⏵ auto mode on (shift+tab to cycle)'
    for (const row of [
      'Talos',
      'Talos: Opus 5.5',
      'Talos: Fable 5 | 7d: 42%',
      'Talos: Haiku 4 | 7d: 7%',
      `Talos: ${'x'.repeat(8)} | 7d: 0%`,
      'Talos: Sonnet 4 | 7d: 100%', // the longest row: 26 characters, all a 30-column pane shows
      'Talos: Opus 5.5                    Not logged in · Run /login',
    ])
      expect(keysAllowed([...base, `  ${row}`, mode], empty), row).toBe(true)
    for (const row of [
      'Opus 5.5', // the old recorder's bare row, and any one-row status line: not ours
      'Talos | 7d: 3%', // a percentage needs a model
      'Talos: Opus 5.5 | buy credits',
      'Talos: Opus 5.5 | 7d: 101%',
      `Talos: ${'x'.repeat(9)}`,
      'Talos: Sonnet 4.5 | 7d: 100%', // 28: Claude Code would cut it at 30 columns, and the recorder never prints it
      'Talos: Sonnet 4.5 (1M context)', // the recorder cuts the name at 10: a longer one is not what it prints
      'Talos: -Opus',
      'Talos: Opus 5.5 ❯ Buy',
      'Talos:Opus',
    ])
      expect(keysAllowed([...base, `  ${row}`, mode], empty), row).toBe(false)
    expect(keyRefusal([...base, '  Talos: Opus 5.5', '  Talos: Opus 5.5 | 7d: 1%'], empty)?.why).toBe('row_under_box')
  })
  it('TRANSITION (remove after the release following this one): the OLD recorder row with its percentage passes, once', () => {
    const empty = { type: 'box', holds: 'empty' } as const
    const base = ['⏺ Done.', ...box]
    // a thread session started before this release still prints the old row until it restarts
    expect(keysAllowed([...base, '  Opus 5.5 | 7d: 42%'], empty)).toBe(true)
    expect(keysAllowed([...base, '  Opus 5.5 | 7d: 42%                 Not logged in · Run /login'], empty)).toBe(true)
    // the old bare model-only form: refused (it cannot be told from any one-row line)
    expect(keysAllowed([...base, '  Opus 5.5'], empty)).toBe(false)
    // never one of each, never two old ones
    expect(keysAllowed([...base, '  Opus 5.5 | 7d: 42%', '  Talos: Opus 5.5'], empty)).toBe(false)
    expect(keysAllowed([...base, '  Opus 5.5 | 7d: 42%', '  Opus 5.5 | 7d: 1%'], empty)).toBe(false)
    // its shape exactly: a percentage over 100, a leading mark, an odd character
    for (const row of ['Opus 5.5 | 7d: 101%', '-Opus | 7d: 3%', 'Buy $50 | 7d: 3%'])
      expect(keysAllowed([...base, `  ${row}`], empty), row).toBe(false)
  })
  it('the REAL recorder’s output for awkward names and percentages passes the guard (Fable R1-1/R1-2 on 3d602733)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-recorder-'))
    try {
      // one python process for every input (the recorder run once per input, as Claude Code runs it, inside one interpreter): a
      // process per input took seconds under a version-manager shim
      const runAll = (inputs: unknown[]): string[] => {
        const driver = [
          'import io, json, sys, contextlib',
          'src, usage, inputs = sys.argv[1], sys.argv[2], json.loads(sys.stdin.read())',
          'outs = []',
          'for i in inputs:',
          '    sys.stdin = io.StringIO(json.dumps(i))',
          '    sys.argv = ["-c", usage]',
          '    buf = io.StringIO()',
          '    with contextlib.redirect_stdout(buf):',
          '        exec(compile(src, "<recorder>", "exec"), {"__name__": "__main__"})',
          '    outs.append(buf.getvalue())',
          'sys.__stdout__.write(json.dumps(outs))',
        ].join('\n')
        const r = spawnSync('python3', ['-I', '-c', driver, USAGE_RECORDER_PY, join(dir, 'usage.json')], {
          input: JSON.stringify(inputs),
        })
        return (JSON.parse(r.stdout.toString()) as string[]).map((o) => o.replace(/\n$/, ''))
      }
      const names = [
        'Opus 5.5',
        'Opus 5.5+',
        'claude-sonnet-4-5[1m]',
        'a_b',
        'alex@example.com',
        'a,b',
        'a:b',
        'a/b',
        'Café',
        'two  spaces',
        'n'.repeat(45),
        `${'n'.repeat(39)} tail`,
        '',
        '@@@',
        '  -lead',
        '模型',
      ]
      const pcts: unknown[] = [undefined, 0, 42.6, 100, 101, 150, -1, 'abc']
      const empty = { type: 'box', holds: 'empty' } as const
      const cases = names.flatMap((name) =>
        pcts.map((p) => ({
          label: `${name} ${String(p)}`,
          input: {
            model: { display_name: name },
            ...(p === undefined ? {} : { rate_limits: { seven_day: { used_percentage: p } } }),
          },
        })),
      )
      const outs = runAll([...cases.map((c) => c.input), {}])
      cases.forEach((c, k) => {
        const out = outs[k] as string
        expect(out.startsWith('Talos'), `${c.label}: ${out}`).toBe(true)
        expect(keysAllowed(['⏺ Done.', ...box, `  ${out}`], empty), `${c.label}: ${out}`).toBe(true)
      })
      // no model at all: the bare prefix
      expect(outs[cases.length]).toBe('Talos')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('no intent, or a pane that cannot be read: no key', () => {
    expect(keysAllowed(capture('real-2.1.318/empty-input.txt'))).toBe(false)
    for (const [n, i] of INTENTS) expect(keysAllowed(null, i), n).toBe(false)
  })
  const rule = '─'.repeat(60)
  const box = [rule, '❯ ', rule]
  it('a menu of any shape under an empty box, or a box-like frame around a menu: never typed into (Fable R3-2, R3-4)', () => {
    const under = [
      ['  → Buy $50 of credits', '    Cancel'],
      ['  * Buy', '  - Cancel'],
      ['  [x] Buy', '  [ ] Cancel'],
      ['  (•) Buy', '  ( ) Cancel'],
      ['  a) Buy', '  b) Cancel'],
      ['  Buy $50 of credits', '  Cancel'],
      ['  100. Buy', '  101. Cancel'],
      ['  1. Buy', '  2. Cancel'],
    ]
    for (const u of under)
      expect(keysAllowed(['⏺ Done.', ...box, ...u], { type: 'box', holds: 'empty' }), u[0]).toBe(false)
    // a one-row line that is not Talos's own (the recorder's prefix) is refused too: only `Talos…` is ours under the box
    expect(keysAllowed(['⏺ Done.', ...box, '  Press Enter to purchase'], { type: 'box', holds: 'empty' })).toBe(false)
    // a menu drawn between two rules: its first row is not an empty prompt row
    expect(
      keysAllowed(['⏺ Done.', rule, '❯ Buy $50 of credits', '  Cancel', rule], { type: 'box', holds: 'empty' }),
    ).toBe(false)
    // the empty box with Claude Code's own status rows under it: typed into
    expect(
      keysAllowed(['⏺ Done.', ...box, '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'], {
        type: 'box',
        holds: 'empty',
      }),
    ).toBe(true)
  })
  it('a dialog key names its kind and only that kind’s reader allows it; a phrase above never names anything (Fable R3-3)', () => {
    const trust = capture('real-2.1.318/trust-dialog.txt')
    expect(keysAllowed(trust, { type: 'dialog', kind: 'trust' })).toBe(true)
    expect(keysAllowed(trust, { type: 'dialog', kind: 'mcp_consent' })).toBe(false)
    expect(keysAllowed(trust, { type: 'box', holds: 'empty' })).toBe(false)
    // the trust dialog's words quoted above an unknown select
    const quoted = [
      ' Quick safety check: Is this a project you created or one you trust?',
      ' Yes, I trust this folder',
      rule,
      ' ❯ 1. Buy $50 of credits',
      '   2. Cancel',
      ' Enter to confirm · Esc to cancel',
    ]
    for (const [n, i] of INTENTS) expect(keysAllowed(quoted, i), n).toBe(false)
  })
  const trimEnd = (r: string[]) => {
    const out = [...r]
    while (out.length > 0 && (out[out.length - 1] as string).trim() === '') out.pop()
    return out
  }
  // the menu's rows (no footer), from the synthetic capture: [header..., rule, headline, title, options...]
  const menuRows = () => rows('usage-limit').filter((r) => r.trim() !== '' && !/Enter to confirm/.test(r))
  const ruleAt = (m: string[]) => m.findIndex((r) => /^─+$/.test(r))
  const variants = (): Record<string, string[]> => {
    const m = menuRows()
    const at = ruleAt(m)
    const head = m.slice(0, at)
    const headline = m[at + 1] as string
    const rest = m.slice(at + 2) // title and options
    return {
      'with its rule': m,
      'no rule': [...head, headline, ...rest],
      'a dashed rule': [...head, '╌'.repeat(100), headline, ...rest],
      'the rule right above the title': [...head, rule, ...rest],
      'a headline and a note paragraph': [
        ...head,
        rule,
        headline,
        '',
        '  Your weekly limit resets Monday.',
        '',
        ...rest,
      ],
    }
  }
  it('recognised with or without a rule above it, and with a note between headline and title (Fable R4-1)', () => {
    for (const [n, v] of Object.entries(variants())) {
      expect(isUsageLimit(v), n).toBe(true)
      // Claude's real box below it (drawn from column 0): the menu is quoted in the conversation, whatever sits under the box (a
      // user's status row, anything); keys still go by the rows under the box, so an unknown row there refuses them all
      const under = [...v, ...box, '  ❯ 1. Buy $50 of credits']
      expect(isUsageLimit(under), n).toBe(false)
      for (const [k, i] of INTENTS) expect(keysAllowed(under, i), `${n} ${k}`).toBe(false)
      // a frame a status line prints (indented) under a live menu is no box: still the live menu (Fable R1-3 on the pair)
      const fake = [...v, '  ' + rule, '  ❯ Talos: new message', '  ' + rule]
      expect(isUsageLimit(fake), n).toBe(true)
      for (const [k, i] of INTENTS) expect(keysAllowed(fake, i), `${n} ${k}`).toBe(false)
    }
    // Fable's repro: the quoted menu with a user's status row under the real box is quoted, not the live menu
    const quoted = [
      ...rows('usage-limit-quoted').filter((r) => r.trim() !== '' && !/⏵⏵/.test(r)),
      '  ~/proj main ✓ 42%',
    ]
    expect(isUsageLimit(quoted)).toBe(false)
    // the narrow fixture as the Mac reads it: no rule
    expect(isUsageLimit(rows('usage-limit-narrow'))).toBe(true)
  })
  it('quoted is the other way round: Claude’s input box live BELOW the menu, the menu above its top rule (Fable R4-1)', () => {
    for (const [n, v] of Object.entries(variants())) {
      const quoted = [...v, '✻ Cooked for 3s', ...box, '  ⏸ manual mode on · ? for shortcuts']
      expect(isUsageLimit(quoted), n).toBe(false)
      expect(keysAllowed(quoted, { type: 'box', holds: 'empty' }), n).toBe(true)
      // a column-0 rule in the conversation between the menu and the real box opens no frame: passed over (Fable R2-3)
      const ruled = [...v, rule, 'a rule the model printed, then text', ...box, '  ⏸ manual mode on · ? for shortcuts']
      expect(isUsageLimit(ruled), n).toBe(false)
    }
  })
  it('status rows under the box: the shared vectors (Pantheon’s spec for parts not yet captured, 2026-11-14)', () => {
    expect(VECTORS.status_row_vectors.vectors.length).toBeGreaterThanOrEqual(40)
    expect(VECTORS.status_row_probes.probes.length).toBeGreaterThanOrEqual(271)
    for (const v of [...VECTORS.status_row_vectors.vectors, ...VECTORS.status_row_probes.probes]) {
      const screen = ['⏺ Done.', ...box, ...v.rows]
      expect(keysAllowed(screen, { type: 'box', holds: 'empty' }), v.name).toBe(v.box_empty)
    }
  })
  it('a cut known part is known only as the last part; elsewhere it is an unknown part, held to the positive shape', () => {
    const ok = (under: string) => keysAllowed(['⏺ Done.', ...box, under], { type: 'box', holds: 'empty' })
    expect(ok('  ⏸ manual mode on · esc to…')).toBe(true) // a known part cut, last
    expect(ok('  ? for shortcuts · esc to…')).toBe(true) // a cut known last part: allowed on any Claude row
    expect(ok('  ⏸ manual mode on · esc to… · ↓ to manage')).toBe(false) // cut, then more: an unknown part with "…" (not ASCII)
    expect(ok('  ⏸ manual mode on · ctrl+r to search · ↓ to manage')).toBe(true) // an unknown part of the shape
    expect(ok('  ? for shortcuts · ctrl+r to search')).toBe(false) // not a mode row: no unknown parts at all
    expect(ok('  ⏸ manual mode on · sure')).toBe(false) // one short word: an answer
    expect(ok('  ⏸ manual mode on · Later')).toBe(false) // a capital: not the shape
    expect(ok('  ⏸ do you want to run rm on · fine by me')).toBe(false) // a mode nobody captured: read exactly
  })
  it('a part refused for its shape is audited by its length and kinds, once per run; an uncaptured mode by its head', () => {
    takeUnknownShapes()
    // shapes no shared vector or probe has (each shape is said once per run, and the probes run in this file too)
    const screen = (part: string) => ['⏺ Done.', ...box, `  ⏸ manual mode on · ${part}`]
    expect(keysAllowed(screen('Zz9 Qq Zz9 Qq Zz9 Qq Zz'), { type: 'box', holds: 'empty' })).toBe(false)
    expect(keysAllowed(screen('Zz9 Qq Zz9 Qq Zz9 Qq Zz'), { type: 'box', holds: 'empty' })).toBe(false)
    expect(takeUnknownShapes()).toEqual([{ event: 'status_part_refused', shape: '23:aANs' }])
    // a mode nobody captured: the row is read exactly (refused), and the head's shape said, as the Mac says it
    const mode = '⏸ zzzzzzzzzzzzzzzzzzzzzzzzzz mode on'
    expect(keysAllowed(['⏺ Done.', ...box, `  ${mode} · ? for shortcuts`], { type: 'box', holds: 'empty' })).toBe(false)
    expect(takeUnknownShapes()).toEqual([{ event: 'status_part_refused', shape: `mode ${refusedShape(mode)}` }])
    expect(refusedShape(mode)).toBe('36:asu')
  })
  it('an unknown part is audited by its shape once per run, and only when the key was allowed', () => {
    takeUnknownShapes()
    const screen = (part: string) => ['⏺ Done.', ...box, `  ⏸ manual mode on · ${part}`]
    expect(keysAllowed(screen('brand new 12'), { type: 'box', holds: 'empty' })).toBe(true)
    expect(keysAllowed(screen('brand new 12'), { type: 'box', holds: 'empty' })).toBe(true)
    expect(
      keysAllowed([...screen('other new'), '  ? for shortcuts', 'x'.repeat(3)], { type: 'box', holds: 'empty' }),
    ).toBe(false)
    expect(takeUnknownShapes()).toEqual([{ event: 'status_part_unknown', shape: 'aaaaa aaa NN' }])
    expect(takeUnknownShapes()).toEqual([])
  })
  it('the key guard types only into a box drawn from column 0: an indented frame is no box (Fable R2-4 on the pair)', () => {
    const at0 = ['⏺ Done.', ...box, '  ⏸ manual mode on · ? for shortcuts']
    expect(keysAllowed(at0, { type: 'box', holds: 'empty' })).toBe(true)
    const indented = ['⏺ Done.', ...box.map((r) => `  ${r}`), '  ⏸ manual mode on · ? for shortcuts']
    for (const [k, i] of INTENTS) expect(keysAllowed(indented, i), k).toBe(false)
  })
  it('a live dialog below a quoted menu wins: the guard allows its key, and first-start waits on it (Fable R5-2, R6-2)', () => {
    const trust = trimEnd(capture('real-2.1.318/trust-dialog.txt'))
    const both = [...menuRows(), ...trust]
    expect(isUsageLimit(both)).toBe(false)
    expect(keysAllowed(both, { type: 'dialog', kind: 'trust' })).toBe(true)
    expect(keysAllowed(both, { type: 'box', holds: 'empty' })).toBe(false)
    // first-start reads it as the trust dialog but sends nothing: two cursor rows on screen (the menu's and the dialog's), so
    // the key toward "Yes" is not one row, and it waits (the safe side; a trust dialog comes before any conversation anyway)
    const screen = firstStartScreen(both)
    expect(screen.kind).toBe('trust')
    expect(keyToward('rows' in screen ? screen.rows : [], 'Yes, I trust this folder')).toBeNull()
  })
  it('a live prompt below a quoted menu wins: it is the prompt, not the usage limit, and gets no key (Fable R5-2)', () => {
    for (const name of [
      'real-2.1.318/bash-permission.txt',
      'real-2.1.318/askuser-select.txt',
      'real-2.1.322/perm-subagent-rm-120x40.txt',
    ]) {
      const prompt = trimEnd(capture(name))
      expect(detectPrompt(prompt), name).not.toBeNull()
      for (const [n, v] of Object.entries(variants())) {
        const both = [...v, ...prompt]
        expect(isUsageLimit(both), `${name} ${n}`).toBe(false)
        expect(detectPrompt(both), `${name} ${n}`).not.toBeNull()
        for (const [k, i] of INTENTS) expect(keysAllowed(both, i), `${name} ${n} ${k}`).toBe(false)
      }
    }
  })
  it('the headline stops at a dashed rule: a line quoted above it is not read into it (R5-3)', () => {
    const m = menuRows()
    const at = ruleAt(m)
    const base = readUsageLimit(m)
    expect(base).not.toBeNull()
    for (const dash of ['╌'.repeat(100), '-'.repeat(100), '┄'.repeat(40)]) {
      const v = [...m.slice(0, at), '  You hit your Opus limit · resets 9am', dash, ...m.slice(at + 1)]
      const info = readUsageLimit(v)
      expect(info?.model, dash).toBe(base?.model as string)
      expect(info?.parts, dash).toEqual(base?.parts as never)
    }
  })
  it('the audit row is cut at 120 CODE POINTS, never inside a pair (Fable R6-3)', () => {
    // 119 plain characters, then emoji: the 120th code point is a whole emoji, two code units
    const kept = auditRow(`${'a'.repeat(119)}${'😀'.repeat(5)}`)
    expect([...kept]).toHaveLength(120)
    expect(kept).toBe(`${'a'.repeat(119)}😀`)
    expect(kept.length).toBe(121) // code units: the pair kept whole
  })
  it('the audit row drops a lone surrogate and the line and paragraph separators (Fable R6-3)', () => {
    const kept = auditRow(`a\uD800b\uDC00c\u2028d\u2029e`)
    expect(kept).toBe('abcde')
  })
  it('the audit row: no control or format characters, at most 120 code points, never half a character (Fable R5-4)', () => {
    const long = `\u202e\u200b${'😀'.repeat(130)}\u0007`
    const kept = auditRow(long)
    expect([...kept]).toHaveLength(120)
    expect(kept).not.toMatch(/[\p{Cc}\p{Cf}]/u)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(kept)).toBe(false) // no lone surrogate
    // from the guard itself, on a pane with that row under the box
    const why = keyRefusal(['⏺ Done.', ...box, `  ${long}`], { type: 'box', holds: 'empty' })
    expect(why?.why).toBe('row_under_box')
    expect(why?.row).toBe(kept)
  })
  it('trust and MCP consent are named only by the exact option reader, in the guard and in first-start (Fable R4-2)', () => {
    // the trust dialog's words, drawn as a tool's permission prompt (one more row after the footer): the phrase reads trust
    const trust = trimEnd(capture('real-2.1.318/trust-dialog.txt'))
    expect(readDialog(trust)?.kind).toBe('trust')
    const prompt = [...trust, ' Tab to amend · ctrl+e to explain']
    expect(liveDialog(prompt).kind).toBe('trust')
    expect(readDialog(prompt)).toBeNull()
    for (const [n, i] of INTENTS) expect(keysAllowed(prompt, i), n).toBe(false)
    expect(firstStartScreen(prompt).kind).toBe('unknown')
    const mcp = trimEnd(capture('real-2.1.318/mcp-consent.txt'))
    expect(readDialog(mcp)?.kind).toBe('mcp_consent')
    const mcpPrompt = [...mcp, ' Tab to amend · ctrl+e to explain']
    expect(liveDialog(mcpPrompt).kind).toBe('mcp_consent')
    expect(keysAllowed(mcpPrompt, { type: 'dialog', kind: 'mcp_consent' })).toBe(false)
    expect(firstStartScreen(mcpPrompt).kind).toBe('unknown')
  })
  it('the Enter goes only on exactly Talos’s line, drawn as Claude Code draws typed text (Fable R4-6)', () => {
    const typed = capture('real-2.1.319/owed-capture/05-typed-30.txt')
    const ours = { type: 'box', holds: 'ours' } as const
    expect(keysAllowed(typed, ours)).toBe(true)
    const swap = (from: string, to: string) => typed.map((r) => r.replace(from, to))
    expect(keysAllowed(swap('thread. Call', 'thread.  Call'), ours)).toBe(false) // a run of spaces
    expect(keysAllowed(swap('  thread. Call', '    thread. Call'), ours)).toBe(false) // a deeper wrapped row
    expect(keysAllowed(swap('read_inbound.', 'read_inbound. x'), ours)).toBe(false) // more after it
    expect(keysAllowed(swap('Talos: new', 'Talos:\tnew'), ours)).toBe(false)
  })
  it('under the box: a second rule, or a menu drawn with the agents panel’s mark, is no status row (Fable R4-6)', () => {
    const empty = { type: 'box', holds: 'empty' } as const
    const base = ['⏺ Done.', ...box]
    expect(keysAllowed([...base, '  ⏸ manual mode on · ? for shortcuts'], empty)).toBe(true)
    expect(keysAllowed([...base, rule, '  ⏸ manual mode on · ? for shortcuts'], empty)).toBe(false)
    expect(keysAllowed([...base, '  ⏺ Buy', '  ⏺ Cancel'], empty)).toBe(false)
    // the agents panel as captured: the main row exactly, and a subagent's row
    expect(
      keysAllowed([...base, '  ⏺ main', '  ◯ talos-builder (+2)  Verify the push        4s · ↓ 36 tokens'], empty),
    ).toBe(true)
  })
})
