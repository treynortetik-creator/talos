// The dialog reader and the prompt detector against the Mac's real Claude Code captures (apps/desktop/Tests/Fixtures; their
// READMEs say where each came from). The cases are those of DialogReaderTests.swift, PromptDetectorTests.swift and
// PromptDetectorReviewTests.swift; a case that changes rows of a real capture says SYNTHETIC, as the Swift does.
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type Dialog,
  detectPrompt,
  isIdle,
  maskCountdown,
  type Prompt,
  readDialog,
} from '../../src/supervisor/dialog-reader.ts'
import { isFrameRule, liveDialog } from '../../src/supervisor/screen.ts'
import { parseCapture } from '../../src/supervisor/tmux-commands.ts'

const FIX = resolve(import.meta.dir, '../../../desktop/Tests/Fixtures')
const CAP = 'real-2.1.319/needs-you-capture'
/** As the Swift's RealScreens.rows: the `.txt` file through `TmuxCommands.parseCapture`. */
const rows = (name: string, dir = 'real-2.1.318') =>
  parseCapture(readFileSync(resolve(FIX, dir, `${name}.txt`), 'utf8'))
const nyRows = (name: string, dir = CAP) => rows(name, dir)
const escaped = (name: string, dir = CAP) => rows(`${name}.ansi`, dir)

const TRUST_OPTIONS = ['No, exit', 'Yes, I trust this folder']
const MCP_OPTIONS = [
  'Use this MCP server',
  'Use this and all future MCP servers in this project',
  'Continue without using this MCP server',
]

/** The folder path row of a trust capture, as the dialog draws it (an independent read of the same file). */
const pathRow = (r: string[]) => r.find((x) => x.startsWith(' /'))?.trim() ?? null

/** SYNTHETIC: a real screen with each matching row replaced by `next`. */
const replacing = (r: string[], match: (row: string) => boolean, next: string[]) =>
  r.flatMap((x) => (match(x) ? next : [x]))

const must = <T>(v: T | null | undefined): T => {
  expect(v).toBeDefined()
  expect(v).not.toBeNull()
  return v as T
}

describe('DialogReader reads the known dialogs', () => {
  const trust: [string, number][] = [
    ['01-trust-first', 0],
    ['02-trust-down', 1],
    ['03-trust-down2', 0],
    ['04-trust-up', 1],
    ['05-trust-first', 0],
    ['06-trust-after-2', 0],
    ['07-trust-after-2-later', 0],
    ['08-trust-first', 0],
    ['09-trust-on-yes', 1],
    ['12-trust-first', 0],
  ]
  for (const [name, cursor] of trust)
    it(`the real 2.1.319 trust capture ${name} is read with its cursor on ${cursor}`, () => {
      const r = nyRows(name)
      const d = must(readDialog(r, escaped(name)))
      expect(d.kind).toBe('trust')
      expect(d.options).toEqual(TRUST_OPTIONS)
      expect(d.cursor).toBe(cursor)
      expect(d.subject).toBe(pathRow(r))
      expect(d.subject?.startsWith('/private/tmp/tcap-ny-proj.')).toBe(true)
      // the same without the colours
      expect(readDialog(r)).toEqual(d)
    })

  for (const [name, path] of [
    ['trust-dialog', '/private/tmp/tsw/cap/proj'],
    ['trust-dialog-tcap', '/private/tmp/tcap/proj'],
  ] as const)
    it(`the real 2.1.318 trust capture ${name} is read`, () => {
      expect(readDialog(rows(name))).toEqual({ kind: 'trust', subject: path, options: TRUST_OPTIONS, cursor: 0 })
    })

  const mcp: [string, number][] = [
    ['20-mcp-first', 2],
    ['21-mcp-up', 1],
    ['22-mcp-up2', 0],
    ['23-mcp-down', 1],
    ['24-mcp-to-top', 1],
    ['27-mcp-first', 2],
    ['28-mcp-after-1', 2],
    ['29-mcp-after-1-later', 2],
  ]
  for (const [name, cursor] of mcp)
    it(`the real 2.1.319 MCP capture ${name} is read with its cursor on ${cursor}`, () => {
      expect(readDialog(nyRows(name), escaped(name))).toEqual({
        kind: 'mcp_consent',
        subject: 'harmless',
        options: MCP_OPTIONS,
        cursor,
      })
    })

  it('the real 2.1.318 MCP capture is read', () => {
    expect(readDialog(rows('mcp-consent'))).toEqual({
      kind: 'mcp_consent',
      subject: 'harmless',
      options: MCP_OPTIONS,
      cursor: 2,
    })
  })

  const LOGIN: Dialog = { kind: 'login', subject: null, options: [], cursor: null }
  for (const [name, dir] of [
    ['login-not-logged-in', 'real-2.1.318'],
    ['10-trust-after-enter', CAP],
    ['11-trust-after-enter-later', CAP],
    ['25-mcp-after-enter', CAP],
    ['26-mcp-after-enter-later', CAP],
  ] as const)
    it(`the real not-logged-in screen ${name} reads as login, with no keys`, () => {
      // the 2.1.318 captures are plain text only; the 2.1.319 ones have their colours too
      expect(readDialog(nyRows(name, dir), dir === CAP ? escaped(name, dir) : undefined)).toEqual(LOGIN)
    })

  it('the bypass disclaimer is never read', () => {
    const r = rows('bypass-disclaimer')
    expect(liveDialog(r).kind).toBe('bypass_disclaimer') // control: it is a known dialog
    expect(readDialog(r)).toBeNull()
  })

  it('screens that are not these dialogs are never read', () => {
    const positives = new Set(['trust-dialog', 'trust-dialog-tcap', 'mcp-consent', 'login-not-logged-in'])
    const names = readdirSync(resolve(FIX, 'real-2.1.318'))
      .filter((f) => f.endsWith('.txt'))
      .map((f) => f.slice(0, -4))
    expect(names.length).toBeGreaterThan(30) // control: the captures were found
    for (const name of names) if (!positives.has(name)) expect([name, readDialog(rows(name))]).toEqual([name, null])
    // after the dialog is answered "No, exit" Claude is gone: an empty pane
    for (const name of ['13-trust-after-no', '14-trust-after-no-later']) expect(readDialog(nyRows(name))).toBeNull()
  })

  it('the input box and unknown Selects are never read', () => {
    for (const name of [
      'empty-input',
      'draft-input',
      'idle-input-auto',
      'bash-permission',
      'write-permission',
      'askuser-select',
      'perm-askuserquestion',
    ])
      expect([name, readDialog(rows(name))]).toEqual([name, null])
    expect(readDialog([])).toBeNull()
  })

  it('SYNTHETIC: a trust path wrapped over two rows is no subject, never a partial one', () => {
    const r = nyRows('01-trust-first')
    const path = must(pathRow(r))
    const wrapped = replacing(r, (x) => x.startsWith(' /private/tmp/tcap'), [
      ` ${path.slice(0, 12)}`,
      ` ${path.slice(12)}`,
    ])
    const d = must(readDialog(wrapped))
    expect(d.subject).toBeNull()
    expect(d.options).toEqual(TRUST_OPTIONS)
    expect(d.cursor).toBe(0)
  })

  it('SYNTHETIC: a path cut with an ellipsis is no subject', () => {
    const cut = replacing(nyRows('01-trust-first'), (x) => x.startsWith(' /private/tmp/tcap'), [
      ' /private/tmp/tcap-ny-pr…',
    ])
    expect(must(readDialog(cut)).subject).toBeNull()
  })

  it('SYNTHETIC: a long MCP server name wrapped onto the next row is no subject, never the first half', () => {
    const wrapped = replacing(nyRows('20-mcp-first'), (x) => x.includes('New MCP server found'), [
      '  New MCP server found in this project: a-very-long-na',
      '  me-that-wrapped',
    ])
    const d = must(readDialog(wrapped))
    expect(d.subject).toBeNull()
    expect(d.options).toEqual(MCP_OPTIONS)
    expect(d.cursor).toBe(2)
  })

  it('SYNTHETIC: the several-servers dialog (never captured) is not read', () => {
    const plural = replacing(nyRows('20-mcp-first'), (x) => x.includes('New MCP server found'), [
      '  3 new MCP servers found in this project',
    ])
    expect(liveDialog(plural).kind).toBe('mcp_consent') // control: it still counts as the MCP dialog
    expect(readDialog(plural)).toBeNull()
  })

  it('SYNTHETIC: a row touching the options that is not an aligned option refuses', () => {
    const r = nyRows('20-mcp-first')
    const isFirst = (x: string) => x === '    Use this MCP server'
    expect(readDialog(replacing(r, isFirst, ['    Use this MCP server', '  continued here']))).toBeNull()
    expect(readDialog(replacing(r, isFirst, ['  a note', '    Use this MCP server']))).toBeNull()
  })

  it('SYNTHETIC: two options with the same label refuse', () => {
    const dup = replacing(nyRows('01-trust-first'), (x) => x === '   Yes, I trust this folder', ['   No, exit'])
    expect(readDialog(dup)).toBeNull()
  })

  it('SYNTHETIC: anything after the footer refuses', () => {
    expect(readDialog([...nyRows('01-trust-first'), ' and then more text'])).toBeNull()
  })

  it('colour rows from another frame refuse', () => {
    // plain: the cursor on "No, exit"; colours: the cursor on "Yes"
    expect(readDialog(nyRows('01-trust-first'), escaped('02-trust-down'))).toBeNull()
    expect(readDialog(nyRows('01-trust-first'), [])).toBeNull()
  })

  it('SYNTHETIC: the cursor row must be the coloured one and the others plain', () => {
    const r = nyRows('01-trust-first')
    const esc = escaped('01-trust-first')
    expect(readDialog(r, esc)).not.toBeNull() // control
    const uncoloured = esc.map((x) => x.replaceAll('\x1b[38;5;153m', ''))
    expect(readDialog(r, uncoloured)).toBeNull() // no colour on the cursor row
    const both = esc.map((x) =>
      x.replaceAll('   Yes, I trust this folder', '   \x1b[38;5;153mYes, I trust this folder'),
    )
    expect(readDialog(r, both)).toBeNull() // a second coloured row
    const dim = esc.map((x) => x.replaceAll('   Yes, I trust this folder', '   \x1b[2mYes, I trust this folder'))
    expect(readDialog(r, dim)).toBeNull() // a dim option
  })

  it('SYNTHETIC: a label wrapped over two rows refuses the dialog (its long first row gives it away)', () => {
    const r = nyRows('20-mcp-first')
    const long = '    Use this and all future MCP servers in this project and every other project on this computer too'
    const isLong = (x: string) => x.includes('Use this and all future')
    const wrapped = replacing(r, isLong, [long, '    as well'])
    expect(liveDialog(wrapped).kind).toBe('mcp_consent') // control: it still counts as the MCP dialog
    expect(readDialog(wrapped)).toBeNull()
    expect(readDialog(replacing(r, isLong, [long]))).toBeNull() // a label that long is not one of the dialogs captured
  })

  it('the longest real option is still read', () => {
    const d = must(readDialog(nyRows('20-mcp-first')))
    expect(Math.max(...d.options.map((o) => [...o].length))).toBe(51) // control: the longest real label is 51 characters
  })

  it('SYNTHETIC: text is compared by code points, never by canonical equivalence', () => {
    const r = nyRows('01-trust-first')
    const path = must(pathRow(r))
    const composed = `${path}/caf\u00e9`
    const decomposed = `${path}/cafe\u0301`
    expect(composed.normalize()).toBe(decomposed.normalize()) // control: the two are canonically equivalent
    const plain = r.map((x) => x.replaceAll(path, composed))
    const esc = escaped('01-trust-first').map((x) => x.replaceAll(path, decomposed))
    expect(must(readDialog(plain)).subject).toBe(composed)
    const same = escaped('01-trust-first').map((x) => x.replaceAll(path, composed))
    expect(readDialog(plain, same)).not.toBeNull() // control: the escaped capture carries the path
    expect(readDialog(plain, esc)).toBeNull()
  })
})

// ---- the prompt detector --------------------------------------------------------------------------------------------------------

const RULE = '─'.repeat(60)
const detect = (name: string) => must(detectPrompt(rows(name)))

/** The Swift tests' devDialog: the development-channels warning as Claude Code draws it. */
function devDialog(highlight = 1, boxed = false): string[] {
  const r = [
    ' WARNING: Loading development channels',
    '',
    ' --dangerously-load-development-channels is for local channel development only. Do not use this option to run channels you have downloaded off the internet.',
    '',
    ' Please use --channels to run a list of approved channels.',
    '',
    ' Channels: server:talos-app',
    '',
    highlight === 1 ? ' ❯ 1. I am using this for local development' : '   1. I am using this for local development',
    highlight === 2 ? ' ❯ 2. Exit' : '   2. Exit',
    '',
    ' Enter to confirm · Esc to cancel',
  ]
  return boxed ? r.map((x) => `│ ${x}   │`) : r
}

/**
 * SYNTHETIC re-flow of a 120-column capture to `width` columns: a rule or a `╌` box row is redrawn at the new width; any other
 * row that is too long is word-wrapped, its continuation rows indented as the row was.
 */
function reflow(r: string[], width: number): string[] {
  const out: string[] = []
  for (const row of r) {
    const t = row.trim()
    if (isFrameRule(row)) out.push(([...row].find((c) => c !== ' ') ?? '─').repeat(width))
    else if (t !== '' && [...t].every((c) => c === '╌')) out.push('╌'.repeat(width))
    else if ([...row].length <= width) out.push(row)
    else {
      const indent = /^ */.exec(row)?.[0] ?? ''
      let line = ''
      for (const word of row.split(' ').filter(Boolean)) {
        const first = line === ''
        const candidate = first ? indent + word : `${line} ${word}`
        if ([...candidate].length > width && !first) {
          out.push(line)
          line = indent + word
        } else line = candidate
      }
      out.push(line)
    }
  }
  return out
}

describe('PromptDetector on real captures', () => {
  for (const [name, kind, question, footer] of [
    ['bash-permission', 'bash_command', 'Do you want to proceed?', true],
    ['bash-permission-cursor2', 'bash_command', 'Do you want to proceed?', true],
    ['write-permission', 'file_create', 'Do you want to create notes.txt?', true],
    ['askuser-select', 'question', 'Which color do you prefer?', true],
    ['onboarding-theme', 'other', 'Choose the text style that looks best with your terminal', false],
  ] as const)
    it(`${name} is a ${kind} prompt`, () => {
      const p = detect(name)
      expect(p.kind).toBe(kind)
      expect(p.question).toBe(question)
      expect(p.footer).toBe(footer)
    })

  // the idle box, the turn that just ended, the interrupted one, a reply that quotes a prompt, "Press Enter to continue"
  for (const name of [
    'idle-input-auto',
    'idle-input-manual',
    'turn-done',
    'after-esc',
    'reply-quotes-prompt',
    'onboarding-security-notes',
    'empty-input',
    'draft-input',
  ])
    it(`${name} is not a prompt`, () => expect(detectPrompt(rows(name))).toBeNull())

  for (const name of ['trust-dialog', 'trust-dialog-tcap', 'mcp-consent', 'bypass-disclaimer', 'login-not-logged-in'])
    it(`the known dialog ${name} is never also a generic prompt`, () => {
      const r = rows(name)
      if (name !== 'login-not-logged-in') expect(liveDialog(r).kind).not.toBe('none') // control
      expect(detectPrompt(r)).toBeNull()
    })

  it('moving the cursor keeps the prompt and changes its region', () => {
    const a = detect('bash-permission')
    const b = detect('bash-permission-cursor2')
    expect(a.signature).toBe(b.signature)
    expect(a.region).not.toEqual(b.region)
  })

  for (const [name, differ] of [
    ['bash-permission', true],
    ['write-permission', false],
    ['askuser-select', false],
  ] as const)
    it(`${name}: a blinking line above the prompt is not in its region`, () => {
      const early = rows(name)
      const late = rows(`${name}-6s`)
      expect(early.join('\n') !== late.join('\n')).toBe(differ) // control: only the Bash pair differs
      const a = must(detectPrompt(early))
      const b = must(detectPrompt(late))
      expect(a.region).toEqual(b.region)
      expect(a.signature).toBe(b.signature)
    })

  it('the region starts at the frame rule above the cursor', () => {
    const p = detect('askuser-select')
    expect(isFrameRule(must(p.region[0]))).toBe(true)
    expect(p.region.some((r) => r.includes('Which color do you prefer?'))).toBe(true)
    expect(p.region.some((r) => r.includes('4. Chat about this'))).toBe(true) // the second rule does not cut it short
    expect(p.region.some((r) => r.includes('Cogitated'))).toBe(false)
  })
})

describe('PromptDetector structure (SYNTHETIC)', () => {
  it('a numbered option list below a rule is a prompt with or without a known footer', () => {
    const numbered = ['output', RULE, ' Allow it?', ' ❯ 1. Yes', '   2. No']
    expect(detectPrompt(numbered)?.footer).toBe(false)
    expect(detectPrompt([...numbered, '', ' Esc to cancel'])?.footer).toBe(true)
    // unnumbered, aligned with the cursor's text
    expect(detectPrompt(['output', RULE, ' Pick one', ' ❯ Red', '   Blue', '   Green'])).not.toBeNull()
  })

  it('the idle box is not a prompt whatever is in it', () => {
    const status = '  ⏸ manual mode on · ? for shortcuts'
    expect(detectPrompt(['output', RULE, '❯ ', RULE, status])).toBeNull()
    expect(detectPrompt(['output', RULE, '❯ Try "fix lint errors"', RULE, status])).toBeNull()
    expect(detectPrompt(['output', RULE, '❯ 1. fix it', '  2. then this', RULE, status])).toBeNull()
    expect(
      detectPrompt([
        'output',
        RULE,
        '❯ one long draft',
        '  that wraps',
        RULE,
        '  ⏵⏵ auto mode on (shift+tab to cycle)',
      ]),
    ).toBeNull()
    expect(
      detectPrompt(['output', RULE, '❯ 1. fix it', '  2. then this', RULE, '  Press Ctrl-C again to exit']),
    ).toBeNull()
    expect(detectPrompt(['output', RULE, '❯ one long draft', '  that wraps', RULE])).toBeNull()
    expect(detectPrompt(['output', RULE, ' ❯ 1. Yes', '   2. No', '', status])).toBeNull()
  })

  it('a quoted prompt above the idle box is not a prompt', () => {
    const quoted = ['⏺ Do you want to proceed?', '  ❯ 1. Yes', '  2. No', '  Esc to cancel · Tab to amend', '']
    expect(detectPrompt([...quoted, RULE, '❯ ', RULE, '  ⏸ manual mode on · ? for shortcuts'])).toBeNull()
    expect(detectPrompt([...quoted, RULE, '❯ ', RULE])).toBeNull()
    expect(
      detectPrompt(['❯ Reply with these lines', '  "Esc to cancel"', '', RULE, '❯ ', RULE, '  ? for shortcuts']),
    ).toBeNull()
  })

  it('one cursor and siblings that line up are required', () => {
    expect(detectPrompt(['output', RULE, ' Allow it?', ' ❯ 1. Yes'])).toBeNull()
    expect(detectPrompt(['output', RULE, ' Allow it?', ' ❯ 1. Yes', '2. No', ' 3. Maybe'])).toBeNull()
    expect(detectPrompt(['output', RULE, ' ❯ 1. Yes', '   2. No', ' ❯ 3. Maybe', '   4. Other'])).toBeNull()
    // a ✔ marker (the theme Select): siblings line up with the label, not the marker
    expect(detectPrompt(['Pick', '', '     Auto', ' ❯ ✔ Dark', '     Light'])).not.toBeNull()
  })

  it('the trust dialog is known, not generic', () => {
    const trust = [
      'Quick safety check',
      '',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      '',
      ' Enter to confirm · Esc to cancel',
    ]
    expect(detectPrompt([RULE, ...trust])).toBeNull()
  })

  it('the footer shapes are supporting evidence only', () => {
    for (const f of [
      'Esc to cancel',
      'Esc to cancel · Tab to amend',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
      'Enter to confirm · Esc to cancel',
    ])
      expect([f, detectPrompt([RULE, ' Q?', ' ❯ 1. A', '   2. B', '', ` ${f}`])?.footer]).toEqual([f, true])
    expect(detectPrompt([RULE, ' Q?', ' ❯ 1. A', '   2. B', '', ' Press Esc to cancel everything now'])?.footer).toBe(
      false,
    )
  })

  it('the question line is cleaned for a notice', () => {
    const p = must(detectPrompt([RULE, ' "Run\u0007 it?"  now?', ' ❯ 1. A', '   2. B']))
    expect(p.question).toBe("'Run it?' now?")
    const q = must(detectPrompt([RULE, ` ${'x'.repeat(300)}`, ' ❯ 1. A', '   2. B']))
    expect([...must(q.question)].length).toBe(101) // 100 and the ellipsis
    expect(detectPrompt(['', ''])).toBeNull()
    expect(detectPrompt([])).toBeNull()
  })
})

describe('PromptDetector review', () => {
  for (const name of ['bash-permission', 'write-permission', 'askuser-select', 'onboarding-theme'])
    it(`SYNTHETIC: ${name} at eighty columns is the same prompt`, () => {
      const wide = rows(name)
      const narrow = reflow(wide, 80)
      expect(narrow).not.toEqual(wide) // control: the layout changed
      const a = must(detectPrompt(wide))
      const b = must(detectPrompt(narrow))
      expect(a.signature).toBe(b.signature)
      expect(a.hash).toBe(b.hash)
      expect(a.kind).toBe(b.kind)
    })

  it('the prompts differ even without their layout', () => {
    const a = detect('bash-permission')
    const w = detect('write-permission')
    expect(a.hash).not.toBe('')
    expect(a.hash).not.toBe(w.hash)
    const other = rows('bash-permission').map((r) => r.replaceAll('touch hello.txt', 'rm -rf build'))
    expect(must(detectPrompt(other)).hash).not.toBe(a.hash)
    expect(detect('bash-permission-cursor2').hash).toBe(a.hash)
  })

  /** SYNTHETIC: the cursor row of askuser-select moved to `4. Chat about this`, alone under the second rule. */
  const cursorOnChat = () =>
    rows('askuser-select').map((r) => {
      if (r.startsWith('❯ 1. Red')) return '  1. Red'
      if (r.startsWith('  4. Chat about this')) return '❯ 4. Chat about this'
      return r
    })

  it('SYNTHETIC: the cursor on "Chat about this" is still the question', () => {
    const real = detect('askuser-select')
    const moved = must(detectPrompt(cursorOnChat()))
    expect(moved.kind).toBe('question')
    expect(moved.question).toBe('Which color do you prefer?')
    expect(moved.hash).toBe(real.hash)
  })

  it('SYNTHETIC: typing into "Type something." is not a new prompt', () => {
    const real = detect('askuser-select')
    const typing = rows('askuser-select').map((r) => {
      if (r.startsWith('❯ 1. Red')) return '  1. Red'
      if (r.startsWith('  3. Type something.')) return '❯ 3. my own colour is teal'
      return r
    })
    const p = must(detectPrompt(typing))
    expect(p.hash).toBe(real.hash)
    expect(p.region).not.toEqual(real.region)
  })

  for (const boxed of [false, true])
    it(`the dev-channels dialog is never generic${boxed ? ' (boxed)' : ''}`, () => {
      expect(detectPrompt(devDialog(1, boxed))).toBeNull()
      expect(detectPrompt(devDialog(2, boxed))).toBeNull()
      // the title and the text scrolled off a short pane: the options and the footer are all that is left
      const short = devDialog(1, boxed).filter(
        (r) => !r.includes('WARNING') && !r.includes('--dangerously') && !r.includes('Please use'),
      )
      expect(short.some((r) => r.includes('WARNING'))).toBe(false)
      expect(detectPrompt(short)).toBeNull()
      expect(detectPrompt(short.slice(-5))).toBeNull()
    })

  it('transcript chrome is never the question', () => {
    for (const chrome of ['✻ Worked for 2s', '⏺ Ran 1 command', '⎿  Interrupted']) {
      const p = must(detectPrompt([RULE, ` ${chrome}`, ' ❯ 1. A', '   2. B']))
      expect([chrome, p.question]).toEqual([chrome, null])
    }
  })

  it('SYNTHETIC: the Edit tool’s permission is a file edit', () => {
    const r = rows('write-permission').map((x) =>
      x
        .replaceAll(' Create file', ' Edit file')
        .replaceAll('Do you want to create notes.txt?', 'Do you want to make this edit to notes.txt?'),
    )
    const p = must(detectPrompt(r))
    expect(p.kind).toBe('file_edit')
    expect(p.title).toBe('file edit')
    expect(p.question).toBe('Do you want to make this edit to notes.txt?')
    // the question alone names it too
    const q = rows('write-permission').map((x) =>
      x
        .replaceAll('Do you want to create notes.txt?', 'Do you want to make this edit to notes.txt?')
        .replaceAll(' Create file', ' notes.txt'),
    )
    expect(must(detectPrompt(q)).kind).toBe('file_edit')
  })

  it('SYNTHETIC: the tab header of several questions is still a question', () => {
    const r = rows('askuser-select').map((x) => (x.startsWith(' ☐ Color') ? ' ← ☐ Color  ☐ Size  ✔ Submit →' : x))
    expect(r.some((x) => x.includes('← ☐'))).toBe(true) // control
    const p = must(detectPrompt(r))
    expect(p.kind).toBe('question')
    expect(p.question).toBe('Which color do you prefer?')
  })

  it('the idle screens are recognised', () => {
    for (const name of ['idle-input-auto', 'idle-input-manual', 'turn-done', 'after-esc', 'reply-quotes-prompt'])
      expect([name, isIdle(rows(name))]).toEqual([name, true])
    for (const name of ['bash-permission', 'askuser-select', 'write-permission', 'onboarding-theme'])
      expect([name, isIdle(rows(name))]).toEqual([name, false])
  })

  it('the kind names the owner reads; none for a kind that cannot be told', () => {
    expect(detect('bash-permission').title).toBe('Bash command')
    expect(detect('write-permission').title).toBe('file create')
    expect(detect('askuser-select').title).toBe('question')
    expect(detect('onboarding-theme').title).toBeNull()
  })
})

describe('PromptDetector on the permission captures', () => {
  const ts = ['perm-dangerous-rm-t0', 'perm-dangerous-rm-t1', 'perm-dangerous-rm-t2', 'perm-dangerous-rm-t3']

  for (const name of [
    'perm-dangerous-rm-bypass',
    'perm-ask-rule-bypass',
    'perm-hook-ask',
    'perm-subagent-ask',
    'perm-background-bash-ask',
  ])
    it(`${name} is found`, () => {
      const p = detect(name)
      expect(p.kind).toBe('bash_command')
      expect(p.question).toBe('Do you want to proceed?')
      expect(p.footer).toBe(true) // its footer is a real shape
    })

  it('the agent’s own question is found', () => expect(detect('perm-askuserquestion').kind).toBe('question'))

  it('the countdown is not part of the prompt', () => {
    const all: Prompt[] = ts.map(detect)
    expect(new Set(all.map((p) => p.signature)).size).toBe(1)
    expect(new Set(all.map((p) => p.hash)).size).toBe(1)
    expect(new Set(all.map((p) => p.region.join('\n'))).size).toBe(1)
    expect(all.map((p) => p.autoBlockSeconds)).toEqual([114, 111, 108, 105])
    expect(all.every((p) => p.kind === 'bash_command' && p.question === 'Do you want to proceed?')).toBe(true)
    // the frames really differ in that one row
    expect(new Set(ts.map((n) => rows(n).join('\n'))).size).toBe(4)
    // a prompt with no countdown has none
    expect(detect('perm-ask-rule-bypass').autoBlockSeconds).toBeNull()
  })

  it('SYNTHETIC: digits in the command are the command, not masked', () => {
    const a = rows('perm-dangerous-rm-t0').map((r) => r.replaceAll(' rm -rf /private/tmp/tsw/perm/home', ' sleep 1:54'))
    const b = a.map((r) => r.replaceAll('sleep 1:54', 'sleep 2:54'))
    expect(must(detectPrompt(a)).hash).not.toBe(must(detectPrompt(b)).hash)
  })
})

describe('the auto-block countdown read off the screen is bounded (screen text anyone can draw)', () => {
  const row = (t: string) => [` ⚠ Claude Code will automatically block this request in ${t}, unless you answer`]
  it('a real countdown is read; a number no countdown has is none, and never overflows into the notice', () => {
    expect(maskCountdown(row('1:54')).seconds).toBe(114)
    expect(maskCountdown(row('45 seconds')).seconds).toBe(45)
    expect(maskCountdown(row('9223372036854775807:00')).seconds).toBeNull()
    expect(maskCountdown(row(`${'9'.repeat(400)}:00`)).seconds).toBeNull()
    expect(maskCountdown(row('1441:00')).seconds).toBeNull() // more than a day
    expect(maskCountdown(row('86401 seconds')).seconds).toBeNull()
    // masked either way: the digits never reach the screen's fingerprint
    expect(maskCountdown(row('9223372036854775807:00')).rows[0]).toContain('#:##')
  })
})
